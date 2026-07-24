const crypto = require("crypto");
const db = require("../config/db");
const { sendOrderReceivedEmail } = require('../services/brevoService');
const { scheduleOrderFeedbackRequest } = require('../services/orderFeedbackScheduler');
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService');
const {
    ensureTaxInvoiceForWorkOrder,
    dispatchInvoiceNotifications,
} = require('../services/invoiceLifecycleService');
const { generateReceiptNumber } = require('../utils/invoiceUtils');
const { isRazorpayEnabled } = require('../config/featureFlags');
const {
    normalizePhoneForWhatsApp,
    createOrderConfirmationPayload,
} = require('../utils/whatsappTemplatePayloads');

const toSafeInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toDecimalAmount = (amountInPaise) => {
    const parsed = Number(amountInPaise || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Number((parsed / 100).toFixed(2));
};

const mapEventToStatus = (eventName = '') => {
    const event = String(eventName || '').toLowerCase();
    if (event === 'order.created') return 'created';
    if (event === 'order.paid') return 'captured';
    if (event === 'payment.authorized') return 'authorized';
    if (event === 'payment.captured') return 'captured';
    if (event === 'payment.failed') return 'failed';
    return 'pending';
};

const mapEventToWorkOrderPaymentStatus = (eventName = '') => {
    const event = String(eventName || '').toLowerCase();

    if (event === 'order.created') return 'PENDING';
    if (event === 'payment.captured' || event === 'order.paid' || event === 'success') return 'SUCCESS';
    if (event === 'payment.cancelled' || event === 'order.cancelled' || event === 'cancelled') return 'CANCELLED';

    return null;
};

const PAYMENT_STATUS_PRECEDENCE_SQL = "'pending','created','authorized','failed','captured'";

const isUnknownColumnError = (error) => {
    return Number(error?.errno) === 1054 || String(error?.code || '') === 'ER_BAD_FIELD_ERROR';
};

const safeJsonParse = (value, fallback = {}) => {
    if (!value) return fallback;

    if (typeof value === 'object') return value;

    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) {
        return fallback;
    }
};

const dispatchOrderConfirmationNotifications = async (workOrderId) => {
    const safeWorkOrderId = toSafeInt(workOrderId);
    if (!safeWorkOrderId) return;

    const [workOrderRows] = await db.query(
        `
        SELECT
            wo.id,
            wo.work_order_number,
            wo.customer_name,
            wo.event_date,
            wo.event_time,
            wo.issue_date,
            wo.subtotal,
            wo.grand_total,
            wo.billing_snapshot,
            wo.shipping_snapshot
        FROM work_orders wo
        WHERE wo.id = ?
        LIMIT 1
        `,
        [safeWorkOrderId]
    );

    const workOrder = workOrderRows?.[0];
    if (!workOrder) return;

    const billingSnapshot = safeJsonParse(workOrder.billing_snapshot, {});
    const shippingSnapshot = safeJsonParse(workOrder.shipping_snapshot, {});

    const customerEmail = String(
        billingSnapshot?.email || shippingSnapshot?.email || ''
    ).trim();

    const customerPhone = String(
        billingSnapshot?.phone || shippingSnapshot?.phone || ''
    ).trim();

    const customerName = String(
        workOrder.customer_name || billingSnapshot?.name || 'Customer'
    ).trim() || 'Customer';

    const [itemRows] = await db.query(
        `
        SELECT
            product_name,
            description,
            quantity,
            unit_price,
            tax
        FROM work_order_items
        WHERE work_order_id = ?
        ORDER BY id ASC
        `,
        [safeWorkOrderId]
    );

    const items = (itemRows || []).map((row) => ({
        name: row.product_name || row.description || 'Item',
        description: row.description || row.product_name || 'Item',
        quantity: Number(row.quantity || 0),
        unit_price: Number(row.unit_price || 0),
        tax: Number(row.tax || 0),
    }));

    if (customerEmail) {
        try {
            await sendOrderReceivedEmail({
                customer_email: customerEmail,
                customer_name: customerName,
                work_order_number: workOrder.work_order_number,
                order_details: {
                    issue_date: workOrder.issue_date || new Date(),
                    requested_fulfillment_at: `${workOrder.event_date || ''} ${workOrder.event_time || ''}`.trim(),
                    event_date: workOrder.event_date || null,
                    event_time: workOrder.event_time || null,
                    subtotal: Number(workOrder.subtotal || 0),
                    grand_total: Number(workOrder.grand_total || 0),
                },
                items,
            });
        } catch (error) {
            console.error('Post-payment email notification failed:', error?.message || error);
        }

        // Feedback requests must be scheduled only after delivery is completed.
        // Scheduling on post-payment was removed to ensure feedback is sent strictly
        // when delivery status becomes 'delivered'. The delivery controller already
        // calls `scheduleOrderFeedbackRequest()` when appropriate.
    }

    const customerWhatsappPhone = normalizePhoneForWhatsApp(customerPhone);
    if (customerWhatsappPhone) {
        try {
            await sendWhatsAppTemplateMessage(
                createOrderConfirmationPayload({
                    phoneNumber: customerWhatsappPhone,
                    customerName,
                    orderNumber: workOrder.work_order_number,
                    orderDate: workOrder.issue_date || new Date(),
                    receivingTime: workOrder.event_time || '',
                    grandTotal: Number(workOrder.grand_total || 0),
                })
            );
        } catch (error) {
            console.error('Post-payment WhatsApp notification failed:', error?.message || error);
        }
    }
};

const persistPaymentRecord = async ({
    workOrderId,
    invoiceId = null,
    provider = 'razorpay',
    status = 'pending',
    amount = null,
    amountInPaise = null,
    currency = 'INR',
    razorpayOrderId = null,
    razorpayPaymentId = null,
    razorpaySignature = null,
    razorpayEvent = null,
    paymentMethod = null,
    bank = null,
    wallet = null,
    vpa = null,
    email = null,
    contact = null,
    feeInPaise = null,
    taxInPaise = null,
    errorCode = null,
    errorDescription = null,
    isWebhookVerified = 0,
    webhookSignature = null,
    notesJson = null,
    webhookPayload = null,
    paidAt = null,
    capturedAt = null,
}) => {
    const safeWorkOrderId = toSafeInt(workOrderId);
    if (!safeWorkOrderId) return;

    const payload = webhookPayload ? JSON.stringify(webhookPayload) : null;
    const notes = notesJson ? JSON.stringify(notesJson) : null;

    if (razorpayPaymentId) {
        await db.query(
            `
            INSERT INTO payments (
              work_order_id,
              invoice_id,
              provider,
              status,
              amount,
              amount_in_paise,
              currency,
              razorpay_order_id,
              razorpay_payment_id,
              razorpay_signature,
              razorpay_event,
              payment_method,
              bank,
              wallet,
              vpa,
              email,
              contact,
              fee_in_paise,
              tax_in_paise,
              error_code,
              error_description,
              is_webhook_verified,
              webhook_signature,
              notes_json,
              webhook_payload,
              paid_at,
              captured_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              work_order_id = VALUES(work_order_id),
              invoice_id = COALESCE(VALUES(invoice_id), invoice_id),
                            status = CASE
                                WHEN FIELD(VALUES(status), ${PAYMENT_STATUS_PRECEDENCE_SQL}) >= FIELD(status, ${PAYMENT_STATUS_PRECEDENCE_SQL})
                                THEN VALUES(status)
                                ELSE status
                            END,
              amount = COALESCE(VALUES(amount), amount),
              amount_in_paise = COALESCE(VALUES(amount_in_paise), amount_in_paise),
              currency = COALESCE(VALUES(currency), currency),
              razorpay_order_id = COALESCE(VALUES(razorpay_order_id), razorpay_order_id),
              razorpay_signature = COALESCE(VALUES(razorpay_signature), razorpay_signature),
              razorpay_event = COALESCE(VALUES(razorpay_event), razorpay_event),
              payment_method = COALESCE(VALUES(payment_method), payment_method),
              bank = COALESCE(VALUES(bank), bank),
              wallet = COALESCE(VALUES(wallet), wallet),
              vpa = COALESCE(VALUES(vpa), vpa),
              email = COALESCE(VALUES(email), email),
              contact = COALESCE(VALUES(contact), contact),
              fee_in_paise = COALESCE(VALUES(fee_in_paise), fee_in_paise),
              tax_in_paise = COALESCE(VALUES(tax_in_paise), tax_in_paise),
              error_code = COALESCE(VALUES(error_code), error_code),
              error_description = COALESCE(VALUES(error_description), error_description),
              is_webhook_verified = GREATEST(is_webhook_verified, VALUES(is_webhook_verified)),
              webhook_signature = COALESCE(VALUES(webhook_signature), webhook_signature),
              notes_json = COALESCE(VALUES(notes_json), notes_json),
              webhook_payload = COALESCE(VALUES(webhook_payload), webhook_payload),
              paid_at = COALESCE(VALUES(paid_at), paid_at),
              captured_at = COALESCE(VALUES(captured_at), captured_at)
            `,
            [
                safeWorkOrderId,
                toSafeInt(invoiceId),
                provider,
                status,
                amount,
                toSafeInt(amountInPaise),
                currency,
                razorpayOrderId,
                razorpayPaymentId,
                razorpaySignature,
                razorpayEvent,
                paymentMethod,
                bank,
                wallet,
                vpa,
                email,
                contact,
                toSafeInt(feeInPaise),
                toSafeInt(taxInPaise),
                errorCode,
                errorDescription,
                Number(isWebhookVerified ? 1 : 0),
                webhookSignature,
                notes,
                payload,
                paidAt,
                capturedAt,
            ]
        );

        return;
    }

    if (razorpayOrderId && razorpayEvent) {
        const [existingRows] = await db.query(
            `
            SELECT id
            FROM payments
            WHERE work_order_id = ?
              AND razorpay_order_id <=> ?
              AND razorpay_event <=> ?
            ORDER BY id DESC
            LIMIT 1
            `,
            [safeWorkOrderId, razorpayOrderId, razorpayEvent]
        );

        if (existingRows?.length) {
            await db.query(
                `
                UPDATE payments
                SET
                  invoice_id = COALESCE(?, invoice_id),
                  provider = COALESCE(?, provider),
                  status = CASE
                    WHEN FIELD(?, ${PAYMENT_STATUS_PRECEDENCE_SQL}) >= FIELD(status, ${PAYMENT_STATUS_PRECEDENCE_SQL})
                    THEN ?
                    ELSE status
                  END,
                  amount = COALESCE(?, amount),
                  amount_in_paise = COALESCE(?, amount_in_paise),
                  currency = COALESCE(?, currency),
                  razorpay_signature = COALESCE(?, razorpay_signature),
                  payment_method = COALESCE(?, payment_method),
                  bank = COALESCE(?, bank),
                  wallet = COALESCE(?, wallet),
                  vpa = COALESCE(?, vpa),
                  email = COALESCE(?, email),
                  contact = COALESCE(?, contact),
                  fee_in_paise = COALESCE(?, fee_in_paise),
                  tax_in_paise = COALESCE(?, tax_in_paise),
                  error_code = COALESCE(?, error_code),
                  error_description = COALESCE(?, error_description),
                  is_webhook_verified = GREATEST(is_webhook_verified, ?),
                  webhook_signature = COALESCE(?, webhook_signature),
                  notes_json = COALESCE(?, notes_json),
                  webhook_payload = COALESCE(?, webhook_payload),
                  paid_at = COALESCE(?, paid_at),
                  captured_at = COALESCE(?, captured_at)
                WHERE id = ?
                `,
                [
                    toSafeInt(invoiceId),
                    provider,
                    status,
                    status,
                    amount,
                    toSafeInt(amountInPaise),
                    currency,
                    razorpaySignature,
                    paymentMethod,
                    bank,
                    wallet,
                    vpa,
                    email,
                    contact,
                    toSafeInt(feeInPaise),
                    toSafeInt(taxInPaise),
                    errorCode,
                    errorDescription,
                    Number(isWebhookVerified ? 1 : 0),
                    webhookSignature,
                    notes,
                    payload,
                    paidAt,
                    capturedAt,
                    existingRows[0].id,
                ]
            );

            return;
        }
    }

    await db.query(
        `
        INSERT INTO payments (
          work_order_id,
          invoice_id,
          provider,
          status,
          amount,
          amount_in_paise,
          currency,
          razorpay_order_id,
          razorpay_signature,
          razorpay_event,
          payment_method,
          bank,
          wallet,
          vpa,
          email,
          contact,
          fee_in_paise,
          tax_in_paise,
          error_code,
          error_description,
          is_webhook_verified,
          webhook_signature,
          notes_json,
          webhook_payload,
          paid_at,
          captured_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
            safeWorkOrderId,
            toSafeInt(invoiceId),
            provider,
            status,
            amount,
            toSafeInt(amountInPaise),
            currency,
            razorpayOrderId,
            razorpaySignature,
            razorpayEvent,
            paymentMethod,
            bank,
            wallet,
            vpa,
            email,
            contact,
            toSafeInt(feeInPaise),
            toSafeInt(taxInPaise),
            errorCode,
            errorDescription,
            Number(isWebhookVerified ? 1 : 0),
            webhookSignature,
            notes,
            payload,
            paidAt,
            capturedAt,
        ]
    );
};

const extractWorkOrderIdFromWebhookPayload = (payload = {}) => {
    const paymentEntity = payload?.payload?.payment?.entity || {};
    const orderEntity = payload?.payload?.order?.entity || {};

    const notesWorkOrderId = Number(
        paymentEntity?.notes?.work_order_id ||
        orderEntity?.notes?.work_order_id ||
        0
    );

    if (Number.isInteger(notesWorkOrderId) && notesWorkOrderId > 0) {
        return notesWorkOrderId;
    }

    const receipt = String(paymentEntity?.receipt || orderEntity?.receipt || '').trim();
    const receiptMatch = receipt.match(/WO[_-](\d+)/i);
    const receiptWorkOrderId = Number(receiptMatch?.[1] || 0);
    if (Number.isInteger(receiptWorkOrderId) && receiptWorkOrderId > 0) {
        return receiptWorkOrderId;
    }

    return null;
};

const createInvoicePaymentFromWebhook = async (workOrderId, webhookPayload = {}) => {
    const paymentEntity = webhookPayload?.payload?.payment?.entity || {};
    const orderEntity = webhookPayload?.payload?.order?.entity || {};

    const razorpayPaymentId = paymentEntity?.id || null;
    const amountInPaise = toSafeInt(paymentEntity?.amount || orderEntity?.amount_paid || orderEntity?.amount);
    const amount = toDecimalAmount(amountInPaise);
    if (!amount || !workOrderId) return false;

    const createdAtTs = toSafeInt(paymentEntity?.created_at || orderEntity?.created_at);
    const capturedAtTs = toSafeInt(paymentEntity?.captured_at);
    const paymentDate = capturedAtTs ? new Date(capturedAtTs * 1000) : (createdAtTs ? new Date(createdAtTs * 1000) : new Date());

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [[invoiceRow]] = await conn.query(
            `SELECT id, grand_total, status, source_type FROM invoices WHERE source_type = 'FRONTEND_ORDER' AND source_id = ? ORDER BY id DESC LIMIT 1`,
            [workOrderId]
        );

        if (!invoiceRow) {
            await conn.rollback();
            conn.release();
            return false;
        }

        const invoiceId = invoiceRow.id;

        // Avoid duplicate receipt creation for same provider payment
        if (razorpayPaymentId) {
            const [dupRows] = await conn.query(`SELECT id FROM invoice_payments WHERE reference_number = ? LIMIT 1`, [razorpayPaymentId]);
            if (dupRows?.length) {
                await conn.rollback();
                conn.release();
                return false;
            }
        }

        // Load invoice settings
        const [[invSettings]] = await conn.query(`SELECT * FROM invoice_settings LIMIT 1`);
        const settings = invSettings || {};

        // Compute next receipt sequence (mirror logic in invoiceController)
        const mode = settings.receipt_numbering_mode || 'continuous';
        const start = Number(settings.receipt_sequence_start || settings.sequence_start || 1);
        let nextSeq = start;
        if (mode === 'yearly') {
            const year = paymentDate.getFullYear();
            const [[r]] = await conn.query(`SELECT MAX(receipt_sequence) AS maxSeq FROM invoice_payments WHERE YEAR(payment_date) = ?`, [year]);
            nextSeq = r?.maxSeq ? Number(r.maxSeq) + 1 : start;
        } else if (mode === 'monthly') {
            const year = paymentDate.getFullYear();
            const month = paymentDate.getMonth() + 1;
            const [[r]] = await conn.query(`SELECT MAX(receipt_sequence) AS maxSeq FROM invoice_payments WHERE YEAR(payment_date) = ? AND MONTH(payment_date) = ?`, [year, month]);
            nextSeq = r?.maxSeq ? Number(r.maxSeq) + 1 : start;
        } else {
            const [[r]] = await conn.query(`SELECT MAX(receipt_sequence) AS maxSeq FROM invoice_payments`);
            nextSeq = r?.maxSeq ? Number(r.maxSeq) + 1 : start;
        }

        const receiptNumber = generateReceiptNumber(settings, nextSeq, paymentDate);

        const paymentMethod = (paymentEntity?.method || orderEntity?.method || 'RAZORPAY').toUpperCase();
        const referenceNumber = razorpayPaymentId || (orderEntity?.id || null);
        const notes = JSON.stringify({ razorpay: paymentEntity, order: orderEntity });

        await conn.query(
            `INSERT INTO invoice_payments (invoice_id, receipt_number, receipt_sequence, amount, payment_date, payment_method, reference_number, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [invoiceId, receiptNumber, nextSeq, amount, paymentDate, paymentMethod || 'RAZORPAY', referenceNumber, notes]
        );

        // Recompute totals and update invoice status if needed
        const [allPayments] = await conn.query(`SELECT * FROM invoice_payments WHERE invoice_id = ?`, [invoiceId]);

        const totalPaid = allPayments.reduce((sum, p) => {
            if (String(p.payment_method || '').toUpperCase() === 'OTHER') return sum;
            return sum + Number(p.amount || 0);
        }, 0);

        const totalAmount = Number(invoiceRow.grand_total || 0);
        const hasOtherPayment = allPayments.some(p => String(p.payment_method || '').toUpperCase() === 'OTHER');

        let newStatus = invoiceRow.status;
        if (hasOtherPayment || totalPaid >= totalAmount) newStatus = 'paid';
        else if (totalPaid > 0) newStatus = 'part-payment';
        else newStatus = 'issued';

        if (newStatus !== invoiceRow.status) {
            await conn.query(`UPDATE invoices SET status = ? WHERE id = ?`, [newStatus, invoiceId]);
        }

        await conn.commit();
        conn.release();
        return true;
    } catch (err) {
        if (conn) await conn.rollback();
        if (conn) conn.release();
        throw err;
    }
};

exports.handleRazorpayWebhook = async (req, res) => {
    try {
        if (!isRazorpayEnabled()) {
            return res.status(503).json({ error: 'Razorpay integration is disabled' });
        }

        const signature = req.headers['x-razorpay-signature'];
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

        console.log('Razorpay webhook hit:', {
            method: req.method,
            path: req.originalUrl,
            has_signature: Boolean(signature),
            content_type: req.headers['content-type'] || null,
            user_agent: req.headers['user-agent'] || null,
            body_size: req.rawBody?.length || Buffer.byteLength(JSON.stringify(req.body || {})),
        });

        if (!webhookSecret) {
            console.error('Razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is not configured');
            return res.status(500).json({ error: 'RAZORPAY_WEBHOOK_SECRET is not configured' });
        }

        if (!signature) {
            console.warn('Razorpay webhook rejected: missing x-razorpay-signature header');
            return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
        }

        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        if (expectedSignature !== signature) {
            console.warn('Razorpay webhook rejected: invalid signature', {
                expected_prefix: String(expectedSignature).slice(0, 8),
                received_prefix: String(signature).slice(0, 8),
            });
            return res.status(400).json({ error: 'Invalid webhook signature' });
        }

        const event = String(req.body?.event || '').toLowerCase();
        const supportedEvents = new Set([
            'order.created',
            'payment.authorized',
            'payment.captured',
            'payment.failed',
            'order.paid',
            'payment.cancelled',
            'order.cancelled',
            'success',
            'cancelled',
        ]);
        const payload = req.body || {};
        const paymentEntity = payload?.payload?.payment?.entity || {};
        const orderEntity = payload?.payload?.order?.entity || {};
        const workOrderId = extractWorkOrderIdFromWebhookPayload(req.body || {});
        const mappedPaymentStatus = mapEventToStatus(event);
        const mappedWorkOrderStatus = mapEventToWorkOrderPaymentStatus(event);
        let workOrderStatusUpdated = false;
        let invoiceStatusUpdated = false;

        console.log('Razorpay webhook event:', event);
        console.log('Work order resolved:', workOrderId);

        if (!supportedEvents.has(event)) {
            const responseBody = {
                received: true,
                ignored: true,
                reason: 'unsupported_event',
                event,
                payment_status: mappedPaymentStatus,
                work_order_payment_status: mappedWorkOrderStatus,
                work_order_id: workOrderId,
            };
            console.log('Razorpay webhook response:', responseBody);
            return res.status(200).json(responseBody);
        }

        if (!workOrderId) {
            const responseBody = {
                received: true,
                ignored: true,
                reason: 'work_order_id not found',
                event,
                payment_status: mappedPaymentStatus,
                work_order_payment_status: mappedWorkOrderStatus,
                work_order_id: null,
            };
            console.log('Razorpay webhook response:', responseBody);
            return res.status(200).json(responseBody);
        }

        if (mappedWorkOrderStatus) {
            try {
                let updateResult;

                if (mappedWorkOrderStatus === 'PENDING') {
                    [updateResult] = await db.query(
                        `UPDATE work_orders
                         SET payment_status = 'PENDING'
                         WHERE id = ?
                           AND (
                                payment_status IS NULL
                                OR payment_status = ''
                                OR UPPER(payment_status) = 'PENDING'
                           )`,
                        [workOrderId]
                    );
                } else if (mappedWorkOrderStatus === 'SUCCESS') {
                    [updateResult] = await db.query(
                        `UPDATE work_orders
                         SET payment_status = 'SUCCESS'
                         WHERE id = ?
                           AND UPPER(COALESCE(payment_status, '')) != 'SUCCESS'`,
                        [workOrderId]
                    );
                } else if (mappedWorkOrderStatus === 'CANCELLED') {
                    [updateResult] = await db.query(
                        `UPDATE work_orders
                         SET payment_status = 'CANCELLED'
                         WHERE id = ?
                           AND UPPER(COALESCE(payment_status, '')) NOT IN ('SUCCESS', 'CANCELLED')`,
                        [workOrderId]
                    );
                }

                workOrderStatusUpdated = Number(updateResult?.affectedRows || 0) > 0;
            } catch (workOrderStatusError) {
                if (!isUnknownColumnError(workOrderStatusError)) {
                    throw workOrderStatusError;
                }

                // Legacy schema compatibility: some DBs do not have work_orders.payment_status.
                console.warn('work_orders.payment_status column missing; skipping status update for webhook event');
            }
        }

        if (event === 'payment.failed') {
            // Keep status unchanged; failure can be retried by customer.
        }

        try {
            const createdAtTs = toSafeInt(paymentEntity?.created_at || orderEntity?.created_at);
            const capturedAtTs = toSafeInt(paymentEntity?.captured_at);
            const paidAt = createdAtTs ? new Date(createdAtTs * 1000) : null;
            const capturedAt = capturedAtTs ? new Date(capturedAtTs * 1000) : null;
            const amountInPaise = toSafeInt(paymentEntity?.amount || orderEntity?.amount_paid || orderEntity?.amount);

            await persistPaymentRecord({
                workOrderId,
                provider: 'razorpay',
                status: mappedPaymentStatus,
                amount: toDecimalAmount(amountInPaise),
                amountInPaise,
                currency: String(paymentEntity?.currency || orderEntity?.currency || 'INR').toUpperCase(),
                razorpayOrderId: paymentEntity?.order_id || orderEntity?.id || null,
                razorpayPaymentId: paymentEntity?.id || null,
                razorpayEvent: event,
                paymentMethod: paymentEntity?.method || null,
                bank: paymentEntity?.bank || null,
                wallet: paymentEntity?.wallet || null,
                vpa: paymentEntity?.vpa || null,
                email: paymentEntity?.email || null,
                contact: paymentEntity?.contact || null,
                feeInPaise: toSafeInt(paymentEntity?.fee),
                taxInPaise: toSafeInt(paymentEntity?.tax),
                errorCode: paymentEntity?.error_code || null,
                errorDescription: paymentEntity?.error_description || null,
                isWebhookVerified: 1,
                webhookSignature: String(signature),
                notesJson: paymentEntity?.notes || orderEntity?.notes || null,
                webhookPayload: payload,
                paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
                capturedAt: capturedAt && !Number.isNaN(capturedAt.getTime()) ? capturedAt : null,
            });
        } catch (paymentTableError) {
            console.error('Payment persistence failed on webhook:', paymentTableError.message);
        }

        if (mappedWorkOrderStatus === 'SUCCESS' && workOrderStatusUpdated) {
            try {
                await dispatchOrderConfirmationNotifications(workOrderId);
            } catch (notificationError) {
                console.error('Post-payment notification dispatch failed:', notificationError?.message || notificationError);
            }
        }

        if (mappedWorkOrderStatus === 'SUCCESS') {
            try {
                invoiceStatusUpdated = await syncFrontendOrderInvoiceStatus(workOrderId, event);
                // Attempt to create an invoice-level receipt for captured payments
                try {
                    await createInvoicePaymentFromWebhook(workOrderId, payload);
                } catch (createPaymentErr) {
                    console.error('Failed to create invoice payment from webhook:', createPaymentErr?.message || createPaymentErr);
                }
            } catch (invoiceStatusError) {
                console.error('Invoice status sync failed on webhook:', invoiceStatusError?.message || invoiceStatusError);
            }
        }

        // Ensure a tax invoice exists for this work order and dispatch notifications
                if (mappedWorkOrderStatus === 'SUCCESS') {
                    try {
                        const ensureResult = await ensureTaxInvoiceForWorkOrder(workOrderId);
                        // Dispatch notifications when a tax invoice was created, or when an existing
                        // invoice was updated to 'paid' by this call. This ensures website/frontend
                        // invoices get notifications after payment even if they pre-existed.
                        if (ensureResult && ensureResult.invoice && (ensureResult.created || ensureResult.statusUpdated)) {
                            const invoiceId = Number(ensureResult.invoice.id || ensureResult.invoice);
                            try {
                                await dispatchInvoiceNotifications(invoiceId, { sendEmail: true, sendWhatsApp: true });
                            } catch (notifyErr) {
                                console.error('Invoice notification dispatch failed on webhook:', notifyErr?.message || notifyErr);
                            }
                        }
                    } catch (ensureErr) {
                        console.error('Failed to ensure tax invoice on payment webhook:', ensureErr?.message || ensureErr);
                    }
                }

        const responseBody = {
            received: true,
            event,
            payment_status: mappedPaymentStatus,
            work_order_payment_status: mappedWorkOrderStatus,
            work_order_id: workOrderId,
            work_order_status_updated: workOrderStatusUpdated,
            invoice_status_updated: invoiceStatusUpdated,
            razorpay_payment_id: paymentEntity?.id || null,
            razorpay_order_id: paymentEntity?.order_id || orderEntity?.id || null,
        };

        console.log('Razorpay webhook response:', responseBody);
        return res.status(200).json(responseBody);
    } catch (error) {
        console.error('Razorpay webhook error:', error);
        return res.status(500).json({ error: error.message || 'Webhook handling failed' });
    }
};

exports.getPayments = async (req, res) => {
    try {
        const workOrderId = toSafeInt(req.query.work_order_id);
        const razorpayOrderId = String(req.query.razorpay_order_id || '').trim();
        const razorpayPaymentId = String(req.query.razorpay_payment_id || '').trim();
        const limitRaw = Number(req.query.limit || 100);
        const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

        const where = [];
        const params = [];

        if (workOrderId) {
            where.push('p.work_order_id = ?');
            params.push(workOrderId);
        }

        if (razorpayOrderId) {
            where.push('p.razorpay_order_id = ?');
            params.push(razorpayOrderId);
        }

        if (razorpayPaymentId) {
            where.push('p.razorpay_payment_id = ?');
            params.push(razorpayPaymentId);
        }

        let rows;

        try {
            const [primaryRows] = await db.query(
                `
                                SELECT
                                    p.*,
                                    wo.work_order_number,
                                    wo.payment_status AS work_order_payment_status,
                                    i.invoice_number
                                FROM payments p
                                LEFT JOIN work_orders wo ON wo.id = p.work_order_id
                                LEFT JOIN invoices i ON i.id = p.invoice_id
                                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                                ORDER BY p.created_at DESC
                                LIMIT ?
                                `,
                [...params, limit]
            );

            rows = primaryRows;
        } catch (queryError) {
            if (!isUnknownColumnError(queryError)) {
                throw queryError;
            }

            // Backward-compatible fallback when work_orders.payment_status is not present.
            const [fallbackRows] = await db.query(
                `
                                SELECT
                                    p.*,
                                    wo.work_order_number,
                                    NULL AS work_order_payment_status,
                                    i.invoice_number
                                FROM payments p
                                LEFT JOIN work_orders wo ON wo.id = p.work_order_id
                                LEFT JOIN invoices i ON i.id = p.invoice_id
                                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                                ORDER BY p.created_at DESC
                                LIMIT ?
                                `,
                [...params, limit]
            );

            rows = fallbackRows;
        }

        return res.status(200).json({
            count: rows.length,
            result: rows,
        });
    } catch (error) {
        console.error('getPayments error:', error);
        return res.status(500).json({ error: error.message || 'Failed to fetch payments' });
    }
};

exports.getPublicPaymentStatus = async (req, res) => {
    try {
        const workOrderId = toSafeInt(req.query.work_order_id);
        const razorpayOrderId = String(req.query.razorpay_order_id || '').trim();
        const razorpayPaymentId = String(req.query.razorpay_payment_id || '').trim();

        if (!workOrderId && !razorpayOrderId && !razorpayPaymentId) {
            return res.status(400).json({ error: 'At least one identifier is required' });
        }

        const where = [];
        const params = [];

        if (workOrderId) {
            where.push('p.work_order_id = ?');
            params.push(workOrderId);
        }

        if (razorpayOrderId) {
            where.push('p.razorpay_order_id = ?');
            params.push(razorpayOrderId);
        }

        if (razorpayPaymentId) {
            where.push('p.razorpay_payment_id = ?');
            params.push(razorpayPaymentId);
        }

        let rows;

        try {
            const [primaryRows] = await db.query(
                `
                SELECT
                  p.id,
                  p.work_order_id,
                  p.status,
                  p.error_code,
                  p.error_description,
                  p.razorpay_order_id,
                  p.razorpay_payment_id,
                  p.razorpay_event,
                  p.created_at,
                  p.updated_at,
                  wo.payment_status AS work_order_payment_status
                FROM payments p
                LEFT JOIN work_orders wo ON wo.id = p.work_order_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY p.created_at DESC
                LIMIT 1
                `,
                params
            );

            rows = primaryRows;
        } catch (queryError) {
            if (!isUnknownColumnError(queryError)) {
                throw queryError;
            }

            const [fallbackRows] = await db.query(
                `
                SELECT
                  p.id,
                  p.work_order_id,
                  p.status,
                  p.error_code,
                  p.error_description,
                  p.razorpay_order_id,
                  p.razorpay_payment_id,
                  p.razorpay_event,
                  p.created_at,
                  p.updated_at,
                  NULL AS work_order_payment_status
                FROM payments p
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY p.created_at DESC
                LIMIT 1
                `,
                params
            );

            rows = fallbackRows;
        }

        const row = rows?.[0] || null;

        return res.status(200).json({
            found: Boolean(row),
            result: row,
        });
    } catch (error) {
        console.error('getPublicPaymentStatus error:', error);
        return res.status(500).json({ error: error.message || 'Failed to fetch payment status' });
    }
};

const syncFrontendOrderInvoiceStatus = async (workOrderId, eventName = '') => {
    const safeWorkOrderId = toSafeInt(workOrderId);
    if (!safeWorkOrderId) return false;

    const event = String(eventName || '').toLowerCase();
    const isSuccessfulPaymentEvent = event === 'payment.captured' || event === 'order.paid' || event === 'success';
    if (!isSuccessfulPaymentEvent) return false;

    const [updateResult] = await db.query(
        `
                UPDATE invoices
                SET status = 'paid'
                WHERE source_type = 'FRONTEND_ORDER'
                    AND source_id = ?
                    AND LOWER(COALESCE(status, '')) <> 'paid'
                `,
        [safeWorkOrderId]
    );

    return Number(updateResult?.affectedRows || 0) > 0;
};