const db = require('../config/db');
const cron = require('node-cron');
const crypto = require('crypto');
const { sendOrderFeedbackRequestEmail } = require('./brevoService');
const { sendWhatsAppTemplateMessage } = require('./whatsappNotfinoService');
const {
  normalizePhoneForWhatsApp,
  createOrderFeedbackPayload,
} = require('../utils/whatsappTemplatePayloads');

let schedulerTask = null;
let isSchedulerCycleRunning = false;

const parseDelayMinutes = (raw, fallback) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(Math.max(rounded, 1), 1440);
};

const getEnvDelayOverride = () => {
  const primary = String(process.env.FEEDBACK_DELAY_MINUTES || '').trim();
  const alias = String(process.env.FEEDBACK_DELAY_MINUTS || '').trim();
  const selected = primary || alias;
  if (!selected) return null;

  return parseDelayMinutes(selected, 30);
};

const DEFAULT_SETTINGS = {
  is_email_enabled: 1,
  delay_minutes: getEnvDelayOverride() || 30,
  email_subject: 'How was your order?',
};

const generateFeedbackToken = () => crypto.randomBytes(24).toString('hex');

const getScheduledForFromDb = async (delayMinutes) => {
  const [rows] = await db.query(
    `SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS scheduled_for`,
    [delayMinutes]
  );

  return rows?.[0]?.scheduled_for || null;
};

const ensureFeedbackSettingsRow = async () => {
  const [rows] = await db.query(`SELECT id FROM order_feedback_settings LIMIT 1`);

  if (rows.length) return rows[0].id;

  const [result] = await db.query(
    `
    INSERT INTO order_feedback_settings
    (is_email_enabled, delay_minutes, email_subject)
    VALUES (?, ?, ?)
    `,
    [
      DEFAULT_SETTINGS.is_email_enabled,
      DEFAULT_SETTINGS.delay_minutes,
      DEFAULT_SETTINGS.email_subject,
    ]
  );

  return result.insertId;
};

const getFeedbackSettings = async () => {
  await ensureFeedbackSettingsRow();

  const [rows] = await db.query(`SELECT * FROM order_feedback_settings LIMIT 1`);
  const settings = rows[0] || {};

  const envDelayOverride = getEnvDelayOverride();
  const delay = envDelayOverride ?? Number(settings.delay_minutes);

  return {
    is_email_enabled: Number(settings.is_email_enabled ?? DEFAULT_SETTINGS.is_email_enabled) === 1,
    delay_minutes: Number.isInteger(delay) ? Math.min(Math.max(delay, 1), 1440) : DEFAULT_SETTINGS.delay_minutes,
    email_subject: String(settings.email_subject || DEFAULT_SETTINGS.email_subject).slice(0, 255),
  };
};

const getWorkOrderCustomerPhone = async (workOrderId) => {
  if (!workOrderId) return null;

  const [rows] = await db.query(
    `
    SELECT JSON_UNQUOTE(JSON_EXTRACT(billing_snapshot, '$.phone')) AS customer_phone
    FROM work_orders
    WHERE id = ?
    LIMIT 1
    `,
    [workOrderId]
  );

  const phone = rows?.[0]?.customer_phone;
  if (!phone) return null;
  const normalized = String(phone).trim();
  return normalized || null;
};

const scheduleOrderFeedbackRequest = async ({
  workOrderId,
  customerEmail,
  customerName,
  workOrderNumber,
}) => {
  if (!workOrderId || !customerEmail) {
    console.log('[feedback-scheduler] Skip scheduling: missing workOrderId or customerEmail', {
      workOrderId,
      customerEmail: Boolean(customerEmail),
    });
    return;
  }

  const settings = await getFeedbackSettings();
  if (!settings.is_email_enabled) {
    console.log('[feedback-scheduler] Skip scheduling: email is disabled in order_feedback_settings');
    return;
  }

  // Determine scheduled time: schedule relative to NOW (delivery marked complete time)
  // The caller (deliveryController.updateDeliveryStatus) invokes this function when
  // a delivery is marked 'delivered' — so compute scheduled_for as NOW + delay_minutes.
  let scheduledFor = null;
  try {
    scheduledFor = await getScheduledForFromDb(settings.delay_minutes);
  } catch (err) {
    console.warn('[feedback-scheduler] Failed to compute scheduledFor via DB, falling back to JS Date', err);
    scheduledFor = new Date(Date.now() + (Number(settings.delay_minutes || 30) * 60 * 1000));
  }
  const customerPhone = await getWorkOrderCustomerPhone(workOrderId);

  const toISTISOString = (d) => {
    if (!d) return null;
    const date = new Date(d);
    // compute IST time by converting UTC then adding +05:30
    const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
    const istMs = utcMs + (330 * 60 * 1000);
    const ist = new Date(istMs);
    const pad = (n) => String(n).padStart(2, '0');
    const YYYY = ist.getUTCFullYear();
    const MM = pad(ist.getUTCMonth() + 1);
    const DD = pad(ist.getUTCDate());
    const hh = pad(ist.getUTCHours());
    const mm = pad(ist.getUTCMinutes());
    const ss = pad(ist.getUTCSeconds());
    return `${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}+05:30`;
  };

  console.log('[feedback-scheduler] Scheduling feedback request', {
    workOrderId,
    customerEmail,
    delayMinutes: settings.delay_minutes,
    scheduledFor: scheduledFor ? (new Date(scheduledFor)).toString() : null,
    scheduledFor_ist: scheduledFor ? toISTISOString(scheduledFor) : null,
  });

  const [existingRows] = await db.query(
    `
    SELECT id, feedback_token, submitted_at
    FROM order_feedback_requests
    WHERE work_order_id = ?
    LIMIT 1
    `,
    [workOrderId]
  );

  if (existingRows.length) {
    const existing = existingRows[0];

    if (existing.submitted_at) {
      return;
    }

    await db.query(
      `
      UPDATE order_feedback_requests
      SET
        customer_email = ?,
        customer_name = ?,
        customer_phone = ?,
        work_order_number = ?,
        scheduled_for = ?,
        sent_at = NULL,
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        customerEmail,
        customerName || null,
        customerPhone,
        workOrderNumber || null,
        scheduledFor,
        existing.id,
      ]
    );

    console.log('[feedback-scheduler] Updated existing feedback request with new scheduled time', {
      requestId: existing.id,
      workOrderId,
      scheduledFor: scheduledFor ? (new Date(scheduledFor)).toString() : null,
      scheduledFor_ist: scheduledFor ? toISTISOString(scheduledFor) : null,
    });

    return {
      requestId: existing.id,
      scheduledFor,
      scheduledFor_ist: scheduledFor ? toISTISOString(scheduledFor) : null,
    };
  }

  await db.query(
    `
    INSERT INTO order_feedback_requests
    (
      work_order_id,
      work_order_number,
      customer_email,
      customer_name,
      customer_phone,
      feedback_token,
      scheduled_for
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      workOrderId,
      workOrderNumber || null,
      customerEmail,
      customerName || null,
      customerPhone,
      generateFeedbackToken(),
      scheduledFor,
    ]
  );

  console.log('[feedback-scheduler] Inserted new feedback request', {
    workOrderId,
    workOrderNumber: workOrderNumber || null,
    scheduledFor: scheduledFor ? (new Date(scheduledFor)).toString() : null,
    scheduledFor_ist: scheduledFor ? toISTISOString(scheduledFor) : null,
  });

  return {
    requestId: null,
    scheduledFor,
    scheduledFor_ist: scheduledFor ? toISTISOString(scheduledFor) : null,
  };
};

const getWorkOrderItems = async (workOrderId) => {
  const [rows] = await db.query(
    `
    SELECT product_name, quantity
    FROM work_order_items
    WHERE work_order_id = ?
    ORDER BY id ASC
    `,
    [workOrderId]
  );

  return rows || [];
};

const runOrderFeedbackSchedulerCycle = async () => {
  if (isSchedulerCycleRunning) return;
  isSchedulerCycleRunning = true;

  try {
    const settings = await getFeedbackSettings();
    if (!settings.is_email_enabled) return;

    const [pendingRows] = await db.query(
      `
      SELECT
        id,
        work_order_id,
        work_order_number,
        customer_email,
        customer_name,
        customer_phone,
        feedback_token,
        scheduled_for
      FROM order_feedback_requests
      WHERE
        sent_at IS NULL
        AND submitted_at IS NULL
        AND scheduled_for <= NOW()
      ORDER BY scheduled_for ASC
      LIMIT 100
      `
    );

    if (!pendingRows.length) {
      console.log('[feedback-scheduler] No pending feedback emails to send in this cycle');
    }

    // De-duplicate pending requests by work_order_id to avoid sending multiple
    // WhatsApp messages if duplicate rows exist for the same work order.
    const grouped = pendingRows.reduce((acc, r) => {
      const key = String(r.work_order_id || '0');
      if (!acc[key]) acc[key] = [];
      acc[key].push(r);
      return acc;
    }, {});

    const uniquePending = [];
    for (const key of Object.keys(grouped)) {
      const arr = grouped[key];
      if (arr.length > 1) {
        // sort by scheduled_for then id to pick the oldest request as canonical
        arr.sort((a, b) => {
          const ta = new Date(a.scheduled_for || 0).getTime() || 0;
          const tb = new Date(b.scheduled_for || 0).getTime() || 0;
          if (ta !== tb) return ta - tb;
          return (a.id || 0) - (b.id || 0);
        });

        // mark duplicates as sent to prevent future processing
        const duplicates = arr.slice(1);
        const dupIds = duplicates.map(d => d.id).filter(Boolean);
        if (dupIds.length) {
          const placeholders = dupIds.map(() => '?').join(',');
          try {
            await db.query(`UPDATE order_feedback_requests SET sent_at = NOW(), updated_at = NOW() WHERE id IN (${placeholders})`, dupIds);
            console.log('[feedback-scheduler] Marked duplicate feedback requests as sent to avoid duplicate WA', { workOrderId: key, duplicateIds: dupIds });
          } catch (dupErr) {
            console.warn('[feedback-scheduler] Failed to mark duplicate feedback requests', { workOrderId: key, duplicateIds: dupIds, err: dupErr && dupErr.message ? dupErr.message : dupErr });
          }
        }
      }

      uniquePending.push(arr[0]);
    }

    // Replace pendingRows with deduplicated list
    const requestsToProcess = uniquePending.length ? uniquePending : pendingRows;

    for (const request of requestsToProcess) {
      try {
        console.log('[feedback-scheduler] Sending feedback email', {
          requestId: request.id,
          workOrderId: request.work_order_id,
          customerEmail: request.customer_email,
          scheduledFor: request.scheduled_for,
        });

        // Strict guards: ensure delivery status is 'delivered' before sending
        try {
          const [deliveryRows] = await db.query(
            `SELECT status FROM deliveries WHERE work_order_id = ? LIMIT 1`,
            [request.work_order_id]
          );

          const deliveryStatus = deliveryRows?.[0]?.status || null;
          if (String(deliveryStatus || '').trim().toLowerCase() !== 'delivered') {
            console.log('[feedback-scheduler] Skipping send: delivery not marked delivered', {
              workOrderId: request.work_order_id,
              deliveryStatus,
            });
            // Do not mark sent_at; leave for future cycles when status becomes delivered
            continue;
          }
        } catch (dErr) {
          console.warn('[feedback-scheduler] Failed to check delivery status, skipping until next cycle', dErr?.message || dErr);
          continue;
        }

        // Atomically mark this request as sent to prevent concurrent workers
        // from both sending the same feedback (UPDATE succeeds only once).
        try {
          const [markRes] = await db.query(
            `UPDATE order_feedback_requests SET sent_at = NOW(), updated_at = NOW() WHERE id = ? AND sent_at IS NULL`,
            [request.id]
          );

          const affectedRows = (markRes && (markRes.affectedRows || markRes.affected_rows || 0)) || 0;
          if (!affectedRows) {
            console.log('[feedback-scheduler] Skipping send: another worker already sent this feedback request', { requestId: request.id, workOrderId: request.work_order_id });
            continue;
          }
        } catch (markErr) {
          console.warn('[feedback-scheduler] Failed to atomically mark request as sent, skipping this request this cycle', markErr?.message || markErr);
          continue;
        }

        const items = await getWorkOrderItems(request.work_order_id);

        await sendOrderFeedbackRequestEmail({
          customer_email: request.customer_email,
          customer_name: request.customer_name,
          work_order_number: request.work_order_number,
          feedback_token: request.feedback_token,
          email_subject: settings.email_subject,
          items,
        });

        const feedbackTemplate = String(process.env.WA_TEMPLATE_FEEDBACK || '').trim();
        const waPhone = normalizePhoneForWhatsApp(request.customer_phone);

        if (feedbackTemplate && waPhone) {
          // For WhatsApp templates pass only the token (not full URL) to avoid duplication
          const tokenOnly = String(request.feedback_token || '').trim();

          try {
            const waResult = await sendWhatsAppTemplateMessage(
              createOrderFeedbackPayload({
                phoneNumber: waPhone,
                customerName: request.customer_name,
                workOrderNumber: request.work_order_number,
                feedbackToken: tokenOnly,
              })
            );

            console.log('[feedback-scheduler] Feedback WhatsApp accepted', {
              requestId: request.id,
              waPhone,
              waStatus: waResult?.data?.status || waResult?.status || 'unknown',
              waLogUid: waResult?.data?.log_uid || null,
            });
          } catch (waError) {
            console.error(`Order feedback WhatsApp failed for request ${request.id}:`, waError.response?.data || waError.message || waError);
          }
        } else {
          console.log('[feedback-scheduler] Feedback WhatsApp skipped', {
            requestId: request.id,
            reason: !feedbackTemplate ? 'WA_TEMPLATE_FEEDBACK missing' : 'customer phone missing/invalid',
            rawPhone: request.customer_phone || null,
          });
        }

        console.log('[feedback-scheduler] Feedback email/WA processing completed (sent_at already marked)', {
          requestId: request.id,
        });
      } catch (error) {
        console.error(`Order feedback scheduler email failed for request ${request.id}:`, error.message);
      }
    }
  } finally {
    isSchedulerCycleRunning = false;
  }
};

const startOrderFeedbackScheduler = () => {
  if (schedulerTask) return;

  const envDelayOverride = getEnvDelayOverride();
  console.log('[feedback-scheduler] Starting scheduler with config', {
    cron: '* * * * *',
    timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
    mailMode: String(process.env.MAIL_MODE || 'send').trim().toLowerCase(),
    envDelayOverrideMinutes: envDelayOverride,
  });

  schedulerTask = cron.schedule(
    '* * * * *',
    async () => {
      try {
        await runOrderFeedbackSchedulerCycle();
      } catch (error) {
        console.error('Order feedback scheduler error:', error.message);
      }
    },
    {
      timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
    }
  );

  console.log('Order feedback scheduler started');
};

module.exports = {
  scheduleOrderFeedbackRequest,
  startOrderFeedbackScheduler,
};
