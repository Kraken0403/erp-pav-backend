const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const vendorController = require('../controllers/vendorController');

router.use(authenticateJWT);

router.get('/vendors', vendorController.listVendors);
router.post('/vendors', vendorController.createVendor);
router.get('/vendors/:id', vendorController.getVendorById);
router.put('/vendors/:id', vendorController.updateVendor);
router.delete('/vendors/:id', vendorController.deleteVendor);

router.get('/vendor-payables', vendorController.listVendorPayables);
router.post('/vendor-payables/:id/payments', vendorController.recordVendorPayment);

module.exports = router;
