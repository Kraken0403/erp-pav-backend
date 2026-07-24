const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const authenticateToken = require('../middleware/authMiddleware');

// All routes require authentication
router.use(authenticateToken);

// Sales Report
router.get('/sales', reportController.getSalesReport);
router.get('/sales/pdf', reportController.exportSalesPdf);

// Customer Report
router.get('/customers', reportController.getCustomerReport);
router.get('/customers/pdf', reportController.exportCustomersPdf);
// Customer detail
router.get('/customers/detail', reportController.getCustomerDetail);

// Product Report
router.get('/products', reportController.getProductReport);
router.get('/products/pdf', reportController.exportProductsPdf);

// Lead Report
router.get('/leads', reportController.getLeadReport);
router.get('/leads/pdf', reportController.exportLeadsPdf);

// Work Order Report
router.get('/work-orders', reportController.getWorkOrderReport);
router.get('/work-orders/pdf', reportController.exportWorkOrdersPdf);

// Dashboard / Monthly aggregated data
router.get('/dashboard', reportController.getDashboardReport);

module.exports = router;
