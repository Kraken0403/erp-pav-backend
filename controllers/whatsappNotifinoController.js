const { sendWhatsAppTemplateMessage } = require("../services/whatsappNotfinoService");

const sendMessage = async (req, res) => {
    try {
        const payload = req.body;
        console.log("Received WhatsApp message request:", payload);

        const result = await sendWhatsAppTemplateMessage(payload);

        console.log("WhatsApp message sent successfully:", result);

        res.status(200).json({
            success: true,
            data: result,
        });
    } catch (error) {
        console.error("Error sending WhatsApp message:", error);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message || "Failed to send WhatsApp message",
        });
    }
}

module.exports = {
    sendMessage
}