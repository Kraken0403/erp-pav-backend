const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const notificationController = require('../controllers/notificationController');

router.use(authenticateJWT);

router.get('/notifications', notificationController.getMyNotifications);
router.get('/notifications/bubble', notificationController.getBubbleCounts);
router.patch('/notifications/status/mark-all', notificationController.markAllNotificationsSeen);
router.patch('/notifications/status/mark-all/:module', notificationController.markModuleNotificationsSeen);
router.patch('/notifications/status/record/:module/:sourceId', notificationController.markRecordNotificationsSeen);
router.patch('/notifications/status/:id', notificationController.markNotificationSeen);

module.exports = router;
