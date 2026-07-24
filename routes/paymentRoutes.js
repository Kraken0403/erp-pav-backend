const express = require("express");
const router = express.Router();

const { handleRazorpayWebhook, getPayments } = require("../controllers/paymentController");

router.get("/webhook-health", (req, res) => {
    return res.status(200).json({
        ok: true,
        route: '/api/razorpay/webhook',
        ts: new Date().toISOString(),
    });
});

router.post("/webhook", handleRazorpayWebhook);
router.get("/payments", getPayments);

module.exports = router;