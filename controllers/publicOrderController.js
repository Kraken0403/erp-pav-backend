const db = require('../config/db');
const { createRazorpayOrder } = require('../services/razorpayService');
const { isRazorpayEnabled } = require('../config/featureFlags');
const {
  createInvoiceRecord,
  dispatchInvoiceNotifications,
} = require('../services/invoiceLifecycleService');
const { recordCouponUsage } = require('./couponController');
const jwt = require('jsonwebtoken');
const { createNotificationsForUsers, getAdminUserIds, getSystemNotifierUserId } = require('../services/notificationService');

const PREP_HOURS_MIN = 24;
const FIXED_CITY = 'Ahmedabad';
const FIXED_STATE = 'Gujarat';
let cachedWorkOrderInitialStatus = null;

const getEnumValuesFromColumnType = (columnType) => {
  const raw = String(columnType || '');
  const matches = [...raw.matchAll(/'([^']+)'/g)];
  return matches.map((match) => match[1]);
};

const resolveWorkOrderInitialStatus = async (connection) => {
  if (cachedWorkOrderInitialStatus) return cachedWorkOrderInitialStatus;

  try {
    const [rows] = await connection.query(`SHOW COLUMNS FROM work_orders LIKE 'status'`);
    const columnType = rows?.[0]?.Type || rows?.[0]?.type || '';
    const allowedStatuses = getEnumValuesFromColumnType(columnType);

    if (allowedStatuses.includes('pending')) {
      cachedWorkOrderInitialStatus = 'pending';
      return cachedWorkOrderInitialStatus;
    }

    if (allowedStatuses.includes('issued')) {
      cachedWorkOrderInitialStatus = 'issued';
      return cachedWorkOrderInitialStatus;
    }
  } catch (error) {
    console.warn('Could not detect work order status enum, defaulting to pending:', error.message);
  }

  cachedWorkOrderInitialStatus = 'pending';
  return cachedWorkOrderInitialStatus;
};

const parseRequestedFulfillmentDateTime = (value) => {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.replace('T', ' ');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr = '00'] = match;

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
  if (Number.isNaN(parsed.getTime())) return null;

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute
  ) {
    return null;
  }

  return parsed;
};

const toDateOnly = (dateObj) => {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toTimeOnly = (dateObj) => {
  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  const seconds = String(dateObj.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const toDateTime = (dateObj) => {
  return `${toDateOnly(dateObj)} ${toTimeOnly(dateObj)}`;
};

const formatHumanDateTime = (dateObj) => {
  return dateObj.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

const floorToMinute = (dateObj) => {
  const next = new Date(dateObj.getTime());
  next.setSeconds(0, 0);
  return next;
};

exports.createOrder = async (req, res) => {
  const {
    customer,
    billing,
    items,
    requested_fulfillment_at: requestedFulfillmentAtRaw,
    order_notes: orderNotesRaw,
    dietary_preference: dietaryPreferenceRaw
  } = req.body;

  // Debug: dump incoming items payload to help diagnose fusion-box ordering issues
  try {
    console.debug('[PublicOrder] createOrder - incoming payload summary:', {
      itemsCount: Array.isArray(items) ? items.length : 0,
      sampleItem: items && items[0] ? (items[0].name || items[0].product_name || items[0].id) : null,
      totals: req.body && req.body.totals ? req.body.totals : null,
      coupon: req.body && req.body.coupon ? req.body.coupon : req.body.coupon_code || null
    });

    // Also log full items structure at debug level when available
    if (Array.isArray(items) && items.length) {
      console.debug('[PublicOrder] createOrder - full items payload:', JSON.stringify(items));
    }
  } catch (dbgErr) {
    console.warn('[PublicOrder] createOrder - failed to log incoming payload', dbgErr && dbgErr.message ? dbgErr.message : dbgErr);
  }

  const firstName = customer?.first_name || customer?.firstName || billing?.firstName || '';
  const lastName = customer?.last_name || customer?.lastName || billing?.lastName || '';
  const customerEmail = customer?.email || billing?.email || null;
  const customerPhone = customer?.phone || billing?.phone || '';

  if (customer && typeof customer === 'object') {
    customer.city = FIXED_CITY;
    customer.state = FIXED_STATE;
  }

  if (billing && typeof billing === 'object') {
    billing.city = FIXED_CITY;
    billing.state = FIXED_STATE;
  }

  if (!customerEmail || !items?.length) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const totalItemQuantity = items.reduce(
    (sum, item) => sum + Number(item?.qty || 0),
    0
  );

  const dietaryPreferenceEnabled = Boolean(dietaryPreferenceRaw?.enabled);
  const dietaryItemPreferencesRaw =
    dietaryPreferenceEnabled && Array.isArray(dietaryPreferenceRaw?.item_preferences)
      ? dietaryPreferenceRaw.item_preferences
      : [];

  const dietaryPreferencesByIndex = new Map();

  for (const preference of dietaryItemPreferencesRaw) {
    const itemIndex = Number(preference?.item_index);
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) {
      continue;
    }

    const jainCount = Number(preference?.jain_count || 0);
    const swaminarayanCount = Number(preference?.swaminarayan_count || 0);

    if (jainCount < 0 || swaminarayanCount < 0) {
      return res.status(400).json({ error: 'Dietary preference counts cannot be negative' });
    }

    const existing = dietaryPreferencesByIndex.get(itemIndex) || { jainCount: 0, swaminarayanCount: 0 };
    dietaryPreferencesByIndex.set(itemIndex, {
      jainCount: existing.jainCount + jainCount,
      swaminarayanCount: existing.swaminarayanCount + swaminarayanCount,
    });
  }

  let dietaryPreferenceTotal = 0;
  const dietaryPreferenceSummaryLines = [];

  for (const [itemIndex, preference] of dietaryPreferencesByIndex.entries()) {
    const sourceItem = items[itemIndex] || {};
    const qty = Number(sourceItem?.qty || 0);
    const rowTotal = Number(preference.jainCount || 0) + Number(preference.swaminarayanCount || 0);

    if (rowTotal > qty) {
      return res.status(400).json({
        error: `Dietary preference total cannot exceed quantity for item ${sourceItem?.name || itemIndex + 1}`,
      });
    }

    if (rowTotal > 0) {
      dietaryPreferenceSummaryLines.push(
        `${sourceItem?.name || `Item ${itemIndex + 1}`}: Jain ${preference.jainCount}, Swaminarayan ${preference.swaminarayanCount}`
      );
    }

    dietaryPreferenceTotal += rowTotal;
  }

  if (dietaryPreferenceEnabled) {
    if (dietaryPreferenceTotal <= 0) {
      return res.status(400).json({ error: 'Enter item-wise Jain or Swaminarayan preference count' });
    }

    if (dietaryPreferenceTotal > totalItemQuantity) {
      return res.status(400).json({
        error: 'Dietary preference total cannot exceed total order quantity'
      });
    }
  }

  const requestedFulfillmentDate = parseRequestedFulfillmentDateTime(requestedFulfillmentAtRaw);

  if (!requestedFulfillmentDate) {
    return res.status(400).json({
      error: 'requested_fulfillment_at is required and must be a valid datetime'
    });
  }

  const requestedAtMinute = floorToMinute(requestedFulfillmentDate);
  const minAllowedDate = floorToMinute(new Date(Date.now() + PREP_HOURS_MIN * 60 * 60 * 1000));
  if (requestedAtMinute.getTime() < minAllowedDate.getTime()) {
    return res.status(400).json({
      error: `requested_fulfillment_at must be at least ${PREP_HOURS_MIN} hours from now`,
      min_allowed_at: minAllowedDate.toISOString(),
      requested_at: requestedAtMinute.toISOString(),
    });
  }

  const eventDate = toDateOnly(requestedFulfillmentDate);
  const eventTime = toTimeOnly(requestedFulfillmentDate);
  const scheduledFor = toDateTime(requestedFulfillmentDate);
  const requestedFulfillmentDisplay = formatHumanDateTime(requestedFulfillmentDate);
  const orderNotes = String(orderNotesRaw || '').trim() || null;
  const dietaryPreferenceSummary = dietaryPreferenceEnabled
    ? ['Dietary preference (item-wise):', ...dietaryPreferenceSummaryLines, `Total: ${dietaryPreferenceTotal}`].join('\n')
    : null;
  const finalOrderNotes = [orderNotes, dietaryPreferenceSummary].filter(Boolean).join('\n') || null;

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // For website orders: create or update a customer record and map work_orders.customer_id
    let leadId = null;
    let customerId = null;

    // If an Authorization header with a valid JWT is present, treat this as a logged-in user
    let loggedInUserId = null;
    try {
      const authHeader = req.headers && req.headers.authorization ? req.headers.authorization : null;
      const token = authHeader ? String(authHeader).split(' ')[1] : null;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) loggedInUserId = Number(decoded.id);
      }
    } catch (e) {
      // ignore token errors here; we will still allow public flow but will not treat user as logged in
      loggedInUserId = null;
    }

    if (customerEmail) {
      // find existing customer by email (include user_id so we can associate)
      const [[existingCustomer]] = await connection.query(
        `SELECT id, user_id FROM customers WHERE email = ? LIMIT 1`,
        [customerEmail]
      );

      if (existingCustomer && existingCustomer.id) {
        customerId = Number(existingCustomer.id);
        // If the request came from an authenticated user, ensure customer.user_id is linked
        if (loggedInUserId && Number(existingCustomer.user_id || 0) !== Number(loggedInUserId)) {
          try {
            await connection.query(`UPDATE customers SET user_id = ? WHERE id = ?`, [loggedInUserId, customerId]);
          } catch (e) {
            console.warn('[PublicOrder] failed to link customer to user:', e && e.message ? e.message : e);
          }
        }
        // update customer contact/address info
        await connection.query(
          `UPDATE customers SET name = ?, phone = ?, address = ?, landmark = ?, city = ?, state = ?, pincode = ?, updated_at = NOW() WHERE id = ?`,
          [
            `${firstName} ${lastName}`.trim() || null,
            customerPhone || null,
            (customer?.address || billing?.address || null),
            (customer?.landmark || billing?.landmark || null),
            (customer?.city || billing?.city || null),
            (customer?.state || billing?.state || null),
            (customer?.pincode || billing?.pincode || null),
            customerId,
          ]
        );
      } else {
        // Insert new customer; attach user_id when authenticated
        const [ins] = await connection.query(
          `INSERT INTO customers (user_id, name, email, phone, address, landmark, city, state, pincode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            loggedInUserId || null,
            `${firstName} ${lastName}`.trim() || null,
            customerEmail,
            customerPhone || null,
            (customer?.address || billing?.address || null),
            (customer?.landmark || billing?.landmark || null),
            (customer?.city || billing?.city || null),
            (customer?.state || billing?.state || null),
            (customer?.pincode || billing?.pincode || null),
          ]
        );
        customerId = Number(ins.insertId);
      }
    }

    // ====================================
    // 2️⃣ FETCH SETTINGS
    // ====================================

    const [[settings]] = await connection.query(
      `SELECT * FROM settings WHERE id = 1`
    );

    const gstEnabled = settings?.gst_enabled === 1;
    const pricingMode = settings?.gst_pricing_mode || 'INCLUSIVE';
    const companyState = (settings?.company_state || '').trim();
    const billingState = (billing.state || '').trim();

    const isIntraState =
      companyState &&
      billingState &&
      companyState.toLowerCase() === billingState.toLowerCase();

    // ====================================
    // 3️⃣ CALCULATE TOTALS + LINE BREAKDOWN
    // ====================================

    let subtotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;

    const computedItems = [];

    // Expand composite items (e.g., fusion_box) into individual product lines
    const expanded = [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx] || {};
      const outerQty = Number(item.qty || 1);

      if (item.meta && item.meta.type === 'fusion_box' && Array.isArray(item.meta.items) && item.meta.items.length) {
        for (const sub of item.meta.items) {
          const pid = Number(sub?.product_id || sub?.id || null);
          if (!Number.isFinite(pid) || pid <= 0) continue;
          const subQty = Number(sub?.quantity || outerQty || 1);
          // Important: avoid letting the composite owner's `unit_price` leak into
          // each expanded component. Use a shallow clone of the source item with
          // `unit_price` removed so later pricing falls back to the product DB
          // selling_price (or resolved price) instead of the whole-box price.
          const sourceWithoutUnit = Object.assign({}, item);
          if (sourceWithoutUnit.hasOwnProperty('unit_price')) delete sourceWithoutUnit.unit_price;

          expanded.push({
            originalIndex: idx,
            sourceItem: sourceWithoutUnit,
            product_id: pid,
            quantity: subQty
          });
        }
      } else {
        const pid = Number(item.id || item.product_id || null);
        expanded.push({
          originalIndex: idx,
          sourceItem: item,
          product_id: Number.isFinite(pid) ? pid : null,
          quantity: Number(item.qty || 1),
          // Respect frontend-provided unit_price when present (converted by frontend
          // to match backend pricing mode). Fall back to selling_price/price.
          unit_price: (item.unit_price != null ? item.unit_price : (item.selling_price != null ? item.selling_price : item.price ?? null)),
          gst_rate: item.gst_rate || null
        });
      }
    }

    // Fetch product details for all referenced product_ids so pricing and GST are accurate
    const prodIds = [...new Set(expanded.map(e => e.product_id).filter(Boolean))];
    const productMap = new Map();
    if (prodIds.length) {
      const placeholders = prodIds.map(() => '?').join(',');
      const [rows] = await connection.query(
        `SELECT p.id, p.name, p.selling_price, p.gst_rate, p.description, c.slug AS category_slug
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.id IN (${placeholders})`,
        prodIds
      );
      for (const r of rows) productMap.set(Number(r.id), r);
    }

    // If any referenced product is a pre-made fusion box (category_slug includes 'fusion')
    // attempt to parse its description (HTML lists or 'Includes' sections) and resolve
    // the component product IDs by name. Replace the single fusion product entry with
    // multiple expanded entries when matches are found.
    const furtherExpanded = [];
    for (const exp of expanded) {
      const prod = exp.product_id ? productMap.get(Number(exp.product_id)) : null;
      if (prod && prod.category_slug && String(prod.category_slug).toLowerCase().includes('fusion')) {
        const desc = String(prod.description || '').trim();
        // crude HTML list extraction: capture contents of <li> or lines after 'Includes:'
        const candidates = [];
        const liRegex = /<li\b[^>]*>(.*?)<\/li>/gi;
        let m;
        while ((m = liRegex.exec(desc)) !== null) {
          const text = m[1].replace(/<[^>]+>/g, '').trim();
          if (text) candidates.push(text);
        }

        if (!candidates.length) {
          // fallback: find paragraphs following 'Includes' or split on newlines
          const includesRegex = /Includes\s*[:\-]?([\s\S]{1,2000})/i;
          const incMatch = desc.match(includesRegex);
          const source = incMatch ? incMatch[1] : desc;
          const lines = source.replace(/<[^>]+>/g, '\n').split(/\n|\.|;|,|\r/).map(s=>s.trim()).filter(Boolean);
          for (const l of lines) {
            // skip very short tokens
            if (l.length > 2 && /[a-zA-Z]/.test(l)) candidates.push(l);
          }
        }

        // Try to resolve candidate names to product IDs
        const resolvedIds = [];
        for (const name of candidates) {
          // attempt exact name match first
          const [exactRows] = await connection.query(
            `SELECT id, name, selling_price, gst_rate FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1`,
            [name]
          );
          if (exactRows && exactRows[0]) {
            resolvedIds.push({ id: Number(exactRows[0].id), name: exactRows[0].name, selling_price: exactRows[0].selling_price, gst_rate: exactRows[0].gst_rate });
            continue;
          }

          // fallback to LIKE match
          const likeName = `%${name.replace(/%/g,'') .replace(/\s+/g, '%')}%`;
          const [likeRows] = await connection.query(
            `SELECT id, name, selling_price, gst_rate FROM products WHERE LOWER(name) LIKE LOWER(?) LIMIT 1`,
            [likeName]
          );
          if (likeRows && likeRows[0]) {
            resolvedIds.push({ id: Number(likeRows[0].id), name: likeRows[0].name, selling_price: likeRows[0].selling_price, gst_rate: likeRows[0].gst_rate });
          }
        }

        if (resolvedIds.length) {
          for (const r of resolvedIds) {
            furtherExpanded.push({
              originalIndex: exp.originalIndex,
              sourceItem: exp.sourceItem,
              product_id: r.id,
              quantity: exp.quantity,
              resolved_name: r.name,
              resolved_price: r.selling_price,
              resolved_gst: r.gst_rate
            });
          }
          continue; // skip pushing the original fusion product
        }
      }

      // default: keep as-is
      furtherExpanded.push(exp);
    }

    // Use furtherExpanded from now on
    const finalExpanded = furtherExpanded;

    // Now compute totals and build computedItems from expanded list
    for (const exp of finalExpanded) {
      const src = exp.sourceItem || {};
      const qty = Number(exp.quantity || 1);
      const prod = exp.product_id ? productMap.get(Number(exp.product_id)) : null;

      // Prefer product's selling_price from DB; fall back to any resolved price or source item price
      // Prefer a frontend-provided `unit_price` (authoritative for what user saw),
      // otherwise fall back to product DB selling_price, resolved price, or source price.
      const price = Number(src.unit_price ?? prod?.selling_price ?? exp.resolved_price ?? src.selling_price ?? src.price ?? 0);
      const gstRate = Number(exp.resolved_gst ?? prod?.gst_rate ?? src.gst_rate ?? 0);

      if (!qty || !Number.isFinite(price) || price <= 0) {
        throw new Error('Invalid item data');
      }

      let taxableAmount = 0;
      let cgstAmount = 0;
      let sgstAmount = 0;
      let igstAmount = 0;
      let lineTotal = 0;

      if (!gstEnabled || gstRate === 0) {
        taxableAmount = qty * price;
        lineTotal = taxableAmount;
      } else {
        if (pricingMode === 'EXCLUSIVE') {
          taxableAmount = qty * price;
          const gstAmount = taxableAmount * gstRate / 100;
          if (isIntraState) {
            cgstAmount = gstAmount / 2;
            sgstAmount = gstAmount / 2;
          } else {
            igstAmount = gstAmount;
          }
          lineTotal = taxableAmount + gstAmount;
        } else { // INCLUSIVE
          const basePrice = price / (1 + gstRate / 100);
          taxableAmount = basePrice * qty;
          const gstAmount = (price * qty) - taxableAmount;
          if (isIntraState) {
            cgstAmount = gstAmount / 2;
            sgstAmount = gstAmount / 2;
          } else {
            igstAmount = gstAmount;
          }
          lineTotal = price * qty;
        }
      }

      subtotal += taxableAmount;
      cgstTotal += cgstAmount;
      sgstTotal += sgstAmount;
      igstTotal += igstAmount;

      computedItems.push({
        product_id: exp.product_id || null,
        description: prod?.name || src.name || null,
        quantity: qty,
        unit_price: price,
        gst_rate: gstRate,
        taxable_amount: taxableAmount,
        cgst_amount: cgstAmount,
        sgst_amount: sgstAmount,
        igst_amount: igstAmount,
        line_total: lineTotal,
        originalIndex: exp.originalIndex
      });
    }

    // Keep a pristine copy of computed items for work_order/kot insertion
    const originalComputedItems = computedItems.map(it => ({ ...it }));

    // Invoice copy (may be scaled to match client UI totals) — default to original
    let invoiceComputedItems = originalComputedItems.map(it => ({ ...it }));

    let grandTotal = subtotal + cgstTotal + sgstTotal + igstTotal;

    // If frontend sent totals (e.g. showing INCLUSIVE prices), prefer that value
    // so the Razorpay order amount matches what user saw. If the client also
    // included a coupon_discount in totals, the clientGrand is likely the
    // post-discount amount — we must scale invoice item prices to the
    // pre-discount total so item unit prices in the invoice PDF remain the
    // original/full prices and the coupon is represented as a separate line.
    const clientTotals = req.body?.totals || {};
    const clientGrand = Number(clientTotals?.grand_total || NaN);
    const clientCouponDiscount = Number(clientTotals?.coupon_discount || 0);
    // Interpret clientPreDiscountGrand as clientGrand + coupon_discount when coupon present
    const clientPreDiscountGrand = Number.isFinite(clientGrand) && clientCouponDiscount > 0 ? (clientGrand + clientCouponDiscount) : clientGrand;

    if (Number.isFinite(clientPreDiscountGrand) && clientPreDiscountGrand > 0) {
      const serverGrand = subtotal + cgstTotal + sgstTotal + igstTotal;
      const diff = Math.abs(clientPreDiscountGrand - serverGrand);
      if (diff > 0.005) {
        console.warn('Client grand_total differs from server calculation; scaling invoice line amounts to match UI (pre-discount)', {
          workOrderCandidate: null,
          serverGrandTotal: serverGrand,
          clientPreDiscountGrand,
          diff
        });

        const scale = serverGrand > 0 ? (clientPreDiscountGrand / serverGrand) : 1;
        // apply scaling to invoiceComputedItems monetary fields only (do not mutate originalComputedItems)
        for (const it of invoiceComputedItems) {
          it.unit_price = Number((it.unit_price * scale).toFixed(2));
          it.taxable_amount = Number((it.taxable_amount * scale).toFixed(2));
          it.cgst_amount = Number((it.cgst_amount * scale).toFixed(2));
          it.sgst_amount = Number((it.sgst_amount * scale).toFixed(2));
          it.igst_amount = Number((it.igst_amount * scale).toFixed(2));
          it.line_total = Number((it.line_total * scale).toFixed(2));
        }
      }

      // Keep grandTotal as the client-visible post-discount amount if provided
      if (Number.isFinite(clientGrand) && clientGrand > 0) {
        grandTotal = clientGrand;
      } else {
        grandTotal = clientPreDiscountGrand;
      }
    }

    const year = new Date().getFullYear();

    // ====================================
    // 4️⃣ CREATE WORK ORDER
    // ====================================

    const [[{ maxSeq: woMaxSeq }]] = await connection.query(
      `SELECT MAX(work_order_sequence) AS maxSeq FROM work_orders`
    );

    const initialWorkOrderStatus = await resolveWorkOrderInitialStatus(connection);

    const nextWoSeq = (woMaxSeq || 0) + 1;
    const workOrderNumber = `WO/${year}/${String(nextWoSeq).padStart(4, '0')}`;

    const businessType = String(settings?.business_type || 'GENERAL').trim().toUpperCase();
    const workOrderMode = businessType === 'CATERING' ? 'CATERING' : 'GENERAL';

    const customerName = `${firstName} ${lastName}`.trim();
    const customerGst = billing?.gst_number || customer?.gst_number || null;

    const billingSnapshot = {
      name: customerName,
      company: customer?.company_name || '',
      phone: billing?.phone || customer?.phone || '',
      email: billing?.email || customerEmail || '',
      gst: customerGst || ''
    };

    const shippingSnapshot = {
      name: customerName,
      company: customer?.company_name || '',
      phone: customer?.phone || '',
      email: customerEmail || '',
      address: customer?.address || '',
      landmark: customer?.landmark || '',
      city: customer?.city || '',
      state: customer?.state || '',
      pincode: customer?.pincode || ''
    };

    // ===== Apply coupon (if any) =====
    const couponCode = (req.body && (req.body.coupon_code || (req.body.coupon && req.body.coupon.code))) || null;
    let couponDiscount = 0;
    let appliedCouponId = null;
    if (couponCode) {
      const [[couponRow]] = await connection.query('SELECT * FROM coupons WHERE UPPER(code) = ? AND active = 1', [String(couponCode).trim().toUpperCase()]);
      const now = new Date();
      if (couponRow) {
          const preCouponServerTotal = Number(subtotal || 0) + Number(cgstTotal || 0) + Number(sgstTotal || 0) + Number(igstTotal || 0);
          // Determine the pre-discount base: prefer client-provided pre-discount total when available
          const preCouponBase = Number.isFinite(clientPreDiscountGrand) && clientPreDiscountGrand > 0 ? clientPreDiscountGrand : preCouponServerTotal;

          if (couponRow.starts_at && new Date(couponRow.starts_at) > now) {
            console.info('[PublicOrder] coupon ignored - not active yet', { coupon: couponRow.code, workOrderCandidate: null });
          } else if (couponRow.ends_at && new Date(couponRow.ends_at) < now) {
            console.info('[PublicOrder] coupon ignored - expired', { coupon: couponRow.code, workOrderCandidate: null });
          } else if (Number(couponRow.min_order_amount || 0) > Number(preCouponBase || 0)) {
            console.info('[PublicOrder] coupon ignored - min_order_amount not met', { coupon: couponRow.code, min_order_amount: couponRow.min_order_amount, preCouponBase });
          } else if (couponRow.usage_limit && Number(couponRow.times_used || 0) >= Number(couponRow.usage_limit)) {
            console.info('[PublicOrder] coupon ignored - global usage limit reached', { coupon: couponRow.code });
          } else {
            // Check per-user usage limit server-side to avoid client bypass
            if (couponRow.usage_limit_per_user && customerId) {
              const [[userCount]] = await connection.query('SELECT COUNT(*) AS cnt FROM coupon_usages WHERE coupon_id = ? AND customer_id = ?', [couponRow.id, customerId]);
              if (Number(userCount.cnt || 0) >= Number(couponRow.usage_limit_per_user)) {
                // user has already used coupon max times — ignore
              } else {
                // Prefer client-sent coupon discount when available; otherwise compute from pre-discount base
                if (Number.isFinite(clientCouponDiscount) && clientCouponDiscount > 0) {
                  couponDiscount = Number(clientCouponDiscount);
                } else if (couponRow.type === 'percent') {
                  couponDiscount = Math.round((Number(preCouponBase || 0) * (Number(couponRow.value || 0) / 100)) * 100) / 100;
                } else {
                  couponDiscount = Math.round(Number(couponRow.value || 0) * 100) / 100;
                }
                if (couponDiscount > Number(preCouponBase || 0)) couponDiscount = Number(preCouponBase || 0);
                appliedCouponId = Number(couponRow.id);
              }
            } else {
              if (Number.isFinite(clientCouponDiscount) && clientCouponDiscount > 0) {
                couponDiscount = Number(clientCouponDiscount);
              } else if (couponRow.type === 'percent') {
                couponDiscount = Math.round((Number(preCouponBase || 0) * (Number(couponRow.value || 0) / 100)) * 100) / 100;
              } else {
                couponDiscount = Math.round(Number(couponRow.value || 0) * 100) / 100;
              }
              if (couponDiscount > Number(preCouponBase || 0)) couponDiscount = Number(preCouponBase || 0);
              appliedCouponId = Number(couponRow.id);
            }
          }
      }
    }

    // Reduce grandTotal by couponDiscount only when the client did not already send a post-discount grand_total.
    // If the client provided `clientGrand` (post-discount), we trust that as the payable amount to avoid double-applying.
    const grandTotalBeforeCoupon = grandTotal;
    const clientProvidedGrand = Number.isFinite(clientGrand) && clientGrand > 0;
    if (!clientProvidedGrand) {
      grandTotal = Math.round((Number(grandTotal || 0) - Number(couponDiscount || 0)) * 100) / 100;
    } else {
      // Keep grandTotal as provided by client (post-discount)
      grandTotal = clientGrand;
    }

    const [woResult] = await connection.query(
      `
      INSERT INTO work_orders
      (
        quotation_id,
        lead_id,
        customer_id,
        mode,
        source_type,
        pax,
        event_name,
        event_date,
        event_time,
        event_location,
        work_order_number,
        work_order_sequence,
        status,
        issue_date,
        customer_name,
        customer_gst,
        notes,
        shipping_snapshot,
        billing_snapshot,
        subtotal,
        grand_total,
        total_amount
      )
      VALUES (NULL, ?, ?, ?, 'WEBSITE', NULL, 'Website Order', ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        leadId,
        customerId,
        workOrderMode,
        eventDate,
        eventTime,
        `${shippingSnapshot.address || ''}${shippingSnapshot.city ? `, ${shippingSnapshot.city}` : ''}${shippingSnapshot.state ? `, ${shippingSnapshot.state}` : ''}${shippingSnapshot.pincode ? ` - ${shippingSnapshot.pincode}` : ''}`.trim() || null,
        workOrderNumber,
        nextWoSeq,
        initialWorkOrderStatus,
        customerName,
        customerGst,
        finalOrderNotes,
        JSON.stringify(shippingSnapshot),
        JSON.stringify(billingSnapshot),
        subtotal,
        grandTotal,
        grandTotal
      ]
    );

    const workOrderId = woResult.insertId;

    let kotId = null;

    if (workOrderMode === 'CATERING') {
      const eventSnapshot = {
        name: 'Website Order',
        venue: `${shippingSnapshot.address || ''}${shippingSnapshot.city ? `, ${shippingSnapshot.city}` : ''}${shippingSnapshot.state ? `, ${shippingSnapshot.state}` : ''}${shippingSnapshot.pincode ? ` - ${shippingSnapshot.pincode}` : ''}`.trim() || null,
        pax: null,
        date: eventDate,
        time: eventTime,
        notes: finalOrderNotes
      };

      const [kotInsert] = await connection.query(
        `
        INSERT INTO kots (
          work_order_id,
          event_snapshot,
          status,
          scheduled_for,
          generated_at,
          created_by
        )
        VALUES (?, ?, 'pending', ?, NOW(), NULL)
        `,
        [
          workOrderId,
          JSON.stringify(eventSnapshot),
          scheduledFor
        ]
      );

      kotId = kotInsert.insertId;
    }

    // ====================================
    // 5️⃣ CREATE INVOICE (FRONTEND ORDER)
    // ====================================

    // Group computedItems by their originalIndex so composite items (fusion boxes)
    // can be collapsed into a single invoice line while keeping work_order_items
    // and kot_items expanded for kitchen operations.
    const itemsByOriginal = new Map();

    for (const it of invoiceComputedItems) {
      const idx = Number(it.originalIndex || 0);
      if (!itemsByOriginal.has(idx)) itemsByOriginal.set(idx, []);
      itemsByOriginal.get(idx).push(it);
    }
    const invoiceItems = [];
    for (const [origIdx, group] of itemsByOriginal.entries()) {
      const sourceItem = items[origIdx] || {};

      // If this source item is a fusion_box (custom composite), collapse lines
      if (sourceItem && sourceItem.meta && sourceItem.meta.type === 'fusion_box' && group.length) {
        // Represent the fusion box as a single invoice line (quantity = 1)
        const componentNames = group.map(g => (g.description || '').trim()).filter(Boolean);
        const sumLineTotal = group.reduce((s, g) => s + Number(g.line_total || 0), 0);
        const sumTaxable = group.reduce((s, g) => s + Number(g.taxable_amount || 0), 0);
        const sumCgst = group.reduce((s, g) => s + Number(g.cgst_amount || 0), 0);
        const sumSgst = group.reduce((s, g) => s + Number(g.sgst_amount || 0), 0);
        const sumIgst = group.reduce((s, g) => s + Number(g.igst_amount || 0), 0);

        // For exclusive pricing, unit price must be tax-exclusive (sum of taxable amounts).
        // For inclusive pricing, unit price should include tax (sumLineTotal).
        const unitPrice = pricingMode === 'EXCLUSIVE' ? Number(Number(sumTaxable || 0).toFixed(2)) : Number(Number(sumLineTotal || 0).toFixed(2));

        let inferredGstRate = 0;
        try {
          if (gstEnabled && sumTaxable > 0) {
            if (pricingMode === 'INCLUSIVE') {
              inferredGstRate = (sumLineTotal / sumTaxable - 1) * 100;
            } else {
              const totalTax = sumCgst + sumSgst + sumIgst;
              inferredGstRate = (totalTax / sumTaxable) * 100;
            }
          }
        } catch (e) {
          inferredGstRate = 0;
        }

        invoiceItems.push({
          product_id: null,
          description: `${sourceItem.name || 'Custom Fusion Box'}\n- ${componentNames.join('\n- ')}`,
          quantity: 1,
          unit_price: unitPrice,
          gst_rate: Number(Number(inferredGstRate || 0).toFixed(2)),
        });
      } else {
        // Normal item(s) — keep them as separate invoice lines
        for (const g of group) {
          invoiceItems.push({
            product_id: g.product_id || null,
            description: g.description || null,
            quantity: g.quantity,
            unit_price: g.unit_price,
            gst_rate: g.gst_rate,
          });
        }
      }
    }

    // If a coupon was applied, represent it as an invoice-level discount line
    if (appliedCouponId && couponDiscount && Number(couponDiscount) > 0) {
      const couponCodeProvided = String(couponCode || '').trim();
      const desc = couponCodeProvided ? `Coupon: ${couponCodeProvided}` : 'Coupon Discount';
      invoiceItems.push({
        product_id: null,
        description: desc,
        quantity: 1,
        unit_price: -Number(Number(couponDiscount || 0).toFixed(2)),
        gst_rate: 0,
      });
    }

    // Create the invoice for frontend/website orders. Use FRONTEND_ORDER so
    // these invoices are identifiable as website-origin and not treated as
    // separate manual work-order invoices.
    const taxInvoice = await createInvoiceRecord({
      conn: connection,
      leadId,
      items: invoiceItems,
      sourceType: 'FRONTEND_ORDER',
      sourceId: workOrderId,
      issueDate: new Date(),
      notes: finalOrderNotes,
      billingSnapshot,
      shippingSnapshot,
      // Website orders will be marked paid by webhook after payment verification
      status: 'issued',
    });

    const invoiceId = taxInvoice.id;
    const invoiceNumber = taxInvoice.invoice_number;

    // Ensure work_order totals reflect the invoice totals computed server-side
    try {
      const serverTotals = taxInvoice.totals || {};
      const serverGrand = Number(serverTotals.grand_total || 0);
      const serverSubtotal = Number(serverTotals.subtotal || 0);
      await connection.query(
        `UPDATE work_orders SET subtotal = ?, grand_total = ?, total_amount = ? WHERE id = ?`,
        [serverSubtotal, serverGrand, serverGrand, workOrderId]
      );
    } catch (e) {
      console.warn('[PublicOrder] failed to sync work_order totals to invoice totals', e && e.message ? e.message : e);
    }

    // ====================================
    // 6️⃣ INSERT WORK ORDER ITEMS (grouped for fusion boxes)
    // ====================================

    // Ensure a placeholder product exists for custom fusion boxes so the
    // `product_id` NOT NULL constraint is satisfied when there is no real
    // product row for a custom composite.
    // Auto-creation can be disabled by setting AUTO_CREATE_CUSTOM_FUSION_PRODUCT=false
    let fusionPlaceholderProductId = null;
    try {
      const [[existingFusionProd]] = await connection.query(
        `SELECT id FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1`,
        ['Custom Fusion Box']
      );
      if (existingFusionProd && existingFusionProd.id) {
        fusionPlaceholderProductId = Number(existingFusionProd.id);
      } else {
        const allowAuto = String(process.env.AUTO_CREATE_CUSTOM_FUSION_PRODUCT || 'true').toLowerCase();
        if (allowAuto === 'true') {
          const [ins] = await connection.query(
            `INSERT INTO products (name, selling_price, gst_rate, description, created_at) VALUES (?, ?, ?, ?, NOW())`,
            ['Custom Fusion Box', 0, 0, 'Auto-created placeholder for custom fusion boxes']
          );
          fusionPlaceholderProductId = Number(ins.insertId);
          console.info('Auto-created Custom Fusion Box product id', fusionPlaceholderProductId);
        } else {
          // Auto-creation disabled — instruct admin to create a placeholder product
          throw new Error('Custom Fusion Box product not found. Set AUTO_CREATE_CUSTOM_FUSION_PRODUCT=true to auto-create, or create a product named "Custom Fusion Box" in Products.');
        }
      }
    } catch (e) {
      console.warn('Could not ensure fusion placeholder product', e?.message || e);
      // rethrow so callers see the problem if auto-create is disabled
      if (String(process.env.AUTO_CREATE_CUSTOM_FUSION_PRODUCT || 'true').toLowerCase() === 'false') {
        throw e;
      }
      fusionPlaceholderProductId = null;
    }

    // Insert expanded work_order_items (atomic) so CRM/KOT have full product breakdown.
    // Insert expanded atomic work order items using the original (unscaled) values
    for (const [index, it] of originalComputedItems.entries()) {
      const sourceItem = items[it.originalIndex] || {};
      const dietaryForItem = dietaryPreferencesByIndex.get(it.originalIndex) || { jainCount: 0, swaminarayanCount: 0 };
      const dietaryLine =
        Number(dietaryForItem.jainCount || 0) + Number(dietaryForItem.swaminarayanCount || 0) > 0
          ? `Dietary: Jain ${Number(dietaryForItem.jainCount || 0)}, Swaminarayan ${Number(dietaryForItem.swaminarayanCount || 0)}`
          : '';
      const itemDescription = [it.description, dietaryLine].filter(Boolean).join('\n');

      const itemTaxAmount =
        Number(it.cgst_amount || 0) +
        Number(it.sgst_amount || 0) +
        Number(it.igst_amount || 0);

      const productIdToUse = it.product_id || fusionPlaceholderProductId;

      await connection.query(
        `
        INSERT INTO work_order_items
        (
          work_order_id,
          product_id,
          product_name,
          variant_id,
          variant_name,
          description,
          quantity,
          unit_price,
          discount,
          tax
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          workOrderId,
          productIdToUse,
          it.description || sourceItem.name || null,
          sourceItem.variant_id || null,
          sourceItem.variant_name || null,
          itemDescription,
          it.quantity,
          it.unit_price,
          0,
          itemTaxAmount
        ]
      );

      if (kotId) {
        // Prefer product HTML description for fusion/food-packages so KOT shows rich content
        const prodForKot = productIdToUse ? productMap.get(Number(productIdToUse)) : null;
        let kotProductName = it.description || sourceItem.name || 'Item';
        let kotProductDesc = dietaryLine || null;

        console.log('Resolving KOT description', { productIdToUse, category_slug: prodForKot?.category_slug, prodDescription: prodForKot?.description, sourceDescription: sourceItem.description, dietaryLine });
        console.log(prodForKot);
        
        if (prodForKot && prodForKot.category_slug) {
          const slug = String(prodForKot.category_slug || '').toLowerCase();
          if (slug.includes('fusion') || slug.includes('food') || slug.includes('food-packages')) {
            // Use raw product.description (may contain HTML) as KOT description
            kotProductDesc = prodForKot.description || kotProductDesc || null;
            // If product has a proper name prefer it for product_name
            kotProductName = prodForKot.name || kotProductName;
          }
        }

        await connection.query(
          `
          INSERT INTO kot_items
          (
            kot_id,
            product_id,
            product_name,
            product_description,
            quantity
          )
          VALUES (?, ?, ?, ?, ?)
          `,
          [
            kotId,
            productIdToUse,
            kotProductName,
            kotProductDesc,
            it.quantity
          ]
        );
      }
    }

    // If a coupon was applied, add a discount row to work_order_items so the
    // work order reflects the discount as an explicit line.
    try {
      if (appliedCouponId && Number(couponDiscount) > 0) {
        const couponDesc = couponCode ? `Coupon: ${String(couponCode).trim()}` : 'Coupon Discount';
        const discountProductId = fusionPlaceholderProductId || null;
        if (!discountProductId) {
          console.warn('[PublicOrder] no fusion placeholder product id available for inserting coupon discount row');
        } else {
          await connection.query(
            `
            INSERT INTO work_order_items
            (
              work_order_id,
              product_id,
              product_name,
              description,
              quantity,
              unit_price,
              discount,
              tax
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              workOrderId,
              discountProductId,
              couponDesc,
              couponDesc,
              1,
              0,
              Number(couponDiscount || 0),
              0,
            ]
          );
        }
      }
    } catch (e) {
      console.warn('[PublicOrder] failed to insert work_order_items discount row', e && e.message ? e.message : e);
    }

    // Record coupon usage if a coupon was applied (use customers.id)
    try {
      if (appliedCouponId) {
        console.info('[PublicOrder] recording coupon usage', { appliedCouponId, couponDiscount, couponCode, customerId, workOrderId });
        const usageResult = await recordCouponUsage(appliedCouponId, customerId || null, workOrderId, connection);
        console.info('[PublicOrder] recordCouponUsage result', { usageResult });
      }
    } catch (e) {
      console.error('Failed to record coupon usage:', e && e.message ? e.message : e);
      // proceed — coupon usage recording failure should not block order creation
    }

    await connection.commit();

    // Create admin notifications for the newly created work order so connected
    // clients receive real-time alerts via socketService.emitNotification.
    try {
      const notifierId = await getSystemNotifierUserId(connection);
      const adminIds = await getAdminUserIds(connection);
      await createNotificationsForUsers({
        byUserId: notifierId,
        toUserIds: adminIds,
        module: 'work_orders',
        action: `Work Order Created - ${workOrderNumber || `#${workOrderId}`}`,
        sourceId: workOrderId,
        redirectUrl: `/workorders/${workOrderId}`,
        connection,
        skipSelf: true,
      });
      // If a KOT was created for this work order, notify KOT recipients too
      if (kotId) {
        try {
          await createNotificationsForUsers({
            byUserId: notifierId,
            toUserIds: adminIds,
            module: 'kot',
            action: `KOT Created - ${workOrderNumber || `#${kotId}`}`,
            sourceId: kotId,
            redirectUrl: `/kots/${kotId}`,
            connection,
            skipSelf: true,
          });
        } catch (e) {
          console.error('Failed to create/emit KOT notifications for public order:', e && e.message ? e.message : e);
        }
      }
    } catch (notifyErr) {
      console.error('Failed to create/emit notifications for public order:', notifyErr && notifyErr.message ? notifyErr.message : notifyErr);
    }

    // Do NOT dispatch invoice notifications here — wait for payment webhook to
    // verify payment and mark invoice as paid. The webhook will call
    // ensureTaxInvoiceForWorkOrder/dispatchInvoiceNotifications on successful capture.

    let razorpayOrder = null;
    if (isRazorpayEnabled()) {
      razorpayOrder = await createRazorpayOrder(
        Math.round(grandTotal * 100),
        `WO_${workOrderId}`,
        { work_order_id: workOrderId }
      );

      try {
        // Mark payment as 'paid' by default for website orders (gateway will confirm separately)
        await db.query(
          `
          INSERT INTO payments
          (
            work_order_id,
            invoice_id,
            provider,
            status,
            amount,
            amount_in_paise,
            currency,
            razorpay_order_id,
            razorpay_event,
            notes_json,
            webhook_payload
          )
          VALUES (?, ?, 'razorpay', 'paid', ?, ?, ?, ?, 'order.created', ?, ?)
          `,
          [
            workOrderId,
            invoiceId,
            Number(grandTotal.toFixed(2)),
            Math.round(Number(grandTotal || 0) * 100),
            razorpayOrder?.currency || 'INR',
            razorpayOrder?.id || null,
            JSON.stringify({ work_order_id: workOrderId }),
            JSON.stringify(razorpayOrder || {}),
          ]
        );
      } catch (paymentInsertError) {
        console.error('⚠️ PAYMENT INSERT ERROR:', paymentInsertError.message);
      }
    }

    return res.status(201).json({
      message: workOrderMode === 'CATERING'
        ? 'Order draft created. Payment confirmation will finalize notifications.'
        : 'Order draft created. Payment confirmation will finalize notifications.',
      work_order_id: workOrderId,
      kot_id: kotId,
      invoice_id: invoiceId,
      invoice_number: invoiceNumber,
      requested_fulfillment_at: requestedFulfillmentDisplay,
      coupon: appliedCouponId ? { id: appliedCouponId, discount: couponDiscount } : null,
      payable_total: Number(Number(grandTotal || 0).toFixed(2)),
      payable_total_in_paise: Math.round(Number(grandTotal || 0) * 100),
      razorpay: isRazorpayEnabled() && razorpayOrder
        ? {
          key: process.env.RAZORPAY_KEY_ID || '',
          order_id: razorpayOrder.id,
          amount: razorpayOrder.amount,
          currency: razorpayOrder.currency
        }
        : null
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('🔥 ORDER ERROR:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
};
