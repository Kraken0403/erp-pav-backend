// be/services/invoicePdfService.js

// Proforma Invoice PDF/HTML generation
async function getProforma(id) {
  const [rows] = await db.query(
    `
    SELECT p.*, l.first_name, l.last_name
    FROM proforma_invoices p
    LEFT JOIN leads l ON l.id = p.lead_id
    WHERE p.id = ?
    `,
    [id]
  )

  if (!rows.length) return null
  const proforma = rows[0]

  try {
    proforma.billing_snapshot = typeof proforma.billing_snapshot === 'string' ? JSON.parse(proforma.billing_snapshot) : proforma.billing_snapshot
  } catch {}
  try {
    proforma.shipping_snapshot = typeof proforma.shipping_snapshot === 'string' ? JSON.parse(proforma.shipping_snapshot) : proforma.shipping_snapshot
  } catch {}

  const [items] = await db.query(`SELECT * FROM proforma_items WHERE proforma_id = ? ORDER BY id ASC`, [id])
  const proformaDiscountMeta = await resolveProformaDiscountMeta(proforma)
  const proformaDisplay = applyDiscountDisplayFields(proforma, items || [], proformaDiscountMeta)
  Object.assign(proforma, proformaDisplay.document)
  proforma.items = proformaDisplay.items

  // normalize billing/shipping snapshots and dates similar to invoices
  const normalizeSnapshot = (snapshot = {}) => ({
    name: String(snapshot?.name || '').trim(),
    company: String(snapshot?.company || '').trim(),
    address: String(snapshot?.address || '').trim(),
    city: String(snapshot?.city || '').trim(),
    state: String(snapshot?.state || '').trim(),
    pincode: String(snapshot?.pincode || '').trim(),
    gst: String(snapshot?.gst || '').trim(),
  })

  try {
    proforma.billing_snapshot = normalizeSnapshot(
      typeof proforma.billing_snapshot === 'string' ? JSON.parse(proforma.billing_snapshot) : proforma.billing_snapshot
    )
  } catch {
    proforma.billing_snapshot = normalizeSnapshot(proforma.billing_snapshot || {})
  }

  try {
    proforma.shipping_snapshot = normalizeSnapshot(
      typeof proforma.shipping_snapshot === 'string' ? JSON.parse(proforma.shipping_snapshot) : proforma.shipping_snapshot
    )
  } catch {
    proforma.shipping_snapshot = normalizeSnapshot(proforma.shipping_snapshot || {})
  }

  // fallbacks
  const leadName = `${proforma.first_name || ''} ${proforma.last_name || ''}`.trim()
  const fallbackCustomerName = proforma.billing_snapshot.name || proforma.shipping_snapshot.name || leadName || 'Customer'
  if (!proforma.billing_snapshot.name) proforma.billing_snapshot.name = fallbackCustomerName
  if (!proforma.shipping_snapshot.name) proforma.shipping_snapshot.name = proforma.billing_snapshot.name

  // format dates
  proforma.issue_date_formatted = formatDate(proforma.issue_date)
  proforma.due_date_formatted = formatDate(proforma.due_date)

  // document meta (title/labels) based on source_type
  const documentMeta = getInvoiceDocumentMeta(proforma.source_type)
  proforma.document_title = documentMeta.documentTitle
  proforma.document_short_label = documentMeta.shortLabel
  proforma.document_number_label = documentMeta.numberLabel

  // ensure template-friendly field: invoice_number (template expects invoice.invoice_number)
  proforma.invoice_number = proforma.proforma_number || proforma.invoice_number || null

  const settingsRaw = await getCompanySettings()
  const preferredLogo = await getPreferredLogoUrl(settingsRaw)
  const company = {
    ...settingsRaw,
    // Ensure GSTIN is available under company_gst for templates
    company_gst: settingsRaw?.company_gst || settingsRaw?.gst_number || settingsRaw?.gst || settingsRaw?.gstNumber || '',
    // Prefer module/internal logo; fallback to main company logo.
    company_logo: preferredLogo,
  }

  const invoiceSettings = await getInvoiceSettings()

  return {
    invoice: proforma,
    company,
    invoiceSettings,
    today: formatDate(new Date()),
  }
}

function loadProformaTemplate(data) {
  // reuse invoice template for now; template loader expects invoice-like data
  return loadInvoiceTemplate(data)
}

exports.generateProformaPdf = async (proformaId) => {
  const data = await getProforma(proformaId)
  if (!data) throw new Error('Proforma not found')
  const html = loadProformaTemplate(data)
  return await renderHtmlToPdfBuffer(html)
}

exports.generateProformaHtml = async (proformaId) => {
  const data = await getProforma(proformaId)
  if (!data) throw new Error('Proforma not found')
  return loadProformaTemplate(data)
}

const db = require('../config/db')
const { loadInvoiceTemplate, loadReceiptTemplate } = require('./invoiceTemplateLoader')
const { generatePdfFromHtml } = require('./puppetPdfService')
const { getInvoiceDocumentMeta, applyDiscountDisplayFields } = require('../utils/invoiceUtils')
const { formatDate } = require('../utils/dateFormatter')
const { resolvePreferredPdfLogo } = require('../utils/pdfAssetResolver')

function parseLocalDate(value) {
  if (!value) return null

  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return null

    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (dateOnly) {
      const [, y, m, d] = dateOnly
      const parsed = new Date(Number(y), Number(m) - 1, Number(d))
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// use shared util to ensure dd/mm/yyyy
// formatDate imported from ../utils/dateFormatter

/* ---------------------------------------------------------
   PUBLIC API - INVOICES
--------------------------------------------------------- */

exports.generatePdf = async (invoiceId) => {
  const data = await loadInvoiceData(invoiceId)
  const html = loadInvoiceTemplate(data)
  return await renderHtmlToPdfBuffer(html)
}

exports.generateHtml = async (invoiceId) => {
  const data = await loadInvoiceData(invoiceId)
  return loadInvoiceTemplate(data)
}

/* ---------------------------------------------------------
   PUBLIC API - RECEIPTS (NEW)
--------------------------------------------------------- */

exports.generateReceiptPdf = async (receiptNumber) => {
  const data = await loadReceiptData(receiptNumber)
  const html = loadReceiptTemplate(data)
  return await renderHtmlToPdfBuffer(html)
}


/* ---------------------------------------------------------
   PUPPETEER ENGINE 
--------------------------------------------------------- */
async function renderHtmlToPdfBuffer(html) {
  return generatePdfFromHtml(html, {
    payloadOverrides: {
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '15mm',
        right: '15mm',
      },
    },
  })
}

/* ---------------------------------------------------------
   INTERNAL DATA LOADERS
--------------------------------------------------------- */

async function loadReceiptData(receiptNumber) {

  const [payments] = await db.query(`SELECT * FROM invoice_payments WHERE receipt_number = ?`, [receiptNumber]);
  if (!payments.length) throw new Error('Receipt not found');
  const payment = payments[0];

  const invoice = await getInvoice(payment.invoice_id);
  if (!invoice) throw new Error('Invoice not found');

  const settingsRaw = await getCompanySettings();
  const preferredLogo = await getPreferredLogoUrl(settingsRaw);
  const company = {
    ...settingsRaw,
    company_gst: settingsRaw?.company_gst || settingsRaw?.gst_number || settingsRaw?.gst || settingsRaw?.gstNumber || '',
    company_logo: preferredLogo,
  };

  return {
    payment,
    invoice,
    billing: invoice.billing_snapshot || {},
    company
  };
}


async function loadInvoiceData(invoiceId) {
  const invoice = await getInvoice(invoiceId)
  if (!invoice) {
    throw new Error('Invoice not found')
  }

  const normalizeSnapshot = (snapshot = {}) => ({
    name: String(snapshot?.name || '').trim(),
    company: String(snapshot?.company || '').trim(),
    address: String(snapshot?.address || '').trim(),
    city: String(snapshot?.city || '').trim(),
    state: String(snapshot?.state || '').trim(),
    pincode: String(snapshot?.pincode || '').trim(),
    gst: String(snapshot?.gst || '').trim(),
  })

  const billingSnapshot = normalizeSnapshot(invoice.billing_snapshot || {})
  const shippingSnapshot = normalizeSnapshot(invoice.shipping_snapshot || {})

  const leadName = `${invoice.first_name || ''} ${invoice.last_name || ''}`.trim()
  const fallbackCustomerName =
    billingSnapshot.name ||
    shippingSnapshot.name ||
    leadName ||
    'Customer'

  if (!billingSnapshot.name) {
    billingSnapshot.name = fallbackCustomerName
  }

  if (!shippingSnapshot.name) {
    shippingSnapshot.name = fallbackCustomerName
  }

  const isShippingEmpty =
    !shippingSnapshot.name &&
    !shippingSnapshot.company &&
    !shippingSnapshot.address &&
    !shippingSnapshot.city &&
    !shippingSnapshot.state &&
    !shippingSnapshot.pincode &&
    !shippingSnapshot.gst

  const isSameAsBilling =
    shippingSnapshot.name === billingSnapshot.name &&
    shippingSnapshot.company === billingSnapshot.company &&
    shippingSnapshot.address === billingSnapshot.address &&
    shippingSnapshot.city === billingSnapshot.city &&
    shippingSnapshot.state === billingSnapshot.state &&
    shippingSnapshot.pincode === billingSnapshot.pincode &&
    shippingSnapshot.gst === billingSnapshot.gst

  invoice.billing_snapshot = billingSnapshot
  invoice.shipping_snapshot = isShippingEmpty || isSameAsBilling
    ? { ...billingSnapshot }
    : shippingSnapshot

  const documentMeta = getInvoiceDocumentMeta(invoice.source_type)
  invoice.document_title = documentMeta.documentTitle
  invoice.document_short_label = documentMeta.shortLabel
  invoice.document_number_label = documentMeta.numberLabel

  invoice.issue_date_formatted = formatDate(invoice.issue_date)
  invoice.due_date_formatted = formatDate(invoice.due_date)

  const settingsRaw = await getCompanySettings()
  const invoiceSettings = await getInvoiceSettings()
  const preferredLogo = await getPreferredLogoUrl(settingsRaw)

  const company = {
    ...settingsRaw,
    company_gst: settingsRaw?.company_gst || settingsRaw?.gst_number || settingsRaw?.gst || settingsRaw?.gstNumber || '',
    company_logo: preferredLogo,
  }

  return {
    invoice,
    company,
    invoiceSettings,
    today: formatDate(new Date()),
  }
}

/* ---------------------------------------------------------
   UTILS
--------------------------------------------------------- */

async function getCompanySettings() {
  const [rows] = await db.query(`SELECT * FROM settings LIMIT 1`)
  return rows[0] || {}
}

async function getPreferredLogoUrl(companySettings = {}) {
  try {
    const [qRows] = await db.query(`SELECT logo_url FROM quotation_settings LIMIT 1`)
    return resolvePreferredPdfLogo(qRows?.[0]?.logo_url, companySettings?.company_logo)
  } catch (err) {
    return resolvePreferredPdfLogo(companySettings?.company_logo)
  }
}

async function getInvoiceSettings() {
  const [rows] = await db.query(`SELECT * FROM invoice_settings LIMIT 1`)
  const settings = rows[0] || {}

  // Normalize rich HTML fields: treat empty or whitespace-only strings as null
  if (typeof settings.footer_notes_html === 'string') {
    const raw = settings.footer_notes_html.trim()
    const stripped = raw.replace(/<[^>]*>/g, '').trim()
    settings.footer_notes_html = stripped.length ? settings.footer_notes_html : null
  }

  if (typeof settings.terms_conditions_html === 'string') {
    const raw = settings.terms_conditions_html.trim()
    const stripped = raw.replace(/<[^>]*>/g, '').trim()
    settings.terms_conditions_html = stripped.length ? settings.terms_conditions_html : null
  }

  return settings
}

function getDiscountPercentFromQuotation(row) {
  if (String(row?.quotation_discount_type || '').toUpperCase() !== 'PERCENT') {
    return null
  }

  const percent = Number(row?.quotation_discount_value || 0)
  return percent > 0 ? percent : null
}

async function getQuotationDiscountMeta(quotationId) {
  const safeQuotationId = Number(quotationId || 0)
  if (!safeQuotationId) return { amount: 0, percent: null }

  const [[quotation]] = await db.query(
    `SELECT quotation_discount_type, quotation_discount_value, quotation_discount_amount FROM quotations WHERE id = ? LIMIT 1`,
    [safeQuotationId]
  )

  return {
    amount: Math.max(0, Number(quotation?.quotation_discount_amount || 0)),
    percent: getDiscountPercentFromQuotation(quotation),
  }
}

async function resolveProformaDiscountMeta(proforma) {
  const sourceType = String(proforma?.source_type || '').toUpperCase()
  const sourceId = Number(proforma?.source_id || 0)

  if (sourceType.includes('QUOTATION') && sourceId) {
    return getQuotationDiscountMeta(sourceId)
  }

  return { amount: 0, percent: null }
}

async function resolveInvoiceDiscountMeta(invoice) {
  const sourceType = String(invoice?.source_type || '').toUpperCase()
  const sourceId = Number(invoice?.source_id || 0)

  if (!sourceId) return { amount: 0, percent: null }

  if (sourceType === 'QUOTATION' || sourceType === 'QUOTATION_PROFORMA') {
    return getQuotationDiscountMeta(sourceId)
  }

  if (sourceType === 'WORK_ORDER' || sourceType === 'WORK_ORDER_PROFORMA') {
    const [[workOrder]] = await db.query(
      `SELECT quotation_id FROM work_orders WHERE id = ? LIMIT 1`,
      [sourceId]
    )
    return getQuotationDiscountMeta(workOrder?.quotation_id)
  }

  if (sourceType.includes('PROFORMA')) {
    const [[proforma]] = await db.query(
      `SELECT source_type, source_id FROM proforma_invoices WHERE id = ? LIMIT 1`,
      [sourceId]
    )
    return resolveProformaDiscountMeta(proforma)
  }

  return { amount: 0, percent: null }
}

async function getInvoice(id) {
  const [rows] = await db.query(
    `
    SELECT
      i.*,
      l.first_name,
      l.last_name
    FROM invoices i
    LEFT JOIN leads l ON l.id = i.lead_id
    WHERE i.id = ?
    `,
    [id]
  )

  if (!rows.length) return null

  const invoice = rows[0]

  try {
    invoice.billing_snapshot = typeof invoice.billing_snapshot === 'string' ? JSON.parse(invoice.billing_snapshot) : invoice.billing_snapshot
  } catch { }

  try {
    invoice.shipping_snapshot = typeof invoice.shipping_snapshot === 'string' ? JSON.parse(invoice.shipping_snapshot) : invoice.shipping_snapshot
  } catch { }

  const [items] = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`, [id])
  const discountMeta = await resolveInvoiceDiscountMeta(invoice)
  const display = applyDiscountDisplayFields(invoice, items || [], discountMeta)
  Object.assign(invoice, display.document)
  invoice.items = display.items

  return invoice
}
