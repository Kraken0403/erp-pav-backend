// pdf/invoiceTemplateLoader.js

const fs = require('fs')
const path = require('path')
const Handlebars = require('handlebars')
const { formatDate: formatDateUtil } = require('../utils/dateFormatter')

/* ---------------------------------------------------------
   Load Base CSS
--------------------------------------------------------- */

function loadBaseCss() {
  const cssPath = path.join(
    __dirname,
    '..',
    'templates',
    'invoices',
    'base.css'
  )

  if (!fs.existsSync(cssPath)) {
    return ''
  }

  return fs.readFileSync(cssPath, 'utf8')
}

/* ---------------------------------------------------------
   Load Invoice HTML Template
--------------------------------------------------------- */

function loadHtmlTemplate() {
  const templatePath = path.join(
    __dirname,
    '..',
    'templates',
    'invoices',
    'invoice.html'
  )

  if (!fs.existsSync(templatePath)) {
    throw new Error('Invoice template file not found')
  }

  return fs.readFileSync(templatePath, 'utf8')
}

function loadReceiptHtmlTemplate() {
  const templatePath = path.join(
    __dirname,
    '..',
    'templates',
    'invoices',
    'receipt.html'
  )

  if (!fs.existsSync(templatePath)) {
    throw new Error('Receipt template file not found')
  }

  return fs.readFileSync(templatePath, 'utf8')
}

/* ---------------------------------------------------------
   Register Handlebars Helpers (ONLY ONCE)
--------------------------------------------------------- */

let helpersRegistered = false

function registerHelpers() {
  if (helpersRegistered) return

  Handlebars.registerHelper('currency', function (value) {
    const n = Number(value || 0)
    return `₹ ${n.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  })

  Handlebars.registerHelper('inc', function (value) {
    return Number(value) + 1
  })

  Handlebars.registerHelper('formatDate', function (date) {
    if (!date) return ''
    try {
      return formatDateUtil(date)
    } catch {
      return date
    }
  })

  // Return true when numeric value > 0
  Handlebars.registerHelper('positive', function (value) {
    try {
      return Number(value) > 0
    } catch {
      return false
    }
  })

  // Return true when string has non-whitespace content
  Handlebars.registerHelper('hasContent', function (value) {
    if (value == null) return false
    if (typeof value !== 'string') return true
    // strip HTML tags and check remaining text
    try {
      const stripped = value.replace(/<[^>]*>/g, '').trim()
      return stripped.length > 0
    } catch {
      return value.trim().length > 0
    }
  })

  helpersRegistered = true
}

/* ---------------------------------------------------------
   PUBLIC: loadInvoiceTemplate(data)
--------------------------------------------------------- */

function loadInvoiceTemplate(data) {
  registerHelpers()

  const baseCss = loadBaseCss()
  const htmlTemplate = loadHtmlTemplate()

  const template = Handlebars.compile(htmlTemplate)

  // Compute aggregated discount (sum of negative line_total invoice items)
  try {
    const inv = data && data.invoice ? data.invoice : null
    if (inv && Array.isArray(inv.items)) {
      let discountSum = 0
      for (const it of inv.items) {
        const lt = Number(it.line_total || 0)
        if (lt < 0) discountSum += lt
      }
      // pass absolute discount amount and percentage (against taxable subtotal)
      const existingDiscount = Math.max(
        0,
        Number(inv.discount || inv._computed_discount || 0)
      )
      inv.discount = existingDiscount || Math.abs(Number(discountSum || 0))
      // compute display_taxable_subtotal as pre-discount subtotal
      inv.display_taxable_subtotal =
        inv.display_taxable_subtotal != null
          ? Number(inv.display_taxable_subtotal || 0)
          : Number(inv.subtotal || 0) + Math.abs(Number(discountSum || 0))
      inv.discount_percent = inv.discount_percent || (Number(inv.display_taxable_subtotal || 0) > 0 && inv.discount > 0
        ? Math.round((inv.discount / Number(inv.display_taxable_subtotal || 0)) * 10000) / 100
        : null)
      // Hide negative discount rows from items table and keep only positive lines
      data.invoice = { ...inv, items: inv.items.filter(it => Number(it.line_total || 0) >= 0) }
    }
  } catch (e) {
    // ignore template prep errors
    console.warn('invoiceTemplateLoader: failed to compute discount', e && e.message ? e.message : e)
  }

  return template({
    ...data,
    baseCss,
  })
}
function loadReceiptTemplate(data) {
  registerHelpers()

  const baseCss = loadBaseCss()
  const htmlTemplate = loadReceiptHtmlTemplate()

  const template = Handlebars.compile(htmlTemplate)

  return template({
    ...data,
    baseCss,
  })
}

module.exports = {
  loadInvoiceTemplate,
  loadReceiptTemplate,
}
