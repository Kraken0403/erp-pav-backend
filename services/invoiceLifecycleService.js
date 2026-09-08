const db = require('../config/db')
const { getTableColumns, buildInsertStatement } = require('../utils/dbSchema')
const { sendInvoiceEmail } = require('./brevoService')
const { sendWhatsAppTemplateMessage } = require('./whatsappNotfinoService')
const { generatePdf: generateInvoicePdf } = require('./invoicePdfService')
const {
  normalizePhoneForWhatsApp,
  createInvoicePayload,
} = require('../utils/whatsappTemplatePayloads')
const {
  generateInvoiceNumber,
  calculateGSTLine,
  computeInvoiceTotals,
  getInvoiceDocumentMeta,
  splitDocumentDiscountLines,
  applyDocumentDiscountToTotals,
} = require('../utils/invoiceUtils')

function normalizeSourceType(sourceType = 'MANUAL') {
  return String(sourceType || 'MANUAL').trim().toUpperCase()
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

async function getCompanySettings(conn) {
  const [[settings]] = await conn.query(`SELECT * FROM settings LIMIT 1`)
  return settings || {}
}

async function getInvoiceSettings(conn) {
  const [[settings]] = await conn.query(`SELECT * FROM invoice_settings LIMIT 1`)
  return (
    settings || {
      prefix: 'INV',
      sequence_start: 1,
      number_format: '{prefix}/{year}/{seq}',
      numbering_mode: 'continuous',
      layout_option: 'minimal',
    }
  )
}

async function getNextInvoiceSequence(conn, invSettings, now = new Date()) {
  const mode = invSettings.numbering_mode || 'continuous'
  const start = Number(invSettings.sequence_start || 1)

  if (mode === 'yearly') {
    const year = now.getFullYear()
    const [[row]] = await conn.query(
      `SELECT MAX(invoice_sequence) AS maxSeq FROM invoices WHERE YEAR(issue_date) = ?`,
      [year]
    )
    return row?.maxSeq ? Number(row.maxSeq) + 1 : start
  }

  if (mode === 'monthly') {
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const [[row]] = await conn.query(
      `SELECT MAX(invoice_sequence) AS maxSeq FROM invoices WHERE YEAR(issue_date) = ? AND MONTH(issue_date) = ?`,
      [year, month]
    )
    return row?.maxSeq ? Number(row.maxSeq) + 1 : start
  }

  const [[row]] = await conn.query(`SELECT MAX(invoice_sequence) AS maxSeq FROM invoices`)
  return row?.maxSeq ? Number(row.maxSeq) + 1 : start
}

function parseSnapshot(snapshot) {
  if (!snapshot) return {}
  if (typeof snapshot === 'object') return snapshot

  try {
    return JSON.parse(String(snapshot))
  } catch {
    return {}
  }
}

async function buildLeadSnapshots(conn, leadId) {
  if (!leadId) {
    return { billing: null, shipping: null, lead: null }
  }

  const [[lead]] = await conn.query(`SELECT l.*, c.name AS linked_company_name, c.gst_number AS linked_company_gst, c.billing_address AS company_billing_address, c.billing_city AS company_billing_city, c.billing_state AS company_billing_state, c.billing_pincode AS company_billing_pincode, c.shipping_address AS company_shipping_address, c.shipping_city AS company_shipping_city, c.shipping_state AS company_shipping_state, c.shipping_pincode AS company_shipping_pincode FROM leads l LEFT JOIN companies c ON c.id = l.company_id WHERE l.id = ?`, [leadId])
  if (!lead) {
    return { billing: null, shipping: null, lead: null }
  }

  const billing = {
    name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
    company: lead.linked_company_name || lead.company_name || '',
    phone: lead.phone_number || '',
    email: lead.email || '',
    gst: lead.linked_company_gst || lead.gst_number || '',
    address: lead.company_billing_address || lead.billing_address || '',
    landmark: lead.billing_landmark || '',
    city: lead.company_billing_city || lead.billing_city || '',
    state: lead.company_billing_state || lead.billing_state || '',
    pincode: lead.company_billing_pincode || lead.billing_pincode || '',
    country: 'India',
  }

  const shipping = {
    name: billing.name,
    company: billing.company,
    phone: billing.phone,
    email: billing.email,
    gst: billing.gst,
    address: lead.company_shipping_address || lead.company_billing_address || lead.shipping_address || lead.billing_address || '',
    landmark: lead.shipping_landmark || lead.billing_landmark || '',
    city: lead.company_shipping_city || lead.company_billing_city || lead.shipping_city || lead.billing_city || '',
    state: lead.company_shipping_state || lead.company_billing_state || lead.shipping_state || lead.billing_state || '',
    pincode: lead.company_shipping_pincode || lead.company_billing_pincode || lead.shipping_pincode || lead.billing_pincode || '',
    country: 'India',
  }

  return { billing, shipping, lead }
}

async function findInvoiceBySource(conn, sourceType, sourceId) {
  const normalizedSourceType = normalizeSourceType(sourceType)
  const safeSourceId = Number(sourceId || 0)
  if (!safeSourceId) return null

  const [rows] = await conn.query(
    `SELECT id, invoice_number, status, source_type FROM invoices WHERE source_type = ? AND source_id = ? LIMIT 1`,
    [normalizedSourceType, safeSourceId]
  )

  return rows[0] || null
}

function normalizeInvoiceItems(items = []) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Invoice items are required')
  }

  return items.map((item) => ({
    product_id: item.product_id ?? item.id ?? null,
    description: item.description ?? item.product_name ?? item.name ?? 'Item',
    quantity: Number(item.quantity || item.qty || 0),
    unit_price: Number(item.unit_price || item.selling_price || 0),
    discount: Number(item.discount || item.line_discount || 0),
    gst_rate: Number(item.gst_rate || 0),
  }))
}

function normalizeDiscountedLine({ quantity, unitPrice, discount }) {
  const qty = Math.max(0, Number(quantity || 0))
  const baseUnit = Math.max(0, Number(unitPrice || 0))
  const lineDiscount = Math.max(0, Number(discount || 0))

  if (!qty) {
    return { qty: 0, effectiveUnit: 0, lineDiscount }
  }

  const grossBaseTotal = qty * baseUnit
  const discountedBaseTotal = Math.max(0, grossBaseTotal - lineDiscount)
  const effectiveUnit = discountedBaseTotal / qty

  return { qty, effectiveUnit, lineDiscount }
}

async function createInvoiceRecord({
  conn,
  leadId = null,
  items = [],
  sourceType = 'MANUAL',
  sourceId = null,
  issueDate = new Date(),
  dueDate = null,
  notes = null,
  billingSnapshot = null,
  shippingSnapshot = null,
  status = 'issued',
  roundingAmount = 0,
  documentDiscountAmount = 0,
}) {
  const normalizedSourceType = normalizeSourceType(sourceType)
  const documentMeta = getInvoiceDocumentMeta(normalizedSourceType)
  const companySettings = await getCompanySettings(conn)
  const invoiceSettings = await getInvoiceSettings(conn)

  const gstPricingMode = companySettings?.gst_pricing_mode || 'EXCLUSIVE'
  const companyState = String(companySettings?.company_state || '').trim()
  const billingState = String(billingSnapshot?.state || '').trim()
  const isInterState =
    !!companyState &&
    !!billingState &&
    companyState.toLowerCase() !== billingState.toLowerCase()

  const splitItems = splitDocumentDiscountLines(items)
  const normalizedItems = normalizeInvoiceItems(splitItems.items)
  const computedItems = normalizedItems.map((item) => {
    const { qty, effectiveUnit, lineDiscount } = normalizeDiscountedLine({
      quantity: item.quantity,
      unitPrice: item.unit_price,
      discount: item.discount,
    })

    return {
      ...item,
      quantity: qty,
      unit_price: effectiveUnit,
      line_discount: lineDiscount,
      ...calculateGSTLine({
      quantity: qty,
      unitPrice: effectiveUnit,
      gstRate: item.gst_rate,
      pricingMode: gstPricingMode,
      isInterState,
    }),
    }
  })

  const totals = computeInvoiceTotals(computedItems)
  const discountedTotals = applyDocumentDiscountToTotals(
    totals,
    Number(documentDiscountAmount || 0) + Number(splitItems.discountAmount || 0),
    roundingAmount
  )
  const sequenceDate = issueDate ? new Date(issueDate) : new Date()
  const nextSeq = await getNextInvoiceSequence(conn, invoiceSettings, sequenceDate)
  const invoiceNumber = generateInvoiceNumber(
    invoiceSettings,
    nextSeq,
    sequenceDate,
    documentMeta.numberPrefix
  )

  const invoiceColumns = await getTableColumns(conn, 'invoices')
  const headerInsert = buildInsertStatement('invoices', {
    invoice_number: invoiceNumber,
    invoice_sequence: nextSeq,
    source_type: normalizedSourceType,
    source_id: sourceId,
    lead_id: leadId,
    issue_date: toDateOnlyString(sequenceDate),
    due_date: toDateOnlyString(dueDate),
    status,
    billing_snapshot: billingSnapshot ? JSON.stringify(billingSnapshot) : null,
    shipping_snapshot: shippingSnapshot ? JSON.stringify(shippingSnapshot) : null,
    subtotal: totals.subtotal,
    cgst_total: totals.cgst_total,
    sgst_total: totals.sgst_total,
    igst_total: totals.igst_total,
    grand_total: discountedTotals.grand_total,
    rounding_amount: Number(roundingAmount || 0),
    notes,
  }, invoiceColumns)
  const [header] = await conn.query(headerInsert.sql, headerInsert.values)

  const invoiceId = header.insertId

  for (const item of computedItems) {
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
        item.product_id,
        item.description,
        item.quantity,
        item.unit_price,
        item.gst_rate,
        item.taxable_amount,
        item.cgst_amount,
        item.sgst_amount,
        item.igst_amount,
        item.line_total,
      ]
    )
  }

  return {
    id: invoiceId,
    invoice_number: invoiceNumber,
    totals: discountedTotals,
    source_type: normalizedSourceType,
    status,
  }
}

async function createProformaInvoiceForWorkOrder({
  conn,
  workOrderId,
  leadId = null,
  items = [],
  billingSnapshot = null,
  shippingSnapshot = null,
  notes = null,
  issueDate = new Date(),
}) {
  return createInvoiceRecord({
    conn,
    leadId,
    items,
    sourceType: 'WORK_ORDER_PROFORMA',
    sourceId: workOrderId,
    issueDate,
    notes,
    billingSnapshot,
    shippingSnapshot,
    status: 'issued',
  })
}

async function buildWorkOrderInvoiceContext(conn, workOrderId) {
  const [[workOrder]] = await conn.query(`SELECT * FROM work_orders WHERE id = ? LIMIT 1`, [workOrderId])
  if (!workOrder) {
    throw new Error('Work order not found')
  }

  const [workOrderItems] = await conn.query(
    `SELECT * FROM work_order_items WHERE work_order_id = ? ORDER BY id ASC`,
    [workOrderId]
  )

  if (!workOrderItems.length) {
    throw new Error('Work order has no items')
  }

  const normalizedItems = []
  for (const item of workOrderItems) {
    let gstRate = Number(item.gst_rate || 0)

    if (!gstRate && item.product_id) {
      const [[product]] = await conn.query(`SELECT gst_rate FROM products WHERE id = ?`, [item.product_id])
      gstRate = Number(product?.gst_rate || 0)
    }

    normalizedItems.push({
      product_id: item.product_id ?? null,
      description: item.product_name || item.description || 'Item',
      quantity: Number(item.quantity || 0),
      unit_price: Number(item.unit_price || 0),
      discount: Number(item.discount || 0),
      gst_rate: gstRate,
    })
  }

  let documentDiscountAmount = Math.max(
    0,
    Number(workOrder.subtotal || 0) - Number(workOrder.total_amount || workOrder.grand_total || 0)
  )

  if (!documentDiscountAmount && workOrder.quotation_id) {
    const [[quotation]] = await conn.query(
      `SELECT quotation_discount_amount FROM quotations WHERE id = ? LIMIT 1`,
      [workOrder.quotation_id]
    )
    documentDiscountAmount = Math.max(0, Number(quotation?.quotation_discount_amount || 0))
  }

  const workOrderBilling = parseSnapshot(workOrder.billing_snapshot)
  const workOrderShipping = parseSnapshot(workOrder.shipping_snapshot)
  const { billing, shipping } = await buildLeadSnapshots(conn, workOrder.lead_id || null)

  return {
    workOrder,
    leadId: workOrder.lead_id || null,
    items: normalizedItems,
    documentDiscountAmount,
    billingSnapshot: Object.keys(workOrderBilling).length ? workOrderBilling : billing,
    shippingSnapshot: Object.keys(workOrderShipping).length ? workOrderShipping : shipping,
  }
}

async function ensureTaxInvoiceForWorkOrder(workOrderId, externalConn = null) {
  const safeWorkOrderId = Number(workOrderId || 0)
  if (!safeWorkOrderId) {
    return { created: false, invoice: null }
  }

  let conn = externalConn
  const ownsConnection = !externalConn
  const ownsTransaction = !externalConn
  try {
    if (ownsConnection) {
      conn = await db.getConnection()
    }
    if (ownsTransaction) {
      await conn.beginTransaction()
    }

    // Consider invoices created by the frontend/website as existing for this
    // work order so we don't create duplicates. Search for any invoice where
    // source_type is WORK_ORDER, FRONTEND_ORDER or WEBSITE_ORDER and source_id
    // matches the work order.
    const [found] = await conn.query(
      `SELECT id, invoice_number, source_type FROM invoices WHERE source_id = ? AND (source_type = 'WORK_ORDER' OR source_type = 'FRONTEND_ORDER' OR source_type = 'WEBSITE_ORDER') LIMIT 1`,
      [safeWorkOrderId]
    )

    const existingInvoice = found && found[0] ? found[0] : null
    if (existingInvoice) {
      const [upd1] = await conn.query(
        `UPDATE invoices SET status = 'paid' WHERE id = ? AND LOWER(COALESCE(status, '')) <> 'paid'`,
        [existingInvoice.id]
      )
      const [upd2] = await conn.query(
        `UPDATE invoices SET status = 'paid' WHERE source_type = 'WORK_ORDER_PROFORMA' AND source_id = ? AND LOWER(COALESCE(status, '')) <> 'paid'`,
        [safeWorkOrderId]
      )
      await conn.query(
        `UPDATE payments SET invoice_id = ? WHERE work_order_id = ?`,
        [existingInvoice.id, safeWorkOrderId]
      )

      const statusUpdated = (upd1 && Number(upd1.affectedRows || 0) > 0) || (upd2 && Number(upd2.affectedRows || 0) > 0)

      if (ownsTransaction) {
        await conn.commit()
      }
      return { created: false, invoice: existingInvoice, statusUpdated }
    }

    const context = await buildWorkOrderInvoiceContext(conn, safeWorkOrderId)
    const invoice = await createInvoiceRecord({
      conn,
      leadId: context.leadId,
      items: context.items,
      sourceType: 'WORK_ORDER',
      sourceId: safeWorkOrderId,
      issueDate: new Date(),
      notes: context.workOrder.notes || null,
      billingSnapshot: context.billingSnapshot,
      shippingSnapshot: context.shippingSnapshot,
      status: 'paid',
      documentDiscountAmount: context.documentDiscountAmount,
    })

    await conn.query(
      `UPDATE invoices SET status = 'paid' WHERE source_type = 'WORK_ORDER_PROFORMA' AND source_id = ? AND LOWER(COALESCE(status, '')) <> 'paid'`,
      [safeWorkOrderId]
    )

    await conn.query(
      `UPDATE payments SET invoice_id = ? WHERE work_order_id = ?`,
      [invoice.id, safeWorkOrderId]
    )

    if (ownsTransaction) {
      await conn.commit()
    }
    return { created: true, invoice }
  } catch (error) {
    if (conn && ownsTransaction) await conn.rollback()
    throw error
  } finally {
    if (conn && ownsConnection) conn.release()
  }
}

async function dispatchInvoiceNotifications(invoiceId, { sendEmail = true, sendWhatsApp = true } = {}) {
  const safeInvoiceId = Number(invoiceId || 0)
  if (!safeInvoiceId) {
    return { email: null, whatsapp: null }
  }

  const [rows] = await db.query(
    `
    SELECT
      i.id,
      i.invoice_number,
      i.issue_date,
      i.due_date,
      i.status,
      i.grand_total,
      i.source_type,
      i.billing_snapshot,
      l.first_name,
      l.last_name,
      l.email,
      l.phone_number
    FROM invoices i
    LEFT JOIN leads l ON i.lead_id = l.id
    WHERE i.id = ?
    LIMIT 1
    `,
    [safeInvoiceId]
  )

  if (!rows.length) {
    throw new Error('Invoice not found')
  }

  const invoice = rows[0]
  const billing = parseSnapshot(invoice.billing_snapshot)
  const customerName =
    `${invoice.first_name || ''} ${invoice.last_name || ''}`.trim() ||
    billing.name ||
    'Customer'

  const [itemRows] = await db.query(
    `SELECT description, quantity, unit_price, line_total FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`,
    [safeInvoiceId]
  )

  const documentMeta = getInvoiceDocumentMeta(invoice.source_type)
  const results = { email: null, whatsapp: null }

  if (sendEmail) {
    const customerEmail = String(invoice.email || billing.email || '').trim()
    if (!customerEmail) {
      throw new Error('Customer email not found for this invoice')
    }

    const invoicePdfBuffer = await generateInvoicePdf(invoice.id)
    results.email = await sendInvoiceEmail({
      customer_email: customerEmail,
      customer_name: customerName,
      invoice_number: invoice.invoice_number,
      documentLabel: documentMeta.shortLabel,
      invoice_details: {
        issue_date: invoice.issue_date,
        due_date: invoice.due_date,
        status: invoice.status,
        total_amount: invoice.grand_total,
      },
      items: itemRows,
      attachments: [
        {
          filename: `${documentMeta.attachmentPrefix}-${invoice.invoice_number || invoice.id}.pdf`,
          content: invoicePdfBuffer,
          contentType: 'application/pdf',
        }
      ]
    })
  }

  if (sendWhatsApp) {
    const customerPhone = normalizePhoneForWhatsApp(
      invoice.phone_number || billing.phone || null
    )

    if (!customerPhone) {
      throw new Error('Customer phone not found for this invoice')
    }

    const backendBaseUrl = String(process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '')
    const invoicePdfUrl = `${backendBaseUrl}/public/documents/invoices/${invoice.id}.pdf`

    results.whatsapp = await sendWhatsAppTemplateMessage(
      createInvoicePayload({
        phoneNumber: customerPhone,
        customerName,
        invoiceNumber: invoice.invoice_number || `INV-${invoice.id}`,
        issueDate: invoice.issue_date,
        status: invoice.status,
        totalAmount: invoice.grand_total,
        invoicePdfUrl,
        documentLabel: documentMeta.shortLabel,
      })
    )
  }

  return results
}

module.exports = {
  createInvoiceRecord,
  createProformaInvoiceForWorkOrder,
  ensureTaxInvoiceForWorkOrder,
  dispatchInvoiceNotifications,
  findInvoiceBySource,
}
