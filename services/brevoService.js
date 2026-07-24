// services/brevoService.js

const nodemailer = require('nodemailer');
const { isEmailEnabled } = require('../config/featureFlags');
const { formatDate } = require('../utils/dateFormatter');

let smtpTransporter = null;
const mailPreviews = [];
const MAX_MAIL_PREVIEWS = 100;

function buildMailPreviewBaseUrl() {
  const configured = String(process.env.MAIL_PREVIEW_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/$/, '').replace(/\/api$/, '');
  }

  const backendUrl = String(process.env.BACKEND_URL || '').trim();
  if (backendUrl) {
    return backendUrl.replace(/\/$/, '').replace(/\/api$/, '');
  }

  const port = process.env.PORT || 5000;
  return `http://localhost:${port}`;
}

function storeMailPreview({ to, toName, subject, fromEmail, fromEmailName, htmlContent, attachmentsCount }) {
  const id = `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  const preview = {
    id,
    createdAt,
    to,
    toName: toName || null,
    from: fromEmail,
    fromName: fromEmailName,
    subject,
    attachmentsCount,
    htmlContent: String(htmlContent || ''),
  };

  mailPreviews.unshift(preview);
  if (mailPreviews.length > MAX_MAIL_PREVIEWS) {
    mailPreviews.length = MAX_MAIL_PREVIEWS;
  }

  return preview;
}

function listMailPreviews() {
  return mailPreviews.map((preview) => ({
    id: preview.id,
    createdAt: preview.createdAt,
    to: preview.to,
    toName: preview.toName,
    from: preview.from,
    fromName: preview.fromName,
    subject: preview.subject,
    attachmentsCount: preview.attachmentsCount,
  }));
}

function getMailPreviewById(id) {
  if (!id) return null;
  return mailPreviews.find((preview) => preview.id === id) || null;
}

function getMailMode() {
  const raw = String(process.env.MAIL_MODE || 'send').trim().toLowerCase();

  if (['console', 'log', 'dry_run', 'dry-run', 'mock'].includes(raw)) {
    return 'console';
  }

  return 'send';
}

function parseLocalDateTime(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const raw = String(value).trim();
  if (!raw) return null;

  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  const dateTime = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (dateTime) {
    const [, y, m, d, hh, mm, ss = '00'] = dateTime;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDisplayDate(value) {
  const parsed = parseLocalDateTime(value);
  if (!parsed) return value;
  return formatDate(parsed);
}

function formatDisplayTime(value) {
  if (!value) return value;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
  if (!match) return value;
  const parsed = new Date(`1970-01-01T${match[1]}:00`);
  return parsed.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDisplayEventTime(startTime, endTime, legacyTime) {
  if (startTime && endTime) {
    return `${formatDisplayTime(startTime)} - ${formatDisplayTime(endTime)}`;
  }
  if (startTime) return formatDisplayTime(startTime);
  if (legacyTime) return formatDisplayTime(legacyTime);
  return legacyTime || '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

function formatWholeQuantityLabel(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'x0';
  return `x${Math.max(0, Math.round(num))}`;
}

function renderRows(rows = []) {
  return rows
    .filter((row) => row && row.value !== undefined && row.value !== null && String(row.value).trim() !== '')
    .map(
      (row) => `<div class="info-row"><strong>${escapeHtml(row.label)}:</strong> ${escapeHtml(row.value)}</div>`
    )
    .join('');
}

function renderTable({ title, headers = [], rows = [] } = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';

  return `
    <h3 style="margin-top:24px;">${escapeHtml(title || 'Details')}</h3>
    <table style="width:100%; border-collapse: collapse; margin-top: 8px;">
      <thead>
        <tr>
          ${headers
      .map(
        (h) => `<th style="text-align:${h.align || 'left'}; border:1px solid #ddd; padding:8px;">${escapeHtml(h.label)}</th>`
      )
      .join('')}
        </tr>
      </thead>
      <tbody>
        ${rows
      .map(
        (row) => `
          <tr>
            ${row
            .map(
              (cell, index) =>
                `<td style="text-align:${headers[index]?.align || 'left'}; border:1px solid #ddd; padding:8px;">${escapeHtml(cell)}</td>`
            )
            .join('')}
          </tr>
        `
      )
      .join('')}
      </tbody>
    </table>
  `;
}

function renderUnifiedEmailTemplate({
  title,
  subtitle,
  greeting,
  intro,
  rows = [],
  table = null,
  cta = null,
  outro = [],
}) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; padding: 0; background:#f6f8fb; font-family: Arial, sans-serif; line-height: 1.6; color: #222; }
          .container { max-width: 760px; margin: 0 auto; padding: 20px; }
          .card { background: #ffffff; border-radius: 12px; overflow: hidden; border:1px solid #e5e7eb; }
          .hero { background: linear-gradient(135deg, #111827 0%, #1f2937 100%); color:#fff; padding: 24px; }
          .hero h2 { margin:0; font-size:24px; }
          .hero p { margin:8px 0 0; color:#e5e7eb; }
          .content { padding: 20px 24px 24px; }
          .info-row {
            margin: 8px 0;
            padding: 10px 12px;
            background: #f9fafb;
            border-radius: 6px;
            border: 1px solid #eef2f7;
          }
          .outro { margin-top: 16px; color: #374151; }
          .cta-wrap { margin-top: 20px; margin-bottom: 8px; }
          .cta-button {
            display: inline-block;
            background: #111827;
            color: #ffffff !important;
            text-decoration: none;
            padding: 10px 16px;
            border-radius: 8px;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="hero">
              <h2>${escapeHtml(title || 'Notification')}</h2>
              ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
            </div>
            <div class="content">
              ${greeting ? `<p>${escapeHtml(greeting)}</p>` : ''}
              ${intro ? `<p>${escapeHtml(intro)}</p>` : ''}
              ${renderRows(rows)}
              ${table ? renderTable(table) : ''}
              ${cta && cta.url
      ? `<div class="cta-wrap"><a class="cta-button" href="${escapeHtml(cta.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cta.label || 'Open Link')}</a></div>`
      : ''}
              ${(outro || []).map((line) => `<p class="outro">${escapeHtml(line)}</p>`).join('')}
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;

  const rawHost = String(process.env.SMTP_HOST || '').trim();
  const host = rawHost.replace(/^serversmtp-relay\./i, 'smtp-relay.');
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_LOGIN || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    throw new Error(
      'SMTP configuration is missing. Required: SMTP_HOST, SMTP_PORT, SMTP_LOGIN(or SMTP_USER), SMTP_PASSWORD(or SMTP_PASS)'
    );
  }

  const secure =
    String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  return smtpTransporter;
}

/**
 * Send email using SMTP (Nodemailer)
 * 
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.toName - Recipient name
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - Email HTML content
 * @param {string} [options.from] - Sender email (optional, uses default if not provided)
 * @param {string} [options.fromName] - Sender name (optional)
 * @returns {Promise} - Nodemailer send result
 */
async function sendBrevoEmail({
  to,
  toName,
  subject,
  htmlContent,
  from,
  fromName,
  attachments = []
}) {
  if (!isEmailEnabled()) {
    return {
      messageId: `email-disabled-${Date.now()}`,
      accepted: [],
      rejected: [to].filter(Boolean),
      response: 'Email not sent (ALLOW_EMAIL=false)',
      mode: 'disabled',
    };
  }

  const fromEmail =
    from ||
    process.env.MAIL_FROM_EMAIL ||
    process.env.SMTP_FROM_EMAIL ||
    process.env.BREVO_SENDER_EMAIL ||
    process.env.SMTP_LOGIN ||
    process.env.SMTP_USER;
  const fromEmailName =
    fromName ||
    process.env.MAIL_FROM_NAME ||
    process.env.SMTP_FROM_NAME ||
    process.env.BREVO_SENDER_NAME ||
    'Zoans CRM';

  if (!to) {
    throw new Error('Recipient email is required');
  }

  if (!fromEmail) {
    throw new Error('Sender email is not configured');
  }

  const mailMode = getMailMode();

  if (mailMode === 'console') {
    const attachmentsCount = Array.isArray(attachments) ? attachments.length : 0;
    const preview = storeMailPreview({
      to,
      toName,
      subject,
      fromEmail,
      fromEmailName,
      htmlContent,
      attachmentsCount,
    });
    const previewUrl = `${buildMailPreviewBaseUrl()}/public/mail-previews/${preview.id}`;

    const logPayload = {
      mode: mailMode,
      to,
      toName: toName || null,
      from: fromEmail,
      fromName: fromEmailName,
      subject,
      attachmentsCount,
      previewUrl,
    };

    console.log('📬 [MAIL_MODE=console] Email send skipped. Payload:', logPayload);

    return {
      messageId: `console-${Date.now()}`,
      accepted: [to],
      rejected: [],
      response: 'Email not sent (console mode)',
      mode: mailMode,
      preview_id: preview.id,
      preview_url: previewUrl,
    };
  }

  const transporter = getSmtpTransporter();

  try {
    console.log('📨 Sending email to:', to);

    const info = await transporter.sendMail({
      from: `"${fromEmailName}" <${fromEmail}>`,
      to: toName ? `"${toName}" <${to}>` : to,
      subject,
      html: htmlContent,
      attachments,
    });

    console.log('✅ Email sent via SMTP:', info.messageId, '| Recipient:', to);
    console.log("Email details:", info);
    return info;
  } catch (error) {
    console.error('❌ SMTP email error:', error.message);
    throw new Error(error.message || 'Failed to send email via SMTP');
  }
}

/**
 * Send lead assignment notification email
 */
async function sendLeadAssignmentEmail({
  salesperson_email,
  salesperson_name,
  lead_data
}) {
  const formatFollowUpDateTime = (value) => {
    if (!value) return 'N/A';

    const raw = String(value).trim();
    if (!raw) return 'N/A';

    const localDateTimeMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);

    if (localDateTimeMatch) {
      const [, y, mo, d, h = '00', mi = '00'] = localDateTimeMatch;
      const year = Number(y);
      const month = Number(mo);
      const day = Number(d);
      const hours24 = Number(h);
      const minutes = Number(mi);

      if (
        Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day) &&
        Number.isFinite(hours24) && Number.isFinite(minutes)
      ) {
        const displayDate = formatDate(new Date(year, month - 1, day));

        if (!localDateTimeMatch[4]) return displayDate;

        const ampm = hours24 >= 12 ? 'PM' : 'AM';
        const hours12 = hours24 % 12 || 12;
        return `${displayDate}, ${hours12}:${String(minutes).padStart(2, '0')} ${ampm}`;
      }
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const dPart = formatDate(parsed);
      let hours24 = parsed.getHours();
      const minutes = String(parsed.getMinutes()).padStart(2, '0');
      const ampm = hours24 >= 12 ? 'PM' : 'AM';
      const hours12 = hours24 % 12 || 12;
      return `${dPart}, ${hours12}:${minutes} ${ampm}`;
    }

    return raw;
  };

  const followUpDisplay = formatFollowUpDateTime(lead_data.follow_up_date);
  const leadFullName = `${lead_data.first_name || ''} ${lead_data.last_name || ''}`.trim() || 'Lead';

  const rows = [
    { label: 'Lead Name', value: leadFullName },
    { label: 'Email', value: lead_data.email || 'N/A' },
    { label: 'Phone', value: lead_data.phone_number || 'N/A' },
    { label: 'Company', value: lead_data.company_name || 'N/A' },
    { label: 'Status', value: lead_data.lead_status || 'N/A' },
    { label: 'Priority', value: lead_data.priority || 'N/A' },
    { label: 'Assigned Salesperson', value: salesperson_name || 'N/A' },
    { label: 'Follow-up Date', value: lead_data.follow_up_date ? followUpDisplay : null },
    { label: 'Amount', value: lead_data.amount || null },
    { label: 'Notes', value: lead_data.notes || null },
  ];

  const customFieldRows = Array.isArray(lead_data.custom_fields)
    ? lead_data.custom_fields.map((f) => [
      f?.field_name || f?.label || f?.name || 'Field',
      f?.value ?? f?.field_value ?? 'N/A',
    ])
    : [];

  const htmlContent = renderUnifiedEmailTemplate({
    title: 'New Lead Assigned',
    subtitle: 'A new lead has been assigned to your account.',
    greeting: `Hi ${salesperson_name || salesperson_email},`,
    intro: 'Lead details are listed below.',
    rows,
    table: customFieldRows.length
      ? {
        title: 'Custom Fields',
        headers: [
          { label: 'Field', align: 'left' },
          { label: 'Value', align: 'right' },
        ],
        rows: customFieldRows,
      }
      : null,
    outro: ['Please login to CRM to view and manage this lead.'],
  });

  return sendBrevoEmail({
    to: salesperson_email,
    toName: salesperson_name || salesperson_email,
    subject: `New Lead Assigned: ${lead_data.first_name || ''} ${lead_data.last_name || ''}`,
    htmlContent
  });
}

/**
 * Send quotation notification email
 */
async function sendQuotationEmail({
  customer_email,
  customer_name,
  quotation_number,
  quotation_details = {},
  items = [],
  attachments = []
}) {
  const eventRows = [
    { label: 'Mode', value: quotation_details.quotation_mode },
    { label: 'Event Name', value: quotation_details.event_name },
    { label: 'Event Date', value: formatDisplayDate(quotation_details.event_date) },
    { label: 'Event Time', value: formatDisplayEventTime(quotation_details.event_start_time, quotation_details.event_end_time, quotation_details.event_time) },
    { label: 'Event Location', value: quotation_details.event_location },
    { label: 'PAX', value: quotation_details.pax },
    { label: 'Total Amount', value: quotation_details.total_amount },
  ].filter((r) => r.value !== undefined && r.value !== null && String(r.value).trim() !== '');

  const tableRows = items.map((item) => [
    item.product_name || 'Item',
    item.quantity ?? '-',
    item.selling_price ?? '-',
    item.line_total ?? '-',
  ]);

  const htmlContent = renderUnifiedEmailTemplate({
    title: 'Your Quotation is Ready',
    subtitle: `Quotation ${quotation_number} has been prepared.`,
    greeting: `Dear ${customer_name || 'Customer'},`,
    intro: 'The quotation PDF is attached with this email.',
    rows: eventRows,
    table: tableRows.length
      ? {
        title: 'Items',
        headers: [
          { label: 'Item', align: 'left' },
          { label: 'Qty', align: 'right' },
          { label: 'Rate', align: 'right' },
          { label: 'Total', align: 'right' },
        ],
        rows: tableRows,
      }
      : null,
    outro: ['Thank you for your interest.'],
  });

  return sendBrevoEmail({
    to: customer_email,
    toName: customer_name,
    subject: `Quotation ${quotation_number} - Zoans CRM`,
    htmlContent,
    attachments,
  });
}

/**
 * Send invoice notification email
 */
async function sendInvoiceEmail({
  customer_email,
  customer_name,
  invoice_number,
  documentLabel = 'Invoice',
  invoice_details = {},
  items = [],
  attachments = []
}) {
  const invoiceRows = [
    { label: 'Issue Date', value: formatDisplayDate(invoice_details.issue_date) },
    { label: 'Due Date', value: formatDisplayDate(invoice_details.due_date) },
    { label: 'Status', value: invoice_details.status },
    { label: 'Total Amount', value: invoice_details.total_amount },
  ].filter((r) => r.value !== undefined && r.value !== null && String(r.value).trim() !== '');

  const tableRows = items.map((item) => [
    item.description || 'Item',
    item.quantity ?? '-',
    item.unit_price ?? '-',
    item.line_total ?? '-',
  ]);

  const htmlContent = renderUnifiedEmailTemplate({
    title: `Your ${documentLabel} is Ready`,
    subtitle: `${documentLabel} ${invoice_number} has been generated.`,
    greeting: `Dear ${customer_name || 'Customer'},`,
    intro: `The ${documentLabel.toLowerCase()} PDF is attached with this email.`,
    rows: invoiceRows,
    table: tableRows.length
      ? {
        title: 'Items',
        headers: [
          { label: 'Item', align: 'left' },
          { label: 'Qty', align: 'right' },
          { label: 'Rate', align: 'right' },
          { label: 'Total', align: 'right' },
        ],
        rows: tableRows,
      }
      : null,
    outro: [
      'Please process the payment at your earliest convenience.',
      'Thank you for your business.',
    ],
  });

  return sendBrevoEmail({
    to: customer_email,
    toName: customer_name,
    subject: `${documentLabel} ${invoice_number} - Zoans CRM`,
    htmlContent,
    attachments,
  });
}

async function sendOrderReceivedEmail({
  customer_email,
  customer_name,
  work_order_number,
  order_details = {},
  items = []
}) {
  const fulfillmentDisplay =
    order_details.requested_fulfillment_at ||
    [formatDisplayDate(order_details.event_date), formatDisplayEventTime(order_details.event_start_time, order_details.event_end_time, order_details.event_time)]
      .filter(Boolean)
      .join(', ');

  const orderRows = [
    { label: 'Order Number', value: work_order_number },
    { label: 'Order Date', value: formatDisplayDate(order_details.issue_date) },
    { label: 'Receiving Time', value: fulfillmentDisplay },
    { label: 'Grand Total', value: formatCurrency(order_details.grand_total) },
  ].filter((r) => r.value !== undefined && r.value !== null && String(r.value).trim() !== '');

  const tableRows = items.map((item) => [
    item.name || item.description || 'Item',
    formatWholeQuantityLabel(item.quantity ?? item.qty),
  ]);

  const htmlContent = renderUnifiedEmailTemplate({
    title: 'Order Confirmation',
    subtitle: 'Your order has been received and is now in processing.',
    greeting: `Dear ${customer_name || 'Customer'},`,
    intro: 'Thank you for your order. We have shared it with our operations team.',
    rows: orderRows,
    table: tableRows.length
      ? {
        title: 'Items',
        headers: [
          { label: 'Item', align: 'left' },
          { label: 'Qty', align: 'right' },
        ],
        rows: tableRows,
      }
      : null,
    outro: [
      'If you need to modify delivery timing, please contact our team as early as possible.',
    ],
  });

  return sendBrevoEmail({
    to: customer_email,
    toName: customer_name,
    subject: `Order Received${work_order_number ? ` - ${work_order_number}` : ''}`,
    htmlContent,
  });
}

async function sendPaymentReminderEmail({
  customer_email,
  customer_name,
  invoice_number,
  invoice_details = {}
}) {
  const reminderRows = [
    { label: 'Invoice Number', value: invoice_number },
    { label: 'Invoice Date', value: formatDisplayDate(invoice_details.issue_date) },
    { label: 'Due Date', value: formatDisplayDate(invoice_details.due_date) },
    { label: 'Invoice Total', value: formatCurrency(invoice_details.grand_total) },
    { label: 'Paid Amount', value: formatCurrency(invoice_details.paid_amount) },
    { label: 'Pending Amount', value: formatCurrency(invoice_details.balance_due) },
  ].filter((row) => row.value !== undefined && row.value !== null && String(row.value).trim() !== '');

  const htmlContent = renderUnifiedEmailTemplate({
    title: 'Payment Reminder',
    subtitle: invoice_number ? `Invoice ${invoice_number}` : 'Pending payment reminder',
    greeting: `Dear ${customer_name || 'Customer'},`,
    intro: 'This is a gentle reminder for your pending payment.',
    rows: reminderRows,
    outro: ['Please process the pending amount at your earliest convenience.', 'Thank you.'],
  });

  return sendBrevoEmail({
    to: customer_email,
    toName: customer_name,
    subject: `Payment Reminder${invoice_number ? ` - ${invoice_number}` : ''}`,
    htmlContent,
  });
}

function getOrderStatusLabel(status) {
  const raw = String(status || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');

  if (raw === 'preparing') return 'Preparing';
  if (raw === 'prepared' || raw === 'ready') return 'Prepared';
  if (raw === 'out_for_delivery') return 'Out for Delivery';
  if (raw === 'delivered') return 'Delivered';
  if (raw === 'cancelled') return 'Cancelled';

  return null;
}

async function sendOrderStatusEmail({
  customer_email,
  customer_name,
  work_order_number,
  order_status,
  order_details = {},
}) {
  const orderStatusLabel = getOrderStatusLabel(order_status);
  if (!orderStatusLabel) return null;

  const orderDate =
    order_details.order_date ||
    order_details.event_date ||
    order_details.delivery_date ||
    null;

  const orderTime =
    order_details.order_time ||
    order_details.event_time ||
    order_details.delivery_time ||
    null;

  const orderLocation =
    order_details.order_location ||
    order_details.event_location ||
    order_details.delivery_location ||
    null;

  const rows = [
    { label: 'Work Order', value: work_order_number },
    { label: 'Order Status', value: orderStatusLabel },
    { label: 'Delivery Date', value: formatDisplayDate(orderDate) },
    { label: 'Delivery Time', value: formatDisplayEventTime(order_details.event_start_time, order_details.event_end_time, orderTime) },
    { label: 'Delivery Location', value: orderLocation },
  ];

  // If delivery person details are present, add them to the email rows
  if (order_details.delivery_man_name || order_details.delivery_man_phone || order_details.delivery_man_vehicle) {
    rows.push({ label: 'Delivery Person', value: `${order_details.delivery_man_name || '-'}${order_details.delivery_man_phone ? ` • ${order_details.delivery_man_phone}` : ''}${order_details.delivery_man_vehicle ? ` • ${order_details.delivery_man_vehicle}` : ''}` });
  }

  const htmlContent = renderUnifiedEmailTemplate({
    title: 'Order Status Update',
    subtitle: `Your order is now ${orderStatusLabel}.`,
    greeting: `Dear ${customer_name || 'Customer'},`,
    intro: 'Please find your latest order status update below.',
    rows,
    outro: ['Thank you for choosing us.'],
  });

  return sendBrevoEmail({
    to: customer_email,
    toName: customer_name,
    subject: `Order Status Update${work_order_number ? ` - ${work_order_number}` : ''}`,
    htmlContent,
  });
}

async function sendOrderFeedbackRequestEmail({
  customer_email,
  customer_name,
  work_order_number,
  feedback_token,
  email_subject,
  items = [],
}) {
  if (!feedback_token) return null;

  const baseUrl = String(process.env.FEEDBACK_FORM_BASE_URL || 'http://localhost:4000').trim().replace(/\/$/, '');
  const feedbackUrl = `${baseUrl}/feedback?token=${encodeURIComponent(feedback_token)}`;

  const tableRows = (items || []).map((item) => [
    item.product_name || 'Item',
    formatWholeQuantityLabel(item.quantity),
  ]);

  const htmlContent = renderUnifiedEmailTemplate({
    title: 'How was your order?',
    subtitle: work_order_number
      ? `Please share feedback for ${work_order_number}`
      : 'Please share your feedback with us',
    greeting: `Dear ${customer_name || 'Customer'},`,
    intro: 'Your order has been delivered. We would love your feedback on food, service and delivery experience.',
    rows: [
      { label: 'Work Order', value: work_order_number },
    ],
    table: tableRows.length
      ? {
        title: 'Ordered Items',
        headers: [
          { label: 'Item', align: 'left' },
          { label: 'Qty', align: 'right' },
        ],
        rows: tableRows,
      }
      : null,
    cta: {
      label: 'Click here to open feedback form',
      url: feedbackUrl,
    },
    outro: [
      'Please click the button above to share your feedback.',
      'Thank you for ordering with us.',
    ],
  });

  return sendBrevoEmail({
    to: customer_email,
    toName: customer_name,
    subject: String(email_subject || `Feedback Request${work_order_number ? ` - ${work_order_number}` : ''}`),
    htmlContent,
  });
}

module.exports = {
  sendBrevoEmail,
  sendLeadAssignmentEmail,
  sendQuotationEmail,
  sendInvoiceEmail,
  sendOrderReceivedEmail,
  sendPaymentReminderEmail,
  sendOrderStatusEmail,
  sendOrderFeedbackRequestEmail,
  listMailPreviews,
  getMailPreviewById,
  // Exported for use by external controllers so all emails share the same template
  renderUnifiedEmailTemplate,
};

