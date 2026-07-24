// controllers/proformaInvoiceController.js
const db = require('../config/db')
const { getTableColumns, buildInsertStatement } = require('../utils/dbSchema')
const {
  calculateGSTLine,
  computeInvoiceTotals,
  generateInvoiceNumber,
  applyDocumentDiscountToTotals,
} = require('../utils/invoiceUtils')

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

async function getCompanySettings(conn) {
  const [[settings]] = await conn.query(`SELECT * FROM settings LIMIT 1`)
  return settings || {}
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

async function buildLeadSnapshots(conn, leadId) {
  if (!leadId) {
    return { billing: null, shipping: null, lead: null }
  }
  const [[lead]] = await conn.query(`SELECT * FROM leads WHERE id = ?`, [leadId])
  if (!lead) throw new Error('Lead not found')
  // ...same as invoiceController.js...
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

function normalizeItems(items = []) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('Proforma items are required')
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

function normalizeDiscountedLine({ quantity, unitPrice, discount }) {
  const qty = Math.max(0, Number(quantity || 0))
  const baseUnit = Math.max(0, Number(unitPrice || 0))
  const lineDiscount = Math.max(0, Number(discount || 0))

  if (!qty) return { qty: 0, effectiveUnit: 0, lineDiscount }

  const grossBaseTotal = qty * baseUnit
  const discountedBaseTotal = Math.max(0, grossBaseTotal - lineDiscount)
  const effectiveUnit = discountedBaseTotal / qty

  return { qty, effectiveUnit, lineDiscount }
}

const createProformaInvoice = async (req, res) => {
  const {
    lead_id = null,
    items = [],
    event_details = null,
    source_type = 'MANUAL_PROFORMA',
    source_id = null,
    issue_date = null,
    due_date = null,
    notes = null,
  } = req.body

  let conn
  try {
    conn = await db.getConnection()
    await conn.beginTransaction()

    const companySettings = await getCompanySettings(conn)
    const gstPricingMode = companySettings?.gst_pricing_mode || 'EXCLUSIVE'
    const { billing, shipping, lead } = await buildLeadSnapshots(conn, lead_id)
    const normalized = normalizeItems(items)
    for (const it of normalized) {
      if (!it.gst_rate && it.product_id) {
        const [[p]] = await conn.query(`SELECT gst_rate FROM products WHERE id = ? LIMIT 1`, [it.product_id])
        it.gst_rate = Number(p?.gst_rate || 0)
      }
    }
    const companyState = String(companySettings?.company_state || '').trim().toLowerCase()
    const billingState = String(billing?.state || '').trim().toLowerCase()
    const isInterState = Boolean(companyState && billingState && companyState !== billingState)

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
        ...calc
      }
    })

    // If proforma is being created from quotation payload, carry overall discount in totals.
    const srcType = String(source_type || '').toUpperCase()
    const srcId = Number(source_id || 0)
    let documentDiscountAmount = 0
    if (srcType.includes('QUOTATION') && srcId) {
      const [[qRow]] = await conn.query(
        `SELECT quotation_discount_type, quotation_discount_value, quotation_discount_amount FROM quotations WHERE id = ? LIMIT 1`,
        [srcId]
      )
      documentDiscountAmount = Math.max(0, Number(qRow?.quotation_discount_amount || 0))
    }

    const totals = computeInvoiceTotals(computedItems)
    const roundingAmount = Number(req.body.rounding_amount || 0)
    const discountedTotals = applyDocumentDiscountToTotals(totals, documentDiscountAmount, roundingAmount)

    // numbering: use invoice settings and PI prefix
    const invSettings = await getInvoiceSettings(conn)
    // get next sequence for proformas
    const now = issue_date ? new Date(issue_date) : new Date()
    // compute next sequence similar to invoices but for proforma_invoices
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

    // insert header
    const proformaColumns = await getTableColumns(conn, 'proforma_invoices')
    const headerInsert = buildInsertStatement('proforma_invoices', {
      proforma_number: proformaNumber,
      proforma_sequence: nextSeq,
      lead_id,
      event_details: event_details ? JSON.stringify(event_details) : null,
      source_type,
      source_id,
      issue_date: toDateOnlyString(issue_date),
      due_date: toDateOnlyString(due_date),
      status: 'issued',
      subtotal: totals.subtotal,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      grand_total: discountedTotals.grand_total,
      rounding_amount: roundingAmount,
      notes,
      billing_snapshot: billing ? JSON.stringify(billing) : null,
      shipping_snapshot: shipping ? JSON.stringify(shipping) : null,
      gst_pricing_mode: gstPricingMode,
    }, proformaColumns)
    const [header] = await conn.query(headerInsert.sql, headerInsert.values)

    const proformaId = header.insertId

    // insert items into proforma_items
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
    // If this proforma was created from a quotation, mark that quotation
    // as converted and locked so another PI cannot be created. Do this
    // inside the same transaction so changes are atomic.
    try {
      const safeSourceId = Number(source_id || 0)
      const src = String(source_type || '').toUpperCase()
      if (src.includes('QUOTATION') && safeSourceId) {
        const [updateResult] = await conn.query(
          `UPDATE quotations SET status = 'converted', is_locked = 1 WHERE id = ? AND status = 'approved'`,
          [safeSourceId]
        )
        if (!updateResult || !updateResult.affectedRows) {
          console.warn('[Proforma] quotation update affected 0 rows', { source_id: safeSourceId })
        } else {
          console.info('[Proforma] quotation marked converted', { source_id: safeSourceId })
        }
      }
    } catch (e) {
      console.warn('Failed to mark quotation converted after proforma creation:', e && e.message ? e.message : e)
    }

    await conn.commit()
    conn.release()

    return res.status(201).json({
      id: proformaId,
      proforma_number: proformaNumber,
      totals: discountedTotals,
      items: computedItems,
    })
  } catch (err) {
    if (conn) {
      await conn.rollback()
      conn.release()
    }
    return res.status(500).json({ error: err.message || 'Failed to create proforma invoice' })
  }
}

module.exports = {
  createProformaInvoice,
}
