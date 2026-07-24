const express = require('express')
const router = express.Router()

const {
  getInvoiceSettings,
  saveInvoiceSettings,
} = require('../controllers/invoiceSettingsController')

/* ---------------------------------------------------------
   GET SETTINGS
   GET /api/invoice-settings
--------------------------------------------------------- */
router.get('/invoice-settings', getInvoiceSettings)

/* ---------------------------------------------------------
   SAVE SETTINGS
   POST /api/invoice-settings
--------------------------------------------------------- */
router.post('/invoice-settings', saveInvoiceSettings)

module.exports = router
