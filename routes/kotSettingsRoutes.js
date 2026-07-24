const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const kotSettingsController = require('../controllers/kotSettingsController');

router.use(authenticateJWT);

router.get('/kot-settings', kotSettingsController.getKotSettings);
router.post('/kot-settings', kotSettingsController.saveKotSettings);

module.exports = router;
