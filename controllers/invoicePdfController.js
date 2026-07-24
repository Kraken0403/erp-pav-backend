const db = require('../config/db')
const { generatePdf, generateHtml, generateReceiptPdf } = require('../services/invoicePdfService')
const { getInvoiceDocumentMeta } = require('../utils/invoiceUtils')

const getInvoiceFilename = async (id) => {
  const [rows] = await db.query(
    `SELECT invoice_number, source_type FROM invoices WHERE id = ? LIMIT 1`,
    [id]
  )

  const invoice = rows?.[0] || null
  if (!invoice) {
    return `invoice-${id}.pdf`
  }

  const documentMeta = getInvoiceDocumentMeta(invoice.source_type)
  return `${documentMeta.attachmentPrefix}-${invoice.invoice_number || id}.pdf`
}

/* ---------------------------------------------------------
   DOWNLOAD INVOICE PDF
   GET /api/invoices/:id/pdf
--------------------------------------------------------- */
const downloadInvoicePdf = async (req, res) => {
  const { id } = req.params

  try {
    const pdfBuffer = await generatePdf(id)
    const filename = await getInvoiceFilename(id)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    )

    return res.send(pdfBuffer)
  } catch (err) {
    console.error('downloadInvoicePdf error:', err)
    return res.status(500).json({ error: err.message })
  }
}

const streamInvoicePdfInline = async (req, res) => {
  const { id } = req.params

  try {
    const pdfBuffer = await generatePdf(id)
    const filename = await getInvoiceFilename(id)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)

    return res.send(pdfBuffer)
  } catch (err) {
    console.error('streamInvoicePdfInline error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   PREVIEW INVOICE HTML (Debug Mode)
   GET /api/invoices/:id/preview
--------------------------------------------------------- */
const previewInvoiceHtml = async (req, res) => {
  const { id } = req.params

  try {
    const html = await generateHtml(id)
    res.setHeader('Content-Type', 'text/html')
    return res.send(html)
  } catch (err) {
    console.error('previewInvoiceHtml error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   DOWNLOAD RECEIPT PDF
   GET /api/invoices/payments/:receiptId/pdf
--------------------------------------------------------- */
const downloadReceiptPdf = async (req, res) => {
  const receiptId = String(req.params?.receiptId || req.query?.receiptId || '').trim();

  if (!receiptId) {
    return res.status(400).json({ error: 'receiptId is required' });
  }

  try {
    const pdfBuffer = await generateReceiptPdf(receiptId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Receipt-${receiptId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('downloadReceiptPdf error:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  downloadInvoicePdf,
  streamInvoicePdfInline,
  previewInvoiceHtml,
  downloadReceiptPdf,
}
