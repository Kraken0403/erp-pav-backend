const db = require('../config/db');
const { sendPaymentReminderEmail } = require('../services/brevoService');
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService');
const {
  normalizePhoneForWhatsApp,
  createPaymentReminderPayload,
} = require('../utils/whatsappTemplatePayloads');

const ALLOWED_FREQUENCIES = ['daily', 'weekly', 'fortnightly', 'monthly'];

const scheduler = require('../services/paymentReminderScheduler');

const normalizeTime = (value, fallback = '10:00:00') => {
  if (!value) return fallback;

  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return fallback;

  const [, hh, mm, ss = '00'] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return fallback;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const parseJsonSafe = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const ensureSettingsRowExists = async () => {
  const [rows] = await db.query(
    `SELECT id FROM payment_reminder_settings LIMIT 1`
  );

  if (rows.length) return rows[0].id;

  const [result] = await db.query(
    `
    INSERT INTO payment_reminder_settings
    (
      frequency,
      email_send_time,
      whatsapp_send_time,
      is_email_enabled,
      is_whatsapp_enabled
    )
    VALUES ('daily', '10:00:00', '10:00:00', 1, 0)
    `
  );

  return result.insertId;
};

exports.getPaymentReminderSettings = async (req, res) => {
  try {
    await ensureSettingsRowExists();

    const [rows] = await db.query(
      `SELECT * FROM payment_reminder_settings LIMIT 1`
    );

    return res.status(200).json(rows[0]);
  } catch (error) {
    console.error('getPaymentReminderSettings error:', error);
    return res.status(500).json({ error: error.message });
  }
};

exports.savePaymentReminderSettings = async (req, res) => {
  try {
    const settingsId = await ensureSettingsRowExists();

    const {
      frequency,
      email_send_time,
      whatsapp_send_time,
      is_email_enabled,
      is_whatsapp_enabled,
    } = req.body;

    const now = new Date();
    const nowHHMMSS = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const safeFrequency = ALLOWED_FREQUENCIES.includes(String(frequency || '').toLowerCase())
      ? String(frequency).toLowerCase()
      : 'daily';

    // If a channel is disabled, set its send_time to current server time so the UI/DB reflects datetime.now
    const effectiveEmailTime = is_email_enabled ? normalizeTime(email_send_time, '10:00:00') : nowHHMMSS;
    const effectiveWhatsAppTime = is_whatsapp_enabled ? normalizeTime(whatsapp_send_time, '10:00:00') : nowHHMMSS;

    await db.query(
      `
      UPDATE payment_reminder_settings
      SET
        frequency = ?,
        email_send_time = ?,
        whatsapp_send_time = ?,
        is_email_enabled = ?,
        is_whatsapp_enabled = ?
      WHERE id = ?
      `,
      [
        safeFrequency,
        effectiveEmailTime,
        effectiveWhatsAppTime,
        is_email_enabled ? 1 : 0,
        is_whatsapp_enabled ? 1 : 0,
        settingsId,
      ]
    );

    // Start or stop scheduler depending on enabled flags
    try {
      if (Number(is_email_enabled || 0) === 0 && Number(is_whatsapp_enabled || 0) === 0) {
        scheduler.stopPaymentReminderScheduler('both channels disabled via settings');
      } else {
        scheduler.startPaymentReminderScheduler();
      }
    } catch (e) {
      console.error('scheduler start/stop error:', e && e.message ? e.message : e);
    }

    return res.status(200).json({ message: 'Payment reminder settings saved successfully' });
  } catch (error) {
    console.error('savePaymentReminderSettings error:', error);
    return res.status(500).json({ error: error.message });
  }
};

exports.getPendingPaymentReminders = async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        i.id,
        i.invoice_number,
        i.issue_date,
        i.due_date,
        i.status,
        i.grand_total,
        i.billing_snapshot,
        l.first_name,
        l.last_name,
        l.email,
        COALESCE(
          SUM(
            CASE
              WHEN UPPER(COALESCE(ip.payment_method, '')) = 'OTHER' THEN 0
              ELSE COALESCE(ip.amount, 0)
            END
          ),
          0
        ) AS paid_amount
      FROM invoices i
      LEFT JOIN leads l ON l.id = i.lead_id
      LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
      WHERE i.status NOT IN ('paid', 'cancelled')
      GROUP BY i.id
      ORDER BY COALESCE(i.due_date, i.issue_date) ASC, i.id DESC
      `
    );

    const pending = rows
      .map((row) => {
        const billing = parseJsonSafe(row.billing_snapshot);
        const customerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || billing.name || 'Customer';
        const customerEmail = row.email || billing.email || null;

        const grandTotal = Number(row.grand_total || 0);
        const paidAmount = Number(row.paid_amount || 0);
        const balanceDue = Math.max(0, grandTotal - paidAmount);

        return {
          id: row.id,
          invoice_number: row.invoice_number,
          issue_date: row.issue_date,
          due_date: row.due_date,
          status: row.status,
          customer_name: customerName,
          customer_email: customerEmail,
          grand_total: grandTotal,
          paid_amount: paidAmount,
          balance_due: balanceDue,
        };
      })
      .filter((row) => row.balance_due > 0);

    return res.status(200).json({ pending_payments: pending });
  } catch (error) {
    console.error('getPendingPaymentReminders error:', error);
    return res.status(500).json({ error: error.message });
  }
};

exports.sendPaymentReminderByInvoiceId = async (req, res) => {
  const { invoiceId } = req.params;

  try {
    const [rows] = await db.query(
      `
      SELECT
        i.id,
        i.invoice_number,
        i.issue_date,
        i.due_date,
        i.status,
        i.grand_total,
        i.billing_snapshot,
        l.first_name,
        l.last_name,
        l.email,
        COALESCE(
          SUM(
            CASE
              WHEN UPPER(COALESCE(ip.payment_method, '')) = 'OTHER' THEN 0
              ELSE COALESCE(ip.amount, 0)
            END
          ),
          0
        ) AS paid_amount
      FROM invoices i
      LEFT JOIN leads l ON l.id = i.lead_id
      LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
      WHERE i.id = ?
      GROUP BY i.id
      LIMIT 1
      `,
      [invoiceId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const row = rows[0];
    const billing = parseJsonSafe(row.billing_snapshot);

    const customerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || billing.name || 'Customer';
    const customerEmail = row.email || billing.email || null;

    if (!customerEmail) {
      return res.status(400).json({ error: 'Customer email not found for this invoice' });
    }

    const grandTotal = Number(row.grand_total || 0);
    const paidAmount = Number(row.paid_amount || 0);
    const balanceDue = Math.max(0, grandTotal - paidAmount);

    if (balanceDue <= 0) {
      return res.status(400).json({ error: 'No pending amount for this invoice' });
    }

    const result = await sendPaymentReminderEmail({
      customer_email: customerEmail,
      customer_name: customerName,
      invoice_number: row.invoice_number,
      invoice_details: {
        issue_date: row.issue_date,
        due_date: row.due_date,
        grand_total: grandTotal,
        paid_amount: paidAmount,
        balance_due: balanceDue,
      },
    });

    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];

    if (!accepted.length || rejected.length) {
      return res.status(502).json({
        error: 'SMTP accepted/rejected mismatch while sending payment reminder',
        accepted,
        rejected,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Payment reminder sent to ${customerEmail}`,
      accepted,
    });
  } catch (error) {
    console.error('sendPaymentReminderByInvoiceId error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send payment reminder' });
  }
};

exports.sendPaymentReminderWhatsAppByInvoiceId = async (req, res) => {
  const { invoiceId } = req.params;

  try {
    const [rows] = await db.query(
      `
      SELECT
        i.id,
        i.invoice_number,
        i.issue_date,
        i.due_date,
        i.status,
        i.grand_total,
        i.billing_snapshot,
        l.first_name,
        l.last_name,
        l.phone_number,
        COALESCE(
          SUM(
            CASE
              WHEN UPPER(COALESCE(ip.payment_method, '')) = 'OTHER' THEN 0
              ELSE COALESCE(ip.amount, 0)
            END
          ),
          0
        ) AS paid_amount
      FROM invoices i
      LEFT JOIN leads l ON l.id = i.lead_id
      LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
      WHERE i.id = ?
      GROUP BY i.id
      LIMIT 1
      `,
      [invoiceId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const row = rows[0];
    const billing = parseJsonSafe(row.billing_snapshot);

    const customerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || billing.name || 'Customer';
    const customerPhone = normalizePhoneForWhatsApp(row.phone_number || billing.phone || null);

    if (!customerPhone) {
      return res.status(400).json({ error: 'Customer phone not found for this invoice' });
    }

    const grandTotal = Number(row.grand_total || 0);
    const paidAmount = Number(row.paid_amount || 0);
    const balanceDue = Math.max(0, grandTotal - paidAmount);

    if (balanceDue <= 0) {
      return res.status(400).json({ error: 'No pending amount for this invoice' });
    }

    const result = await sendWhatsAppTemplateMessage(
      createPaymentReminderPayload({
        phoneNumber: customerPhone,
        customerName,
        invoiceNumber: row.invoice_number || `INV-${row.id}`,
        invoiceDate: row.issue_date,
        invoiceTotal: grandTotal,
        paidAmount,
        pendingAmount: balanceDue,
      })
    );

    return res.status(200).json({
      success: true,
      message: `Payment reminder WhatsApp sent to ${customerPhone}`,
      data: result,
    });
  } catch (error) {
    console.error('sendPaymentReminderWhatsAppByInvoiceId error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send payment reminder WhatsApp' });
  }
};

exports.runPaymentRemindersNow = async (req, res) => {
  try {
    const scheduler = require('../services/paymentReminderScheduler');
    await scheduler.runNow();
    return res.status(200).json({ success: true, message: 'Payment reminder scheduler executed' });
  } catch (error) {
    console.error('runPaymentRemindersNow error:', error);
    return res.status(500).json({ error: error.message || 'Failed to run scheduler' });
  }
};
