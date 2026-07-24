const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const orderFeedbackAdminController = require('../controllers/orderFeedbackAdminController');
const orderFeedbackSettingsController = require('../controllers/orderFeedbackSettingsController');

router.use(authenticateJWT);

router.get('/order-feedbacks/settings', orderFeedbackSettingsController.getOrderFeedbackSettings);
router.post('/order-feedbacks/settings', orderFeedbackSettingsController.saveOrderFeedbackSettings);

router.get('/order-feedbacks', orderFeedbackAdminController.getOrderFeedbackResponses);
router.get('/order-feedbacks/:id', orderFeedbackAdminController.getOrderFeedbackResponseById);

module.exports = router;
