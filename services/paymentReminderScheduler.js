const db = require('../config/db');
const cron = require('node-cron');
const { sendPaymentReminderEmail } = require('./brevoService');
const { sendWhatsAppTemplateMessage } = require('./whatsappNotfinoService');
const { createPaymentReminderPayload, normalizePhoneForWhatsApp } = require('../utils/whatsappTemplatePayloads');
const { DateTime } = require('luxon');

let schedulerTask = null;
let lastHandledMinuteKey = null;
let isSchedulerCycleRunning = false;

const parseJsonSafe = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const formatMinuteKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

const toTimeHHMM = (value) => {
  if (!value) return null;
  return String(value).slice(0, 5);
};

const addMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);

  if (d.getDate() < day) {
    d.setDate(0);
  }

  return d;
};

const shouldRunByFrequency = (frequency, lastRunAt, now) => {
  if (!lastRunAt) return true;

  const lastRun = new Date(lastRunAt);
  if (Number.isNaN(lastRun.getTime())) return true;

  const msDiff = now.getTime() - lastRun.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  switch (String(frequency || 'daily').toLowerCase()) {
    case 'weekly':
      return msDiff >= 7 * dayMs;
    case 'fortnightly':
      return msDiff >= 14 * dayMs;
    case 'monthly': {
      const nextMonthlyRun = addMonths(lastRun, 1);
      return now.getTime() >= nextMonthlyRun.getTime();
    }
    case 'daily':
    default:
      return msDiff >= dayMs;
  }
};

const getPendingInvoices = async () => {
  const [rows] = await db.query(
    `
    SELECT
      i.id,
      i.invoice_number,
      i.issue_date,
      i.due_date,
      i.grand_total,
      i.status,
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
    ORDER BY i.id DESC
    `
  );

  return rows
    .map((row) => {
      const billing = parseJsonSafe(row.billing_snapshot);
      const customerName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || billing.name || 'Customer';
      const customerEmail = row.email || billing.email || null;

      const grandTotal = Number(row.grand_total || 0);
      const paidAmount = Number(row.paid_amount || 0);
      const balanceDue = Math.max(0, grandTotal - paidAmount);

      return {
        ...row,
        customer_name: customerName,
        customer_email: customerEmail,
        grand_total: grandTotal,
        paid_amount: paidAmount,
        balance_due: balanceDue,
      };
    })
    .filter((row) => row.customer_email && row.balance_due > 0);
};

const runReminderCycle = async () => {
  if (isSchedulerCycleRunning) {
    return;
  }

  isSchedulerCycleRunning = true;

  try {
  const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  const nowTz = DateTime.now().setZone(tz);
  const minuteKey = nowTz.toFormat('yyyy-MM-dd HH:mm');

  if (lastHandledMinuteKey === minuteKey) {
    return;
  }

  const [[settings]] = await db.query(`SELECT * FROM payment_reminder_settings LIMIT 1`);
  if (!settings) return;

  const currentHHMM = nowTz.toFormat('HH:mm');

  // Log run start and settings for observability
  console.log('[payment-scheduler] run start', { minuteKey, currentHHMM, timezone: tz });
  console.log('[payment-scheduler] settings', {
    id: settings.id,
    is_email_enabled: Number(settings.is_email_enabled || 0),
    is_whatsapp_enabled: Number(settings.is_whatsapp_enabled || 0),
    email_send_time: settings.email_send_time,
    whatsapp_send_time: settings.whatsapp_send_time,
    frequency: settings.frequency,
    last_email_run_at: settings.last_email_run_at,
    last_whatsapp_run_at: settings.last_whatsapp_run_at,
  });

  // We'll attempt email and whatsapp runs depending on settings and configured times
  lastHandledMinuteKey = minuteKey;

  // Mark invoices as overdue when their due_date has passed and they have a positive balance
  try {
    await db.query(
      `
      UPDATE invoices i
      LEFT JOIN (
        SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid_amount
        FROM invoice_payments
        GROUP BY invoice_id
      ) p ON p.invoice_id = i.id
      SET i.status = 'overdue'
      WHERE LOWER(COALESCE(i.status, '')) NOT IN ('paid', 'cancelled', 'overdue')
        AND i.due_date IS NOT NULL
        AND i.due_date < CURDATE()
        AND COALESCE(i.grand_total, 0) > COALESCE(p.paid_amount, 0)
      `
    );
  } catch (err) {
    console.error('Failed to mark overdue invoices:', err && err.message ? err.message : err);
  }

  // Fetch pending invoices once
  const pendingInvoices = await getPendingInvoices();
  console.log('[payment-scheduler] pending invoices fetched', { count: pendingInvoices.length });

  if (!pendingInvoices.length) {
    console.log('[payment-scheduler] no pending invoices to process, skipping cycles');
  }

  // EMAIL cycle
  try {
    if (Number(settings.is_email_enabled || 0) === 1) {
      const targetEmailHHMM = toTimeHHMM(settings.email_send_time);
      if (!targetEmailHHMM) {
        console.warn('[payment-scheduler] email cycle skipped: invalid email_send_time', { raw: settings.email_send_time });
      } else if (currentHHMM !== targetEmailHHMM) {
        console.log('[payment-scheduler] email cycle skipped: current minute does not match configured email_send_time', { currentHHMM, targetEmailHHMM });
      } else if (!shouldRunByFrequency(settings.frequency, settings.last_email_run_at, nowTz.toJSDate())) {
        console.log('[payment-scheduler] email cycle skipped: frequency gating prevents run', { frequency: settings.frequency, last_email_run_at: settings.last_email_run_at });
      } else {
        let sentCount = 0;
        console.log('[payment-scheduler] starting email cycle', { pendingCount: pendingInvoices.length });
        for (const invoice of pendingInvoices) {
          try {
            await sendPaymentReminderEmail({
              customer_email: invoice.customer_email,
              customer_name: invoice.customer_name,
              invoice_number: invoice.invoice_number,
              invoice_details: {
                issue_date: invoice.issue_date,
                due_date: invoice.due_date,
                grand_total: invoice.grand_total,
                paid_amount: invoice.paid_amount,
                balance_due: invoice.balance_due,
              },
            });
            sentCount += 1;
          } catch (error) {
            console.error('[payment-scheduler] Payment reminder auto-email failed for invoice ' + invoice.id + ':', error && error.message ? error.message : error);
          }
        }

        await db.query(`UPDATE payment_reminder_settings SET last_email_run_at = NOW() WHERE id = ?`, [settings.id]);
        console.log('[payment-scheduler] email cycle complete', { sent: sentCount });
      }
    } else {
      console.log('[payment-scheduler] email cycle skipped: email disabled in settings');
    }
  } catch (err) {
    console.error('[payment-scheduler] Error in email reminder cycle:', err && err.message ? err.message : err);
  }

  // WHATSAPP cycle
  try {
    if (Number(settings.is_whatsapp_enabled || 0) === 1) {
      const targetWhatsAppHHMM = toTimeHHMM(settings.whatsapp_send_time);
      if (!targetWhatsAppHHMM) {
        console.warn('[payment-scheduler] whatsapp cycle skipped: invalid whatsapp_send_time', { raw: settings.whatsapp_send_time });
      } else if (currentHHMM !== targetWhatsAppHHMM) {
        console.log('[payment-scheduler] whatsapp cycle skipped: current minute does not match configured whatsapp_send_time', { currentHHMM, targetWhatsAppHHMM });
      } else if (!shouldRunByFrequency(settings.frequency, settings.last_whatsapp_run_at, nowTz.toJSDate())) {
        console.log('[payment-scheduler] whatsapp cycle skipped: frequency gating prevents run', { frequency: settings.frequency, last_whatsapp_run_at: settings.last_whatsapp_run_at });
      } else {
        let sentWCount = 0;
        console.log('[payment-scheduler] starting whatsapp cycle', { pendingCount: pendingInvoices.length });
        for (const invoice of pendingInvoices) {
          try {
            const billing = parseJsonSafe(invoice.billing_snapshot);
            const phoneRaw = billing.phone || invoice.phone || billing.mobile || billing.mobile_number || '';
            const phone = normalizePhoneForWhatsApp(phoneRaw);
            if (!phone) {
              console.warn('[payment-scheduler] Skipping WhatsApp reminder: no phone number', { invoiceId: invoice.id });
              continue;
            }

            const payload = createPaymentReminderPayload({
              phoneNumber: phone,
              customerName: invoice.customer_name,
              invoiceNumber: invoice.invoice_number,
              invoiceDate: invoice.issue_date,
              invoiceTotal: invoice.grand_total,
              paidAmount: invoice.paid_amount,
              pendingAmount: invoice.balance_due,
            });

            await sendWhatsAppTemplateMessage(payload);
            sentWCount += 1;
          } catch (error) {
            console.error('[payment-scheduler] Payment reminder auto-whatsapp failed for invoice', invoice && invoice.id ? invoice.id : '(unknown)', error && (error.response?.data || error.message) ? (error.response?.data || error.message) : error);
          }
        }

        await db.query(`UPDATE payment_reminder_settings SET last_whatsapp_run_at = NOW() WHERE id = ?`, [settings.id]);
        console.log('[payment-scheduler] whatsapp cycle complete', { sent: sentWCount });
      }
    } else {
      console.log('[payment-scheduler] whatsapp cycle skipped: whatsapp disabled in settings');
    }
  } catch (err) {
    console.error('[payment-scheduler] Error in whatsapp reminder cycle:', err && err.message ? err.message : err);
  }
  } finally {
    isSchedulerCycleRunning = false;
  }
};

const startPaymentReminderScheduler = () => {
  if (schedulerTask) return;

  schedulerTask = cron.schedule('* * * * *', async () => {
    try {
      await runReminderCycle();
    } catch (error) {
      console.error('Payment reminder scheduler error:', error.message);
    }
  }, {
    timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata'
  });

  console.log('Payment reminder cron scheduler started');
  // Log configured settings at start for visibility
  db.query(`SELECT * FROM payment_reminder_settings LIMIT 1`)
    .then(([rows]) => {
      const s = rows && rows[0];
      if (s) {
        console.log('[payment-scheduler] configured to send notifications', {
          email_enabled: Number(s.is_email_enabled || 0) === 1,
          email_send_time: s.email_send_time,
          whatsapp_enabled: Number(s.is_whatsapp_enabled || 0) === 1,
          whatsapp_send_time: s.whatsapp_send_time,
          frequency: s.frequency,
          timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
        });
      } else {
        console.log('[payment-scheduler] no settings row found at start');
      }
    })
    .catch((err) => {
      console.error('[payment-scheduler] failed to read settings on start:', err && err.message ? err.message : err);
    });
};

const stopPaymentReminderScheduler = (reason) => {
  try {
    if (!schedulerTask) {
      console.log('Payment reminder cron scheduler not running');
      return;
    }

    // stop will halt the scheduled task; destroy frees resources
    try {
      schedulerTask.stop();
    } catch (e) {
      // ignore
    }

    try {
      if (typeof schedulerTask.destroy === 'function') schedulerTask.destroy();
    } catch (e) {
      // ignore
    }

    schedulerTask = null;
    console.log('Payment reminder cron scheduler stopped', reason ? { reason } : {});
  } catch (err) {
    console.error('Failed to stop payment reminder scheduler:', err && err.message ? err.message : err);
  }
};

// Expose run function so controllers/routes can trigger it manually for testing
const runNow = async () => runReminderCycle();

module.exports = {
  startPaymentReminderScheduler,
  stopPaymentReminderScheduler,
  runNow,
};
