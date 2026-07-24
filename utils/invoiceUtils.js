// utils/invoiceUtils.js

function generateInvoiceNumber(settings, sequence, now = new Date(), prefixOverride = null) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = prefixOverride || settings.prefix || 'INV'

  return String(settings.number_format || '{prefix}/{year}/{seq}')
    .replace('{prefix}', prefix)
    .replace('{year}', year)
    .replace('{month}', month)
    .replace('{seq}', String(sequence).padStart(4, '0'))
}

function getInvoiceDocumentMeta(sourceType = 'MANUAL') {
  const normalizedSourceType = String(sourceType || 'MANUAL').trim().toUpperCase()

  if (normalizedSourceType.endsWith('_PROFORMA')) {
    return {
      documentType: 'PROFORMA',
      documentTitle: 'PROFORMA INVOICE',
      shortLabel: 'Proforma Invoice',
      numberLabel: 'Proforma No',
      attachmentPrefix: 'Proforma-Invoice',
      numberPrefix: 'PI',
    }
  }

  return {
    documentType: 'TAX',
    documentTitle: 'TAX INVOICE',
    shortLabel: 'Tax Invoice',
    numberLabel: 'Invoice No',
    attachmentPrefix: 'Invoice',
    numberPrefix: null,
  }
}

function generateReceiptNumber(settings, sequence, now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')

  const format = settings.receipt_number_format || settings.number_format || '{prefix}/{year}/{seq}'
  const prefix = settings.receipt_prefix || 'REC'

  return String(format)
    .replace('{prefix}', prefix)
    .replace('{year}', year)
    .replace('{month}', month)
    .replace('{seq}', String(sequence).padStart(4, '0'))
}

function round2(n) {
  const x = Number(n || 0)
  return Math.round(x * 100) / 100
}

/**
 * GST calculation per line
 * pricingMode: 'INCLUSIVE' | 'EXCLUSIVE'
 * isInterState: boolean
 */
function calculateGSTLine({
  quantity,
  unitPrice,
  gstRate,
  pricingMode,
  isInterState,
}) {
  const qty = Number(quantity || 0)
  const price = Number(unitPrice || 0)
  const rate = Number(gstRate || 0)

  const gross = qty * price // as entered

  let taxable = 0
  let taxAmount = 0

  if (pricingMode === 'INCLUSIVE') {
    // Compute per-unit tax, round per-unit then multiply by qty (mirrors frontend)
    const basePerUnitUnrounded = price / (1 + rate / 100)
    const taxPerUnit = round2(basePerUnitUnrounded * rate / 100)
    const basePerUnit = round2(price - taxPerUnit)

    taxable = round2(basePerUnit * qty)
    taxAmount = round2(taxPerUnit * qty)
  } else {
    // EXCLUSIVE: taxable is gross (qty * exclusive unit price), round then compute tax
    taxable = round2(gross)
    taxAmount = round2(taxable * (rate / 100))
  }

  let cgst = 0
  let sgst = 0
  let igst = 0

  if (rate > 0) {
    if (isInterState) {
      igst = round2(taxAmount)
    } else {
      cgst = round2(taxAmount / 2)
      sgst = round2(taxAmount / 2)
    }
  }

  const lineTotal = pricingMode === 'INCLUSIVE' ? round2(gross) : round2(taxable + taxAmount)

  return {
    taxable_amount: round2(taxable),
    cgst_amount: round2(cgst),
    sgst_amount: round2(sgst),
    igst_amount: round2(igst),
    line_total: round2(lineTotal),
  }
}

/**
 * Sum totals from items array (items already contain per-line computed fields)
 */
function computeInvoiceTotals(items = []) {
  const totals = {
    subtotal: 0, // taxable subtotal (sum taxable_amount)
    cgst_total: 0,
    sgst_total: 0,
    igst_total: 0,
    grand_total: 0, // sum line_total
  }

  for (const it of items) {
    totals.subtotal = round2(totals.subtotal + Number(it.taxable_amount || 0))
    totals.cgst_total = round2(totals.cgst_total + Number(it.cgst_amount || 0))
    totals.sgst_total = round2(totals.sgst_total + Number(it.sgst_amount || 0))
    totals.igst_total = round2(totals.igst_total + Number(it.igst_amount || 0))
    totals.grand_total = round2(totals.grand_total + Number(it.line_total || 0))
  }

  return totals
}

function isDocumentDiscountLine(item = {}) {
  return (
    Number(item.line_total || 0) < 0 ||
    Number(item.taxable_amount || 0) < 0 ||
    Number(item.unit_price || item.selling_price || 0) < 0
  )
}

function splitDocumentDiscountLines(items = []) {
  const result = {
    items: [],
    discountAmount: 0,
  }

  for (const item of Array.isArray(items) ? items : []) {
    if (isDocumentDiscountLine(item)) {
      const lineTotal = Number(item.line_total || 0)
      const fallbackTotal =
        Number(item.quantity || 1) * Number(item.unit_price || item.selling_price || 0)
      result.discountAmount = round2(
        result.discountAmount + Math.abs(lineTotal || fallbackTotal || 0)
      )
    } else {
      result.items.push(item)
    }
  }

  return result
}

function applyDocumentDiscountToTotals(totals = {}, discountAmount = 0, roundingAmount = 0) {
  const preDiscountGrandTotal = round2(Number(totals.grand_total || 0))
  const normalizedDiscount = Math.max(0, round2(discountAmount))
  const appliedDiscount = Math.min(normalizedDiscount, Math.max(0, preDiscountGrandTotal))
  const rounding = round2(roundingAmount)

  return {
    ...totals,
    pre_discount_grand_total: preDiscountGrandTotal,
    document_discount: appliedDiscount,
    grand_total: round2(Math.max(0, preDiscountGrandTotal - appliedDiscount) + rounding),
    roundingAmount: rounding,
  }
}

function applyDiscountDisplayFields(document = {}, items = [], sourceDiscountMeta = {}) {
  const split = splitDocumentDiscountLines(items)
  const sourceAmount = Math.max(0, round2(sourceDiscountMeta.amount || 0))
  const discountAmount = sourceAmount || split.discountAmount
  const displaySubtotal = round2(
    Number(document.subtotal || 0) + (split.discountAmount > 0 ? split.discountAmount : 0)
  )
  const taxes = round2(
    Number(document.cgst_total || 0) +
      Number(document.sgst_total || 0) +
      Number(document.igst_total || 0)
  )
  const fallbackPercent =
    displaySubtotal > 0 && discountAmount > 0
      ? Math.round((discountAmount / displaySubtotal) * 10000) / 100
      : null

  return {
    document: {
      ...document,
      display_taxable_subtotal: displaySubtotal,
      discount: discountAmount,
      _computed_discount: discountAmount,
      discount_percent: sourceDiscountMeta.percent || fallbackPercent,
      taxes,
    },
    items: split.items,
    discountAmount,
  }
}

module.exports = {
  generateInvoiceNumber,
  generateReceiptNumber,
  getInvoiceDocumentMeta,
  calculateGSTLine,
  computeInvoiceTotals,
  round2,
  splitDocumentDiscountLines,
  applyDocumentDiscountToTotals,
  applyDiscountDisplayFields,
}
