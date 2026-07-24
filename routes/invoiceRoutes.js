const express = require('express')
const router = express.Router()
const {
   downloadInvoicePdf,
   previewInvoiceHtml,
   downloadReceiptPdf
} = require('../controllers/invoicePdfController')

const {
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
   sendProformaWhatsAppById
} = require('../controllers/invoiceController')

/* ---------------------------------------------------------
   CREATE INVOICE (Manual / Frontend Order)
--------------------------------------------------------- */
router.post('/invoices', createInvoice)
router.post('/invoices/from-workorder/:workOrderId', createInvoiceFromWorkOrder)
router.post('/proforma-invoices/from-quotation/:quotationId', createProformaInvoiceFromQuotation)
router.post('/proforma-invoices/:id/create-tax-invoice', createTaxInvoiceFromProforma)

/* ---------------------------------------------------------
   LIST ALL INVOICES
--------------------------------------------------------- */
router.get('/invoices', getInvoices)
router.get('/proforma-invoices', getProformaInvoices)

/* =========================================================
   PAYMENT & RECEIPT ROUTES
========================================================= */
router.post('/invoices/:id/add-payment', addInvoicePayment)
router.get('/invoices/payments/pdf', downloadReceiptPdf)
router.get('/invoices/payments/:receiptId/pdf', downloadReceiptPdf)

/* ---------------------------------------------------------
   GET / UPDATE SPECIFIC INVOICE (Dynamic :id routes)
--------------------------------------------------------- */
router.get('/invoices/:id', getInvoiceById)
router.get('/proforma-invoices/:id', getProformaInvoiceById)
router.put('/invoices/:id/status', updateInvoiceStatus)
router.post('/invoices/:id/send-email', sendInvoiceEmailById)
router.post('/invoices/:id/send-whatsapp', sendInvoiceWhatsAppById)
router.post('/proforma-invoices/:id/send-email', sendProformaEmailById)
router.post('/proforma-invoices/:id/send-whatsapp', sendProformaWhatsAppById)
// Send receipt (by receipt number)
router.post('/invoices/payments/:receiptId/send-email', async (req, res, next) => {
   // delegate to controller function if available
   try {
      const { sendReceiptEmailById } = require('../controllers/invoiceController')
      return sendReceiptEmailById(req, res, next)
   } catch (err) {
      return res.status(500).json({ error: 'Handler not available' })
   }
})
router.post('/invoices/payments/:receiptId/send-whatsapp', async (req, res, next) => {
   try {
      const { sendReceiptWhatsAppById } = require('../controllers/invoiceController')
      return sendReceiptWhatsAppById(req, res, next)
   } catch (err) {
      return res.status(500).json({ error: 'Handler not available' })
   }
})
router.get('/invoices/:id/pdf', downloadInvoicePdf)
router.get('/invoices/:id/preview', previewInvoiceHtml)

module.exports = router