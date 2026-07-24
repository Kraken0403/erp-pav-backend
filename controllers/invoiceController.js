// controllers/invoiceController.js
const db = require('../config/db')
const { getTableColumns, buildInsertStatement } = require('../utils/dbSchema')
const {
  dispatchInvoiceNotifications,
  createInvoiceRecord,
  findInvoiceBySource,
  ensureTaxInvoiceForWorkOrder,
} = require('../services/invoiceLifecycleService')
const {
  generateInvoiceNumber,
  generateReceiptNumber,
  calculateGSTLine,
  computeInvoiceTotals,
  splitDocumentDiscountLines,
  applyDocumentDiscountToTotals,
  applyDiscountDisplayFields,
} = require('../utils/invoiceUtils')

/* ---------------------------------------------------------
   Load company settings (gst_pricing_mode + company_state etc.)
--------------------------------------------------------- */
async function getCompanySettings(conn) {
  const [[settings]] = await conn.query(`SELECT * FROM settings LIMIT 1`)
  return settings || {}
}

/* ---------------------------------------------------------
   Load invoice settings (numbering + prefix)
--------------------------------------------------------- */
async function getInvoiceSettings(conn) {
  const [[s]] = await conn.query(`SELECT * FROM invoice_settings LIMIT 1`)
  return (
    s || {
      prefix: 'INV',
      sequence_start: 1,
      number_format: '{prefix}/{year}/{seq}',
      numbering_mode: 'continuous',
      layout_option: 'minimal',
    }
  )
}

function toDateOnlyString(value) {
  if (!value) return null

  const raw = String(value).trim()
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (match) return match[1]

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseSnapshot(snapshot) {
  if (!snapshot) return null
  if (typeof snapshot === 'object') return snapshot

  try {
    return JSON.parse(snapshot)
  } catch {
    return null
  }
}

async function tableColumnExists(conn, tableName, columnName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  )
  return Number(rows?.[0]?.count || 0) > 0
}

/* ---------------------------------------------------------
   Get next sequence based on numbering_mode
   - continuous: max(invoice_sequence)+1 (global)
   - yearly: max sequence within year
   - monthly: max sequence within year+month
--------------------------------------------------------- */
async function getNextInvoiceSequence(conn, invSettings, now = new Date()) {
  const mode = invSettings.numbering_mode || 'continuous'
  const start = Number(invSettings.sequence_start || 1)

  if (mode === 'yearly') {
    const year = now.getFullYear()
    const [[row]] = await conn.query(
      `
      SELECT MAX(invoice_sequence) AS maxSeq
      FROM invoices
      WHERE YEAR(issue_date) = ?
      `,
      [year]
    )
    return row?.maxSeq ? Number(row.maxSeq) + 1 : start
  }

  if (mode === 'monthly') {
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const [[row]] = await conn.query(
      `
      SELECT MAX(invoice_sequence) AS maxSeq
      FROM invoices
      WHERE YEAR(issue_date) = ? AND MONTH(issue_date) = ?
      `,
      [year, month]
    )
    return row?.maxSeq ? Number(row.maxSeq) + 1 : start
  }

  // continuous
  const [[row]] = await conn.query(
    `SELECT MAX(invoice_sequence) AS maxSeq FROM invoices`
  )
  return row?.maxSeq ? Number(row.maxSeq) + 1 : start
}

/* ---------------------------------------------------------
   Load lead billing snapshot + shipping snapshot
--------------------------------------------------------- */
async function buildLeadSnapshots(conn, leadId) {
  if (!leadId) {
    return { billing: null, shipping: null, lead: null }
  }

  const [[lead]] = await conn.query(`SELECT * FROM leads WHERE id = ?`, [leadId])
  if (!lead) throw new Error('Lead not found')

  const billing = {
    name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
    company: lead.company_name || '',
    phone: lead.phone_number || '',
    email: lead.email || '',
    gst: lead.gst_number || '',

    address: lead.billing_address || '',
    landmark: lead.billing_landmark || '',
    city: lead.billing_city || '',
    state: lead.billing_state || '',
    pincode: lead.billing_pincode || '',
    country: 'India',
  }

  const shipping = {
    name: billing.name,
    company: billing.company,
    phone: billing.phone,
    email: billing.email,
    gst: billing.gst,

    address: lead.shipping_address || lead.billing_address || '',
    landmark: lead.shipping_landmark || lead.billing_landmark || '',
    city: lead.shipping_city || lead.billing_city || '',
    state: lead.shipping_state || lead.billing_state || '',
    pincode: lead.shipping_pincode || lead.billing_pincode || '',
    country: 'India',
  }

  return { billing, shipping, lead }
}

/* ---------------------------------------------------------
   Normalize items input
--------------------------------------------------------- */
function normalizeItems(items = []) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Invoice items are required')
  }

  return items.map(i => ({
    product_id: i.product_id ?? null,
    description: i.description ?? i.product_name ?? 'Item',
    quantity: Number(i.quantity || 0),
    unit_price: Number(i.unit_price || i.selling_price || 0),
    discount: Number(i.discount || 0),
    gst_rate: Number(i.gst_rate || 0),
  }))
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDiscountedLine({ quantity, unitPrice, discount }) {
  const qty = Math.max(0, toNumber(quantity, 0));
  const baseUnit = Math.max(0, toNumber(unitPrice, 0));
  const lineDiscount = Math.max(0, toNumber(discount, 0));

  if (!qty) {
    return {
      qty: 0,
      baseUnit,
      lineDiscount,
      effectiveUnit: 0,
      discountedBaseTotal: 0,
    };
  }

  const grossBaseTotal = qty * baseUnit;
  const discountedBaseTotal = Math.max(0, grossBaseTotal - lineDiscount);
  const effectiveUnit = discountedBaseTotal / qty;

  return {
    qty,
    baseUnit,
    lineDiscount,
    effectiveUnit,
    discountedBaseTotal,
  };
}

function normalizeSourceType(sourceType = 'MANUAL') {
  return String(sourceType || 'MANUAL').trim().toUpperCase();
}

function getDiscountPercentFromQuotation(row) {
  if (String(row?.quotation_discount_type || '').toUpperCase() !== 'PERCENT') {
    return null;
  }

  const percent = Number(row?.quotation_discount_value || 0);
  return percent > 0 ? percent : null;
}

async function getQuotationDiscountMeta(conn, quotationId) {
  const safeQuotationId = Number(quotationId || 0);
  if (!safeQuotationId) return { amount: 0, percent: null };

  const [[quotation]] = await conn.query(
    `SELECT quotation_discount_type, quotation_discount_value, quotation_discount_amount FROM quotations WHERE id = ? LIMIT 1`,
    [safeQuotationId]
  );

  return {
    amount: Math.max(0, Number(quotation?.quotation_discount_amount || 0)),
    percent: getDiscountPercentFromQuotation(quotation),
  };
}

async function resolveInvoiceDiscountMeta(invoice) {
  const sourceType = normalizeSourceType(invoice?.source_type);
  const sourceId = Number(invoice?.source_id || 0);

  if (!sourceId) return { amount: 0, percent: null };

  if (sourceType === 'QUOTATION' || sourceType === 'QUOTATION_PROFORMA') {
    return getQuotationDiscountMeta(db, sourceId);
  }

  if (sourceType === 'WORK_ORDER' || sourceType === 'WORK_ORDER_PROFORMA') {
    const [[workOrder]] = await db.query(
      `SELECT quotation_id FROM work_orders WHERE id = ? LIMIT 1`,
      [sourceId]
    );
    return getQuotationDiscountMeta(db, workOrder?.quotation_id);
  }

  if (sourceType.includes('PROFORMA')) {
    const [[proforma]] = await db.query(
      `SELECT source_type, source_id FROM proforma_invoices WHERE id = ? LIMIT 1`,
      [sourceId]
    );

    if (String(proforma?.source_type || '').toUpperCase().includes('QUOTATION')) {
      return getQuotationDiscountMeta(db, proforma?.source_id);
    }
  }

  return { amount: 0, percent: null };
}

async function findExistingInvoiceForSource(conn, sourceType, sourceId) {
  const normalizedType = normalizeSourceType(sourceType);
  const normalizedSourceId = Number(sourceId || 0);

  if (!normalizedSourceId) return null;

  if (normalizedType === 'WORK_ORDER') {
    const [[workOrder]] = await conn.query(
      `SELECT id, quotation_id FROM work_orders WHERE id = ? LIMIT 1`,
      [normalizedSourceId]
    );

    if (!workOrder) {
      throw new Error('Work order not found');
    }

    const [existing] = await conn.query(
      `
      SELECT id, invoice_number
      FROM invoices
      WHERE (source_type = 'WORK_ORDER' AND source_id = ?)
         OR (? IS NOT NULL AND source_type = 'QUOTATION' AND source_id = ?)
      LIMIT 1
      `,
      [normalizedSourceId, workOrder.quotation_id, workOrder.quotation_id]
    );

    return existing[0] || null;
  }

  if (normalizedType === 'QUOTATION') {
    const [existing] = await conn.query(
      `
      SELECT i.id, i.invoice_number
      FROM invoices i
      LEFT JOIN work_orders wo
        ON i.source_type = 'WORK_ORDER'
       AND i.source_id = wo.id
      WHERE (i.source_type = 'QUOTATION' AND i.source_id = ?)
         OR (wo.quotation_id = ?)
      LIMIT 1
      `,
      [normalizedSourceId, normalizedSourceId]
    );

    return existing[0] || null;
  }

  const [existing] = await conn.query(
    `SELECT id, invoice_number FROM invoices WHERE source_type = ? AND source_id = ? LIMIT 1`,
    [normalizedType, normalizedSourceId]
  );

  return existing[0] || null;
}

/* ---------------------------------------------------------
   Create invoice (MANUAL / FRONTEND_ORDER generic)
   POST /invoices
--------------------------------------------------------- */
const createInvoice = async (req, res) => {
  const {
    lead_id = null,
    items = [],
    source_type = 'MANUAL', // MANUAL | WORK_ORDER | FRONTEND_ORDER
    source_id = null,
    issue_date = null, // optional
    due_date = null,
    notes = null,
  } = req.body

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const normalizedSourceType = normalizeSourceType(source_type)

    if (source_id) {
      const existingInvoice = await findExistingInvoiceForSource(
        conn,
        normalizedSourceType,
        source_id
      )

      if (existingInvoice) {
        await conn.rollback()
        conn.release()
        return res.status(409).json({
          error: 'Invoice already exists for this source',
          id: existingInvoice.id,
          invoice_number: existingInvoice.invoice_number,
          already_existed: true,
        })
      }
    }

    const companySettings = await getCompanySettings(conn)
    const invSettings = await getInvoiceSettings(conn)

    const { billing, shipping, lead } = await buildLeadSnapshots(conn, lead_id)

    const gstPricingMode = companySettings?.gst_pricing_mode || 'EXCLUSIVE'
    const companyState = (companySettings?.company_state || '').trim()
    const billingState = (lead?.billing_state || '').trim()

    const isInterState =
      !!companyState &&
      !!billingState &&
      companyState.toLowerCase() !== billingState.toLowerCase()

    const normalized = normalizeItems(items)

    // compute per-line
    const computedItems = normalized.map(it => {
      const { qty, effectiveUnit, lineDiscount } = normalizeDiscountedLine({
        quantity: it.quantity,
        unitPrice: it.unit_price,
        discount: it.discount,
      })

      const calc = calculateGSTLine({
        quantity: qty,
        unitPrice: effectiveUnit,
        gstRate: it.gst_rate,
        pricingMode: gstPricingMode,
        isInterState,
      })

      return {
        ...it,
        quantity: qty,
        unit_price: effectiveUnit,
        line_discount: lineDiscount,
        ...calc,
      }
    })

    const totals = computeInvoiceTotals(computedItems)
    let documentDiscountAmount = 0
    if (normalizedSourceType === 'QUOTATION') {
      const quotationDiscount = await getQuotationDiscountMeta(conn, source_id)
      documentDiscountAmount = quotationDiscount.amount
    } else if (normalizedSourceType === 'WORK_ORDER') {
      const [[workOrder]] = await conn.query(
        `SELECT quotation_id, subtotal, total_amount, grand_total FROM work_orders WHERE id = ? LIMIT 1`,
        [source_id]
      )
      documentDiscountAmount = Math.max(
        0,
        Number(workOrder?.subtotal || 0) - Number(workOrder?.total_amount || workOrder?.grand_total || 0)
      )
      if (!documentDiscountAmount && workOrder?.quotation_id) {
        const quotationDiscount = await getQuotationDiscountMeta(conn, workOrder.quotation_id)
        documentDiscountAmount = quotationDiscount.amount
      }
    }

    const roundingAmount = Number(req.body.rounding_amount || 0)
    const discountedTotals = applyDocumentDiscountToTotals(totals, documentDiscountAmount, roundingAmount)

    const now = issue_date ? new Date(issue_date) : new Date()
    const nextSeq = await getNextInvoiceSequence(conn, invSettings, now)
    const invoiceNumber = generateInvoiceNumber(invSettings, nextSeq, now)

    // insert header. Keep schema-aware so older databases without rounding_amount do not crash.
    const invoiceColumns = await getTableColumns(conn, 'invoices')
    const headerInsert = buildInsertStatement('invoices', {
      invoice_number: invoiceNumber,
      invoice_sequence: nextSeq,
      source_type: normalizedSourceType,
      source_id,
      lead_id,
      issue_date: toDateOnlyString(now),
      due_date: toDateOnlyString(due_date),
      status: 'issued',
      billing_snapshot: billing ? JSON.stringify(billing) : null,
      shipping_snapshot: shipping ? JSON.stringify(shipping) : null,
      subtotal: totals.subtotal,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      grand_total: discountedTotals.grand_total,
      rounding_amount: roundingAmount,
      notes,
    }, invoiceColumns)
    const [header] = await conn.query(headerInsert.sql, headerInsert.values)

    const invoiceId = header.insertId

    // insert items
    for (const it of computedItems) {
      await conn.query(
        `
        INSERT INTO invoice_items
        (
          invoice_id,
          product_id,
          description,
          quantity,
          unit_price,
          gst_rate,
          taxable_amount,
          cgst_amount,
          sgst_amount,
          igst_amount,
          line_total
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          invoiceId,
          it.product_id,
          it.description,
          it.quantity,
          it.unit_price,
          it.gst_rate,
          it.taxable_amount,
          it.cgst_amount,
          it.sgst_amount,
          it.igst_amount,
          it.line_total,
        ]
      )
    }

    // If invoice was created from a quotation source, mark that quotation
    // as converted (only when source type is QUOTATION). Log result so we
    // can detect when the UPDATE doesn't affect any rows.
    try {
      if (normalizedSourceType === 'QUOTATION' && Number(source_id || 0)) {
        const [updateRes] = await conn.query(
          `UPDATE quotations SET status = 'converted', is_locked = 1 WHERE id = ? AND status = 'approved'`,
          [source_id]
        )
        if (!updateRes || !updateRes.affectedRows) {
          console.warn('[Invoice] quotation update affected 0 rows', { source_id })
        } else {
          console.info('[Invoice] marked quotation converted', { source_id })
        }
      }
    } catch (e) {
      // Don't block invoice creation on a non-critical update failure
      console.warn('Failed to mark quotation as converted:', e && e.message ? e.message : e)
    }

    await conn.commit()
    conn.release()

    return res.status(201).json({
      message: 'Invoice created',
      id: invoiceId,
      invoice_number: invoiceNumber,
      totals: discountedTotals,
    })
  } catch (err) {
    if (conn) {
      await conn.rollback()
      conn.release()
    }
    console.error('createInvoice error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   Create invoice from Work Order
   POST /invoices/from-workorder/:workOrderId
--------------------------------------------------------- */
const createInvoiceFromWorkOrder = async (req, res) => {
  const { workOrderId } = req.params

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const existing = await findInvoiceBySource(conn, 'WORK_ORDER_PROFORMA', workOrderId)

    const existingTax = await findInvoiceBySource(conn, 'WORK_ORDER', workOrderId)

    if (existing || existingTax) {
      const found = existing || existingTax
      await conn.commit()
      conn.release()
      return res.status(200).json({
        message: 'Proforma invoice already exists for this work order',
        id: found.id,
        invoice_number: found.invoice_number,
        already_existed: true,
      })
    }

    // load work order + lead_id
    const [[wo]] = await conn.query(
      `SELECT * FROM work_orders WHERE id = ?`,
      [workOrderId]
    )
    if (!wo) throw new Error('Work order not found')
    if (!wo.quotation_id) {
      // still ok, but lead_id should exist ideally
    }

    const leadId = wo.lead_id || null

    // load work order items
    const [woItems] = await conn.query(
      `SELECT * FROM work_order_items WHERE work_order_id = ? ORDER BY id ASC`,
      [workOrderId]
    )
    if (!woItems.length) throw new Error('Work order has no items')

    const companySettings = await getCompanySettings(conn)
    const invSettings = await getInvoiceSettings(conn)
    const { billing, shipping, lead } = await buildLeadSnapshots(conn, leadId)

    const gstPricingMode = companySettings?.gst_pricing_mode || 'EXCLUSIVE'
    const companyState = (companySettings?.company_state || '').trim()
    const billingState = (lead?.billing_state || '').trim()

    const isInterState =
      !!companyState &&
      !!billingState &&
      companyState.toLowerCase() !== billingState.toLowerCase()

    // IMPORTANT: Work order item unit_price already exists (your WO table uses unit_price)
    const normalized = woItems.map(i => ({
      product_id: i.product_id ?? null,
      description: i.product_name || i.description || 'Item',
      quantity: Number(i.quantity || 0),
      unit_price: Number(i.unit_price || 0),
      discount: Number(i.discount || 0),
      gst_rate: Number(i.gst_rate || 0), // if wo doesn't have gst_rate column, fallback from products below
    }))

    // If your work_order_items does NOT have gst_rate, pull from products:
    for (const it of normalized) {
      if (!it.gst_rate && it.product_id) {
        const [[p]] = await conn.query(
          `SELECT gst_rate FROM products WHERE id = ?`,
          [it.product_id]
        )
        it.gst_rate = Number(p?.gst_rate || 0)
      }
    }

    const computedItems = normalized.map(it => {
      const { qty, effectiveUnit, lineDiscount } = normalizeDiscountedLine({
        quantity: it.quantity,
        unitPrice: it.unit_price,
        discount: it.discount,
      });

      const calc = calculateGSTLine({
        quantity: qty,
        unitPrice: effectiveUnit,
        gstRate: it.gst_rate,
        pricingMode: gstPricingMode,
        isInterState,
      })
      return {
        ...it,
        quantity: qty,
        unit_price: effectiveUnit,
        line_discount: lineDiscount,
        ...calc,
      }
    })

    const totals = computeInvoiceTotals(computedItems)
    let documentDiscountAmount = Math.max(
      0,
      Number(wo.subtotal || 0) - Number(wo.total_amount || wo.grand_total || 0)
    )
    if (!documentDiscountAmount && wo.quotation_id) {
      const quotationDiscount = await getQuotationDiscountMeta(conn, wo.quotation_id)
      documentDiscountAmount = quotationDiscount.amount
    }
    const roundingAmount = Number(req.body?.rounding_amount || 0)
    const discountedTotals = applyDocumentDiscountToTotals(totals, documentDiscountAmount, roundingAmount)

    const now = new Date()
    const nextSeq = await getNextInvoiceSequence(conn, invSettings, now)
    const invoiceNumber = generateInvoiceNumber(invSettings, nextSeq, now, 'PI')

    const invoiceColumns = await getTableColumns(conn, 'invoices')
    const headerInsert = buildInsertStatement('invoices', {
      invoice_number: invoiceNumber,
      invoice_sequence: nextSeq,
      source_type: 'WORK_ORDER_PROFORMA',
      source_id: workOrderId,
      lead_id: leadId,
      issue_date: toDateOnlyString(now),
      status: 'issued',
      billing_snapshot: billing ? JSON.stringify(billing) : null,
      shipping_snapshot: shipping ? JSON.stringify(shipping) : null,
      subtotal: totals.subtotal,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      grand_total: discountedTotals.grand_total,
      rounding_amount: roundingAmount,
      notes: wo.notes || null,
    }, invoiceColumns)
    const [header] = await conn.query(headerInsert.sql, headerInsert.values)

    const invoiceId = header.insertId

    for (const it of computedItems) {
      await conn.query(
        `
        INSERT INTO invoice_items
        (
          invoice_id,
          product_id,
          description,
          quantity,
          unit_price,
          gst_rate,
          taxable_amount,
          cgst_amount,
          sgst_amount,
          igst_amount,
          line_total
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          invoiceId,
          it.product_id,
          it.description,
          it.quantity,
          it.unit_price,
          it.gst_rate,
          it.taxable_amount,
          it.cgst_amount,
          it.sgst_amount,
          it.igst_amount,
          it.line_total,
        ]
      )
    }

    await conn.commit()
    conn.release()

    try {
      await dispatchInvoiceNotifications(invoiceId, {
        sendEmail: true,
        sendWhatsApp: true,
      })
    } catch (notificationError) {
      console.error('Proforma invoice notification dispatch failed:', notificationError?.message || notificationError)
    }

    return res.status(201).json({
      message: 'Proforma invoice created from Work Order',
      id: invoiceId,
      invoice_number: invoiceNumber,
      totals: discountedTotals,
      already_existed: false,
    })
  } catch (err) {
    if (conn) {
      await conn.rollback()
      conn.release()
    }
    console.error('createInvoiceFromWorkOrder error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   Create proforma invoice from quotation
   POST /proforma-invoices/from-quotation/:quotationId
--------------------------------------------------------- */
const createProformaInvoiceFromQuotation = async (req, res) => {
  const { quotationId } = req.params
  const safeQuotationId = Number(quotationId || 0)

  console.info('[Proforma] create from quotation requested:', { quotationId: safeQuotationId })

  if (!safeQuotationId) {
    return res.status(400).json({ error: 'Invalid quotation id' })
  }

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    // Check existing proforma in the dedicated table first
    const [[existingRow]] = await conn.query(
      `SELECT id, proforma_number FROM proforma_invoices WHERE source_type = 'QUOTATION_PROFORMA' AND source_id = ? LIMIT 1`,
      [safeQuotationId]
    )

    if (existingRow) {
      await conn.commit()
      conn.release()
      return res.status(200).json({
        message: 'Proforma invoice already exists for this quotation',
        id: existingRow.id,
        proforma_number: existingRow.proforma_number,
        already_existed: true,
      })
    }

    // Prevent duplicates: if any invoice (tax or proforma) already exists
    // for this quotation (or linked work order), return early.
    try {
      const existingInvoice = await findExistingInvoiceForSource(conn, 'QUOTATION', safeQuotationId)
      if (existingInvoice) {
        await conn.commit()
        conn.release()
        return res.status(200).json({
          message: 'Invoice already exists for this quotation',
          id: existingInvoice.id,
          invoice_number: existingInvoice.invoice_number,
          already_existed: true,
        })
      }
    } catch (e) {
      // Non-fatal: proceed to proforma creation if the check fails unexpectedly
      console.warn('Failed to verify existing invoice for quotation before creating proforma:', e && e.message ? e.message : e)
    }

    const [[quotation]] = await conn.query(
      `SELECT * FROM quotations WHERE id = ? LIMIT 1`,
      [safeQuotationId]
    )

    if (!quotation) throw new Error('Quotation not found')

    const normalizedStatus = String(quotation.status || '').toLowerCase()
    console.info('[Proforma] quotation status:', { quotationId: safeQuotationId, status: normalizedStatus })
    // Allow creating a proforma from an approved or already-converted quotation.
    // Once a proforma is created we mark the quotation as 'converted' to prevent duplicate proforma creation.
    if (!(normalizedStatus === 'approved' || normalizedStatus === 'converted')) {
      throw new Error('Proforma can only be created from approved quotation')
    }

    const [quotationItems] = await conn.query(
      `SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY id ASC`,
      [safeQuotationId]
    )

    if (!quotationItems.length) {
      throw new Error('Quotation has no items')
    }

    console.info('[Proforma] quotation items found:', {
      quotationId: safeQuotationId,
      count: quotationItems.length,
    })

    const { billing, shipping } = await buildLeadSnapshots(conn, quotation.lead_id || null)

    // Normalize items from quotation snapshot
    const normalized = quotationItems.map((item) => ({
      product_id: item.product_id ?? null,
      description: item.product_name || 'Item',
      quantity: Number(item.quantity || 0),
      unit_price: Number(item.selling_price || item.unit_price || 0),
      discount: Number(item.discount || 0),
      gst_rate: Number(item.gst_rate || 0),
    }))

    // Fallback GST from products when quotation item GST is missing.
    for (const it of normalized) {
      if (!it.gst_rate && it.product_id) {
        const [[p]] = await conn.query(`SELECT gst_rate FROM products WHERE id = ? LIMIT 1`, [it.product_id])
        it.gst_rate = Number(p?.gst_rate || 0)
      }
    }

    // Compute GST lines and totals similar to proforma creation endpoint
    const companySettings = await getCompanySettings(conn)
    const gstPricingMode = companySettings?.gst_pricing_mode || 'EXCLUSIVE'
    const companyState = String(companySettings?.company_state || '').trim().toLowerCase()
    const billingState = String(billing?.state || '').trim().toLowerCase()
    const isInterState = Boolean(companyState && billingState && companyState !== billingState)

    const computedItems = normalized.map((it) => {
      const { qty, effectiveUnit, lineDiscount } = normalizeDiscountedLine({
        quantity: it.quantity,
        unitPrice: it.unit_price,
        discount: it.discount,
      })

      return {
        ...it,
        quantity: qty,
        unit_price: effectiveUnit,
        line_discount: lineDiscount,
        ...calculateGSTLine({
        quantity: qty,
        unitPrice: effectiveUnit,
        gstRate: it.gst_rate,
        pricingMode: gstPricingMode,
        isInterState,
      }),
      }
    })

    const quotationDiscountAmount = Math.max(0, Number(quotation.quotation_discount_amount || 0))
    const totals = computeInvoiceTotals(computedItems)

    // Numbering for proformas
    const invSettings = await getInvoiceSettings(conn)
    const now = new Date()
    const mode = invSettings.numbering_mode || 'continuous'
    const start = Number(invSettings.sequence_start || 1)
    let nextSeq = start
    if (mode === 'yearly') {
      const year = now.getFullYear()
      const [[row]] = await conn.query(`SELECT MAX(proforma_sequence) AS maxSeq FROM proforma_invoices WHERE YEAR(issue_date) = ?`, [year])
      nextSeq = row?.maxSeq ? Number(row.maxSeq) + 1 : start
    } else if (mode === 'monthly') {
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const [[row]] = await conn.query(`SELECT MAX(proforma_sequence) AS maxSeq FROM proforma_invoices WHERE YEAR(issue_date) = ? AND MONTH(issue_date) = ?`, [year, month])
      nextSeq = row?.maxSeq ? Number(row.maxSeq) + 1 : start
    } else {
      const [[row]] = await conn.query(`SELECT MAX(proforma_sequence) AS maxSeq FROM proforma_invoices`)
      nextSeq = row?.maxSeq ? Number(row.maxSeq) + 1 : start
    }

    const prefixOverride = invSettings.proforma_prefix || 'PI'
    const settingsForNumber = { ...invSettings, number_format: invSettings.proforma_number_format || invSettings.number_format }
    const proformaNumber = generateInvoiceNumber(settingsForNumber, nextSeq, now, prefixOverride)

    // Insert proforma header
    const roundingAmount = Number(req.body && req.body.rounding_amount ? req.body.rounding_amount : 0)
    const discountedTotals = applyDocumentDiscountToTotals(totals, quotationDiscountAmount, roundingAmount)

    const proformaColumns = await getTableColumns(conn, 'proforma_invoices')
    const headerInsert = buildInsertStatement('proforma_invoices', {
      proforma_number: proformaNumber,
      proforma_sequence: nextSeq,
      lead_id: quotation.lead_id || null,
      event_details: null,
      source_type: 'QUOTATION_PROFORMA',
      source_id: safeQuotationId,
      issue_date: toDateOnlyString(now),
      due_date: toDateOnlyString(quotation.valid_until),
      status: 'issued',
      subtotal: totals.subtotal,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      grand_total: discountedTotals.grand_total,
      rounding_amount: roundingAmount,
      notes: quotation.notes || null,
      billing_snapshot: billing ? JSON.stringify(billing) : null,
      shipping_snapshot: shipping ? JSON.stringify(shipping) : null,
      gst_pricing_mode: gstPricingMode,
    }, proformaColumns)
    const [header] = await conn.query(headerInsert.sql, headerInsert.values)

    const proformaId = header.insertId

    for (const it of computedItems) {
      await conn.query(
        `INSERT INTO proforma_items (proforma_id, product_id, description, quantity, unit_price, gst_rate, taxable_amount, cgst_amount, sgst_amount, igst_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          proformaId,
          it.product_id,
          it.description,
          it.quantity,
          it.unit_price,
          it.gst_rate,
          it.taxable_amount,
          it.cgst_amount,
          it.sgst_amount,
          it.igst_amount,
          it.line_total,
        ]
      )
    }

    // Mark quotation as converted and locked so another PI cannot be created.
    // Capture result and log so we can verify the DB change took place.
    try {
      const [updateResult] = await conn.query(`UPDATE quotations SET status = 'converted', is_locked = 1 WHERE id = ?`, [safeQuotationId])
      if (!updateResult || !updateResult.affectedRows) {
        console.warn('[Proforma] quotation update affected 0 rows', { quotationId: safeQuotationId })
      } else {
        console.info('[Proforma] quotation marked converted', { quotationId: safeQuotationId })
      }
    } catch (e) {
      console.warn('Failed to mark quotation converted after proforma creation:', e && e.message ? e.message : e)
    }

    // NOTE: quotation status transition to 'converted' is handled by the frontend
    // after successful proforma creation to avoid duplicate/racing updates.
    // Previous server-side conversion caused surprising status changes when
    // endpoints were invoked by different flows; keep server side passive here.

    await conn.commit()
    conn.release()

    console.info('[Proforma] created successfully:', {
      quotationId: safeQuotationId,
      proformaInvoiceId: proformaId,
      proformaNumber: proformaNumber,
    })

    return res.status(201).json({
      message: 'Proforma invoice created from quotation',
      id: proformaId,
      proforma_number: proformaNumber,
      totals: discountedTotals,
      already_existed: false,
    })
  } catch (err) {
    if (conn) {
      await conn.rollback()
      conn.release()
    }
    console.error('createProformaInvoiceFromQuotation error:', err)
    if (err?.message === 'Invalid quotation id') {
      return res.status(400).json({ error: err.message })
    }
    if (err?.message === 'Quotation not found') {
      return res.status(404).json({ error: err.message })
    }
    if (err?.message === 'Proforma can only be created from approved quotation' || err?.message === 'Quotation has no items') {
      return res.status(400).json({ error: err.message })
    }
    return res.status(500).json({ error: err.message || 'Failed to create proforma invoice from quotation' })
  }
}

/* ---------------------------------------------------------
   Create tax invoice from proforma invoice
   POST /proforma-invoices/:id/create-tax-invoice
--------------------------------------------------------- */
const createTaxInvoiceFromProforma = async (req, res) => {
  const { id } = req.params
  const proformaId = Number(id || 0)

  if (!proformaId) {
    return res.status(400).json({ error: 'Invalid proforma invoice id' })
  }

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    // Read proforma directly from the dedicated proforma_invoices table
    let proformaSourceTable = 'proforma_invoices'
    const [[proformaRow]] = await conn.query(`SELECT * FROM proforma_invoices WHERE id = ? LIMIT 1`, [proformaId])
    if (!proformaRow) throw new Error('Proforma invoice not found')

    const sourceType = String(proformaRow.source_type || '').toUpperCase()

    // Handle work order proforma: delegate to ensureTaxInvoiceForWorkOrder
    if (sourceType === 'WORK_ORDER_PROFORMA') {
      const workOrderId = proformaRow.source_id || proformaRow.sourceId || null
      const generated = await ensureTaxInvoiceForWorkOrder(workOrderId, conn)

      // Persist link back to proforma row so frontend can open tax invoice directly
      try {
        const taxId = generated?.invoice?.id || (generated?.invoice || generated?.id) || null
        if (taxId) {
          await conn.query(`UPDATE proforma_invoices SET tax_invoice_id = ?, tax_invoice_exists = 1 WHERE id = ?`, [taxId, proformaId])
        }
      } catch (e) {
        console.warn('Failed to update proforma_invoices with tax invoice link:', e && e.message ? e.message : e)
      }

      await conn.commit()
      conn.release()

      return res.status(generated?.created ? 201 : 200).json({
        message: generated?.created ? 'Tax invoice created from proforma' : 'Tax invoice already exists for this proforma',
        tax_invoice: generated?.invoice || null,
        already_existed: !generated?.created,
      })
    }

    // Handle different proforma source types:
    // - WORK_ORDER_PROFORMA: delegate to ensureTaxInvoiceForWorkOrder (handled above)
    // - QUOTATION_PROFORMA (or includes 'QUOTATION'): use quotation id to check duplicates
    // - MANUAL_PROFORMA / other PROFORMA: treat as generic proforma (create tax invoice linked to proforma id)

    const isQuotationSource = String(sourceType || '').includes('QUOTATION')
    let sourceId = 0
    if (isQuotationSource) {
      sourceId = Number(proformaRow.source_id || proformaRow.sourceId || 0)
      if (!sourceId) throw new Error('Proforma source is invalid')

      const existingTaxInvoice = await findInvoiceBySource(conn, 'QUOTATION', sourceId)
      if (existingTaxInvoice) {
        // Persist link back to proforma
        try {
          await conn.query(`UPDATE proforma_invoices SET tax_invoice_id = ?, tax_invoice_exists = 1 WHERE id = ?`, [existingTaxInvoice.id, proformaId])
        } catch (e) {
          console.warn('Failed to update proforma_invoices with existing tax invoice link:', e && e.message ? e.message : e)
        }

        await conn.commit()
        conn.release()
        return res.status(200).json({
          message: 'Tax invoice already exists for this proforma',
          tax_invoice: existingTaxInvoice,
          already_existed: true,
        })
      }
    }

    // Fetch proforma items depending on source table
    let proformaItems = []
    if (proformaSourceTable === 'invoices') {
      const [items] = await conn.query(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`, [proformaId])
      proformaItems = items
    } else {
      const [items] = await conn.query(`SELECT * FROM proforma_items WHERE proforma_id = ? ORDER BY id ASC`, [proformaId])
      proformaItems = items
    }

    if (!proformaItems.length) throw new Error('Proforma has no items')

    const splitProformaItems = splitDocumentDiscountLines(proformaItems)
    const positiveProformaItems = splitProformaItems.items
    if (!positiveProformaItems.length) throw new Error('Proforma has no billable items')

    let documentDiscountAmount = Number(splitProformaItems.discountAmount || 0)

    if (isQuotationSource && sourceId) {
      const quotationDiscount = await getQuotationDiscountMeta(conn, sourceId)
      documentDiscountAmount = quotationDiscount.amount || documentDiscountAmount
    }

    if (!documentDiscountAmount) {
      const preDiscountGrandTotal = positiveProformaItems.reduce(
        (sum, item) => sum + Number(item.line_total || 0),
        0
      )
      documentDiscountAmount = Math.max(
        0,
        Number(preDiscountGrandTotal || 0) +
          Number(proformaRow.rounding_amount || 0) -
          Number(proformaRow.grand_total || 0)
      )
    }

    const items = positiveProformaItems.map((item) => ({
      product_id: item.product_id ?? null,
      description: item.description || 'Item',
      quantity: Number(item.quantity || 0),
      unit_price: Number(item.unit_price || 0),
      gst_rate: Number(item.gst_rate || 0),
    }))

    // Decide invoice source type and id to avoid duplicates and keep traceability
    let invoiceSourceType = 'PROFORMA'
    let invoiceSourceId = proformaId

    if (String(sourceType || '').includes('QUOTATION')) {
      invoiceSourceType = 'QUOTATION'
      invoiceSourceId = sourceId
    }

    // Check existing tax invoice for the chosen source
    const existing = await findInvoiceBySource(conn, invoiceSourceType, invoiceSourceId)
    if (existing) {
      await conn.commit()
      conn.release()
      return res.status(200).json({
        message: 'Tax invoice already exists for this proforma',
        tax_invoice: existing,
        already_existed: true,
      })
    }

    const taxInvoice = await createInvoiceRecord({
      conn,
      leadId: proformaRow.lead_id || proformaRow.leadId || null,
      items,
      sourceType: invoiceSourceType,
      sourceId: invoiceSourceId,
      issueDate: new Date(),
      dueDate: proformaRow.due_date || proformaRow.dueDate || null,
      notes: proformaRow.notes || null,
      billingSnapshot: parseSnapshot(proformaRow.billing_snapshot),
      shippingSnapshot: parseSnapshot(proformaRow.shipping_snapshot),
      status: 'issued',
      roundingAmount: Number(proformaRow.rounding_amount || 0),
      documentDiscountAmount,
    })

    // Persist tax invoice link on the proforma row
    try {
      const taxId = taxInvoice?.id || taxInvoice?.invoice?.id || null
      if (taxId) {
        await conn.query(`UPDATE proforma_invoices SET tax_invoice_id = ?, tax_invoice_exists = 1 WHERE id = ?`, [taxId, proformaId])
      }
    } catch (e) {
      console.warn('Failed to update proforma_invoices with new tax invoice link:', e && e.message ? e.message : e)
    }

    await conn.commit()
    conn.release()

    return res.status(201).json({
      message: 'Tax invoice created from proforma',
      tax_invoice: taxInvoice,
      already_existed: false,
    })
  } catch (err) {
    if (conn) {
      await conn.rollback()
      conn.release()
    }
    console.error('createTaxInvoiceFromProforma error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   List invoices
   GET /invoices
--------------------------------------------------------- */
const getInvoices = async (req, res) => {
  try {
    const [invoices] = await db.query(
      `SELECT i.*, l.first_name, l.last_name, l.company_name
       FROM invoices i
       LEFT JOIN leads l ON l.id = i.lead_id
       WHERE UPPER(COALESCE(i.source_type, '')) NOT IN ('WORK_ORDER_PROFORMA', 'QUOTATION_PROFORMA', 'MANUAL_PROFORMA')
       ORDER BY i.id DESC`
    )
    const [allPayments] = await db.query(`SELECT * FROM invoice_payments`);

    // Attach payments and compute paid / balance / overdue flags per invoice
    const invoicesWithPayments = invoices.map(inv => {
      const invPayments = allPayments.filter(p => p.invoice_id === inv.id) || [];
      const payments = invPayments.map(p => ({
        recieptId: p.receipt_number,
        paymentType: p.payment_method,
        amount: Number(p.amount),
        paymentDate: p.payment_date,
        refNumber: p.reference_number,
        remark: p.notes
      }));

      // Compute paid amount (exclude payments with method 'OTHER' as previously used)
      const paid_amount = invPayments.reduce((sum, p) => {
        if (String(p.payment_method || '').toUpperCase() === 'OTHER') return sum
        return sum + Number(p.amount || 0)
      }, 0)

      const grand_total = Number(inv.grand_total || 0)
      const balance_due = Math.max(0, grand_total - paid_amount)

      // Determine overdue (due_date passed and still has positive balance)
      let is_overdue = false
      try {
        if (inv.due_date) {
          const d = new Date(inv.due_date)
          if (!Number.isNaN(d.getTime())) {
            const today = new Date()
            // compare date-only: if due_date < today (any time earlier than start of today)
            const dueDateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate())
            const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate())
            if (dueDateOnly < todayOnly && balance_due > 0) is_overdue = true
          }
        }
      } catch (e) {
        is_overdue = false
      }

      return {
        ...inv,
        payments,
        paid_amount,
        balance_due,
        is_overdue,
      }
    })

    return res.status(200).json(invoicesWithPayments)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   List proforma invoices
   GET /proforma-invoices
--------------------------------------------------------- */
const getProformaInvoices = async (req, res) => {
  try {
    // Read proformas from the dedicated proforma_invoices table.
    // Some live DBs may not have the optional tax link columns yet, so select
    // safe NULL/default aliases instead of crashing the list page.
    const hasTaxInvoiceId = await tableColumnExists(db, 'proforma_invoices', 'tax_invoice_id')
    const hasTaxInvoiceExists = await tableColumnExists(db, 'proforma_invoices', 'tax_invoice_exists')
    const taxInvoiceIdSelect = hasTaxInvoiceId ? 'p.tax_invoice_id' : 'NULL AS tax_invoice_id'
    const taxInvoiceExistsSelect = hasTaxInvoiceExists ? 'p.tax_invoice_exists' : '0 AS tax_invoice_exists'

    const [rows] = await db.query(
      `SELECT p.id, p.proforma_number AS invoice_number, p.proforma_sequence, p.issue_date, p.due_date, p.status, p.subtotal, p.cgst_total, p.sgst_total, p.igst_total, p.grand_total, p.notes, ${taxInvoiceIdSelect}, ${taxInvoiceExistsSelect}, p.source_type, p.source_id, l.first_name, l.last_name, l.company_name
       FROM proforma_invoices p
       LEFT JOIN leads l ON l.id = p.lead_id
       ORDER BY p.id DESC`
    )

    // Ensure tax link fields are present and fallback resolve when missing
    const enriched = []
    for (const r of rows) {
      const row = { ...r }
      row.tax_invoice_id = row.tax_invoice_id || null
      row.tax_invoice_exists = Boolean(row.tax_invoice_exists || 0)

      if (!row.tax_invoice_id) {
        try {
          // If proforma has a quotation source, try locating tax invoice by quotation id
          const srcType = String(row.source_type || '').toUpperCase()
          const srcId = Number(row.source_id || 0)

          let taxRow = null
          if (srcType.includes('QUOTATION') && srcId) {
            const [tRows] = await db.query(`SELECT id FROM invoices WHERE source_type = 'QUOTATION' AND source_id = ? LIMIT 1`, [srcId])
            taxRow = (tRows && tRows[0]) || null
          }

          if (!taxRow) {
            const [tRows2] = await db.query(`SELECT id FROM invoices WHERE source_type IN ('PROFORMA','PROFORMA_INVOICE','PROFORMA_INVOICE') AND source_id = ? LIMIT 1`, [row.id])
            taxRow = (tRows2 && tRows2[0]) || null
          }

          row.tax_invoice_id = taxRow ? taxRow.id : null
          row.tax_invoice_exists = Boolean(row.tax_invoice_id)
        } catch (e) {
          // don't block response on lookup errors
          console.warn('Proforma tax invoice lookup failed (list):', e && e.message ? e.message : e)
        }
      }

      enriched.push(row)
    }

    return res.status(200).json(enriched)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   Get proforma invoice by id
   GET /proforma-invoices/:id
--------------------------------------------------------- */
const getProformaInvoiceById = async (req, res) => {
  const { id } = req.params

  try {
    // Read proforma directly from the dedicated proforma_invoices table
    const [pRows] = await db.query(
      `SELECT p.*, l.first_name, l.last_name, l.email, l.phone_number AS phone
       FROM proforma_invoices p
       LEFT JOIN leads l ON l.id = p.lead_id
       WHERE p.id = ? LIMIT 1`,
      [id]
    )

    if (!pRows.length) return res.status(404).json({ error: 'Proforma invoice not found' })

    const p = pRows[0]
    // Normalize field names to match invoices shape expected by frontend
    const invoice = {
      id: p.id,
      invoice_number: p.proforma_number || p.invoice_number || null,
      proforma_number: p.proforma_number,
      proforma_sequence: p.proforma_sequence,
      issue_date: p.issue_date,
      due_date: p.due_date,
      status: p.status,
      subtotal: p.subtotal,
      cgst_total: p.cgst_total,
      sgst_total: p.sgst_total,
      igst_total: p.igst_total,
      grand_total: p.grand_total,
      notes: p.notes,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      phone: p.phone,
      lead_id: p.lead_id,
      source_type: p.source_type,
      source_id: p.source_id,
      lead: {
        id: p.lead_id,
        first_name: p.first_name,
        last_name: p.last_name,
        email: p.email,
        phone: p.phone,
      },
      billing_snapshot: null,
      shipping_snapshot: null,
      tax_invoice_id: p.tax_invoice_id || null,
      tax_invoice_exists: Boolean(p.tax_invoice_exists || 0),
    }

    try { invoice.billing_snapshot = typeof p.billing_snapshot === 'string' ? JSON.parse(p.billing_snapshot) : p.billing_snapshot } catch { }
    try { invoice.shipping_snapshot = typeof p.shipping_snapshot === 'string' ? JSON.parse(p.shipping_snapshot) : p.shipping_snapshot } catch { }

    // Fallback: if proforma table doesn't have tax link columns, try to resolve tax invoice by source references
    try {
      if (!invoice.tax_invoice_id) {
        // If proforma has a quotation source, try locating tax invoice by quotation id
        const srcType = String(p.source_type || '').toUpperCase()
        const srcId = Number(p.source_id || p.sourceId || 0)

        let taxRow = null
        if (srcType.includes('QUOTATION') && srcId) {
          const [tRows] = await db.query(`SELECT id FROM invoices WHERE source_type = 'QUOTATION' AND source_id = ? LIMIT 1`, [srcId])
          taxRow = (tRows && tRows[0]) || null
        }

        if (!taxRow) {
          const [tRows2] = await db.query(`SELECT id FROM invoices WHERE source_type IN ('PROFORMA','PROFORMA_INVOICE','PROFORMA_INVOICE') AND source_id = ? LIMIT 1`, [p.id])
          taxRow = (tRows2 && tRows2[0]) || null
        }

        invoice.tax_invoice_id = taxRow ? taxRow.id : null
        invoice.tax_invoice_exists = Boolean(invoice.tax_invoice_id)
      }
    } catch (e) {
      // don't block response on fallback lookup errors
      console.warn('Proforma tax invoice lookup failed:', e && e.message ? e.message : e)
    }

    const [pItems] = await db.query(`SELECT * FROM proforma_items WHERE proforma_id = ? ORDER BY id ASC`, [id])
    const allItems = Array.isArray(pItems) ? pItems : []
    let discountMeta = { amount: 0, percent: null }
    const srcType = String(p.source_type || '').toUpperCase()
    const srcId = Number(p.source_id || p.sourceId || 0)
    if (srcType.includes('QUOTATION') && srcId) {
      discountMeta = await getQuotationDiscountMeta(db, srcId)
    }
    const display = applyDiscountDisplayFields(invoice, allItems, discountMeta)
    Object.assign(invoice, display.document)
    invoice.items = display.items

    return res.status(200).json(invoice)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   Get invoice by id (with items)
   GET /invoices/:id
--------------------------------------------------------- */
const getInvoiceById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT i.*, l.first_name, l.last_name, l.email, l.phone_number AS phone 
             FROM invoices i LEFT JOIN leads l ON i.lead_id = l.id WHERE i.id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Invoice not found" });
    const invoice = rows[0];

    try { invoice.billing_snapshot = typeof invoice.billing_snapshot === "string" ? JSON.parse(invoice.billing_snapshot) : invoice.billing_snapshot; } catch { }
    try { invoice.shipping_snapshot = typeof invoice.shipping_snapshot === "string" ? JSON.parse(invoice.shipping_snapshot) : invoice.shipping_snapshot; } catch { }

    const [items] = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`, [id]);
    const allItems = Array.isArray(items) ? items : [];

    // Compute discount and prepare display values.
    try {
      const discountMeta = await resolveInvoiceDiscountMeta(invoice);
      const display = applyDiscountDisplayFields(invoice, allItems, discountMeta);
      Object.assign(invoice, display.document);
      invoice.items = display.items;
    } catch (e) {
      console.warn('getInvoiceById: failed to compute display totals', e && e.message ? e.message : e);
      invoice.display_taxable_subtotal = Number(invoice.subtotal || 0);
      invoice._computed_discount = 0;
      invoice.discount = 0;
      invoice.discount_percent = null;
      invoice.taxes = Number(invoice.cgst_total || 0) + Number(invoice.sgst_total || 0) + Number(invoice.igst_total || 0);
      invoice.items = allItems.filter(it => Number(it.line_total || 0) >= 0);
    }

    const [payments] = await db.query(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date ASC`, [id]);
    invoice.payments = payments.map(p => ({
      recieptId: p.receipt_number,
      paymentType: p.payment_method,
      amount: Number(p.amount),
      paymentDate: p.payment_date,
      refNumber: p.reference_number,
      remark: p.notes
    }));

    return res.status(200).json(invoice);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
/* ---------------------------------------------------------
   Update invoice status
   PUT /invoices/:id/status
--------------------------------------------------------- */
const updateInvoiceStatus = async (req, res) => {
  const { id } = req.params
  const { status } = req.body

  const allowed = ['draft', 'issued', 'part-payment', 'paid', 'cancelled']
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }

  try {
    const [result] = await db.query(`UPDATE invoices SET status = ? WHERE id = ?`, [status, id])
    if (!result.affectedRows) return res.status(404).json({ error: 'Invoice not found' })
    return res.status(200).json({ message: 'Invoice status updated', status })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
/* ---------------------------------------------------------
   Get next receipt sequence (mirrors getNextInvoiceSequence)
--------------------------------------------------------- */
async function getNextReceiptSequence(conn, invSettings) {
  const mode = invSettings.receipt_numbering_mode || 'continuous'
  const start = Number(invSettings.receipt_sequence_start || invSettings.sequence_start || 1)
  const now = new Date()

  if (mode === 'yearly') {
    const year = now.getFullYear()
    const [[row]] = await conn.query(
      `SELECT MAX(receipt_sequence) AS maxSeq FROM invoice_payments WHERE YEAR(payment_date) = ?`,
      [year]
    )
    return row?.maxSeq ? Number(row.maxSeq) + 1 : start
  }

  if (mode === 'monthly') {
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const [[row]] = await conn.query(
      `SELECT MAX(receipt_sequence) AS maxSeq FROM invoice_payments WHERE YEAR(payment_date) = ? AND MONTH(payment_date) = ?`,
      [year, month]
    )
    return row?.maxSeq ? Number(row.maxSeq) + 1 : start
  }

  // continuous
  const [[row]] = await conn.query(
    `SELECT MAX(receipt_sequence) AS maxSeq FROM invoice_payments`
  )
  return row?.maxSeq ? Number(row.maxSeq) + 1 : start
}

const addInvoicePayment = async (req, res) => {
  const { id: invoiceId } = req.params;
  const paymentsArray = req.body.payments || [];
  if (paymentsArray.length === 0) return res.status(400).json({ error: "No payment data provided" });

  const newPayment = paymentsArray[paymentsArray.length - 1];
  const { paymentType, amount, paymentDate, refNumber, remark } = newPayment;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [[invoice]] = await conn.query(`SELECT id, source_type, source_id, grand_total, status FROM invoices WHERE id = ?`, [invoiceId]);
    if (!invoice) throw new Error('Invoice not found');

    // Generate receipt number like invoice numbers
    const invSettings = await getInvoiceSettings(conn);
    const nextSeq = await getNextReceiptSequence(conn, invSettings);
    const receiptNumber = generateReceiptNumber(invSettings, nextSeq);

    await conn.query(
      `INSERT INTO invoice_payments (invoice_id, receipt_number, receipt_sequence, amount, payment_date, payment_method, reference_number, notes) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId, receiptNumber, nextSeq, amount || 0,
        paymentDate ? new Date(paymentDate) : new Date(),
        paymentType || 'OTHER', refNumber || null, remark || null
      ]
    );

    const [allPayments] = await conn.query(`SELECT * FROM invoice_payments WHERE invoice_id = ?`, [invoiceId]);

    const totalPaid = allPayments.reduce((sum, p) => {
      if (p.payment_method.toUpperCase() === 'OTHER') return sum;
      return sum + Number(p.amount);
    }, 0);

    const totalAmount = Number(invoice.grand_total);
    const hasOtherPayment = allPayments.some(p => p.payment_method.toUpperCase() === 'OTHER');

    let newStatus = invoice.status;
    if (hasOtherPayment || totalPaid >= totalAmount) {
      newStatus = 'paid';
    } else if (totalPaid > 0) {
      newStatus = 'part-payment';
    } else {
      newStatus = 'issued';
    }

    let generatedTaxInvoice = null;

    if (newStatus !== invoice.status) {
      await conn.query(`UPDATE invoices SET status = ? WHERE id = ?`, [newStatus, invoiceId]);

      if (newStatus === 'paid' && String(invoice.source_type || '').toUpperCase() === 'WORK_ORDER_PROFORMA') {
        generatedTaxInvoice = await ensureTaxInvoiceForWorkOrder(invoice.source_id, conn);

        if (generatedTaxInvoice?.created && generatedTaxInvoice?.invoice?.id) {
          try {
            await dispatchInvoiceNotifications(generatedTaxInvoice.invoice.id, {
              sendEmail: true,
              sendWhatsApp: true,
            });
          } catch (notificationError) {
            console.error('Tax invoice notification dispatch failed:', notificationError?.message || notificationError);
          }
        }
      }
    }

    await conn.commit();
    res.status(200).json({
      message: 'Payment recorded successfully',
      receiptNumber,
      status: newStatus,
      totalPaid,
      generated_tax_invoice: generatedTaxInvoice?.invoice || null,
      tax_invoice_created: Boolean(generatedTaxInvoice?.created),
    });
  } catch (err) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

const sendInvoiceEmailById = async (req, res) => {
  const { id } = req.params

  try {
    const sendResult = await dispatchInvoiceNotifications(id, {
      sendEmail: true,
      sendWhatsApp: false,
    })

    const accepted = Array.isArray(sendResult?.email?.accepted) ? sendResult.email.accepted : []
    const rejected = Array.isArray(sendResult?.email?.rejected) ? sendResult.email.rejected : []

    if (!accepted.length || rejected.length) {
      // Some or all recipients were rejected — return details for debugging
      return res.status(207).json({
        success: false,
        message: 'Some recipients were not accepted by the mail service',
        accepted,
        rejected,
      })
    }

    return res.json({
      success: true,
      message: `Invoice email sent successfully`,
      accepted,
    })
  } catch (err) {
    console.error('sendInvoiceEmailById error:', err)
    return res.status(500).json({ error: err.message || 'Failed to send invoice email' })
  }
}

const sendInvoiceWhatsAppById = async (req, res) => {
  const { id } = req.params

  try {
    const result = await dispatchInvoiceNotifications(id, {
      sendEmail: false,
      sendWhatsApp: true,
    })

    return res.json({
      success: true,
      message: `Invoice WhatsApp notification sent`,
      data: result.whatsapp,
    })
  } catch (err) {
    console.error('sendInvoiceWhatsAppById error:', err)
    return res.status(500).json({ error: err.message || 'Failed to send invoice WhatsApp notification' })
  }
}

const sendProformaEmailById = async (req, res) => {
  const { id } = req.params
  try {
    const [[pRow]] = await db.query(
      `SELECT p.*, l.first_name, l.last_name, l.email, l.phone_number AS phone
       FROM proforma_invoices p
       LEFT JOIN leads l ON l.id = p.lead_id
       WHERE p.id = ? LIMIT 1`,
      [id]
    )

    if (!pRow) return res.status(404).json({ error: 'Proforma invoice not found' })

    const [pItems] = await db.query(`SELECT description, quantity, unit_price, line_total FROM proforma_items WHERE proforma_id = ? ORDER BY id ASC`, [id])

    const pdfBuffer = await require('../services/invoicePdfService').generateProformaPdf(Number(id))

    const customerEmail = String(pRow.email || (pRow.billing_snapshot ? (() => { try { return JSON.parse(pRow.billing_snapshot).email } catch { return '' } })() : '') || '').trim()
    const customerName = `${pRow.first_name || ''} ${pRow.last_name || ''}`.trim() || (pRow.billing_snapshot ? (() => { try { return JSON.parse(pRow.billing_snapshot).name } catch { return null } })() : '') || 'Customer'

    const attachments = [
      {
        filename: `Proforma-${pRow.proforma_number || id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ]

    if (!customerEmail) return res.status(400).json({ error: 'Customer email not found' })

    await require('../services/brevoService').sendInvoiceEmail({
      customer_email: customerEmail,
      customer_name: customerName,
      invoice_number: pRow.proforma_number || `PI-${id}`,
      documentLabel: 'Proforma',
      invoice_details: { issue_date: pRow.issue_date, due_date: pRow.due_date, status: pRow.status, total_amount: pRow.grand_total },
      items: pItems || [],
      attachments,
    })

    return res.json({ success: true, message: 'Proforma email sent successfully' })
  } catch (err) {
    console.error('sendProformaEmailById error:', err)
    return res.status(500).json({ error: err.message || 'Failed to send proforma email' })
  }
}

const sendProformaWhatsAppById = async (req, res) => {
  const { id } = req.params
  try {
    const [[pRow]] = await db.query(
      `SELECT p.*, l.first_name, l.last_name, l.email, l.phone_number AS phone
       FROM proforma_invoices p
       LEFT JOIN leads l ON l.id = p.lead_id
       WHERE p.id = ? LIMIT 1`,
      [id]
    )

    if (!pRow) return res.status(404).json({ error: 'Proforma invoice not found' })

    const billing = (() => {
      try { return typeof pRow.billing_snapshot === 'string' ? JSON.parse(pRow.billing_snapshot) : pRow.billing_snapshot } catch { return {} }
    })()

    const customerPhoneRaw = pRow.phone || billing.phone || null
    const { normalizePhoneForWhatsApp, createInvoicePayload } = require('../utils/whatsappTemplatePayloads')
    const phone = normalizePhoneForWhatsApp(customerPhoneRaw)
    if (!phone) return res.status(400).json({ error: 'Customer phone not found' })

    const backendBaseUrl = String(process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '')
    const proformaPdfUrl = `${backendBaseUrl}/public/proforma-invoices/${id}/pdf`

    const payload = createInvoicePayload({
      phoneNumber: phone,
      customerName: `${pRow.first_name || ''} ${pRow.last_name || ''}`.trim() || billing.name || 'Customer',
      invoiceNumber: pRow.proforma_number || `PI-${id}`,
      issueDate: pRow.issue_date,
      status: pRow.status,
      totalAmount: pRow.grand_total,
      invoicePdfUrl: proformaPdfUrl,
      documentLabel: 'Proforma',
    })

    const result = await require('../services/whatsappNotfinoService').sendWhatsAppTemplateMessage(payload)

    return res.json({ success: true, message: 'Proforma WhatsApp sent', data: result })
  } catch (err) {
    console.error('sendProformaWhatsAppById error:', err)
    return res.status(500).json({ error: err.message || 'Failed to send proforma WhatsApp notification' })
  }
}

const sendReceiptEmailById = async (req, res) => {
  const { receiptId } = req.params
  try {
    const [[row]] = await db.query(
      `SELECT p.*, i.invoice_number, l.first_name, l.last_name, l.email, l.phone_number AS phone
       FROM invoice_payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN leads l ON l.id = i.lead_id
       WHERE p.receipt_number = ? LIMIT 1`,
      [receiptId]
    )

    if (!row) return res.status(404).json({ error: 'Receipt not found' })

    const pdfBuffer = await require('../services/invoicePdfService').generateReceiptPdf(String(receiptId))

    const customerEmail = String(row.email || (row.billing_snapshot ? (() => { try { return JSON.parse(row.billing_snapshot).email } catch { return '' } })() : '') || '').trim()
    const customerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || (row.billing_snapshot ? (() => { try { return JSON.parse(row.billing_snapshot).name } catch { return null } })() : '') || 'Customer'

    const attachments = [
      {
        filename: `Receipt-${receiptId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ]

    if (!customerEmail) return res.status(400).json({ error: 'Customer email not found' })

    await require('../services/brevoService').sendInvoiceEmail({
      customer_email: customerEmail,
      customer_name: customerName,
      invoice_number: receiptId,
      documentLabel: 'Receipt',
      invoice_details: { issue_date: row.paymentDate, total_amount: row.amount },
      items: [],
      attachments,
    })

    return res.json({ success: true, message: 'Receipt email sent successfully' })
  } catch (err) {
    console.error('sendReceiptEmailById error:', err)
    return res.status(500).json({ error: err.message || 'Failed to send receipt email' })
  }
}

const sendReceiptWhatsAppById = async (req, res) => {
  const { receiptId } = req.params
  try {
    const [[row]] = await db.query(
      `SELECT p.*, i.invoice_number, l.first_name, l.last_name, l.email, l.phone_number AS phone
       FROM invoice_payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN leads l ON l.id = i.lead_id
       WHERE p.receipt_number = ? LIMIT 1`,
      [receiptId]
    )

    if (!row) return res.status(404).json({ error: 'Receipt not found' })

    const billing = (() => {
      try { return typeof row.billing_snapshot === 'string' ? JSON.parse(row.billing_snapshot) : row.billing_snapshot } catch { return {} }
    })()

    const customerPhoneRaw = row.phone || billing.phone || null
    const { normalizePhoneForWhatsApp, createInvoicePayload } = require('../utils/whatsappTemplatePayloads')
    const phone = normalizePhoneForWhatsApp(customerPhoneRaw)
    if (!phone) return res.status(400).json({ error: 'Customer phone not found' })

    const backendBaseUrl = String(process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '')
    const receiptPdfUrl = `${backendBaseUrl}/public/documents/receipts/${receiptId}.pdf`

    const payload = createInvoicePayload({
      phoneNumber: phone,
      customerName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || billing.name || 'Customer',
      invoiceNumber: receiptId,
      issueDate: row.paymentDate,
      status: 'PAID',
      totalAmount: row.amount,
      invoicePdfUrl: receiptPdfUrl,
      documentLabel: 'Receipt'
    })

    const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService')
    const result = await sendWhatsAppTemplateMessage(payload)

    return res.json({ success: true, message: `Receipt WhatsApp notification sent`, data: result })
  } catch (err) {
    console.error('sendReceiptWhatsAppById error:', err)
    return res.status(500).json({ error: err.message || 'Failed to send receipt WhatsApp notification' })
  }
}

module.exports = {
  createInvoice,
  createInvoiceFromWorkOrder,
  createProformaInvoiceFromQuotation,
  createTaxInvoiceFromProforma,
  getInvoices,
  getProformaInvoices,
  getInvoiceById,
  getProformaInvoiceById,
  updateInvoiceStatus,
  addInvoicePayment,
  sendInvoiceEmailById,
  sendInvoiceWhatsAppById,
  sendProformaEmailById,
  sendProformaWhatsAppById,
  sendReceiptEmailById,
  sendReceiptWhatsAppById,
}
