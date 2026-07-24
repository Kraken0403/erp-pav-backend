const express = require('express');
const router = express.Router();
const quotationSettingsController = require('../controllers/quotationSettingsController');
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);
// Get settings
router.get('/quotation-settings', quotationSettingsController.getQuotationSettings);

// Save/update settings
router.post('/quotation-settings', quotationSettingsController.saveQuotationSettings);

module.exports = router;
