const axios = require("axios");
const { isWhatsAppEnabled } = require('../config/featureFlags');

const getWhatsAppMode = () => {
    const raw = String(process.env.WHATSAPP_MODE || 'send').trim().toLowerCase();

    if (['off', 'disabled', 'disable', 'none'].includes(raw)) {
        return 'off';
    }

    if (['console', 'log', 'dry_run', 'dry-run', 'mock'].includes(raw)) {
        return 'console';
    }

    return 'send';
};

const normalizePayloadForNotifino = (payload = {}) => {
    const normalized = { ...payload };

    const sanitizeTemplateText = (value) => String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();

    if (!normalized.phone_number && normalized.mobile_number) {
        normalized.phone_number = normalized.mobile_number;
        delete normalized.mobile_number;
    }

    if (normalized.template_fields && typeof normalized.template_fields === 'object') {
        Object.assign(normalized, normalized.template_fields);
        delete normalized.template_fields;
    }

    if (!normalized.template_language) {
        normalized.template_language = process.env.WA_TEMPLATE_LANGUAGE || 'en';
    }

    if (!normalized.from_phone_number_id && process.env.WA_FROM_PHONE_NUMBER_ID) {
        normalized.from_phone_number_id = process.env.WA_FROM_PHONE_NUMBER_ID;
    }

    Object.keys(normalized).forEach((key) => {
        if (!/^field_\d+$/i.test(key)) return;
        const safeText = sanitizeTemplateText(normalized[key]);
        normalized[key] = safeText || '-';
    });

    return normalized;
};

const getField = (payload, index) => String(payload[`field_${index}`] ?? '-');

const renderConsoleMessage = (payload = {}) => {
    const templateName = String(payload.template_name || '').trim();

    if (templateName === 'jdh_leads_assignment') {
        return [
            'New Lead Assigned',
            '',
            `Hi ${getField(payload, 1)},`,
            '',
            'A new lead has been assigned to you. Details are below:',
            '',
            `Lead Name: ${getField(payload, 2)}`,
            `Email: ${getField(payload, 3)}`,
            `Phone: ${getField(payload, 4)}`,
            `Company: ${getField(payload, 5)}`,
            `Status: ${getField(payload, 6)}`,
            `Priority: ${getField(payload, 7)}`,
            `Assigned Salesperson: ${getField(payload, 8)}`,
            `Follow-up Date: ${getField(payload, 9)}`,
            `Amount: ${getField(payload, 10)}`,
            '',
            'Thanks',
        ].join('\n');
    }

    if (templateName === 'jdh_order_status') {
        return [
            'Order Status Update',
            '',
            'Your order preparation status has changed.',
            '',
            `Dear ${getField(payload, 1)},`,
            '',
            'Please find the latest preparation update below.',
            '',
            `Work Order: ${getField(payload, 2)}`,
            `Order Status: ${getField(payload, 3)}`,
            `Delivery Date: ${getField(payload, 4)}`,
            `Delivery Time: ${getField(payload, 5)}`,
            `Delivery Location: ${getField(payload, 6)}`,
            '',
            'We will keep you posted on further progress.',
        ].join('\n');
    }

    if (templateName === 'jdh_order_confirmation') {
        return [
            'Order Confirmation',
            '',
            'Your order has been received and is now in processing.',
            '',
            `Dear ${getField(payload, 1)},`,
            '',
            'Thank you for your order. We’ve successfully received it and shared it with our operations team.',
            '',
            `Order Number: ${getField(payload, 2)}`,
            `Order Date: ${getField(payload, 3)}`,
            `Receiving Time: ${getField(payload, 4)}`,
            `Grand Total: ${getField(payload, 5)}`,
            '',
            'If you need to modify delivery timing, please contact our team as early as possible.',
        ].join('\n');
    }

    if (templateName === 'jdh_payment_reminder') {
        return [
            'Payment Reminder',
            '',
            `Dear ${getField(payload, 1)},`,
            '',
            'This is a gentle reminder for your pending payment.',
            '',
            `Invoice Number: ${getField(payload, 2)}`,
            `Invoice Date: ${getField(payload, 3)}`,
            `Invoice Total: ${getField(payload, 4)}`,
            `Paid Amount: ${getField(payload, 5)}`,
            `Pending Amount: ${getField(payload, 6)}`,
            '',
            'Please process the pending amount at your earliest convenience.',
        ].join('\n');
    }

    if (templateName === 'jdh_quotation_ready') {
        return [
            'Your Quotation is Ready',
            '',
            `Dear ${getField(payload, 1)},`,
            '',
            `Your quotation ${getField(payload, 2)} has been prepared.`,
            '',
            `Mode: ${getField(payload, 3)}`,
            `Event Name: ${getField(payload, 4)}`,
            `Event Date: ${getField(payload, 5)}`,
            `Event Time: ${getField(payload, 6)}`,
            `Event Location: ${getField(payload, 7)}`,
            `PAX: ${getField(payload, 8)}`,
            `Total Amount: ${getField(payload, 9)}`,
            '',
            `PDF: ${String(payload.header_document || '-')}`,
            '',
            'Thank you for your interest!',
        ].join('\n');
    }

    if (templateName === 'jdh_invoice') {
        const documentLabel = String(payload.document_label || 'Invoice').trim() || 'Invoice';
        return [
            `Your ${documentLabel} is Ready`,
            '',
            `Dear ${getField(payload, 1)},`,
            '',
            `Your ${documentLabel.toLowerCase()} ${getField(payload, 2)} has been generated.`,
            '',
            `Issue Date: ${getField(payload, 3)}`,
            `Status: ${getField(payload, 4)}`,
            `Total Amount: ₹${getField(payload, 5)}`,
            '',
            `PDF: ${String(payload.header_document || '-')}`,
            '',
            'Please process the payment at your earliest convenience.',
            '',
            'Thank you for your business!',
        ].join('\n');
    }

    return [
        `Template: ${templateName || '-'}`,
        `To: ${String(payload.phone_number || '-')}`,
        Object.keys(payload)
            .filter((k) => /^field_\d+$/.test(k))
            .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]))
            .map((k) => `${k}: ${String(payload[k])}`)
            .join('\n')
    ].join('\n');
};

const sendWhatsAppTemplateMessage = async (payload) => {
    try {
        if (!isWhatsAppEnabled()) {
            return {
                success: true,
                mode: 'disabled',
                message: 'WhatsApp not sent (ALLOW_WHATSAPP=false)',
                payload,
            };
        }

        const normalizedPayload = normalizePayloadForNotifino(payload);
        const whatsAppMode = getWhatsAppMode();

        if (whatsAppMode === 'off') {
            console.log('📵 [WHATSAPP_MODE=off] WhatsApp send skipped. Payload:', normalizedPayload);
            return {
                success: true,
                mode: 'off',
                message: 'WhatsApp not sent (off mode)',
                payload: normalizedPayload,
            };
        }

        if (whatsAppMode === 'console') {
            console.log('💬 [WHATSAPP_MODE=console] WhatsApp send skipped. Payload:', normalizedPayload);
            console.log('📝 [WHATSAPP_MODE=console] Message Preview:\n' + renderConsoleMessage(normalizedPayload));
            return {
                success: true,
                mode: 'console',
                message: 'WhatsApp not sent (console mode)',
                payload: normalizedPayload,
            };
        }

        const url = `${process.env.NOTIFINO_API_URL}/${process.env.NOTIFINO_VENDOR_UID}/contact/send-template-message?token=${process.env.NOTIFINO_TOKEN}`;
        console.log(url, normalizedPayload);

        const response = await axios.post(url, normalizedPayload, {
            headers: {
                "Content-Type": "application/json",
            },
        });

        console.log("WhatsApp Message Sent:", response.data);

        return response.data;
    } catch (error) {
        console.error("WhatsApp Error:", error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendWhatsAppTemplateMessage
}