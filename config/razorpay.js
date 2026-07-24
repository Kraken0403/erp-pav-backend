const Razorpay = require('razorpay');
const { isRazorpayEnabled } = require('./featureFlags');

let razorpayInstance = null;

const getRazorpayInstance = () => {
    if (!isRazorpayEnabled()) return null;
    if (razorpayInstance) return razorpayInstance;

    razorpayInstance = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    return razorpayInstance;
};

module.exports = getRazorpayInstance;