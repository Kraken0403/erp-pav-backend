const express = require("express");
const { sendEmail, sendWhatsApp } = require("../controllers/emailController");

const router = express.Router();

// Route to send email
router.post("/send-email", sendEmail);
router.post('/send-whatsapp', sendWhatsApp);

module.exports = router;
