const db = require("../config/db");
const { ensureCustomerSchema } = require("../utils/pavilionSchema");

const logCustomerCreateError = (message, meta = {}) => {
  console.error("[CUSTOMER][CREATE]", message, {
    timestamp: new Date().toISOString(),
    ...meta,
  });
};

/**
 * Create a new customer
 */
exports.createCustomer = async (req, res) => {
  try {
    await ensureCustomerSchema(db);
    const { name, email, phone, address, landmark, city, state, pincode } =
      req.body;
    const user_id = req.user?.id || null;

    // Validate required fields
    if (!name || !email) {
      logCustomerCreateError("Validation failed: required fields missing", {
        userId: user_id,
        hasName: Boolean(name),
        hasEmail: Boolean(email),
        body: req.body,
      });
      return res.status(400).json({ error: "Name and email are required" });
    }

    // Check if email already exists
    const [existingCustomer] = await db.query(
      `SELECT id FROM customers WHERE email = ? LIMIT 1`,
      [email],
    );

    if (existingCustomer.length > 0) {
      logCustomerCreateError("Duplicate email blocked", {
        userId: user_id,
        email,
      });
      return res.status(400).json({ error: "Email already exists" });
    }

    // Insert new customer
    const [result] = await db.query(
      `INSERT INTO customers (user_id, name, email, phone, address, landmark, city, state, pincode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        user_id,
        name,
        email,
        phone || null,
        address || null,
        landmark || null,
        city || null,
        state || null,
        pincode || null,
      ],
    );

    res.status(201).json({
      message: "Customer created successfully",
      customerId: result.insertId,
    });
  } catch (error) {
    logCustomerCreateError("Unhandled error while creating customer", {
      userId: req.user?.id || null,
      body: req.body,
      errorMessage: error?.message,
      errorCode: error?.code,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ error: error.message || "Failed to create customer" });
  }
};

/**
 * Get all customers
 */
const normalizeCustomerKey = (customer = {}) => {
  const email = String(customer.customer_email || customer.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;

  const phone = String(customer.customer_phone || customer.phone || '').replace(/\D/g, '');
  if (phone) return `phone:${phone}`;

  const name = String(customer.customer_name || customer.name || '').trim().toLowerCase();
  if (name) return `name:${name}`;

  const sourceId = customer.source_id || customer.id || customer.row_id || '';
  return `row:${String(customer.source || 'customer').toLowerCase()}:${String(sourceId || 'unknown')}`;
};

const normalizeBusinessCustomer = (row = {}) => ({
  row_id: row.row_id || normalizeCustomerKey(row),
  source: row.source || row.source_label || 'CRM',
  source_id: row.source_id || row.lead_id || row.id || null,
  lead_id: row.lead_id || null,
  customer_name: row.customer_name || row.name || 'Unknown Customer',
  customer_email: row.customer_email || row.email || '',
  customer_phone: row.customer_phone || row.phone || '',
  company_name: row.company_name || '',
  total_invoices: Number(row.total_invoices || row.total_orders || 0),
  total_orders: Number(row.total_orders || row.total_invoices || 0),
  total_spent: Number(row.total_spent || 0),
  paid_amount: Number(row.paid_amount || 0),
  pending_amount: Number(row.pending_amount || 0),
  last_transaction_date: row.last_transaction_date || row.updated_at || row.created_at || null,
});

/**
 * Get all customers.
 * Customers are derived from leads that have actually converted / done business
 * plus manually-created CRM customers. This keeps the Customers page useful for
 * Pavilion/general businesses instead of showing only website/frontend orders.
 */
exports.getAllCustomers = async (req, res) => {
  try {
    await ensureCustomerSchema(db);

    const [manualCustomers] = await db.query(
      `SELECT
          CONCAT('customer_', c.id) AS row_id,
          c.id AS source_id,
          c.source_type AS source,
          c.name AS customer_name,
          c.email AS customer_email,
          c.phone AS customer_phone,
          '' AS company_name,
          0 AS total_invoices,
          0 AS total_orders,
          0 AS total_spent,
          0 AS paid_amount,
          0 AS pending_amount,
          c.created_at AS last_transaction_date,
          c.created_at,
          c.updated_at
       FROM customers c`
    );

    const [businessLeadRows] = await db.query(
      `SELECT
          CONCAT('lead_', l.id) AS row_id,
          'LEAD' AS source,
          l.id AS source_id,
          l.id AS lead_id,
          COALESCE(
            NULLIF(TRIM(CONCAT(COALESCE(l.first_name, ''), ' ', COALESCE(l.last_name, ''))), ''),
            NULLIF(l.contact_name, ''),
            NULLIF(l.company_name, ''),
            'Unknown Customer'
          ) AS customer_name,
          COALESCE(l.email, '') AS customer_email,
          COALESCE(l.phone_number, '') AS customer_phone,
          COALESCE(l.company_name, '') AS company_name,
          COALESCE(inv.invoice_count, 0) AS total_invoices,
          COALESCE(inv.invoice_count, 0) + COALESCE(wo.work_order_count, 0) + COALESCE(pi.proforma_count, 0) AS total_orders,
          COALESCE(inv.invoice_total, 0) + COALESCE(wo.work_order_total, 0) AS total_spent,
          COALESCE(inv.paid_amount, 0) AS paid_amount,
          COALESCE(inv.pending_amount, 0) AS pending_amount,
          GREATEST(
            COALESCE(inv.last_invoice_date, '1000-01-01'),
            COALESCE(wo.last_work_order_date, '1000-01-01'),
            COALESCE(pi.last_proforma_date, '1000-01-01'),
            COALESCE(q.last_quotation_date, '1000-01-01'),
            COALESCE(DATE(l.updated_at), '1000-01-01')
          ) AS last_transaction_date
       FROM leads l
       LEFT JOIN (
          SELECT lead_id,
                 COUNT(*) AS quotation_count,
                 MAX(quotation_date) AS last_quotation_date,
                 SUM(COALESCE(total_amount, 0)) AS quotation_total
          FROM quotations
          WHERE lead_id IS NOT NULL
            AND LOWER(COALESCE(status, '')) IN ('approved', 'converted', 'won')
          GROUP BY lead_id
       ) q ON q.lead_id = l.id
       LEFT JOIN (
          SELECT lead_id,
                 COUNT(*) AS work_order_count,
                 MAX(issue_date) AS last_work_order_date,
                 SUM(COALESCE(grand_total, total_amount, 0)) AS work_order_total
          FROM work_orders
          WHERE lead_id IS NOT NULL
          GROUP BY lead_id
       ) wo ON wo.lead_id = l.id
       LEFT JOIN (
          SELECT lead_id,
                 COUNT(*) AS invoice_count,
                 MAX(issue_date) AS last_invoice_date,
                 SUM(COALESCE(grand_total, 0)) AS invoice_total,
                 SUM(CASE WHEN LOWER(COALESCE(status, '')) = 'paid' THEN COALESCE(grand_total, 0) ELSE 0 END) AS paid_amount,
                 SUM(CASE WHEN LOWER(COALESCE(status, '')) <> 'paid' THEN COALESCE(grand_total, 0) ELSE 0 END) AS pending_amount
          FROM invoices
          WHERE lead_id IS NOT NULL
          GROUP BY lead_id
       ) inv ON inv.lead_id = l.id
       LEFT JOIN (
          SELECT lead_id,
                 COUNT(*) AS proforma_count,
                 MAX(issue_date) AS last_proforma_date
          FROM proforma_invoices
          WHERE lead_id IS NOT NULL
          GROUP BY lead_id
       ) pi ON pi.lead_id = l.id
       WHERE LOWER(COALESCE(l.lead_status, '')) IN ('won', 'converted', 'closed', 'closed won')
          OR q.quotation_count IS NOT NULL
          OR wo.work_order_count IS NOT NULL
          OR inv.invoice_count IS NOT NULL
          OR pi.proforma_count IS NOT NULL`
    );

    const merged = new Map();
    [...manualCustomers, ...businessLeadRows].forEach((row) => {
      const normalized = normalizeBusinessCustomer(row);
      const key = normalizeCustomerKey(normalized);
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, normalized);
        return;
      }

      merged.set(key, {
        ...existing,
        ...normalized,
        customer_name: existing.customer_name || normalized.customer_name,
        customer_email: existing.customer_email || normalized.customer_email,
        customer_phone: existing.customer_phone || normalized.customer_phone,
        company_name: existing.company_name || normalized.company_name,
        total_invoices: Number(existing.total_invoices || 0) + Number(normalized.total_invoices || 0),
        total_orders: Number(existing.total_orders || 0) + Number(normalized.total_orders || 0),
        total_spent: Number(existing.total_spent || 0) + Number(normalized.total_spent || 0),
        paid_amount: Number(existing.paid_amount || 0) + Number(normalized.paid_amount || 0),
        pending_amount: Number(existing.pending_amount || 0) + Number(normalized.pending_amount || 0),
        last_transaction_date: [existing.last_transaction_date, normalized.last_transaction_date]
          .filter(Boolean)
          .sort()
          .pop() || null,
      });
    });

    const customers = Array.from(merged.values()).sort((a, b) => {
      const da = new Date(a.last_transaction_date || 0).getTime();
      const dbb = new Date(b.last_transaction_date || 0).getTime();
      return dbb - da;
    });

    res.status(200).json({ data: customers });
  } catch (error) {
    console.error("GET CUSTOMERS ERROR:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to fetch customers" });
  }
};

/**
 * Get customer by ID
 */
exports.getCustomerById = async (req, res) => {
  try {
    await ensureCustomerSchema(db);
    const { id } = req.params;

    const [customers] = await db.query(
      `SELECT id, user_id, name, email, phone, address, landmark, city, state, pincode, created_at, updated_at
       FROM customers
       WHERE id = ? LIMIT 1`,
      [id],
    );

    if (customers.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.status(200).json({ data: customers[0] });
  } catch (error) {
    console.error("GET CUSTOMER ERROR:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to fetch customer" });
  }
};

/**
 * Update customer
 */
exports.updateCustomer = async (req, res) => {
  try {
    await ensureCustomerSchema(db);
    const { id } = req.params;
    const { name, email, phone, address, landmark, city, state, pincode } =
      req.body;

    // Check if customer exists
    const [existingCustomer] = await db.query(
      `SELECT id FROM customers WHERE id = ? LIMIT 1`,
      [id],
    );

    if (existingCustomer.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // Check if new email is unique (if email is being changed)
    if (email) {
      const [duplicateEmail] = await db.query(
        `SELECT id FROM customers WHERE email = ? AND id != ? LIMIT 1`,
        [email, id],
      );

      if (duplicateEmail.length > 0) {
        return res.status(400).json({ error: "Email already exists" });
      }
    }

    // Update customer
    await db.query(
      `UPDATE customers
       SET name = COALESCE(?, name),
           email = COALESCE(?, email),
           phone = COALESCE(?, phone),
           address = COALESCE(?, address),
           landmark = COALESCE(?, landmark),
           city = COALESCE(?, city),
           state = COALESCE(?, state),
           pincode = COALESCE(?, pincode),
           updated_at = NOW()
       WHERE id = ?`,
      [name, email, phone, address, landmark, city, state, pincode, id],
    );

    res.status(200).json({ message: "Customer updated successfully" });
  } catch (error) {
    console.error("UPDATE CUSTOMER ERROR:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to update customer" });
  }
};

/**
 * Delete customer
 */
exports.deleteCustomer = async (req, res) => {
  try {
    await ensureCustomerSchema(db);
    const { id } = req.params;

    // Check if customer exists
    const [existingCustomer] = await db.query(
      `SELECT id FROM customers WHERE id = ? LIMIT 1`,
      [id],
    );

    if (existingCustomer.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // Delete customer
    await db.query(`DELETE FROM customers WHERE id = ?`, [id]);

    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    console.error("DELETE CUSTOMER ERROR:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to delete customer" });
  }
};
