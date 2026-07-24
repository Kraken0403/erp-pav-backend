const express = require("express");
const router = express.Router();
const { sendMessage } = require("../controllers/whatsappNotifinoController");

router.post("/send-template-message", sendMessage);

module.exports = router;