const DEFAULT_LANGUAGE = 'en';
const { formatDate } = require('./dateFormatter');

const sanitizeTemplateText = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return '-';

    // Meta template params reject newline/tab and long whitespace runs.
    return raw
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
};

const normalizePhoneForWhatsApp = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    if (digits.length >= 12) return digits;
    return null;
};

const toDisplayDate = (value) => {
    if (!value) return '-';
    try {
        return formatDate(value);
    } catch (e) {
        return String(value);
    }
};

const toDisplayTime = (value) => {
    if (!value) return '-';
    const raw = String(value).trim();
    const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
    if (!match) return raw;
    const date = new Date(`1970-01-01T${match[1]}:00`);
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
};

const createBasePayload = ({ phoneNumber, templateName }) => {
    const payload = {
        phone_number: phoneNumber,
        template_name: templateName,
        template_language: process.env.WA_TEMPLATE_LANGUAGE || DEFAULT_LANGUAGE,
    };

    if (process.env.WA_FROM_PHONE_NUMBER_ID) {
        payload.from_phone_number_id = process.env.WA_FROM_PHONE_NUMBER_ID;
    }

    return payload;
};

const createLeadAssignmentPayload = ({ phoneNumber, salespersonName, lead }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_LEAD_ASSIGNMENT || 'jdh_leads_assignment',
    }),
    field_1: sanitizeTemplateText(salespersonName || 'Salesperson'),
    field_2: sanitizeTemplateText(lead.name || '-'),
    field_3: sanitizeTemplateText(lead.email || '-'),
    field_4: sanitizeTemplateText(lead.phone || '-'),
    field_5: sanitizeTemplateText(lead.company || '-'),
    field_6: sanitizeTemplateText(String(lead.status || '-').toUpperCase()),
    field_7: sanitizeTemplateText(String(lead.priority || '-').toUpperCase()),
    field_8: sanitizeTemplateText(salespersonName || '-'),
    field_9: sanitizeTemplateText(lead.followUpDate || '-'),
    field_10: sanitizeTemplateText(lead.amount || '-'),
});

const createOrderStatusPayload = ({ phoneNumber, customerName, workOrderNumber, status, deliveryDate, deliveryTime, deliveryLocation, deliveryManName, deliveryManPhone, deliveryManVehicle }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_ORDER_STATUS || 'jdh_order_status',
    }),
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(workOrderNumber || '-'),
    field_3: sanitizeTemplateText(String(status || '-').replace(/_/g, ' ').toUpperCase()),
    field_4: sanitizeTemplateText(toDisplayDate(deliveryDate)),
    field_5: sanitizeTemplateText(toDisplayTime(deliveryTime)),
    field_6: sanitizeTemplateText(deliveryLocation || '-'),
    // Optional delivery person details (mapped to later template fields if template supports them)
    field_7: sanitizeTemplateText(deliveryManName || '-'),
    field_8: sanitizeTemplateText(deliveryManPhone || '-'),
    field_9: sanitizeTemplateText(deliveryManVehicle || '-'),
});

const createDeliveryStatusPayload = ({ phoneNumber, customerName, workOrderNumber, status, deliveryDate, deliveryTime, deliveryLocation, deliveryManName, deliveryManPhone, deliveryManVehicle }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_DELIVERY_STATUS || 'jdh_delivery_status',
    }),
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(workOrderNumber || '-'),
    field_3: sanitizeTemplateText(String(status || '-').replace(/_/g, ' ').toUpperCase()),
    field_4: sanitizeTemplateText(toDisplayDate(deliveryDate)),
    field_5: sanitizeTemplateText(toDisplayTime(deliveryTime)),
    field_6: sanitizeTemplateText(deliveryLocation || '-'),
    // Optional delivery person details (mapped to later template fields if template supports them)
    field_7: sanitizeTemplateText(deliveryManName || '-'),
    field_8: sanitizeTemplateText(deliveryManPhone || '-'),
    field_9: sanitizeTemplateText(deliveryManVehicle || '-'),
});

const createOrderConfirmationPayload = ({ phoneNumber, customerName, orderNumber, orderDate, receivingTime, grandTotal }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_ORDER_CONFIRMATION || 'jdh_order_confirmation',
    }),
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(orderNumber || '-'),
    field_3: sanitizeTemplateText(toDisplayDate(orderDate)),
    field_4: sanitizeTemplateText(toDisplayTime(receivingTime)),
    field_5: sanitizeTemplateText(Number(grandTotal || 0).toFixed(2)),
});

const createPaymentReminderPayload = ({ phoneNumber, customerName, invoiceNumber, invoiceDate, invoiceTotal, paidAmount, pendingAmount }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_PAYMENT_REMINDER || 'jdh_payment_reminder',
    }),
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(invoiceNumber || '-'),
    field_3: sanitizeTemplateText(toDisplayDate(invoiceDate)),
    field_4: sanitizeTemplateText(Number(invoiceTotal || 0).toFixed(2)),
    field_5: sanitizeTemplateText(Number(paidAmount || 0).toFixed(2)),
    field_6: sanitizeTemplateText(Number(pendingAmount || 0).toFixed(2)),
});

const createQuotationPayload = ({ phoneNumber, customerName, quotationNumber, quotationMode, eventName, eventDate, eventTime, eventLocation, pax, totalAmount, quotationPdfUrl }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_QUOTATION || 'jdh_quotation_ready',
    }),
    header_document: quotationPdfUrl,
    header_document_name: `Quotation-${quotationNumber || 'Document'}.pdf`,
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(quotationNumber || '-'),
    field_3: sanitizeTemplateText(String(quotationMode || 'GENERAL').toUpperCase()),
    field_4: sanitizeTemplateText(eventName || '-'),
    field_5: sanitizeTemplateText(toDisplayDate(eventDate)),
    field_6: sanitizeTemplateText(toDisplayTime(eventTime)),
    field_7: sanitizeTemplateText(eventLocation || '-'),
    field_8: sanitizeTemplateText(pax !== undefined && pax !== null && String(pax).trim() !== '' ? String(pax) : '-'),
    field_9: sanitizeTemplateText(Number(totalAmount || 0).toFixed(2)),
});

const createInvoicePayload = ({ phoneNumber, customerName, invoiceNumber, issueDate, status, totalAmount, invoicePdfUrl, documentLabel = 'Invoice' }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_INVOICE || 'jdh_invoice',
    }),
    document_label: sanitizeTemplateText(documentLabel),
    header_document: invoicePdfUrl,
    header_document_name: `${sanitizeTemplateText(documentLabel).replace(/\s+/g, '-')}-${invoiceNumber || 'Document'}.pdf`,
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(/proforma/i.test(documentLabel) ? `${documentLabel} ${invoiceNumber || '-'}` : (invoiceNumber || '-')),
    field_3: sanitizeTemplateText(toDisplayDate(issueDate)),
    field_4: sanitizeTemplateText(String(status || '-').toUpperCase()),
    field_5: sanitizeTemplateText(Number(totalAmount || 0).toFixed(2)),
});

const extractTokenFrom = (value) => {
    if (!value) return '';
    const raw = String(value).trim();
    // If it's already a short token (no protocol, no =), return as-is
    if (!/^https?:\/\//i.test(raw) && !raw.includes('token=')) return raw;

    try {
        // Try to parse URL and extract token param
        const u = new URL(raw);
        return u.searchParams.get('token') || '';
    } catch (e) {
        // Fallback: regex search
        const m = raw.match(/[?&]token=([^&]+)/i);
        return m ? decodeURIComponent(m[1]) : '';
    }
};

const createOrderFeedbackPayload = ({ phoneNumber, customerName, workOrderNumber, feedbackUrl, feedbackToken }) => ({
    ...createBasePayload({
        phoneNumber,
        templateName: process.env.WA_TEMPLATE_FEEDBACK || 'jdh_order_feedback',
    }),
    template_language: process.env.WA_TEMPLATE_FEEDBACK_LANGUAGE || process.env.WA_TEMPLATE_LANGUAGE || DEFAULT_LANGUAGE,
    field_1: sanitizeTemplateText(customerName || 'Customer'),
    field_2: sanitizeTemplateText(workOrderNumber || '-'),
    // Accept either a full URL or a raw token. Extract token if needed and pass token only
    button_0: sanitizeTemplateText((() => {
        const token = String(feedbackToken || extractTokenFrom(feedbackUrl || '') || '').trim();
        return token || '-';
    })()),
});

module.exports = {
    normalizePhoneForWhatsApp,
    createLeadAssignmentPayload,
    createOrderStatusPayload,
    createOrderConfirmationPayload,
    createPaymentReminderPayload,
    createQuotationPayload,
    createInvoicePayload,
    createOrderFeedbackPayload,
    createDeliveryStatusPayload,
};
