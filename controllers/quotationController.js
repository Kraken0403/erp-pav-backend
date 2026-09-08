const db = require('../config/db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getRootQuotationId } = require('../utils/quotationUtils');
const { sendQuotationEmail } = require('../services/brevoService');
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService');
const {
  generatePdf: generateQuotationPdf,
  generateHtml: generateQuotationHtml,
} = require('../services/quotationPdfService');
const { _createWorkOrderForQuotation } = require('./workOrderController');
const { ensureKotForWorkOrder } = require('./kotController');
const { ensureVendorSchema, ensureQuotationShareSchema } = require('../utils/pavilionSchema');
const { getTableColumns, buildInsertStatement, buildUpdateParts } = require('../utils/dbSchema');
const { upsertCustomerFromLead } = require('../services/customerSyncService');
const { createNotificationsForUsers, getAdminUserIds, getSystemNotifierUserId } = require('../services/notificationService');
const {
  normalizePhoneForWhatsApp,
  createQuotationPayload,
} = require('../utils/whatsappTemplatePayloads');

const quotationEmailLocks = new Map();

const invokeJsonController = async (handler, request) => {
  let statusCode = 200;
  let payload = null;
  await handler(request, {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return data; },
  });
  if (statusCode >= 400) throw new Error(payload?.error || 'Document generation failed');
  return payload;
};

const createPublicQuotationLink = async (req, res) => {
  const { id } = req.params;
  const { accessCode, acceptanceEnabled = false, slug = '' } = req.body || {};
  try {
    await ensureQuotationShareSchema(db);
    const requestedSlug = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (requestedSlug && requestedSlug.length < 3) return res.status(400).json({ error: 'Client URL slug must be at least three characters' });
    let token = requestedSlug || crypto.randomBytes(24).toString('hex');
    if (requestedSlug) {
      const [[duplicate]] = await db.query('SELECT id FROM quotations WHERE public_token = ? AND id <> ? LIMIT 1', [token, id]);
      if (duplicate) return res.status(409).json({ error: 'That client URL is already in use. Choose another slug.' });
    }
    const code = String(accessCode || '');
    if (code && !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Access code must be six digits' });
    await db.query('UPDATE quotations SET public_token = ?, public_access_enabled = ?, public_access_code_hash = ?, public_access_code_display = ?, public_acceptance_enabled = ?, public_viewed_at = NULL WHERE id = ?', [token, code ? 1 : 0, code ? await bcrypt.hash(code, 10) : null, code || null, acceptanceEnabled ? 1 : 0, id]);
    return res.json({ token, publicUrl: `/public/quotations/${token}`, accessCodeRequired: Boolean(code) });
  } catch (err) { return res.status(500).json({ error: 'Failed to create public quotation link', details: err.message }); }
};

const getPublicQuotation = async (req, res) => {
  try {
    await ensureQuotationShareSchema(db);
    const [rows] = await db.query('SELECT id, quotation_number, quotation_date, valid_until, total_amount, total_amount AS grand_total, notes, status, company_id, public_access_enabled, public_acceptance_enabled, public_viewed_at, accepted_at FROM quotations WHERE public_token = ? LIMIT 1', [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'Quotation not found' });
    if (rows[0].public_access_enabled) return res.status(401).json({ accessCodeRequired: true });
    const [items] = await db.query(`SELECT id, product_name, quantity, selling_price, discount, gst_rate, hsn_sac FROM quotation_items WHERE quotation_id = ? ORDER BY id ASC`, [rows[0].id]);
    const renderedHtml = await generateQuotationHtml(rows[0].id);
    await db.query('UPDATE quotations SET public_viewed_at = COALESCE(public_viewed_at, NOW()) WHERE id = ?', [rows[0].id]);
    return res.json({ ...rows[0], public_viewed_at: rows[0].public_viewed_at || new Date(), items, rendered_html: renderedHtml });
  } catch (err) { return res.status(500).json({ error: 'Failed to load quotation' }); }
};

const verifyPublicQuotation = async (req, res) => {
  try {
    await ensureQuotationShareSchema(db);
    const [rows] = await db.query('SELECT id, public_access_code_hash FROM quotations WHERE public_token = ? LIMIT 1', [req.params.token]);
    if (!rows.length || !rows[0].public_access_code_hash || !(await bcrypt.compare(String(req.body?.accessCode || ''), rows[0].public_access_code_hash))) return res.status(401).json({ error: 'Invalid access code' });
    const [quotationRows] = await db.query('SELECT id, quotation_number, quotation_date, valid_until, total_amount, total_amount AS grand_total, notes, status, company_id, public_acceptance_enabled, public_viewed_at, accepted_at FROM quotations WHERE id = ? LIMIT 1', [rows[0].id]);
    const [items] = await db.query(`SELECT id, product_name, quantity, selling_price, discount, gst_rate, hsn_sac FROM quotation_items WHERE quotation_id = ? ORDER BY id ASC`, [rows[0].id]);
    const renderedHtml = await generateQuotationHtml(rows[0].id);
    await db.query('UPDATE quotations SET public_viewed_at = COALESCE(public_viewed_at, NOW()) WHERE id = ?', [rows[0].id]);
    return res.json({ verified: true, quotation: { ...quotationRows[0], public_viewed_at: quotationRows[0].public_viewed_at || new Date(), items, rendered_html: renderedHtml } });
  } catch (err) { return res.status(500).json({ error: 'Unable to verify access code' }); }
};

const acceptPublicQuotation = async (req, res) => {
  try {
    await ensureQuotationShareSchema(db);
    const [rows] = await db.query('SELECT id, lead_id, public_acceptance_enabled, public_access_enabled, public_access_code_hash, status FROM quotations WHERE public_token = ? LIMIT 1', [req.params.token]);
    if (!rows.length || !rows[0].public_acceptance_enabled) return res.status(404).json({ error: 'Quotation acceptance is unavailable' });
    if (rows[0].public_access_enabled && !(await bcrypt.compare(String(req.body?.accessCode || ''), rows[0].public_access_code_hash || ''))) {
      return res.status(401).json({ error: 'A valid six-digit access code is required' });
    }
    if (rows[0].status !== 'approved') {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const rootId = await getRootQuotationId(connection, rows[0].id);
        await connection.query(`UPDATE quotations SET status = 'rejected', is_locked = 1 WHERE id = ? OR parent_id = ?`, [rootId, rootId]);
        await connection.query("UPDATE quotations SET status = 'approved', accepted_at = NOW(), is_locked = 1 WHERE id = ?", [rows[0].id]);
        await upsertCustomerFromLead(connection, rows[0].lead_id, null);
        const workOrder = await _createWorkOrderForQuotation(connection, rows[0].id);
        await connection.commit();
        let proformaInvoice = null;
        try {
          const { createProformaInvoiceFromQuotation } = require('./invoiceController');
          proformaInvoice = await invokeJsonController(createProformaInvoiceFromQuotation, {
            params: { quotationId: rows[0].id },
            body: { notes: 'Automatically generated after client approval.' },
          });
        } catch (proformaError) {
          console.error('Client-approved quotation proforma generation failed:', proformaError.message);
        }
        return res.json({ accepted: true, workOrderId: workOrder?.id || null, proformaInvoiceId: proformaInvoice?.id || null });
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
    let proformaInvoice = null;
    try {
      const { createProformaInvoiceFromQuotation } = require('./invoiceController');
      proformaInvoice = await invokeJsonController(createProformaInvoiceFromQuotation, {
        params: { quotationId: rows[0].id },
        body: { notes: 'Automatically generated after client approval.' },
      });
    } catch (proformaError) {
      console.error('Approved quotation proforma generation failed:', proformaError.message);
    }
    return res.json({ accepted: true, proformaInvoiceId: proformaInvoice?.id || null });
  } catch (err) { return res.status(500).json({ error: 'Unable to accept quotation' }); }
};

const requestPublicQuotationClarification = async (req, res) => {
  const { customerName = '', customerEmail = '', message = '' } = req.body || {};
  if (!String(message).trim()) return res.status(400).json({ error: 'Please enter your question or clarification.' });
  try {
    await ensureQuotationShareSchema(db);
    const [[quotation]] = await db.query('SELECT id, quotation_number FROM quotations WHERE public_token = ? LIMIT 1', [req.params.token]);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    await db.query(
      'INSERT INTO quotation_clarifications (quotation_id, customer_name, customer_email, message) VALUES (?, ?, ?, ?)',
      [quotation.id, String(customerName).trim() || null, String(customerEmail).trim() || null, String(message).trim()]
    );
    try {
      const byUserId = await getSystemNotifierUserId(db);
      const toUserIds = await getAdminUserIds(db);
      if (byUserId && toUserIds.length) await createNotificationsForUsers({
        byUserId, toUserIds, module: 'quotations',
        action: `Clarification requested - ${quotation.quotation_number || `#${quotation.id}`}`,
        sourceId: quotation.id, redirectUrl: `/quotations/${quotation.id}`,
      });
    } catch (notificationError) {
      console.warn('Quotation clarification saved but notification failed:', notificationError.message);
    }
    return res.status(201).json({ success: true, message: 'Your clarification request has been sent.' });
  } catch (err) {
    return res.status(500).json({ error: 'Unable to send clarification request', details: err.message });
  }
};

// ---------------------------------------------------------
// Helper: Generate Quotation Number
// ---------------------------------------------------------
// Normalize incoming dates while preserving intended calendar day.
const toMySQLDate = (value) => {
  if (!value) return null;

  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}


async function buildQuotationEventSelect(alias = 'q') {
  const columns = await getTableColumns(db, 'quotations');
  const columnExpr = (modern, legacy, fallback = 'NULL') => {
    if (modern && columns.has(modern)) return `${alias}.${modern}`;
    if (legacy && columns.has(legacy)) return `${alias}.${legacy}`;
    return fallback;
  };

  return `
        ${columnExpr('event_name', null)} AS event_name,
        ${columnExpr('event_start_date', 'event_date')} AS event_date,
        ${columnExpr('event_start_time', 'event_time')} AS event_start_time,
        ${columnExpr('event_end_time', null)} AS event_end_time,
        ${columnExpr('event_location', null)} AS event_location,`;
}

function generateQuotationNumber(settings, sequence) {
  const year = new Date().getFullYear()
  const month = String(new Date().getMonth() + 1).padStart(2, '0')

  return settings.number_format
    .replace('{prefix}', settings.prefix)
    .replace('{year}', year)
    .replace('{month}', month)
    .replace('{seq}', String(sequence).padStart(4, '0'))
}

// ---------------------------------------------------------
// INSERT QUOTATION ITEMS (FULL SNAPSHOT)
// ---------------------------------------------------------

async function insertQuotationItemsSnapshot(connection, quotationId, items) {
  await ensureVendorSchema(connection);
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Invoice items are required')
  }

  for (const item of items) {
    const {
      product_id,
      variant_id = null,

      quantity,
      unit_price, // frontend sends unit_price
      discount = 0,
      gst_rate = 0,

      // optional overrides from frontend
      cost_price,
      cost_price_unit,
      cost_price_qty,
      cost_pricing_mode,
      cost_discount_percent,
    } = item

    const pid = Number(product_id || 0)
    const qty = Number(quantity || 0)
    const price = Number(unit_price || 0)
    const disc = Number(discount || 0)

    if (!pid) throw new Error('Invalid quotation item: product_id missing')
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid quotation item: quantity invalid')
    if (!Number.isFinite(price) || price < 0) throw new Error('Invalid quotation item: unit_price invalid')

    // 1) Fetch product snapshot (source of truth)
    const [[product]] = await connection.query(
      `
      SELECT
        p.name AS product_name,
        p.sku,
        p.cost_price,
        p.cost_price_unit,
        p.cost_price_qty,
        p.cost_pricing_mode,
        p.cost_discount_percent,
        p.vendor_id,
        p.gst_rate,
        p.hsn_sac
      FROM products p
      WHERE p.id = ?
      LIMIT 1
      `,
      [pid]
    )

    if (!product) throw new Error(`Product not found for product_id=${pid}`)

    // 2) Resolve cost fields (frontend override > product snapshot > fallback)
    const resolvedCostPrice = Number(
      (cost_price ?? product.cost_price ?? 0)
    )
    const resolvedCostPriceQty = Number(
      (cost_price_qty ?? product.cost_price_qty ?? 1)
    )
    const resolvedCostDiscountPercent = Number(
      (cost_discount_percent ?? product.cost_discount_percent ?? 0)
    )
    const resolvedCostPricingMode =
      (cost_pricing_mode ?? product.cost_pricing_mode ?? 'absolute')

    const resolvedCostPriceUnit =
      (cost_price_unit ?? product.cost_price_unit ?? 'unit')

    // 3) Resolve GST + HSN
    const resolvedGstRate = Number(product.gst_rate ?? gst_rate ?? 0)
    const resolvedHsn = product.hsn_sac ?? null

    // 4) Insert snapshot row
    // IMPORTANT: Do NOT insert `line_total` because it is STORED GENERATED in your table.
    await connection.query(
      `
      INSERT INTO quotation_items (
        quotation_id,
        product_id,
        variant_id,
        quantity,

        selling_price,
        selling_price_unit,
        selling_price_qty,

        discount,
        tax,

        gst_rate,
        hsn_sac,

        product_name,
        variant_sku,
        attributes_json,
        packaging_json,
        vendor_id,

        cost_price,
        cost_price_unit,
        cost_price_qty,
        cost_pricing_mode,
        cost_discount_percent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        quotationId,
        pid,
        variant_id,

        qty,

        price,
        'unit',
        1,

        Math.max(0, disc),
        0, // tax is separate column; keep 0 unless you use it

        resolvedGstRate,
        resolvedHsn,

        product.product_name || product.product_name === '' ? product.product_name : product.product_name, // safe
        product.sku ?? null,
        JSON.stringify(item.attributes_json ?? {}),
        JSON.stringify(item.packaging_json ?? {}),
        item.vendor_id || product.vendor_id || null,

        Number.isFinite(resolvedCostPrice) ? resolvedCostPrice : 0,
        resolvedCostPriceUnit,
        Number.isFinite(resolvedCostPriceQty) && resolvedCostPriceQty > 0 ? resolvedCostPriceQty : 1,
        resolvedCostPricingMode === 'percentage' ? 'percentage' : 'absolute',
        Number.isFinite(resolvedCostDiscountPercent) ? resolvedCostDiscountPercent : 0,
      ]
    )
  }
}



// ---------------------------------------------------------
// CREATE QUOTATION
// ---------------------------------------------------------
const createQuotation = async (req, res) => {
  const {
    lead_id,
    quotation_date,
    valid_until,
    notes,
    items,
    parent_id = null,

    pax = null,
    event_name = null,
    event_date = null,
    event_start_date = null,
    event_start_time = null,
    event_end_date = null,
    event_end_time = null,
    event_location = null,

    quotation_discount_type = null,
    quotation_discount_value = 0,
    company_id = null,
    quotation_template = null,
    quotation_type = null,
    cover_letter_html = null,
    terms_conditions_html = null,
    company_logo_url = null,
    payment_terms = null,
    line_columns = null,
    group_items_by_top_category = false,
    issuer_company_name = null,
    issuer_company_email = null,
    issuer_company_phone = null,
    issuer_company_address = null,
    issuer_company_gst_number = null,
    public_link_enabled = false,
    protected_link = false,
    access_code = '',
    acceptance_enabled = false,
    client_slug = ''
  } = req.body;
  const rounding_amount = req.body.rounding_amount || 0

  // Ensure legacy `event_time` (single-field) is ignored - use start/end fields instead
  if (Object.prototype.hasOwnProperty.call(req.body, 'event_time')) {
    delete req.body.event_time;
  }

  // If creating a new version (parent_id provided) and lead_id is empty
  // inherit lead_id from the root parent so clients don't have to resend it.
  let effectiveLeadId = lead_id;
  try {
    if (parent_id && (!effectiveLeadId || String(effectiveLeadId).trim() === '')) {
      const [[parentRow]] = await db.query(`SELECT lead_id FROM quotations WHERE id = ? LIMIT 1`, [parent_id]);
      if (parentRow && parentRow.lead_id) {
        effectiveLeadId = parentRow.lead_id;
      }
    }
  } catch (e) {
    console.warn('Failed to lookup parent quotation lead_id:', e && e.message ? e.message : e)
  }

  if (!effectiveLeadId || !quotation_date || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  let connection;

  try {
    connection = await db.getConnection();
    // Run schema compatibility work before opening the transaction: MySQL DDL
    // implicitly commits, which would otherwise break the quotation write.
    await ensureQuotationShareSchema(connection);

    let publicToken = null;
    let publicAccessCodeHash = null;
    const requestedSlug = String(client_slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const publicAccessCode = protected_link ? String(access_code || '') : '';
    if (public_link_enabled) {
      if (requestedSlug && requestedSlug.length < 3) {
        connection.release();
        return res.status(400).json({ error: 'Client URL slug must be at least three characters' });
      }
      if (publicAccessCode && !/^\d{6}$/.test(publicAccessCode)) {
        connection.release();
        return res.status(400).json({ error: 'Access code must be six digits' });
      }
      publicToken = requestedSlug || crypto.randomBytes(24).toString('hex');
      if (requestedSlug) {
        const [[duplicate]] = await connection.query('SELECT id FROM quotations WHERE public_token = ? LIMIT 1', [publicToken]);
        if (duplicate) {
          connection.release();
          return res.status(409).json({ error: 'That client URL is already in use. Choose another slug.' });
        }
      }
      publicAccessCodeHash = publicAccessCode ? await bcrypt.hash(publicAccessCode, 10) : null;
    }

    await connection.beginTransaction();
    await ensureVendorSchema(connection);

    /* ---------------------------
       FETCH SETTINGS
    --------------------------- */

    const [[quotationSettingsRow]] = await connection.query(
      `SELECT * FROM quotation_settings LIMIT 1`
    );

    const quotationSettings = {
      prefix: quotationSettingsRow?.prefix || 'QT',
      number_format:
        quotationSettingsRow?.number_format || '{prefix}-{year}-{month}-{seq}',
      sequence_start: Number(quotationSettingsRow?.sequence_start || 1),
    };

    const [[globalSettings]] = await connection.query(
      `SELECT * FROM settings LIMIT 1`
    );

    const businessType = globalSettings?.business_type || 'GENERAL';

    // Default to EXCLUSIVE like invoices/proformas when company setting is missing
    const gstPricingMode = (globalSettings?.gst_pricing_mode || 'EXCLUSIVE')
      .toUpperCase();

    /* ---------------------------
       DETERMINE QUOTATION MODE
    --------------------------- */

    let quotationMode = 'GENERAL';

    if (businessType === 'CATERING') {
      quotationMode = 'CATERING';
    }

    if (businessType === 'HYBRID') {
      quotationMode = pax && Number(pax) > 0 ? 'CATERING' : 'GENERAL';
    }

    if (quotationMode === 'CATERING' && (!pax || Number(pax) < 1)) {
      throw new Error('PAX required for catering quotation');
    }

    // ✅ VALIDATE: Sum of quantities must equal PAX in CATERING mode
    if (quotationMode === 'CATERING' && items && items.length > 0) {
      const totalQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      if (totalQty !== Number(pax)) {
        throw new Error(`Total quantity (${totalQty}) must equal PAX (${pax})`);
      }
    }

    /* ---------------------------
       SEQUENCE + VERSION
    --------------------------- */

    // Determine versioning when creating a new version (parent_id provided)
    let insertParentId = parent_id || null
    let versionToInsert = 1

    if (insertParentId) {
      // Ensure we use the root parent id for version grouping
      const rootId = await getRootQuotationId(connection, insertParentId)
      insertParentId = rootId

      const [[vrow]] = await connection.query(
        `SELECT MAX(version) AS maxV FROM quotations WHERE parent_id = ?`,
        [insertParentId]
      )

      versionToInsert = vrow?.maxV ? Number(vrow.maxV) + 1 : 2
      // When creating a new version, set quotation_date to today
      // so the version reflects the new creation date.
      const now = new Date()
      // override incoming quotation_date variable for insertion
      // eslint-disable-next-line no-param-reassign
      req.body.quotation_date = toMySQLDate(now)
    }

    const [[seqRow]] = await connection.query(
      `SELECT MAX(quotation_sequence) AS maxSeq FROM quotations`
    );

    const nextSeq = seqRow?.maxSeq
      ? seqRow.maxSeq + 1
      : quotationSettings.sequence_start;

    const quotation_number = generateQuotationNumber(
      quotationSettings,
      nextSeq
    );

    /* ---------------------------
       INSERT HEADER
       GENERAL quotations must not depend on catering/event columns.
       Keep this insert schema-aware because older Pavilion databases still
       have the legacy event_date/event_time columns while newer catering DBs
       may have event_start/end columns.
    --------------------------- */

    const quotationColumns = await getTableColumns(connection, 'quotations');
    const headerRow = {
      lead_id: effectiveLeadId,
      quotation_date: toMySQLDate(req.body.quotation_date || quotation_date),
      valid_until: toMySQLDate(valid_until),
      notes,
      status: 'pending',
      quotation_number,
      quotation_sequence: nextSeq,
      quotation_mode: quotationMode,
      quotation_discount_type,
      quotation_discount_value: Number(quotation_discount_value || 0),
      parent_id: insertParentId,
      version: versionToInsert,
      company_id: company_id || null,
      quotation_template,
      quotation_type,
      cover_letter_html,
      terms_conditions_html,
      company_logo_url,
      payment_terms,
      quotation_line_columns_json: JSON.stringify(Array.isArray(line_columns) ? line_columns : []),
      group_items_by_top_category: group_items_by_top_category ? 1 : 0,
      issuer_company_name,
      issuer_company_email,
      issuer_company_phone,
      issuer_company_address,
      issuer_company_gst_number,
      public_token: publicToken,
      public_access_enabled: publicToken && publicAccessCode ? 1 : 0,
      public_access_code_hash: publicToken ? publicAccessCodeHash : null,
      public_access_code_display: publicToken ? (publicAccessCode || null) : null,
      public_acceptance_enabled: publicToken && acceptance_enabled ? 1 : 0,
    };

    if (quotationMode === 'CATERING') {
      Object.assign(headerRow, {
        pax,
        event_name,
        event_location,
      });

      if (quotationColumns.has('event_start_date')) {
        headerRow.event_start_date = toMySQLDate(event_start_date || event_date);
      } else if (quotationColumns.has('event_date')) {
        headerRow.event_date = toMySQLDate(event_start_date || event_date);
      }

      if (quotationColumns.has('event_start_time')) {
        headerRow.event_start_time = event_start_time;
      } else if (quotationColumns.has('event_time')) {
        headerRow.event_time = event_start_time || req.body.event_time || null;
      }

      if (quotationColumns.has('event_end_date')) {
        headerRow.event_end_date = toMySQLDate(event_end_date);
      }

      if (quotationColumns.has('event_end_time')) {
        headerRow.event_end_time = event_end_time;
      }
    }

    const headerInsert = buildInsertStatement('quotations', headerRow, quotationColumns);
    const [header] = await connection.query(headerInsert.sql, headerInsert.values);

    /* ---------------------------
       INSERT ITEMS SNAPSHOT
    --------------------------- */

    await insertQuotationItemsSnapshot(
      connection,
      header.insertId,
      items
    );

    /* ---------------------------
       TOTAL CALCULATION
       ❌ REMOVED PAX MULTIPLICATION
       In CATERING mode, quantities should add up to PAX
       We don't multiply by PAX again
    --------------------------- */

    // Determine billing state to allow correct GST handling if needed
    let billingState = null
    try {
      const [[leadRow]] = await connection.query(`SELECT billing_state FROM leads WHERE id = ? LIMIT 1`, [effectiveLeadId])
      billingState = (leadRow?.billing_state || '').trim()
    } catch (e) {
      billingState = null
    }

    const [[totals]] = await connection.query(
      `
      SELECT
        1 AS paxFactor,

        IFNULL(SUM(qi.selling_price * qi.quantity),0) AS subtotal,

        IFNULL(SUM(
          LEAST(
            IFNULL(qi.discount, 0),
            GREATEST((qi.selling_price * qi.quantity), 0)
          )
        ),0) AS item_discount_total,

        IFNULL(SUM(
          GREATEST(
            (qi.selling_price * qi.quantity)
            -
            LEAST(
              IFNULL(qi.discount, 0),
              GREATEST((qi.selling_price * qi.quantity), 0)
            ),
            0
          )
        ),0) AS base_amount,

        IFNULL(SUM(
          CASE
            WHEN ? = 'INCLUSIVE'
            THEN
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
            ELSE
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              +
              (
                GREATEST(
                  (qi.selling_price * qi.quantity)
                  -
                  LEAST(
                    IFNULL(qi.discount, 0),
                    GREATEST((qi.selling_price * qi.quantity), 0)
                  ),
                  0
                )
                * (IFNULL(qi.gst_rate, 0) / 100)
              )
          END
        ),0) AS total_before_overall_discount,

        IFNULL(SUM(
          CASE
            WHEN ? = 'INCLUSIVE'
            THEN
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              * IFNULL(qi.gst_rate, 0)
              / (100 + IFNULL(qi.gst_rate, 0))
            ELSE
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              * (IFNULL(qi.gst_rate, 0) / 100)
          END
        ),0) AS total_tax
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      WHERE qi.quotation_id = ?
      `,
      [gstPricingMode, gstPricingMode, header.insertId]
    );

    const subtotal = Number(totals.subtotal || 0);
    const itemDiscountTotal = Number(totals.item_discount_total || 0);
    const baseAmount = Number(totals.base_amount || 0);
    const totalBeforeOverallDiscount = Number(totals.total_before_overall_discount || 0);
    const totalTax = Number(totals.total_tax || 0);

    let quotation_discount_amount = 0;

    if (quotation_discount_type === 'PERCENT') {
      quotation_discount_amount =
        (baseAmount * Number(quotation_discount_value)) / 100;
    }

    if (quotation_discount_type === 'FLAT') {
      quotation_discount_amount = Number(quotation_discount_value || 0);
    }

    quotation_discount_amount = Math.max(0, quotation_discount_amount);

    const total_discount =
      itemDiscountTotal + quotation_discount_amount;

    const total_amount =
      Math.max(0, totalBeforeOverallDiscount - quotation_discount_amount);

    const roundingAmount = Number(rounding_amount || 0)
    const finalTotalAmount = Number((total_amount || 0) + roundingAmount)

    const totalUpdate = buildUpdateParts({
      subtotal,
      total_discount,
      total_tax: totalTax,
      total_amount: finalTotalAmount,
      quotation_discount_amount,
      rounding_amount: roundingAmount,
    }, quotationColumns);

    totalUpdate.values.push(header.insertId);
    await connection.query(
      `UPDATE quotations SET ${totalUpdate.fields.join(', ')} WHERE id = ?`,
      totalUpdate.values
    );

    await connection.commit();
    connection.release();

    return res.status(201).json({
      id: header.insertId,
      quotationId: header.insertId,
      quotation_number,
      publicToken,
      publicUrl: publicToken ? `/public/quotations/${publicToken}` : '',
      accessCodeRequired: Boolean(publicToken && publicAccessCode),
      totals: {
        subtotal,
        total_discount,
        tax: totalTax,
        total: finalTotalAmount,
        rounding_amount: roundingAmount
      }
    });

  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }

    console.error('createQuotation error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ---------------------------------------------------------
// UPDATE QUOTATION
// ---------------------------------------------------------

const updateQuotation = async (req, res) => {
  const { id } = req.params;

  const {
    lead_id,
    quotation_date,
    valid_until,
    notes,
    pax,
    event_name,
    event_date,
    event_start_date,
    event_start_time,
    event_end_date,
    event_end_time,
    event_location,
    quotation_discount_type,
    quotation_discount_value
  } = req.body;

  // Ignore legacy `event_time` if provided by clients
  if (Object.prototype.hasOwnProperty.call(req.body, 'event_time')) {
    delete req.body.event_time;
  }

  const safeDate = (d) => toMySQLDate(d);

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [[existing]] = await connection.query(
      `SELECT * FROM quotations WHERE id = ?`,
      [id]
    );

    if (!existing) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: "Quotation not found" });
    }

    if (existing.is_locked) {
      await connection.rollback();
      connection.release();
      return res.status(403).json({
        error: "Locked quotations cannot be edited"
      });
    }

    /* ---------------------------
       UPDATE FIELDS
    --------------------------- */

    const quotationColumns = await getTableColumns(connection, 'quotations');
    const headerUpdate = {
      lead_id: lead_id !== undefined ? lead_id : undefined,
      quotation_date: quotation_date !== undefined ? safeDate(quotation_date) : undefined,
      valid_until: valid_until !== undefined ? safeDate(valid_until) : undefined,
      notes: notes !== undefined ? notes : undefined,
      quotation_discount_type: quotation_discount_type !== undefined ? quotation_discount_type : undefined,
      quotation_discount_value: quotation_discount_value !== undefined ? Number(quotation_discount_value) : undefined,
    };

    const isCateringQuotation = String(existing.quotation_mode || '').toUpperCase() === 'CATERING';
    if (isCateringQuotation) {
      Object.assign(headerUpdate, {
        pax: pax !== undefined ? pax : undefined,
        event_name: event_name !== undefined ? event_name : undefined,
        event_location: event_location !== undefined ? event_location : undefined,
      });

      const nextEventDate = event_start_date !== undefined ? event_start_date : event_date;
      if (nextEventDate !== undefined) {
        if (quotationColumns.has('event_start_date')) {
          headerUpdate.event_start_date = safeDate(nextEventDate);
        } else if (quotationColumns.has('event_date')) {
          headerUpdate.event_date = safeDate(nextEventDate);
        }
      }

      if (event_start_time !== undefined) {
        if (quotationColumns.has('event_start_time')) {
          headerUpdate.event_start_time = event_start_time;
        } else if (quotationColumns.has('event_time')) {
          headerUpdate.event_time = event_start_time;
        }
      }

      if (event_end_date !== undefined && quotationColumns.has('event_end_date')) {
        headerUpdate.event_end_date = safeDate(event_end_date);
      }

      if (event_end_time !== undefined && quotationColumns.has('event_end_time')) {
        headerUpdate.event_end_time = event_end_time;
      }
    }

    const { fields, values } = buildUpdateParts(headerUpdate, quotationColumns);

    if (fields.length > 0) {
      values.push(id);
      await connection.query(
        `UPDATE quotations SET ${fields.join(", ")} WHERE id = ?`,
        values
      );
    }

    /* ---------------------------
       RECALCULATE TOTALS
    --------------------------- */

    const [[globalSettings]] = await connection.query(`SELECT * FROM settings LIMIT 1`)
    const gstPricingMode = (globalSettings?.gst_pricing_mode || 'EXCLUSIVE').toUpperCase()

    const [[totals]] = await connection.query(
      `
      SELECT
        1 AS paxFactor,

        IFNULL(SUM(qi.selling_price * qi.quantity),0) AS subtotal,

        IFNULL(SUM(
          LEAST(
            IFNULL(qi.discount, 0),
            GREATEST((qi.selling_price * qi.quantity), 0)
          )
        ),0) AS item_discount_total,

        IFNULL(SUM(
          GREATEST(
            (qi.selling_price * qi.quantity)
            -
            LEAST(
              IFNULL(qi.discount, 0),
              GREATEST((qi.selling_price * qi.quantity), 0)
            ),
            0
          )
        ),0) AS base_amount,

        IFNULL(SUM(
          CASE
            WHEN ? = 'INCLUSIVE'
            THEN
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
            ELSE
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              +
              (
                GREATEST(
                  (qi.selling_price * qi.quantity)
                  -
                  LEAST(
                    IFNULL(qi.discount, 0),
                    GREATEST((qi.selling_price * qi.quantity), 0)
                  ),
                  0
                )
                * (IFNULL(qi.gst_rate, 0) / 100)
              )
          END
        ),0) AS total_before_overall_discount,

        IFNULL(SUM(
          CASE
            WHEN ? = 'INCLUSIVE'
            THEN
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              * IFNULL(qi.gst_rate, 0)
              / (100 + IFNULL(qi.gst_rate, 0))
            ELSE
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              * (IFNULL(qi.gst_rate, 0) / 100)
          END
        ),0) AS total_tax
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      WHERE qi.quotation_id = ?
      `,
      [gstPricingMode, gstPricingMode, id]
    );

    const subtotal = Number(totals.subtotal || 0);
    const itemDiscount = Number(totals.item_discount_total || 0);
    const baseAmount = Number(totals.base_amount || 0);
    const totalBeforeOverallDiscount = Number(totals.total_before_overall_discount || 0);
    const totalTax = Number(totals.total_tax || 0);

    const discountType =
      quotation_discount_type ?? existing.quotation_discount_type;

    const discountValue =
      Number(quotation_discount_value ?? existing.quotation_discount_value ?? 0);

    let quotationDiscountAmount = 0;

    if (discountType === 'PERCENT') {
      quotationDiscountAmount =
        (baseAmount * discountValue) / 100;
    }

    if (discountType === 'FLAT') {
      quotationDiscountAmount = discountValue;
    }

    quotationDiscountAmount = Math.max(0, quotationDiscountAmount);

    const totalDiscount =
      itemDiscount + quotationDiscountAmount;

    const totalAmount =
      Math.max(0, totalBeforeOverallDiscount - quotationDiscountAmount);

    const totalUpdate = buildUpdateParts({
      subtotal,
      total_discount: totalDiscount,
      total_tax: totalTax,
      total_amount: totalAmount,
      quotation_discount_amount: quotationDiscountAmount,
    }, quotationColumns);

    totalUpdate.values.push(id);
    await connection.query(
      `UPDATE quotations SET ${totalUpdate.fields.join(', ')} WHERE id = ?`,
      totalUpdate.values
    );

    await connection.commit();
    connection.release();

    return res.status(200).json({
      message: "Quotation updated successfully",
      totals: {
        subtotal,
        item_discount: itemDiscount,
        quotation_discount: quotationDiscountAmount,
        total_discount: totalDiscount,
        tax: totalTax,
        total: totalAmount
      }
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }

    console.error("updateQuotation failed:", error);
    return res.status(500).json({ error: error.message });
  }
};

// ---------------------------------------------------------
// OTHER METHODS (UNCHANGED LOGIC)
// ---------------------------------------------------------
const getQuotations = async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        q.*,
        l.first_name,
        l.last_name
      FROM quotations q
      LEFT JOIN leads l ON q.lead_id = l.id
      ORDER BY q.id DESC
      `
    );

    return res.json(rows);

  } catch (err) {
    console.error('getQuotations error:', err);
    return res.status(500).json({ error: err.message });
  }
};

const getQuotationById = async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT * FROM quotations WHERE id = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    const quotation = rows[0];

    // Keep the API response compatible with both legacy catering schemas
    // (event_date/event_time) and newer schemas (event_start_date/event_start_time).
    quotation.event_date = quotation.event_date || quotation.event_start_date || null;
    quotation.event_time = quotation.event_time || (
      quotation.event_start_time && quotation.event_end_time
        ? `${quotation.event_start_time} - ${quotation.event_end_time}`
        : (quotation.event_start_time || null)
    );

    const [items] = await db.query(
      `SELECT * FROM quotation_items WHERE quotation_id = ?`,
      [id]
    );

    quotation.items = items;

    const [workOrders] = await db.query(
      `SELECT id, work_order_number FROM work_orders WHERE quotation_id = ? ORDER BY id DESC`,
      [id]
    );
    const [invoices] = await db.query(
      `SELECT i.id, i.invoice_number, i.status, i.source_type
       FROM invoices i
       LEFT JOIN work_orders wo ON i.source_type = 'WORK_ORDER' AND i.source_id = wo.id
       WHERE (i.source_type = 'QUOTATION' AND i.source_id = ?) OR wo.quotation_id = ?
       ORDER BY i.id DESC`,
      [id, id]
    );
    const [proformaInvoices] = await db.query(
      `SELECT id, proforma_number, status, source_type
       FROM proforma_invoices
       WHERE source_type LIKE '%QUOTATION%' AND source_id = ?
       ORDER BY id DESC`,
      [id]
    );
    quotation.related_documents = { work_orders: workOrders, invoices, proforma_invoices: proformaInvoices };

    return res.json(quotation);

  } catch (err) {
    console.error('getQuotationById error:', err);
    return res.status(500).json({ error: err.message });
  }
};






// ---------------------------------------------------------
// DELETE QUOTATION
// ---------------------------------------------------------
const deleteQuotation = async (req, res) => {
  const { id } = req.params;

  let conn;

  try {
    // 1️⃣ Check if quotation exists + locked
    const [rows] = await db.query(
      `SELECT is_locked FROM quotations WHERE id = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    if (rows[0].is_locked) {
      return res.status(403).json({
        error: 'Approved quotations cannot be deleted'
      });
    }

    // 2️⃣ Start transaction
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 3️⃣ Delete items
    await conn.query(
      `DELETE FROM quotation_items WHERE quotation_id = ?`,
      [id]
    );

    // 4️⃣ Delete quotation
    await conn.query(
      `DELETE FROM quotations WHERE id = ?`,
      [id]
    );

    // 5️⃣ Commit
    await conn.commit();
    conn.release();

    return res.status(200).json({
      message: 'Quotation deleted successfully'
    });

  } catch (err) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }

    console.error('deleteQuotation error:', err);

    return res.status(500).json({
      error: err.message
    });
  }
};


// ---------------------------------------------------------
// UPDATE STATUS
// ---------------------------------------------------------
const updateQuotationStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const actorUserId = Number(req.user?.id || 0);

  let conn;

  try {
    conn = await db.getConnection();

    await conn.beginTransaction();

    let autoWorkOrder = null;

    const [rows] = await conn.query(
      `SELECT id, lead_id FROM quotations WHERE id = ?`,
      [id]
    );

    if (!rows.length) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: 'Quotation not found' });
    }

    if (status === 'approved') {
      const rootId = await getRootQuotationId(conn, id);

      await conn.query(
        `UPDATE quotations 
         SET status = 'rejected', is_locked = 1
         WHERE id = ? OR parent_id = ?`,
        [rootId, rootId]
      );

      await conn.query(
        `UPDATE quotations 
         SET status = 'approved', is_locked = 1
         WHERE id = ?`,
        [id]
      );

      try {
        await upsertCustomerFromLead(conn, rows[0]?.lead_id, actorUserId || null);
      } catch (customerSyncErr) {
        console.warn('Quotation approved but customer sync failed:', customerSyncErr && customerSyncErr.message ? customerSyncErr.message : customerSyncErr);
      }

      // Note: work order creation is an explicit action in the UI
      // (Create Work Order). Removing automatic WO creation here avoids
      // implicitly converting the quotation to 'converted' when merely
      // approving it.

      // Create a Work Order automatically on approval so downstream users
      // (sales / operations) receive the work order and notifications.
      try {
        if (typeof _createWorkOrderForQuotation === 'function') {
          const wo = await _createWorkOrderForQuotation(conn, id);
          if (wo) {
            autoWorkOrder = wo;
            // Send notifications for created WO (admins + assigned users)
            try {
              const actorUserIdForWo = actorUserId || await getSystemNotifierUserId(conn);
              if (Number.isInteger(actorUserIdForWo) && actorUserIdForWo > 0) {
                const adminUserIds = await getAdminUserIds(conn);
                await createNotificationsForUsers({
                  byUserId: actorUserIdForWo,
                  toUserIds: adminUserIds,
                  module: 'work_orders',
                  action: `Work Order Created - ${wo.work_order_number || `#${wo.id}`}`,
                  sourceId: wo.id,
                  redirectUrl: `/workorders/${wo.id}`,
                  connection: conn,
                });
              }
            
              // Attempt to create a KOT for the work order (if applicable)
              try {
                if (typeof ensureKotForWorkOrder === 'function') {
                  const kotResult = await ensureKotForWorkOrder({
                    connection: conn,
                    workOrderId: wo.id,
                    actorUserId: actorUserIdForWo,
                    createdBy: req.user?.id || null,
                  });

                  // expose kot info in the response via autoWorkOrder.kot
                  autoWorkOrder.kot = kotResult || null;
                }
              } catch (kotErr) {
                console.warn('Work order created but KOT generation failed:', kotErr && kotErr.message ? kotErr.message : kotErr);
              }

            } catch (notifErr) {
              console.warn('Work order created but notification failed:', notifErr && notifErr.message ? notifErr.message : notifErr);
            }
          }
        }
      } catch (woErr) {
        // If WO creation fails, continue — don't make quotation approval fail.
        console.error('Auto work order creation failed:', woErr && woErr.message ? woErr.message : woErr);
      }

    } else {
      await conn.query(
        `UPDATE quotations SET status = ? WHERE id = ?`,
        [status, id]
      );
    }

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      message: 'Status updated successfully',
      workOrder: autoWorkOrder
        ? {
          id: autoWorkOrder.id,
          work_order_number: autoWorkOrder.work_order_number,
          already_existed: !!autoWorkOrder.existing,
        }
        : null,
    });

  } catch (err) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }

    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

const sendQuotationEmailById = async (req, res) => {
  const { id } = req.params;
  const lockKey = String(id);

  if (quotationEmailLocks.has(lockKey)) {
    return res.status(429).json({ error: 'Email send already in progress for this quotation' });
  }

  quotationEmailLocks.set(lockKey, Date.now());

  try {
    const eventSelect = await buildQuotationEventSelect('q');
    const [rows] = await db.query(
      `
      SELECT
        q.id,
        q.quotation_number,
        q.quotation_mode,
        ${eventSelect}
        q.pax,
        q.total_amount,
        l.first_name,
        l.last_name,
        l.email
      FROM quotations q
      LEFT JOIN leads l ON q.lead_id = l.id
      WHERE q.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    const quotation = rows[0];
    // Compute a legacy `event_time` display value from start/end when templates expect it
    quotation.event_time = (quotation.event_start_time && quotation.event_end_time)
      ? `${quotation.event_start_time} - ${quotation.event_end_time}`
      : (quotation.event_start_time || '');
    const customerEmail = quotation.email;
    const customerName = `${quotation.first_name || ''} ${quotation.last_name || ''}`.trim() || 'Customer';

    if (!customerEmail) {
      return res.status(400).json({ error: 'Customer email not found for this quotation' });
    }

    const quotationPdfBuffer = await generateQuotationPdf(quotation.id);

    const [quotationItems] = await db.query(
      `
      SELECT
        product_name,
        quantity,
        selling_price,
        (quantity * selling_price) AS line_total
      FROM quotation_items
      WHERE quotation_id = ?
      ORDER BY id ASC
      `,
      [quotation.id]
    );

    const sendResult = await sendQuotationEmail({
      customer_email: customerEmail,
      customer_name: customerName,
      quotation_number: quotation.quotation_number,
      quotation_details: {
        quotation_mode: quotation.quotation_mode,
        event_name: quotation.event_name,
        event_date: quotation.event_date,
        event_time: quotation.event_time,
        event_location: quotation.event_location,
        pax: quotation.pax,
        total_amount: quotation.total_amount,
      },
      items: quotationItems || [],
      attachments: [
        {
          filename: `Quotation-${quotation.quotation_number || quotation.id}.pdf`,
          content: quotationPdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });

    const accepted = Array.isArray(sendResult?.accepted) ? sendResult.accepted : [];
    const rejected = Array.isArray(sendResult?.rejected) ? sendResult.rejected : [];

    if (!accepted.length || rejected.length) {
      return res.status(502).json({
        error: 'SMTP accepted/rejected mismatch while sending quotation email',
        accepted,
        rejected,
      });
    }

    return res.json({
      success: true,
      message: `Quotation email sent to ${customerEmail}`,
      accepted,
    });
  } catch (error) {
    console.error('sendQuotationEmailById error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send quotation email' });
  } finally {
    quotationEmailLocks.delete(lockKey);
  }
};

const sendQuotationWhatsAppById = async (req, res) => {
  const { id } = req.params;

  try {
    const eventSelect = await buildQuotationEventSelect('q');
    const [rows] = await db.query(
      `
      SELECT
        q.id,
        q.quotation_number,
        q.quotation_mode,
        ${eventSelect}
        q.pax,
        q.total_amount,
        l.first_name,
        l.last_name,
        l.phone_number
      FROM quotations q
      LEFT JOIN leads l ON q.lead_id = l.id
      WHERE q.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    const quotation = rows[0];
    // Compute legacy `event_time` for templates
    quotation.event_time = (quotation.event_start_time && quotation.event_end_time)
      ? `${quotation.event_start_time} - ${quotation.event_end_time}`
      : (quotation.event_start_time || '');
    const customerName = `${quotation.first_name || ''} ${quotation.last_name || ''}`.trim() || 'Customer';
    const customerPhone = normalizePhoneForWhatsApp(quotation.phone_number || null);

    if (!customerPhone) {
      return res.status(400).json({ error: 'Customer phone not found for this quotation' });
    }

    const backendBaseUrl = String(process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const quotationPdfUrl = `${backendBaseUrl}/public/documents/quotations/${quotation.id}.pdf`;

    const result = await sendWhatsAppTemplateMessage(
      createQuotationPayload({
        phoneNumber: customerPhone,
        customerName,
        quotationNumber: quotation.quotation_number || `QT-${quotation.id}`,
        quotationMode: quotation.quotation_mode,
        eventName: quotation.event_name,
        eventDate: quotation.event_date,
        eventTime: quotation.event_time,
        eventLocation: quotation.event_location,
        pax: quotation.pax,
        totalAmount: quotation.total_amount,
        quotationPdfUrl,
      })
    );

    return res.json({
      success: true,
      message: `Quotation WhatsApp sent to ${customerPhone}`,
      data: result,
    });
  } catch (error) {
    console.error('sendQuotationWhatsAppById error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send quotation WhatsApp' });
  }
};




// ---------------------------------------------------------
// UPDATE QUOTATION ITEMS (delete + reinsert + recalc total)
// ---------------------------------------------------------
const updateQuotationItems = async (req, res) => {
  const { id } = req.params
  const { items } = req.body

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items array is required' })
  }

  let connection
  try {
    connection = await db.getConnection()
    await connection.beginTransaction()

    // 1) safety
    const [[quotation]] = await connection.query(
      `SELECT status, is_locked, quotation_mode, pax, quotation_discount_type, quotation_discount_value
       FROM quotations WHERE id = ?`,
      [id]
    )
    if (!quotation) throw new Error('Quotation not found')
    if (quotation.is_locked) throw new Error('Locked quotations cannot be edited')

    // ✅ VALIDATE: Sum of quantities must equal PAX in CATERING mode
    if (quotation.quotation_mode === 'CATERING' && quotation.pax) {
      const totalQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      if (totalQty !== Number(quotation.pax)) {
        throw new Error(`Total quantity (${totalQty}) must equal PAX (${quotation.pax})`);
      }
    }

    // 2) settings
    const [[globalSettings]] = await connection.query(`SELECT * FROM settings LIMIT 1`)
    const gstPricingMode = (globalSettings?.gst_pricing_mode || 'EXCLUSIVE').toUpperCase()

    // 3) delete + insert items
    await connection.query(`DELETE FROM quotation_items WHERE quotation_id = ?`, [id])
    await insertQuotationItemsSnapshot(connection, id, items)

    // 4) totals
    const [[t]] = await connection.query(
      `
      SELECT
        1 AS paxFactor,

        IFNULL(SUM(qi.selling_price * qi.quantity), 0) AS subtotal,

        IFNULL(SUM(
          LEAST(
            IFNULL(qi.discount, 0),
            GREATEST((qi.selling_price * qi.quantity), 0)
          )
        ), 0) AS item_discount_total,

        IFNULL(SUM(
          GREATEST(
            (qi.selling_price * qi.quantity)
            -
            LEAST(
              IFNULL(qi.discount, 0),
              GREATEST((qi.selling_price * qi.quantity), 0)
            ),
            0
          )
        ), 0) AS base_amount,

        IFNULL(SUM(
          CASE
            WHEN ? = 'INCLUSIVE'
            THEN
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
            ELSE
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              +
              (
                GREATEST(
                  (qi.selling_price * qi.quantity)
                  -
                  LEAST(
                    IFNULL(qi.discount, 0),
                    GREATEST((qi.selling_price * qi.quantity), 0)
                  ),
                  0
                )
                * (IFNULL(qi.gst_rate, 0) / 100)
              )
          END
        ), 0) AS total_before_overall_discount,

        IFNULL(SUM(
          CASE
            WHEN ? = 'INCLUSIVE'
            THEN
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              * IFNULL(qi.gst_rate, 0)
              / (100 + IFNULL(qi.gst_rate, 0))
            ELSE
              GREATEST(
                (qi.selling_price * qi.quantity)
                -
                LEAST(
                  IFNULL(qi.discount, 0),
                  GREATEST((qi.selling_price * qi.quantity), 0)
                ),
                0
              )
              * (IFNULL(qi.gst_rate, 0) / 100)
          END
        ), 0) AS total_tax
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      WHERE qi.quotation_id = ?
      `,
      [gstPricingMode, gstPricingMode, id]
    )

    const subtotal = Number(t.subtotal || 0)
    const itemDiscountTotal = Number(t.item_discount_total || 0)
    const baseAmount = Number(t.base_amount || 0)
    const totalBeforeOverallDiscount = Number(t.total_before_overall_discount || 0)
    const totalTax = Number(t.total_tax || 0)

    // 5) quotation-level discount from header
    const discountType = quotation.quotation_discount_type
    const discountValue = Number(quotation.quotation_discount_value || 0)

    let quotation_discount_amount = 0
    if (discountType === 'PERCENT') {
      quotation_discount_amount = (baseAmount * discountValue) / 100
    } else if (discountType === 'FLAT') {
      quotation_discount_amount = discountValue
    }

    quotation_discount_amount = Math.max(0, quotation_discount_amount)

    const total_discount = itemDiscountTotal + quotation_discount_amount
    const total_amount = Math.max(0, totalBeforeOverallDiscount - quotation_discount_amount)

    // 6) update quotation header totals
    await connection.query(
      `
      UPDATE quotations
      SET
        subtotal = ?,
        total_discount = ?,
        total_tax = ?,
        total_amount = ?,
        quotation_discount_amount = ?
      WHERE id = ?
      `,
      [
        subtotal,
        total_discount,
        totalTax,
        total_amount,
        quotation_discount_amount,
        id
      ]
    )

    await connection.commit()
    connection.release()

    return res.status(200).json({
      message: 'Quotation items updated successfully',
      totals: {
        subtotal,
        item_discount_total: itemDiscountTotal,
        quotation_discount_amount,
        total_discount,
        total_tax: totalTax,
        total: total_amount
      }
    })
  } catch (error) {
    console.error('❌ updateQuotationItems failed:', error)
    if (connection) {
      await connection.rollback()
      connection.release()
    }
    return res.status(500).json({ error: error.message })
  }
}



module.exports = {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  deleteQuotation,
  updateQuotationStatus,
  updateQuotationItems,
  createPublicQuotationLink,
  getPublicQuotation,
  verifyPublicQuotation,
  acceptPublicQuotation,
  requestPublicQuotationClarification,
  sendQuotationEmailById,
  sendQuotationWhatsAppById
};
