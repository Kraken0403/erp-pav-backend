const express = require('express');
const router = express.Router();
const couponController = require('../controllers/couponController');
const authenticateJWT = require('../middleware/authMiddleware');

// Public endpoints
router.post('/coupons/validate', couponController.validateCoupon);
router.get('/coupons', couponController.listPublicCoupons);

// Protect the remaining coupon admin routes
router.use(authenticateJWT);

router.get('/admin/coupons', couponController.listCoupons);
router.get('/admin/coupons/:id', couponController.getCoupon);
router.post('/admin/coupons', couponController.createCoupon);
router.put('/admin/coupons/:id', couponController.updateCoupon);
router.delete('/admin/coupons/:id', couponController.deleteCoupon);

module.exports = router;
