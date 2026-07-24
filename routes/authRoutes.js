const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');


// 🔓 PUBLIC ROUTES — NO MIDDLEWARE
router.post('/login', authController.login);
router.post('/signup', authController.signup);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

module.exports = router;
