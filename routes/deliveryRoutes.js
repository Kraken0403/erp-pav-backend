const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const {
  createDeliveryFromWorkOrder,
  getDeliveries,
  getDeliveryById,
  updateDeliveryStatus,
  updateDeliveryNotes,
  deleteDelivery
} = require('../controllers/deliveryController');

// All routes require authentication
router.use(authenticateJWT);

// Create delivery from work order
router.post('/create/:workOrderId', createDeliveryFromWorkOrder);

// Get all deliveries with optional filters
router.get('/', getDeliveries);

// Get single delivery
router.get('/:id', getDeliveryById);

// Update delivery status
router.patch('/:id/status', updateDeliveryStatus);

// Update delivery notes
router.patch('/:id/notes', updateDeliveryNotes);

// Delete delivery
router.delete('/:id', deleteDelivery);

module.exports = router;
