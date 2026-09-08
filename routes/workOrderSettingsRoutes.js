const express = require('express');
const authenticateJWT = require('../middleware/authMiddleware');
const controller = require('../controllers/workOrderSettingsController');
const router = express.Router();
router.use(authenticateJWT);
router.get('/work-order-settings', controller.getWorkOrderSettings);
router.put('/work-order-settings', controller.saveWorkOrderSettings);
module.exports = router;
