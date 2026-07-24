
const express = require('express')
const router = express.Router()

const { createProformaInvoice } = require('../controllers/proformaInvoiceController')
const { downloadProformaPdf, previewProformaHtml } = require('../controllers/proformaPdfController')

// POST /proforma-invoices
router.post('/proforma-invoices', createProformaInvoice)

// GET /proforma-invoices/:id/pdf
router.get('/proforma-invoices/:id/pdf', downloadProformaPdf)

// GET /proforma-invoices/:id/preview
router.get('/proforma-invoices/:id/preview', previewProformaHtml)

// GET /proforma-invoices/:id
// (Add getProformaInvoiceById if needed)

module.exports = router
