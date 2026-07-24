const db = require('../config/db')
const { ensureVendorSchema } = require('../utils/pavilionSchema')
const { upsertCustomerFromLead } = require('../services/customerSyncService')
const { ensureDeliveryForWorkOrder } = require('./deliveryController')
const { sendOrderStatusEmail } = require('../services/brevoService')
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService')
const {
  normalizePhoneForWhatsApp,
  createOrderStatusPayload,
} = require('../utils/whatsappTemplatePayloads')
const {
  createNotificationsForUsers,
  getAdminUserIds,
  getSystemNotifierUserId,
  resolveUserIdByAssignment,
} = require('../services/notificationService')

const WORK_ORDER_ALLOWED_STATUS = ['pending', 'preparing', 'ready', 'completed', 'cancelled']
let cachedWorkOrderInitialStatus = null

function getEnumValuesFromColumnType(columnType) {
  const raw = String(columnType || '')
  const matches = [...raw.matchAll(/'([^']+)'/g)]
  return matches.map((match) => match[1])
}

async function resolveWorkOrderInitialStatus(connection) {
  if (cachedWorkOrderInitialStatus) return cachedWorkOrderInitialStatus

  try {
    const [rows] = await connection.query(`SHOW COLUMNS FROM work_orders LIKE 'status'`)
    const columnType = rows?.[0]?.Type || rows?.[0]?.type || ''
    const allowedStatuses = getEnumValuesFromColumnType(columnType)

    if (allowedStatuses.includes('pending')) {
      cachedWorkOrderInitialStatus = 'pending'
      return cachedWorkOrderInitialStatus
    }

    if (allowedStatuses.includes('issued')) {
      cachedWorkOrderInitialStatus = 'issued'
      return cachedWorkOrderInitialStatus
    }
  } catch (error) {
    console.warn('Could not detect work order status enum, defaulting to pending:', error.message)
  }

  cachedWorkOrderInitialStatus = 'pending'
  return cachedWorkOrderInitialStatus
}

function normalizeWorkOrderStatus(status) {
  const raw = String(status || '').trim().toLowerCase().replace(/-/g, '_')

  if (raw === 'issued') return 'pending'
  if (raw === 'in_progress') return 'preparing'

  return raw
}

function toDateOnlyString(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const raw = value.trim()
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
    if (match) return match[1]
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toTimeOnlyString(value) {
  if (!value) return null
  const raw = String(value).trim()
  const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/)
  if (!match) return null
  return `${match[1]}:00`
}

function mapWorkOrderStatusToKotStatus(workOrderStatus) {
  if (workOrderStatus === 'pending') return 'pending'
  if (workOrderStatus === 'preparing') return 'preparing'
  if (workOrderStatus === 'ready') return 'ready'
  if (workOrderStatus === 'completed') return 'completed'
  return null
}

/* --------------------------------------------------
   Simple numbering: WO/{year}/{seq}
-------------------------------------------------- */
function generateWorkOrderNumber(sequence) {
  const year = new Date().getFullYear()
  return `WO/${year}/${String(sequence).padStart(4, '0')}`
}

/* --------------------------------------------------
   INTERNAL CREATION FUNCTION
-------------------------------------------------- */
async function _createWorkOrderForQuotation(connection, quotationId) {
  await ensureVendorSchema(connection)

  /* 1️⃣ Load quotation + FULL lead data */
  const [quotationRows] = await connection.query(
    `
    SELECT 
      q.*, 
      l.first_name,
      l.last_name,
      l.company_name,
      l.phone_number,
      l.email,
      l.gst_number
    FROM quotations q
    LEFT JOIN leads l ON q.lead_id = l.id
    WHERE q.id = ?
    `,
    [quotationId]
  )

  const quotation = quotationRows[0]

  if (!quotation)
    throw new Error('Quotation not found for work order creation')

  if (quotation.status !== 'approved')
    throw new Error('Work order can only be created from approved quotations')

  /* 2️⃣ Prevent duplicates */
  const [existingRows] = await connection.query(
    `SELECT id FROM work_orders WHERE quotation_id = ? LIMIT 1`,
    [quotationId]
  )

  if (existingRows.length) {
    return {
      id: existingRows[0].id,
      work_order_number: null,
      existing: true
    }
  }

  /* 3️⃣ Load quotation items */
  const [items] = await connection.query(
    `SELECT * FROM quotation_items WHERE quotation_id = ?`,
    [quotationId]
  )

  if (!items.length)
    throw new Error('Quotation has no items')

  /* 4️⃣ Generate sequence */
  const [seqRows] = await connection.query(
    `SELECT MAX(work_order_sequence) AS maxSeq FROM work_orders`
  )

  const nextSeq = (seqRows[0]?.maxSeq || 0) + 1
  const work_order_number = generateWorkOrderNumber(nextSeq)
  const initialWorkOrderStatus = await resolveWorkOrderInitialStatus(connection)

  /* 5️⃣ Determine mode + source_type */
  let mode = 'GENERAL'

  if (quotation.quotation_mode === 'CATERING') {
    mode = 'CATERING'
  }

  const sourceType = 'CRM'

  /* 6️⃣ Build immutable snapshot */
  const billingSnapshot = {
    name: `${quotation.first_name || ''} ${quotation.last_name || ''}`.trim(),
    company: quotation.company_name || '',
    phone: quotation.phone_number || '',
    email: quotation.email || '',
    gst: quotation.gst_number || ''
  }

  const shippingSnapshot = billingSnapshot
  const customerId = await upsertCustomerFromLead(connection, quotation.lead_id, null)

  /* 7️⃣ Insert header */
  const [header] = await connection.query(
    `
    INSERT INTO work_orders
    (
      quotation_id,
      lead_id,
      customer_id,
      mode,
      source_type,
      pax,
      event_name,
      event_date,
      event_time,
      event_location,
      work_order_number,
      work_order_sequence,
      status,
      issue_date,
      customer_name,
      customer_gst,
      notes,
      shipping_snapshot,
      billing_snapshot,
      subtotal,
      grand_total,
      total_amount
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, 0, 0, 0)
    `,
    [
      quotation.id,
      quotation.lead_id || null,
      customerId || null,
      mode,
      sourceType,
      quotation.pax || null,
      quotation.event_name || null,
      toDateOnlyString(quotation.event_date),
      toTimeOnlyString(quotation.event_time),
      quotation.event_location || null,
      work_order_number,
      nextSeq,
      initialWorkOrderStatus,
      billingSnapshot.name,
      billingSnapshot.gst,
      quotation.notes || null,
      JSON.stringify(shippingSnapshot),
      JSON.stringify(billingSnapshot)
    ]
  )

  const workOrderId = header.insertId

  /* 8️⃣ Insert items */
  let computedTotal = 0

  for (const it of items) {

    // ❌ REMOVED PAX MULTIPLICATION
    // Quotation quantities already represent the total needed
    // In CATERING mode, sum(quantities) = PAX (validated on quotation save)
    const effectiveQty = Number(it.quantity) || 0

    const unitPrice = Number(it.selling_price) || 0
    const discount = Number(it.discount) || 0
    const tax = Number(it.tax) || 0

    const lineTotal =
      effectiveQty * unitPrice - discount + tax

    computedTotal += lineTotal

    const [itemInsert] = await connection.query(
      `
      INSERT INTO work_order_items
      (
        work_order_id,
        product_id,
        product_name,
        variant_id,
        variant_name,
        description,
        quantity,
        unit_price,
        discount,
        tax,
        vendor_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        workOrderId,
        it.product_id,
        it.product_name || null,
        it.variant_id || null,
        it.variant_name || null,
        it.product_name || null,
        effectiveQty,
        unitPrice,
        discount,
        tax,
        it.vendor_id || null
      ]
    )

    const vendorId = Number(it.vendor_id || 0)
    const rawCost = Number(it.cost_price || it.unit_cost || 0)
    const costQty = Number(it.cost_price_qty || 1) || 1
    const payableAmount = vendorId ? Number(((rawCost / costQty) * effectiveQty).toFixed(2)) : 0

    if (vendorId && payableAmount > 0) {
      await connection.query(
        `INSERT INTO vendor_payables (vendor_id, work_order_id, quotation_id, product_id, work_order_item_id, description, amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [vendorId, workOrderId, quotation.id, it.product_id || null, itemInsert.insertId, it.product_name || null, payableAmount]
      )
    }
  }

  /* 9️⃣ Update totals */
  const quotationDiscountAmount = Math.max(0, Number(quotation.quotation_discount_amount || 0))
  const finalTotal = Math.max(0, computedTotal - quotationDiscountAmount)

  await connection.query(
    `
    UPDATE work_orders
    SET subtotal = ?, 
        grand_total = ?, 
        total_amount = ?
    WHERE id = ?
    `,
    [computedTotal, finalTotal, finalTotal, workOrderId]
  )

  /* 🔒 Lock quotation */
  // await connection.query(
  //   `
  //   UPDATE quotations
  //   SET status = 'converted',
  //       is_locked = 1
  //   WHERE id = ?
  //   `,
  //   [quotationId]
  // )

  return {
    id: workOrderId,
    work_order_number,
    existing: false
  }
}

/* --------------------------------------------------
   MANUAL CREATE FROM QUOTATION
-------------------------------------------------- */
const createFromQuotation = async (req, res) => {
  const { quotationId } = req.params
  const connection = await db.getConnection()
  let actorUserId = Number(req.user?.id || 0)

  try {
    await connection.beginTransaction()
    if (!(Number.isInteger(actorUserId) && actorUserId > 0)) {
      actorUserId = await getSystemNotifierUserId(connection)
    }

    const wo = await _createWorkOrderForQuotation(connection, quotationId)

    if (!wo.existing && Number.isInteger(actorUserId) && actorUserId > 0) {
      const adminUserIds = await getAdminUserIds(connection)
      await createNotificationsForUsers({
        byUserId: actorUserId,
        toUserIds: adminUserIds,
        module: 'work_orders',
        action: `Work Order Created - ${wo.work_order_number || `#${wo.id}`}`,
        sourceId: wo.id,
        redirectUrl: `/workorders/${wo.id}`,
        connection,
      })
    }

    await connection.commit()
    connection.release()

    return res.status(201).json({
      message: wo.existing
        ? 'Work order already existed for this quotation'
        : 'Work order created from quotation',
      work_order_id: wo.id,
      work_order_number: wo.work_order_number,
      already_existed: wo.existing
    })

  } catch (error) {
    console.error('createFromQuotation error:', error)
    await connection.rollback()
    connection.release()
    return res.status(500).json({ error: error.message })
  }
}

/* --------------------------------------------------
   GET ALL WORK ORDERS
-------------------------------------------------- */
const getWorkOrderById = async (req, res) => {
  try {
    const { id } = req.params

    const [rows] = await db.query(
      `
      SELECT 
        wo.*,
        q.quotation_number,
        q.version,
        q.parent_id,
        q.total_amount AS quotation_total,
        q.quotation_discount_type,
        q.quotation_discount_value,
        q.quotation_discount_amount
      FROM work_orders wo
      LEFT JOIN quotations q ON wo.quotation_id = q.id
      WHERE wo.id = ?
      `,
      [id]
    )

    if (!rows.length)
      return res.status(404).json({ error: 'Work order not found' })

    const wo = rows[0]

    /* Parse billing snapshot */
    if (wo.billing_snapshot) {
      try {
        const billing =
          typeof wo.billing_snapshot === 'string'
            ? JSON.parse(wo.billing_snapshot)
            : wo.billing_snapshot

        wo.first_name = billing?.name || ''
        wo.company_name = billing?.company || ''
        wo.phone_number = billing?.phone || ''
        wo.email = billing?.email || ''
        wo.gst_number = billing?.gst || ''

      } catch (e) {
        console.error('Snapshot parse error:', e)
      }
    }

    const [items] = await db.query(
      `
      SELECT woi.*, p.name AS product_name,
             COALESCE(woi.description, p.description) AS product_description
      FROM work_order_items woi
      LEFT JOIN products p ON woi.product_id = p.id
      WHERE woi.work_order_id = ?
      `,
      [id]
    )

    wo.items = items || []

    const sourceDiscount = Math.max(0, Number(wo.quotation_discount_amount || 0))
    if (sourceDiscount > 0) {
      const itemTotal = (wo.items || []).reduce((sum, it) => {
        const qty = Number(it.quantity || 0)
        const unit = Number(it.unit_price || it.rate || 0)
        const disc = Number(it.discount || 0)
        const tax = Number(it.tax || it.tax_amount || it.gst_amount || 0)
        return sum + Math.max(0, qty * unit - disc + tax)
      }, 0)
      const storedTotal = Number(wo.total_amount || wo.grand_total || itemTotal || 0)
      const storedDiscount = Math.max(0, Number(wo.subtotal || itemTotal || 0) - storedTotal)

      wo.display_taxable_subtotal = Number(wo.subtotal || itemTotal || 0)
      wo._computed_discount = sourceDiscount
      if (storedDiscount === 0 && storedTotal > 0) {
        const correctedTotal = Math.max(0, storedTotal - sourceDiscount)
        wo.total_amount = correctedTotal
        wo.grand_total = correctedTotal
      }
      wo.discount_percent =
        String(wo.quotation_discount_type || '').toUpperCase() === 'PERCENT'
          ? Number(wo.quotation_discount_value || 0)
          : null
    }

    // Compute display_taxable_subtotal, computed discount and tax totals for frontend display.
    // Prefer negative line totals from work_order_items; fall back to invoice_items
    try {
      const mapped = Array.isArray(wo.items) ? wo.items : []
      const discountSum = mapped.reduce((s, it) => {
        // compute per-row line total similar to frontend logic
        const qty = Number(it.quantity || 0)
        const unit = Number(it.unit_price || it.rate || 0)
        const disc = Number(it.discount || 0)
        const tax = Number(it.tax || it.tax_amount || it.gst_amount || 0)
        const lineTotal = qty * unit - disc + tax
        return s + (lineTotal < 0 ? lineTotal : 0)
      }, 0)

      if (discountSum !== 0) {
        wo.display_taxable_subtotal = Number(wo.subtotal || 0) + Math.abs(Number(discountSum || 0))
        wo._computed_discount = Math.abs(Number(discountSum || 0))
      } else {
        // fallback: check linked invoice for negative invoice_items (coupons)
        try {
          const [invRow] = await db.query(
            `SELECT id FROM invoices WHERE source_type IN ('FRONTEND_ORDER','WEBSITE_ORDER') AND source_id = ? LIMIT 1`,
            [id]
          )
          const invoice = invRow && invRow[0] ? invRow[0] : null
          if (invoice && invoice.id) {
            const [invItems] = await db.query(
              `SELECT line_total FROM invoice_items WHERE invoice_id = ?`,
              [invoice.id]
            )
            const invDiscount = Array.isArray(invItems)
              ? invItems.reduce((s, r) => s + (Number(r.line_total || 0) < 0 ? Number(r.line_total || 0) : 0), 0)
              : 0

            if (invDiscount !== 0) {
              wo.display_taxable_subtotal = Number(wo.subtotal || 0) + Math.abs(Number(invDiscount || 0))
              wo._computed_discount = Math.abs(Number(invDiscount || 0))
            }
          }
        } catch (e) {
          console.warn('getWorkOrderById: failed to read invoice_items for discount fallback', e && e.message ? e.message : e)
        }
      }

      // Compute tax totals from work order items (sum of tax fields)
      try {
        const taxSum = mapped.reduce((s, it) => {
          const taxVal = Number(it.tax || it.tax_amount || it.gst_amount || 0)
          return s + (Number.isFinite(taxVal) ? Number(taxVal) : 0)
        }, 0)
        wo.taxes = Number(taxSum || 0)

        // Discount percent against pre-discount subtotal
        if (Number(wo.display_taxable_subtotal || 0) > 0 && Number(wo._computed_discount || 0) > 0) {
          if (!wo.discount_percent) {
            wo.discount_percent = Math.round((Number(wo._computed_discount) / Number(wo.display_taxable_subtotal)) * 10000) / 100
          }
        } else {
          wo.discount_percent = null
        }
      } catch (taxErr) {
        console.warn('getWorkOrderById: failed to compute tax totals', taxErr && taxErr.message ? taxErr.message : taxErr)
        wo.taxes = Number(wo.taxes || 0)
        wo.discount_percent = null
      }

    } catch (e) {
      console.warn('getWorkOrderById: failed to compute display_taxable_subtotal', e && e.message ? e.message : e)
    }

    return res.status(200).json(wo)

  } catch (err) {
    console.error('getWorkOrderById error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* --------------------------------------------------
   GET ALL WORK ORDERS (ADMIN)
-------------------------------------------------- */
const getWorkOrders = async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT 
        wo.id,
        wo.work_order_number,
        wo.issue_date,
        wo.customer_name,
        wo.total_amount,
        wo.status,
        wo.mode,
        wo.source_type,
        q.quotation_number
      FROM work_orders wo
      LEFT JOIN quotations q ON wo.quotation_id = q.id
      ORDER BY wo.id DESC
      `
    )

    return res.status(200).json({ workOrders: rows })
  } catch (err) {
    console.error('getWorkOrders error:', err)
    return res.status(500).json({ error: 'Failed to fetch work orders', details: err.message })
  }
}

/* --------------------------------------------------
   GET WORK ORDERS FOR AUTHENTICATED USER
   Strategy: lookup user's email by user id, find leads and customers with that email,
   then return work_orders for those leads/customers or matching billing_snapshot.email
-------------------------------------------------- */
const getWorkOrdersForUser = async (req, res) => {
  try {
    const userId = Number(req.user?.id || 0)
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' })

    const [[userRow]] = await db.query('SELECT email FROM users WHERE id = ? LIMIT 1', [userId])
    const userEmail = userRow?.email || null

    if (!userEmail) return res.status(200).json({ workOrders: [] })

    const [leads] = await db.query('SELECT id FROM leads WHERE email = ?', [userEmail])
    const leadIds = leads.map(l => l.id).filter(Boolean)

    const [customers] = await db.query('SELECT id FROM customers WHERE email = ?', [userEmail])
    const customerIds = customers.map(c => c.id).filter(Boolean)

    let rows = []
    if (leadIds.length || customerIds.length) {
      const leadPlaceholders = leadIds.length ? leadIds.map(() => '?').join(',') : null
      const custPlaceholders = customerIds.length ? customerIds.map(() => '?').join(',') : null
      const params = [...leadIds, ...customerIds, userEmail]

      // Build WHERE clause parts safely to avoid empty parentheses or stray ORs
      const whereParts = []
      if (leadPlaceholders) whereParts.push(`wo.lead_id IN (${leadPlaceholders})`)
      if (custPlaceholders) whereParts.push(`wo.customer_id IN (${custPlaceholders})`)
      whereParts.push("JSON_UNQUOTE(JSON_EXTRACT(wo.billing_snapshot, '$.email')) = ?")
      const whereClause = whereParts.join(' OR ')

      const [r] = await db.query(
        `
        SELECT 
          wo.id,
          wo.customer_id,
          wo.work_order_number,
          wo.issue_date,
          wo.customer_name,
          wo.total_amount,
          wo.status,
          wo.mode,
          wo.source_type,
          q.quotation_number
        FROM work_orders wo
        LEFT JOIN quotations q ON wo.quotation_id = q.id
        WHERE (
          ${whereClause}
        )
        ORDER BY wo.id DESC
        `,
        params
      )
      rows = r
    } else {
      const [r] = await db.query(
        `
        SELECT 
          wo.id,
          wo.customer_id,
          wo.work_order_number,
          wo.issue_date,
          wo.customer_name,
          wo.total_amount,
          wo.status,
          wo.mode,
          wo.source_type,
          q.quotation_number
        FROM work_orders wo
        LEFT JOIN quotations q ON wo.quotation_id = q.id
        WHERE JSON_UNQUOTE(JSON_EXTRACT(wo.billing_snapshot, '$.email')) = ?
        ORDER BY wo.id DESC
        `,
        [userEmail]
      )
      rows = r
    }

    return res.status(200).json({ workOrders: rows })
  } catch (err) {
    console.error('getWorkOrdersForUser error:', err)
    return res.status(500).json({ error: 'Failed to fetch work orders for user', details: err.message })
  }
}

/* --------------------------------------------------
   UPDATE WORK ORDER STATUS
-------------------------------------------------- */
const updateWorkOrderStatus = async (req, res) => {
  let connection
  const actorUserId = Number(req.user?.id || 0)

  try {
    const { id } = req.params
    const normalizedStatus = normalizeWorkOrderStatus(req.body?.status)

    if (!normalizedStatus)
      return res.status(400).json({ error: 'Status is required' })

    if (!WORK_ORDER_ALLOWED_STATUS.includes(normalizedStatus)) {
      return res.status(400).json({
        error: `Invalid status. Allowed: ${WORK_ORDER_ALLOWED_STATUS.join(', ')}`
      })
    }

    connection = await db.getConnection()
    await connection.beginTransaction()

    const [workOrderRows] = await connection.query(
      `
      SELECT
        wo.id,
        wo.status AS previous_status,
        k.id AS kot_id,
        k.status AS previous_kot_status,
        wo.work_order_number,
        wo.customer_name,
        wo.lead_id,
        wo.event_date,
        wo.event_time,
        wo.event_location,
        wo.billing_snapshot,
        l.email AS lead_email,
        l.phone_number AS lead_phone_number,
        l.assigned_salesperson AS lead_assigned_salesperson
      FROM work_orders wo
      LEFT JOIN kots k ON k.work_order_id = wo.id
      LEFT JOIN leads l ON l.id = wo.lead_id
      WHERE wo.id = ?
      LIMIT 1
      `,
      [id]
    )

    if (!workOrderRows.length) {
      await connection.rollback()
      return res.status(404).json({ error: 'Work order not found' })
    }

    const workOrder = workOrderRows[0]

    const [result] = await connection.query(
      `UPDATE work_orders SET status = ? WHERE id = ?`,
      [normalizedStatus, id]
    )

    if (!result.affectedRows) {
      await connection.rollback()
      return res.status(404).json({ error: 'Work order not found' })
    }

    const kotStatus = mapWorkOrderStatusToKotStatus(normalizedStatus)
    if (kotStatus) {
      await connection.query(
        `UPDATE kots SET status = ? WHERE work_order_id = ?`,
        [kotStatus, id]
      )

      if (
        Number.isInteger(actorUserId) &&
        actorUserId > 0 &&
        workOrder.kot_id &&
        workOrder.previous_kot_status !== kotStatus
      ) {
        const adminUserIds = await getAdminUserIds(connection)
        try {
          console.warn('updateWorkOrderStatus: notify KOT admins', {
            byUserId: actorUserId,
            toUserIds: adminUserIds,
            module: 'kot',
            kotId: workOrder.kot_id,
            previousKotStatus: workOrder.previous_kot_status,
            newKotStatus: kotStatus,
          })
        } catch (logErr) {
          console.error('updateWorkOrderStatus: logging error (kot admins)', logErr)
        }

        await createNotificationsForUsers({
          byUserId: actorUserId,
          toUserIds: adminUserIds,
          module: 'kot',
          action: `KOT Status Updated (${workOrder.previous_kot_status || 'unknown'} -> ${kotStatus}) - ${workOrder.work_order_number || `#${workOrder.kot_id}`}`,
          sourceId: workOrder.kot_id,
          redirectUrl: '/kots',
          connection,
        })
      }
    }

    if (workOrder.previous_status !== normalizedStatus && normalizedStatus === 'completed') {
      await ensureDeliveryForWorkOrder({
        connection,
        workOrderId: Number(id),
        deliveryDate: workOrder.event_date,
        deliveryTime: workOrder.event_time,
        actorUserId,
        initialStatus: 'pending',
      })
    }

    if (
      workOrder.previous_status !== normalizedStatus &&
      Number.isInteger(actorUserId) &&
      actorUserId > 0
    ) {
      const assignedUserId = await resolveUserIdByAssignment(workOrder.lead_assigned_salesperson, connection)
      const adminUserIds = await getAdminUserIds(connection)
      const recipients = assignedUserId ? [assignedUserId, ...adminUserIds] : adminUserIds

      try {
        console.warn('updateWorkOrderStatus: notifying work order recipients', {
          byUserId: actorUserId,
          toUserIds: recipients,
          module: 'work_orders',
          workOrderId: id,
          previousStatus: workOrder.previous_status,
          newStatus: normalizedStatus,
        })
      } catch (logErr) {
        console.error('updateWorkOrderStatus: logging error (work_orders recipients)', logErr)
      }

      await createNotificationsForUsers({
        byUserId: actorUserId,
        toUserIds: recipients,
        module: 'work_orders',
        action: `Work Order Status Updated (${workOrder.previous_status || 'unknown'} -> ${normalizedStatus}) - ${workOrder.work_order_number || `#${id}`}`,
        sourceId: id,
        redirectUrl: `/workorders/${id}`,
        connection,
      })
    }

    await connection.commit()

    if (workOrder.previous_status !== normalizedStatus && (normalizedStatus === 'cancelled' || normalizedStatus === 'preparing')) {
      let billingSnapshot = {}
      try {
        billingSnapshot = typeof workOrder.billing_snapshot === 'string'
          ? JSON.parse(workOrder.billing_snapshot)
          : (workOrder.billing_snapshot || {})
      } catch {
        billingSnapshot = {}
      }

      const customerEmail = workOrder.lead_email || billingSnapshot.email || null
      const customerPhone = normalizePhoneForWhatsApp(workOrder.lead_phone_number || billingSnapshot.phone || null)
      const customerName = workOrder.customer_name || billingSnapshot.name || 'Customer'

      const orderMailStatus = normalizedStatus === 'preparing' ? 'preparing' : 'cancelled'

      if (customerEmail) {
        try {
          await sendOrderStatusEmail({
            customer_email: customerEmail,
            customer_name: customerName,
            work_order_number: workOrder.work_order_number,
            order_status: orderMailStatus,
            order_details: {
              event_date: workOrder.event_date,
              event_time: workOrder.event_time,
              event_location: workOrder.event_location,
            },
          })
        } catch (emailErr) {
          console.error('Order cancelled email error:', emailErr.message)
        }
      }

      if (customerPhone) {
        try {
          await sendWhatsAppTemplateMessage(
            createOrderStatusPayload({
              phoneNumber: customerPhone,
              customerName,
              workOrderNumber: workOrder.work_order_number,
              status: orderMailStatus,
              deliveryDate: workOrder.event_date,
              deliveryTime: workOrder.event_time,
              deliveryLocation: workOrder.event_location,
            })
          )
        } catch (whatsAppErr) {
          console.error('Order status WhatsApp error:', whatsAppErr.message)
        }
      }
    }

    return res.status(200).json({
      message: 'Work order status updated'
    })

  } catch (err) {
    if (connection) await connection.rollback()
    console.error('updateWorkOrderStatus error:', err)
    return res.status(500).json({
      error: 'Failed to update status',
      details: err.message
    })
  } finally {
    if (connection) connection.release()
  }
}

/* --------------------------------------------------
   CREATE WORK ORDER MANUALLY (NO QUOTATION)
-------------------------------------------------- */
const createManualWorkOrder = async (req, res) => {
  const {
    customer_name,
    customer_email,
    customer_phone,
    customer_company,
    customer_gst,
    mode,
    pax,
    event_name,
    event_date,
    event_time,
    event_location,
    notes,
    items
  } = req.body

  if (!customer_name || !items || items.length === 0) {
    return res.status(400).json({
      error: 'Customer name and items are required'
    })
  }

  const connection = await db.getConnection()
  let actorUserId = Number(req.user?.id || 0)

  try {
    await connection.beginTransaction()
    if (!(Number.isInteger(actorUserId) && actorUserId > 0)) {
      actorUserId = await getSystemNotifierUserId(connection)
    }

    /* 1️⃣ Generate sequence */
    const [seqRows] = await connection.query(
      `SELECT MAX(work_order_sequence) AS maxSeq FROM work_orders`
    )

    const nextSeq = (seqRows[0]?.maxSeq || 0) + 1
    const work_order_number = generateWorkOrderNumber(nextSeq)
    const initialWorkOrderStatus = await resolveWorkOrderInitialStatus(connection)

    /* 2️⃣ Determine mode */
    let workOrderMode = mode || 'GENERAL'

    /* 3️⃣ Build snapshots */
    const billingSnapshot = {
      name: customer_name || '',
      company: customer_company || '',
      phone: customer_phone || '',
      email: customer_email || '',
      gst: customer_gst || ''
    }

    const shippingSnapshot = billingSnapshot

    /* 4️⃣ Insert header */
    const [header] = await connection.query(
      `
      INSERT INTO work_orders
      (
        quotation_id,
        lead_id,
        mode,
        source_type,
        pax,
        event_name,
        event_date,
        event_time,
        event_location,
        work_order_number,
        work_order_sequence,
        status,
        issue_date,
        customer_name,
        customer_gst,
        notes,
        shipping_snapshot,
        billing_snapshot,
        subtotal,
        grand_total,
        total_amount
      )
      VALUES (NULL, NULL, ?, 'CRM', ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, 0, 0, 0)
      `,
      [
        workOrderMode,
        pax || null,
        event_name || null,
        event_date || null,
        event_time || null,
        event_location || null,
        work_order_number,
        nextSeq,
        initialWorkOrderStatus,
        customer_name,
        customer_gst || null,
        notes || null,
        JSON.stringify(shippingSnapshot),
        JSON.stringify(billingSnapshot)
      ]
    )

    const workOrderId = header.insertId

    /* 5️⃣ Insert items and calculate total */
    let computedTotal = 0

    for (const it of items) {
      const effectiveQty = Number(it.quantity) || 0
      const unitPrice = Number(it.unit_price) || Number(it.selling_price) || 0
      const discount = Number(it.discount) || 0
      const tax = Number(it.tax) || 0

      const lineTotal = effectiveQty * unitPrice - discount + tax
      computedTotal += lineTotal

      await connection.query(
        `
        INSERT INTO work_order_items
        (
          work_order_id,
          product_id,
          product_name,
          variant_id,
          variant_name,
          description,
          quantity,
          unit_price,
          discount,
          tax
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          workOrderId,
          it.product_id || null,
          it.product_name || '',
          it.variant_id || null,
          it.variant_name || null,
          it.description || it.product_name || null,
          effectiveQty,
          unitPrice,
          discount,
          tax
        ]
      )
    }

    /* 6️⃣ Update totals */
    await connection.query(
      `
      UPDATE work_orders
      SET subtotal = ?, 
          grand_total = ?, 
          total_amount = ?
      WHERE id = ?
      `,
      [computedTotal, computedTotal, computedTotal, workOrderId]
    )

    if (Number.isInteger(actorUserId) && actorUserId > 0) {
      const adminUserIds = await getAdminUserIds(connection)
      await createNotificationsForUsers({
        byUserId: actorUserId,
        toUserIds: adminUserIds,
        module: 'work_orders',
        action: `Work Order Created - ${work_order_number || `#${workOrderId}`}`,
        sourceId: workOrderId,
        redirectUrl: `/workorders/${workOrderId}`,
        connection,
      })
    }

    await connection.commit()
    connection.release()

    return res.status(201).json({
      message: 'Work order created manually',
      work_order_id: workOrderId,
      work_order_number
    })

  } catch (error) {
    console.error('createManualWorkOrder error:', error)
    await connection.rollback()
    connection.release()
    return res.status(500).json({ error: error.message })
  }
}

module.exports = {
  createFromQuotation,
  createManualWorkOrder,
  getWorkOrders,
  getWorkOrdersForUser,
  getWorkOrderById,
  updateWorkOrderStatus,
  _createWorkOrderForQuotation,
  createWorkOrderForQuotation: _createWorkOrderForQuotation
}
