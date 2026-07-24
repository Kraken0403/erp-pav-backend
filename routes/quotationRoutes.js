// routes/quotationRoutes.js
const express = require('express');
const router = express.Router();
const quotationController = require('../controllers/quotationController');
const quotationPdfController = require('../controllers/quotationPdfController');
const quotationPdfBrowserlessController = require('../controllers/quotationPdfBrowserlessController');
const quotationPdfPuppetController = require('../controllers/quotationPdfPuppetController');
const authenticateJWT = require('../middleware/authMiddleware');

// router.use(authenticateJWT);
// Retrieve all quotations

router.get('/quotations', quotationController.getQuotations);

// Retrieve a specific quotation (including its items)

// Create a new quotation
router.post('/quotations', quotationController.createQuotation);

router.put('/quotations/:id/status', quotationController.updateQuotationStatus);
router.post('/quotations/:id/send-email', quotationController.sendQuotationEmailById);
router.post('/quotations/:id/send-whatsapp', quotationController.sendQuotationWhatsAppById);

router.put('/quotations/:id/items', quotationController.updateQuotationItems);

router.get('/quotations/:id/pdf', quotationPdfController.exportPdf)
router.get('/quotations/:id/pdf-browserless', quotationPdfBrowserlessController.exportPdfBrowserless)
router.get('/quotations/:id/pdf-puppet', quotationPdfPuppetController.exportPdfPuppet)
router.post('/quotations/pdf-puppet', quotationPdfPuppetController.exportPdfPuppetFromHtml)

router.get('/quotations/:id/pdf-preview', quotationPdfController.previewHtml)
// Update a quotation header (updates do not include items by this endpoint)
router.put('/quotations/:id', quotationController.updateQuotation);

router.delete('/quotations/:id', quotationController.deleteQuotation);

router.get('/quotations/:id', quotationController.getQuotationById);

console.log('✅ quotationRoutes loaded');


module.exports = router;
