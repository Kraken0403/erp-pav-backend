const db = require('../config/db');
const { ensureDeliveryForWorkOrder } = require('./deliveryController');
const { sendOrderStatusEmail } = require('../services/brevoService');
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService');
const {
  normalizePhoneForWhatsApp,
  createOrderStatusPayload,
} = require('../utils/whatsappTemplatePayloads');
const {
  createNotificationsForUsers,
  getAdminUserIds,
  getSystemNotifierUserId,
} = require('../services/notificationService');

const ALLOWED_STATUS = ['pending', 'preparing', 'ready', 'completed'];

const normalizeKotStatus = (status) => {
  const raw = String(status || '').trim().toLowerCase().replace(/-/g, '_');

  if (raw === 'in_progress') return 'preparing';
  if (raw === 'issued') return 'pending';

  return raw;
};

const isCateringBusiness = async () => {
  const [rows] = await db.query(
    `SELECT business_type FROM settings WHERE id = 1 LIMIT 1`
  );

  const businessType = rows?.[0]?.business_type || 'GENERAL';
  return businessType === 'CATERING';
};

const normalizeDateOnly = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const raw = value.trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeTimeOnly = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
  if (!match) return null;
  return `${match[1]}:00`;
};

const parseScheduledFor = (eventDate, eventTime) => {
  const datePart = normalizeDateOnly(eventDate);
  if (!datePart) return null;

  const normalizedTime = normalizeTimeOnly(eventTime) || '00:00:00';

  return `${datePart} ${normalizedTime}`;
};

const mapKotStatusToWorkOrderStatus = (kotStatus) => {
  if (kotStatus === 'pending') return 'pending';
  if (kotStatus === 'preparing') return 'preparing';
  if (kotStatus === 'ready') return 'ready';
  if (kotStatus === 'completed') return 'completed';
  return null;
};

const mapKotStatusToOrderMailStatus = (kotStatus) => {
  if (kotStatus === 'preparing') return 'preparing';
  if (kotStatus === 'ready') return 'prepared';
  return null;
};

const ensureKotForWorkOrder = async ({
  connection,
  workOrderId,
  actorUserId,
  createdBy = null,
}) => {
  const [existingRows] = await connection.query(
    `SELECT id FROM kots WHERE work_order_id = ? LIMIT 1`,
    [workOrderId]
  );

  if (existingRows.length) {
    return {
      kot_id: existingRows[0].id,
      work_order_id: Number(workOrderId),
      already_existed: true,
      skipped: false,
    };
  }

  const [workOrderRows] = await connection.query(
    `
      SELECT
        id,
        work_order_number,
        mode,
        event_name,
        event_location,
        pax,
        event_date,
        event_time
      FROM work_orders
      WHERE id = ?
      LIMIT 1
      `,
    [workOrderId]
  );

  const workOrder = workOrderRows[0];

  if (!workOrder) {
    throw new Error('Work order not found');
  }

  if (workOrder.mode !== 'CATERING') {
    return {
      kot_id: null,
      work_order_id: Number(workOrderId),
      already_existed: false,
      skipped: true,
      reason: 'NON_CATERING_WORK_ORDER',
    };
  }

  const [itemRows] = await connection.query(
    `
      SELECT
        woi.product_id,
        woi.product_name,
        woi.quantity,
        p.description AS product_description
      FROM work_order_items woi
      LEFT JOIN products p ON woi.product_id = p.id
      WHERE woi.work_order_id = ?
      `,
    [workOrderId]
  );

  if (!itemRows.length) {
    throw new Error('Work order has no items');
  }

  const eventSnapshot = {
    name: workOrder.event_name || null,
    venue: workOrder.event_location || null,
    pax: workOrder.pax || null,
    date: normalizeDateOnly(workOrder.event_date),
    time: normalizeTimeOnly(workOrder.event_time)
  };

  const scheduledFor = parseScheduledFor(
    workOrder.event_date,
    workOrder.event_time
  );

  const [kotInsert] = await connection.query(
    `
      INSERT INTO kots (
        work_order_id,
        event_snapshot,
        status,
        scheduled_for,
        generated_at,
        created_by
      )
      VALUES (?, ?, 'pending', ?, NOW(), ?)
      `,
    [
      workOrderId,
      JSON.stringify(eventSnapshot),
      scheduledFor,
      createdBy,
    ]
  );

  const kotId = kotInsert.insertId;

  for (const item of itemRows) {
    await connection.query(
      `
        INSERT INTO kot_items (
          kot_id,
          product_id,
          product_name,
          product_description,
          quantity
        )
        VALUES (?, ?, ?, ?, ?)
        `,
      [
        kotId,
        item.product_id || null,
        item.product_name || 'Unnamed Product',
        item.product_description || null,
        Number(item.quantity || 0)
      ]
    );
  }

  if (Number.isInteger(actorUserId) && actorUserId > 0) {
    const adminUserIds = await getAdminUserIds(connection);
    await createNotificationsForUsers({
      byUserId: actorUserId,
      toUserIds: adminUserIds,
      module: 'kot',
      action: `KOT Created - ${workOrder.work_order_number || `#${kotId}`}`,
      sourceId: kotId,
      redirectUrl: '/kots',
      connection,
    });
  }

  return {
    kot_id: kotId,
    work_order_id: Number(workOrderId),
    already_existed: false,
    skipped: false,
  };
};

exports.generateKotFromWorkOrder = async (req, res) => {
  const { workOrderId } = req.params;
  const connection = await db.getConnection();
  let actorUserId = Number(req.user?.id || 0);

  try {
    const cateringEnabled = await isCateringBusiness();

    if (!cateringEnabled) {
      connection.release();
      return res.status(400).json({
        error: 'KOT is available only when business type is CATERING'
      });
    }

    await connection.beginTransaction();
    if (!(Number.isInteger(actorUserId) && actorUserId > 0)) {
      actorUserId = await getSystemNotifierUserId(connection);
    }

    const result = await ensureKotForWorkOrder({
      connection,
      workOrderId: Number(workOrderId),
      actorUserId,
      createdBy: req.user?.id || null,
    });

    if (result.already_existed) {
      await connection.commit();
      connection.release();
      return res.status(409).json({
        error: 'KOT already exists for this work order',
        kot_id: result.kot_id,
        already_existed: true
      });
    }

    await connection.commit();
    connection.release();

    return res.status(201).json({
      message: 'KOT generated successfully',
      kot_id: result.kot_id,
      work_order_id: result.work_order_id,
      already_existed: false
    });

  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('generateKotFromWorkOrder error:', error);
    return res.status(400).json({ error: error.message });
  }
};

exports.getKots = async (req, res) => {
  try {
    const cateringEnabled = await isCateringBusiness();

    if (!cateringEnabled) {
      return res.status(400).json({
        error: 'KOT is available only when business type is CATERING'
      });
    }

    const { range = 'today' } = req.query;

    let whereClause = '';
    if (range === 'today') {
      whereClause = `WHERE DATE(k.scheduled_for) = CURDATE()`;
    } else if (range === 'tomorrow') {
      whereClause = `WHERE DATE(k.scheduled_for) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;
    } else if (range === 'upcoming') {
      whereClause = `WHERE DATE(k.scheduled_for) >= CURDATE()`;
    }

    const [rows] = await db.query(
      `
      SELECT
        k.id,
        k.work_order_id,
        k.event_snapshot,
        k.status,
        k.scheduled_for,
        k.generated_at,
        k.created_by,
        wo.work_order_number,
        wo.customer_name,
        wo.notes AS work_order_notes
      FROM kots k
      INNER JOIN work_orders wo ON wo.id = k.work_order_id
      ${whereClause}
      ORDER BY k.scheduled_for ASC, k.id DESC
      `
    );

    const kotIds = rows.map((row) => row.id);

    let itemsByKotId = {};

    if (kotIds.length > 0) {
      const [itemRows] = await db.query(
        `
        SELECT
          id,
          kot_id,
          product_id,
          product_name,
          product_description,
          quantity
        FROM kot_items
        WHERE kot_id IN (?)
        ORDER BY id ASC
        `,
        [kotIds]
      );

      itemsByKotId = itemRows.reduce((acc, item) => {
        if (!acc[item.kot_id]) acc[item.kot_id] = [];
        // Ensure `description` is present for frontend compatibility
        if (!item.description && item.product_description) {
          item.description = item.product_description;
        }
        acc[item.kot_id].push(item);
        return acc;
      }, {});
    }

    const kots = rows.map((row) => {
      let eventSnapshot = row.event_snapshot;

      if (typeof eventSnapshot === 'string') {
        try {
          eventSnapshot = JSON.parse(eventSnapshot);
        } catch (e) {
          eventSnapshot = {};
        }
      }

      return {
        ...row,
        event_snapshot: eventSnapshot || {},
        items: itemsByKotId[row.id] || []
      };
    });

    return res.status(200).json({ kots });

  } catch (error) {
    console.error('getKots error:', error);
    return res.status(500).json({ error: error.message });
  }
};

exports.updateKotStatus = async (req, res) => {
  let connection;
  const actorUserId = Number(req.user?.id || 0);

  try {
    const { id } = req.params;
    const status = normalizeKotStatus(req.body?.status);

    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Allowed: pending, preparing, ready, completed'
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT
        k.id,
        k.status AS previous_status,
        k.work_order_id,
        wo.work_order_number AS work_order_number,
        wo.status AS previous_work_order_status,
        wo.customer_name,
        wo.event_date,
        wo.event_time,
        wo.event_location,
        wo.billing_snapshot,
        l.email AS lead_email,
        l.phone_number AS lead_phone_number
      FROM kots k
      INNER JOIN work_orders wo ON wo.id = k.work_order_id
      LEFT JOIN leads l ON l.id = wo.lead_id
      WHERE k.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'KOT not found' });
    }

    const currentKot = rows[0];

    await connection.query(
      `UPDATE kots SET status = ? WHERE id = ?`,
      [status, id]
    );

    const workOrderStatus = mapKotStatusToWorkOrderStatus(status);
    if (workOrderStatus) {
      await connection.query(
        `UPDATE work_orders SET status = ? WHERE id = ?`,
        [workOrderStatus, currentKot.work_order_id]
      );

      if (
        Number.isInteger(actorUserId) &&
        actorUserId > 0 &&
        currentKot.previous_work_order_status !== workOrderStatus
      ) {
        const adminUserIds = await getAdminUserIds(connection);
        await createNotificationsForUsers({
          byUserId: actorUserId,
          toUserIds: adminUserIds,
          module: 'work_orders',
          action: `Work Order Status Updated (${currentKot.previous_work_order_status || 'unknown'} -> ${workOrderStatus}) - ${currentKot.work_order_number || `#${currentKot.work_order_id}`}`,
          sourceId: currentKot.work_order_id,
          redirectUrl: `/workorders/${currentKot.work_order_id}`,
          connection,
        });
      }
    }

    if (
      currentKot.previous_status !== status &&
      Number.isInteger(actorUserId) &&
      actorUserId > 0
    ) {
      const adminUserIds = await getAdminUserIds(connection);
      await createNotificationsForUsers({
        byUserId: actorUserId,
        toUserIds: adminUserIds,
        module: 'kot',
        action: `KOT Status Updated (${currentKot.previous_status || 'unknown'} -> ${status}) - ${currentKot.work_order_number || `#${id}`}`,
        sourceId: id,
        redirectUrl: '/kots',
        connection,
      });
    }

    if (currentKot.previous_status !== status && status === 'completed') {
      await ensureDeliveryForWorkOrder({
        connection,
        workOrderId: Number(currentKot.work_order_id),
        deliveryDate: currentKot.event_date,
        deliveryTime: currentKot.event_time,
        actorUserId,
        initialStatus: 'pending',
      });
    }

    await connection.commit();

    if (currentKot.previous_status !== status) {
      let billingSnapshot = {};
      try {
        billingSnapshot = typeof currentKot.billing_snapshot === 'string'
          ? JSON.parse(currentKot.billing_snapshot)
          : (currentKot.billing_snapshot || {});
      } catch {
        billingSnapshot = {};
      }

      const customerEmail = currentKot.lead_email || billingSnapshot.email || null;
      const customerPhone = normalizePhoneForWhatsApp(currentKot.lead_phone_number || billingSnapshot.phone || null);
      const customerName = currentKot.customer_name || billingSnapshot.name || 'Customer';

      const orderMailStatus = mapKotStatusToOrderMailStatus(status);

      if (customerEmail && orderMailStatus) {
        try {
          await sendOrderStatusEmail({
            customer_email: customerEmail,
            customer_name: customerName,
            work_order_number: currentKot.work_order_number,
            order_status: orderMailStatus,
            order_details: {
              event_date: currentKot.event_date,
              event_time: currentKot.event_time,
              event_location: currentKot.event_location,
            },
          });
        } catch (emailErr) {
          console.error('Order status email error:', emailErr.message);
        }
      }

      if (customerPhone && orderMailStatus) {
        try {
          await sendWhatsAppTemplateMessage(
            createOrderStatusPayload({
              phoneNumber: customerPhone,
              customerName,
              workOrderNumber: currentKot.work_order_number,
              status: orderMailStatus,
              deliveryDate: currentKot.event_date,
              deliveryTime: currentKot.event_time,
              deliveryLocation: currentKot.event_location,
            })
          );
        } catch (whatsAppErr) {
          console.error('Order status WhatsApp error:', whatsAppErr.message);
        }
      }
    }

    return res.status(200).json({
      message: 'KOT status updated successfully'
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('updateKotStatus error:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

exports.checkKotExists = async (req, res) => {
  try {
    const { workOrderId } = req.params;

    const [rows] = await db.query(
      `SELECT id, status FROM kots WHERE work_order_id = ? LIMIT 1`,
      [workOrderId]
    );

    if (rows.length) {
      return res.status(200).json({
        exists: true,
        kot_id: rows[0].id,
        status: rows[0].status
      });
    }

    return res.status(200).json({
      exists: false
    });

  } catch (error) {
    console.error('checkKotExists error:', error);
    return res.status(500).json({ error: error.message });
  }
};

exports.ensureKotForWorkOrder = ensureKotForWorkOrder;
