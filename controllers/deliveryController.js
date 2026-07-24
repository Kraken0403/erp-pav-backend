const db = require('../config/db');
const { sendOrderStatusEmail } = require('../services/brevoService');
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService');
const { scheduleOrderFeedbackRequest } = require('../services/orderFeedbackScheduler');
const {
  normalizePhoneForWhatsApp,
  createOrderStatusPayload,
  createDeliveryStatusPayload,
} = require('../utils/whatsappTemplatePayloads');
const {
  createNotificationsForUsers,
  getAdminUserIds,
} = require('../services/notificationService');

const DELIVERY_ALLOWED_STATUS = ['pending', 'out_for_delivery', 'delivered', 'failed'];

const normalizeDeliveryStatus = (status) => {
  const raw = String(status || '').trim().toLowerCase().replace(/-/g, '_');

  if (raw === 'out for delivery') return 'out_for_delivery';
  if (raw === 'outfordelivery') return 'out_for_delivery';

  return raw;
};

const mapDeliveryStatusToProductionStatus = (deliveryStatus) => {
  if (deliveryStatus === 'pending') return 'pending';
  if (deliveryStatus === 'out_for_delivery') return 'ready';
  if (deliveryStatus === 'delivered') return 'completed';
  return null;
};

const mapDeliveryStatusToOrderMailStatus = (deliveryStatus) => {
  if (deliveryStatus === 'out_for_delivery') return 'out_for_delivery';
  if (deliveryStatus === 'delivered') return 'delivered';
  return null;
};

const toDateOnlyString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const raw = value.trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toTimeOnlyString = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
  if (!match) return null;
  return `${match[1]}:00`;
};

const parseEventSnapshot = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
};

const normalizeDeliveryRow = (delivery) => {
  const eventSnapshot = parseEventSnapshot(delivery.event_snapshot);
  return {
    ...delivery,
    delivery_date: toDateOnlyString(delivery.delivery_date),
    delivery_time: toTimeOnlyString(delivery.delivery_time),
    event_snapshot: {
      ...eventSnapshot,
      date: toDateOnlyString(eventSnapshot.date),
      time: toTimeOnlyString(eventSnapshot.time),
    },
  };
};

const ensureDeliveryForWorkOrder = async ({
  connection,
  workOrderId,
  deliveryDate = null,
  deliveryTime = null,
  actorUserId = 0,
  initialStatus = 'pending',
  deliveryManName = null,
  deliveryManPhone = null,
  deliveryManVehicle = null,
}) => {
  if (!connection) {
    throw new Error('DB connection is required');
  }

  const normalizedWorkOrderId = Number(workOrderId);
  if (!Number.isInteger(normalizedWorkOrderId) || normalizedWorkOrderId <= 0) {
    throw new Error('Invalid work order id');
  }

  const [existingDeliveries] = await connection.query(
    `SELECT id, status FROM deliveries WHERE work_order_id = ? LIMIT 1`,
    [normalizedWorkOrderId]
  );

  if (existingDeliveries.length) {
    return {
      id: existingDeliveries[0].id,
      work_order_id: normalizedWorkOrderId,
      already_exists: true,
      status: existingDeliveries[0].status,
    };
  }

  const [woRows] = await connection.query(
    `SELECT
      wo.*,
      l.first_name,
      l.last_name,
      l.email,
      l.phone_number
    FROM work_orders wo
    LEFT JOIN leads l ON wo.lead_id = l.id
    WHERE wo.id = ?
    LIMIT 1`,
    [normalizedWorkOrderId]
  );

  if (!woRows.length) {
    throw new Error('Work order not found');
  }

  const workOrder = woRows[0];

  const normalizedDeliveryDate =
    toDateOnlyString(deliveryDate) ||
    toDateOnlyString(workOrder.event_date) ||
    toDateOnlyString(new Date());

  const normalizedDeliveryTime =
    toTimeOnlyString(deliveryTime) ||
    toTimeOnlyString(workOrder.event_time) ||
    '09:00:00';

  const [items] = await connection.query(
    `SELECT product_id, product_name, quantity, unit_price FROM work_order_items WHERE work_order_id = ?`,
    [normalizedWorkOrderId]
  );

  if (!items.length) {
    throw new Error('Work order has no items');
  }

  const eventSnapshot = {
    name: workOrder.event_name || '',
    date: toDateOnlyString(workOrder.event_date) || '',
    time: toTimeOnlyString(workOrder.event_time) || '',
    location: workOrder.event_location || '',
    pax: workOrder.pax || null,
  };

  const customerName = `${workOrder.first_name || ''} ${workOrder.last_name || ''}`.trim() || workOrder.customer_name || '';

  const [deliveryHeader] = await connection.query(
    `INSERT INTO deliveries
    (
      work_order_id,
      delivery_date,
      delivery_time,
      customer_name,
      customer_phone,
      customer_email,
      delivery_location,
      delivery_man_name,
      delivery_man_phone,
      delivery_man_vehicle,
      event_snapshot,
      pax,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedWorkOrderId,
      normalizedDeliveryDate,
      normalizedDeliveryTime,
      customerName,
      workOrder.phone_number || null,
      workOrder.email || null,
      eventSnapshot.location,
      deliveryManName || null,
      deliveryManPhone || null,
      deliveryManVehicle || null,
      JSON.stringify(eventSnapshot),
      eventSnapshot.pax,
      normalizeDeliveryStatus(initialStatus) || 'pending',
    ]
  );

  const deliveryId = deliveryHeader.insertId;

  for (const item of items) {
    await connection.query(
      `INSERT INTO delivery_items (delivery_id, product_id, product_name, quantity, unit_price)
       VALUES (?, ?, ?, ?, ?)`,
      [deliveryId, item.product_id, item.product_name, item.quantity, item.unit_price || 0]
    );
  }

  if (Number.isInteger(actorUserId) && actorUserId > 0) {
    const adminUserIds = await getAdminUserIds(connection);
    await createNotificationsForUsers({
      byUserId: actorUserId,
      toUserIds: adminUserIds,
      module: 'delivery',
      action: `Delivery Created - ${workOrder.work_order_number || `#${deliveryId}`}`,
      sourceId: deliveryId,
      redirectUrl: '/deliveries',
      connection,
    });
  }

  return {
    id: deliveryId,
    work_order_id: normalizedWorkOrderId,
    already_exists: false,
    status: normalizeDeliveryStatus(initialStatus) || 'pending',
  };
};

/* ====================================
   DELIVERY CONTROLLER
==================================== */

/**
 * CREATE DELIVERY FROM WORK ORDER
 */
const createDeliveryFromWorkOrder = async (req, res) => {
  const { workOrderId } = req.params;
  const { delivery_date, delivery_time, delivery_status, delivery_man_name, delivery_man_phone, delivery_man_vehicle } = req.body;
  const actorUserId = Number(req.user?.id || 0);

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const requestedStatus = normalizeDeliveryStatus(delivery_status);
    const nextInitialStatus = requestedStatus === 'out_for_delivery' ? 'out_for_delivery' : 'pending';

    const delivery = await ensureDeliveryForWorkOrder({
      connection,
      workOrderId: Number(workOrderId),
      deliveryDate: delivery_date,
      deliveryTime: delivery_time,
      actorUserId,
      initialStatus: nextInitialStatus,
      deliveryManName: delivery_man_name || null,
      deliveryManPhone: delivery_man_phone || null,
      deliveryManVehicle: delivery_man_vehicle || null,
    });

    if (delivery.already_exists && requestedStatus === 'out_for_delivery' && delivery.status !== 'out_for_delivery') {
      if (!delivery_man_name || !delivery_man_phone) {
        await connection.rollback();
        return res.status(400).json({ error: 'Delivery man name and phone are required when setting status to Out For Delivery' });
      }

      await connection.query(
        `UPDATE deliveries SET status = ?, delivered_at = NULL, delivery_man_name = ?, delivery_man_phone = ?, delivery_man_vehicle = ? WHERE id = ?`,
        ['out_for_delivery', delivery_man_name, delivery_man_phone, delivery_man_vehicle || null, delivery.id]
      );
      delivery.status = 'out_for_delivery';
    }

    // If the requested status is out_for_delivery, ensure delivery man details were provided
    if (requestedStatus === 'out_for_delivery') {
      if (!delivery_man_name || !delivery_man_phone) {
        await connection.rollback();
        return res.status(400).json({ error: 'Delivery man name and phone are required when creating delivery Out For Delivery' });
      }
    }

    await connection.commit();

    res.json({
      id: delivery.id,
      work_order_id: Number(workOrderId),
      already_exists: Boolean(delivery.already_exists),
      status: delivery.status,
      message: delivery.already_exists
        ? 'Delivery already exists for this work order'
        : 'Delivery created successfully'
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error creating delivery:', error);
    res.status(500).json({ error: error.message || 'Failed to create delivery' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * GET DELIVERIES (with filters)
 */
const getDeliveries = async (req, res) => {
  const { date, status } = req.query;

  let connection;
  try {
    connection = await db.getConnection();

    let query = `SELECT * FROM deliveries WHERE 1=1`;
    const params = [];

    if (date) {
      query += ` AND DATE(delivery_date) = ?`;
      params.push(date);
    }

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY delivery_date ASC, delivery_time ASC`;

    const [deliveries] = await connection.query(query, params);

    // Load items for each delivery
    const deliveriesWithItems = await Promise.all(
      deliveries.map(async (delivery) => {
        const [items] = await connection.query(
          `SELECT * FROM delivery_items WHERE delivery_id = ?`,
          [delivery.id]
        );
        return {
          ...normalizeDeliveryRow(delivery),
          items,
        };
      })
    );

    res.json({ deliveries: deliveriesWithItems });

  } catch (error) {
    console.error('Error fetching deliveries:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * GET SINGLE DELIVERY
 */
const getDeliveryById = async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await db.getConnection();

    const [deliveries] = await connection.query(
      `SELECT * FROM deliveries WHERE id = ?`,
      [id]
    );

    if (!deliveries.length) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const delivery = deliveries[0];

    const [items] = await connection.query(
      `SELECT * FROM delivery_items WHERE delivery_id = ?`,
      [id]
    );

    res.json({
      ...normalizeDeliveryRow(delivery),
      items,
    });

  } catch (error) {
    console.error('Error fetching delivery:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * UPDATE DELIVERY STATUS
 */
const updateDeliveryStatus = async (req, res) => {
  const { id } = req.params;
  const status = normalizeDeliveryStatus(req.body?.status);
  const actorUserId = Number(req.user?.id || 0);

  if (!DELIVERY_ALLOWED_STATUS.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${DELIVERY_ALLOWED_STATUS.join(', ')}`
    });
  }

  let connection;
  try {
    connection = await db.getConnection();

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT
        d.id,
        d.work_order_id,
        d.status AS previous_status,
        d.delivery_date,
        d.delivery_time,
        d.delivery_location,
        d.delivery_man_name,
        d.delivery_man_phone,
        d.delivery_man_vehicle,
        wo.work_order_number,
        wo.customer_name,
        wo.billing_snapshot,
        l.email AS lead_email,
        l.phone_number AS lead_phone_number
      FROM deliveries d
      INNER JOIN work_orders wo ON wo.id = d.work_order_id
      LEFT JOIN leads l ON l.id = wo.lead_id
      WHERE d.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const delivery = rows[0];

    const deliveredAt = status === 'delivered' ? new Date() : null;

    const delivery_man_name = req.body?.delivery_man_name || null;
    const delivery_man_phone = req.body?.delivery_man_phone || null;
    const delivery_man_vehicle = req.body?.delivery_man_vehicle || null;

    if (status === 'out_for_delivery') {
      if (!delivery_man_name || !delivery_man_phone) {
        await connection.rollback();
        return res.status(400).json({ error: 'Delivery man name and phone are required when setting status to Out For Delivery' });
      }

      await connection.query(
        `UPDATE deliveries SET status = ?, delivered_at = ?, delivery_man_name = ?, delivery_man_phone = ?, delivery_man_vehicle = ? WHERE id = ?`,
        [status, deliveredAt, delivery_man_name, delivery_man_phone, delivery_man_vehicle || null, id]
      );
    } else {
      await connection.query(
        `UPDATE deliveries SET status = ?, delivered_at = ? WHERE id = ?`,
        [status, deliveredAt, id]
      );
    }

    const productionStatus = mapDeliveryStatusToProductionStatus(status);
    if (productionStatus) {
      await connection.query(
        `UPDATE work_orders SET status = ? WHERE id = ?`,
        [productionStatus, delivery.work_order_id]
      );

      await connection.query(
        `UPDATE kots SET status = ? WHERE work_order_id = ?`,
        [productionStatus, delivery.work_order_id]
      );
    }

    if (
      delivery.previous_status !== status &&
      Number.isInteger(actorUserId) &&
      actorUserId > 0
    ) {
      const adminUserIds = await getAdminUserIds(connection);
      await createNotificationsForUsers({
        byUserId: actorUserId,
        toUserIds: adminUserIds,
        module: 'delivery',
        action: `Delivery Status Updated (${delivery.previous_status || 'unknown'} -> ${status}) - ${delivery.work_order_number || `#${id}`}`,
        sourceId: id,
        redirectUrl: '/deliveries',
        connection,
      });
    }

    await connection.commit();

    let scheduledFeedback = null;
    if (delivery.previous_status !== status) {
      let billingSnapshot = {};
      try {
        billingSnapshot = typeof delivery.billing_snapshot === 'string'
          ? JSON.parse(delivery.billing_snapshot)
          : (delivery.billing_snapshot || {});
      } catch {
        billingSnapshot = {};
      }

      const customerEmail = delivery.lead_email || billingSnapshot.email || null;
      const customerName = delivery.customer_name || billingSnapshot.name || 'Customer';
      const customerPhone = normalizePhoneForWhatsApp(delivery.lead_phone_number || billingSnapshot.phone || null);

      const orderMailStatus = mapDeliveryStatusToOrderMailStatus(status);

      if (customerEmail && orderMailStatus) {
        try {
          await sendOrderStatusEmail({
              customer_email: customerEmail,
              customer_name: customerName,
              work_order_number: delivery.work_order_number,
              order_status: orderMailStatus,
              order_details: {
                delivery_date: delivery.delivery_date,
                delivery_time: delivery.delivery_time,
                delivery_location: delivery.delivery_location,
                delivery_man_name: delivery.delivery_man_name || null,
                delivery_man_phone: delivery.delivery_man_phone || null,
                delivery_man_vehicle: delivery.delivery_man_vehicle || null,
              },
            });
        } catch (emailErr) {
          console.error('Order status email error:', emailErr.message);
        }
      }

      if (customerPhone && orderMailStatus) {
        try {
          try {
            // Prefer delivery person details provided in the status-change request (modal)
            // falling back to values stored on the delivery row.
            const deliveryManNameForPayload = req.body?.delivery_man_name || delivery.delivery_man_name || null;
            const deliveryManPhoneForPayload = req.body?.delivery_man_phone || delivery.delivery_man_phone || null;
            const deliveryManVehicleForPayload = req.body?.delivery_man_vehicle || delivery.delivery_man_vehicle || null;

            const payload = createDeliveryStatusPayload({
              phoneNumber: customerPhone,
              customerName,
              workOrderNumber: delivery.work_order_number,
              status: orderMailStatus,
              deliveryDate: delivery.delivery_date,
              deliveryTime: delivery.delivery_time,
              deliveryLocation: delivery.delivery_location,
              deliveryManName: deliveryManNameForPayload || null,
              deliveryManPhone: normalizePhoneForWhatsApp(deliveryManPhoneForPayload) || (deliveryManPhoneForPayload || null),
              deliveryManVehicle: deliveryManVehicleForPayload || null,
            });

            await sendWhatsAppTemplateMessage(payload);
          } catch (whatsAppErr) {
            console.error('Order status WhatsApp error:', whatsAppErr.message);
          }
        } catch (whatsAppErr) {
          console.error('Order status WhatsApp error:', whatsAppErr.message);
        }
      }

      if (status === 'delivered' && customerEmail) {
        try {
          scheduledFeedback = await scheduleOrderFeedbackRequest({
            workOrderId: delivery.work_order_id,
            customerEmail,
            customerName,
            workOrderNumber: delivery.work_order_number,
          });
        } catch (feedbackErr) {
          console.error('Order feedback scheduling error:', feedbackErr.message);
        }
      }
    }

    const responsePayload = { message: 'Delivery status updated successfully' };
    if (scheduledFeedback && scheduledFeedback.scheduledFor_ist) {
      responsePayload.scheduled_for_ist = scheduledFeedback.scheduledFor_ist;
    }

    res.json(responsePayload);

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error updating delivery status:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * UPDATE DELIVERY NOTES
 */
const updateDeliveryNotes = async (req, res) => {
  const { id } = req.params;
  const { delivery_notes } = req.body;

  let connection;
  try {
    connection = await db.getConnection();

    await connection.query(
      `UPDATE deliveries SET delivery_notes = ? WHERE id = ?`,
      [delivery_notes || null, id]
    );

    res.json({ message: 'Delivery notes updated successfully' });

  } catch (error) {
    console.error('Error updating delivery notes:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * DELETE DELIVERY
 */
const deleteDelivery = async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await db.getConnection();

    await connection.query(`DELETE FROM deliveries WHERE id = ?`, [id]);

    res.json({ message: 'Delivery deleted successfully' });

  } catch (error) {
    console.error('Error deleting delivery:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  ensureDeliveryForWorkOrder,
  createDeliveryFromWorkOrder,
  getDeliveries,
  getDeliveryById,
  updateDeliveryStatus,
  updateDeliveryNotes,
  deleteDelivery
};
