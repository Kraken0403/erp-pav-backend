const express = require('express');
const router = express.Router();
const workOrderItemController = require('../controllers/workOrderItemController');
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);

router.post('/workOrderItem', workOrderItemController.createWorkOrderItem);
router.get('/workOrderItem/:id', workOrderItemController.getWorkOrderItemById);


module.exports = router;