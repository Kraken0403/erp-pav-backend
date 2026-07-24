const getRazorpayInstance = require("../config/razorpay");
const { isRazorpayEnabled } = require('../config/featureFlags');

exports.createRazorpayOrder = async (amount, receipt, notes = {}) => {
    if (!isRazorpayEnabled()) {
        return null;
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error('Razorpay configuration is missing. Required: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET');
    }

    const razorpay = getRazorpayInstance();
    return await razorpay.orders.create({
        amount,
        currency: "INR",
        receipt,
        notes
    });
};