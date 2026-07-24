const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const kotController = require('../controllers/kotController');
const kotPdfController = require('../controllers/kotPdfController');

router.use(authenticateJWT);

router.get('/kots', kotController.getKots);
router.get('/kots/check/:workOrderId', kotController.checkKotExists);
router.post('/kots/generate/:workOrderId', kotController.generateKotFromWorkOrder);
router.patch('/kots/:id/status', kotController.updateKotStatus);

// PDF routes
router.get('/kots/:id/pdf', kotPdfController.exportPdf);
router.get('/kots/:id/preview', kotPdfController.previewHtml);

module.exports = router;
