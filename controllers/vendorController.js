const db = require('../config/db');
const { ensureVendorSchema } = require('../utils/pavilionSchema');

const normalizeVendorPayload = (body = {}, userId = null) => ({
  name: String(body.name || '').trim(),
  contact_person: body.contact_person || null,
  email: body.email || null,
  phone: body.phone || null,
  alternate_phone: body.alternate_phone || null,
  gst_number: body.gst_number || null,
  address: body.address || null,
  city: body.city || null,
  state: body.state || null,
  pincode: body.pincode || null,
  brands: Array.isArray(body.brands) ? body.brands.join(', ') : (body.brands || null),
  payment_terms: body.payment_terms || null,
  credit_days: Number(body.credit_days || 0),
  opening_balance: Number(body.opening_balance || 0),
  notes: body.notes || null,
  is_active: typeof body.is_active === 'undefined' ? 1 : (body.is_active ? 1 : 0),
  created_by: userId || null,
});

exports.listVendors = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const search = String(req.query.search || '').trim();
    const includeInactive = String(req.query.includeInactive || 'false') === 'true';

    const values = [];
    let where = includeInactive ? '1=1' : 'v.is_active = 1';
    if (search) {
      where += ` AND (v.name LIKE ? OR v.contact_person LIKE ? OR v.email LIKE ? OR v.phone LIKE ? OR v.brands LIKE ?)`;
      const like = `%${search}%`;
      values.push(like, like, like, like, like);
    }

    const [vendors] = await db.query(
      `SELECT v.*, 
              COALESCE(SUM(CASE WHEN vp.status IN ('pending','partial') THEN vp.amount - vp.paid_amount ELSE 0 END), 0) AS payable_balance
       FROM vendors v
       LEFT JOIN vendor_payables vp ON vp.vendor_id = v.id
       WHERE ${where}
       GROUP BY v.id
       ORDER BY v.name ASC`,
      values
    );

    return res.json({ data: vendors });
  } catch (err) {
    console.error('listVendors error:', err);
    return res.status(500).json({ error: 'Failed to fetch vendors', details: err.message });
  }
};

exports.getVendorById = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const [[vendor]] = await db.query(`SELECT * FROM vendors WHERE id = ? LIMIT 1`, [req.params.id]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    return res.json({ data: vendor });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch vendor', details: err.message });
  }
};

exports.createVendor = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const payload = normalizeVendorPayload(req.body, req.user?.id || null);
    if (!payload.name) return res.status(400).json({ error: 'Vendor name is required' });

    const [result] = await db.query(
      `INSERT INTO vendors (name, contact_person, email, phone, alternate_phone, gst_number, address, city, state, pincode, brands, payment_terms, credit_days, opening_balance, notes, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [payload.name, payload.contact_person, payload.email, payload.phone, payload.alternate_phone, payload.gst_number, payload.address, payload.city, payload.state, payload.pincode, payload.brands, payload.payment_terms, payload.credit_days, payload.opening_balance, payload.notes, payload.is_active, payload.created_by]
    );

    const [[vendor]] = await db.query(`SELECT * FROM vendors WHERE id = ?`, [result.insertId]);
    return res.status(201).json({ message: 'Vendor created successfully', data: vendor });
  } catch (err) {
    console.error('createVendor error:', err);
    return res.status(500).json({ error: 'Failed to create vendor', details: err.message });
  }
};

exports.updateVendor = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const payload = normalizeVendorPayload(req.body, req.user?.id || null);
    if (!payload.name) return res.status(400).json({ error: 'Vendor name is required' });

    const [result] = await db.query(
      `UPDATE vendors SET name=?, contact_person=?, email=?, phone=?, alternate_phone=?, gst_number=?, address=?, city=?, state=?, pincode=?, brands=?, payment_terms=?, credit_days=?, opening_balance=?, notes=?, is_active=?, updated_at=NOW() WHERE id=?`,
      [payload.name, payload.contact_person, payload.email, payload.phone, payload.alternate_phone, payload.gst_number, payload.address, payload.city, payload.state, payload.pincode, payload.brands, payload.payment_terms, payload.credit_days, payload.opening_balance, payload.notes, payload.is_active, req.params.id]
    );

    if (!result.affectedRows) return res.status(404).json({ error: 'Vendor not found' });
    const [[vendor]] = await db.query(`SELECT * FROM vendors WHERE id = ?`, [req.params.id]);
    return res.json({ message: 'Vendor updated successfully', data: vendor });
  } catch (err) {
    console.error('updateVendor error:', err);
    return res.status(500).json({ error: 'Failed to update vendor', details: err.message });
  }
};

exports.deleteVendor = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    await db.query(`UPDATE vendors SET is_active = 0 WHERE id = ?`, [req.params.id]);
    return res.json({ message: 'Vendor archived successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to archive vendor', details: err.message });
  }
};

exports.listVendorPayables = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const status = String(req.query.status || '').trim();
    const vendorId = Number(req.query.vendor_id || 0);
    const values = [];
    let where = '1=1';
    if (status) { where += ' AND vp.status = ?'; values.push(status); }
    if (vendorId) { where += ' AND vp.vendor_id = ?'; values.push(vendorId); }

    const [rows] = await db.query(
      `SELECT vp.*, v.name AS vendor_name, wo.work_order_number, q.quotation_number, p.name AS product_name
       FROM vendor_payables vp
       JOIN vendors v ON v.id = vp.vendor_id
       LEFT JOIN work_orders wo ON wo.id = vp.work_order_id
       LEFT JOIN quotations q ON q.id = vp.quotation_id
       LEFT JOIN products p ON p.id = vp.product_id
       WHERE ${where}
       ORDER BY vp.created_at DESC`,
      values
    );

    const [summaryRows] = await db.query(
      `SELECT
          COALESCE(SUM(amount), 0) AS total_amount,
          COALESCE(SUM(paid_amount), 0) AS paid_amount,
          COALESCE(SUM(amount - paid_amount), 0) AS balance_amount
       FROM vendor_payables vp WHERE ${where}`,
      values
    );

    return res.json({ data: rows, summary: summaryRows[0] || {} });
  } catch (err) {
    console.error('listVendorPayables error:', err);
    return res.status(500).json({ error: 'Failed to fetch vendor payables', details: err.message });
  }
};

exports.recordVendorPayment = async (req, res) => {
  try {
    await ensureVendorSchema(db);
    const id = Number(req.params.id);
    const amount = Number(req.body.amount || 0);
    if (!id || amount <= 0) return res.status(400).json({ error: 'Valid payable and amount are required' });

    const [[payable]] = await db.query(`SELECT * FROM vendor_payables WHERE id = ? LIMIT 1`, [id]);
    if (!payable) return res.status(404).json({ error: 'Payable not found' });

    const paid = Number(payable.paid_amount || 0) + amount;
    const status = paid >= Number(payable.amount || 0) ? 'paid' : 'partial';
    await db.query(`UPDATE vendor_payables SET paid_amount = ?, status = ?, updated_at = NOW() WHERE id = ?`, [paid, status, id]);
    return res.json({ message: 'Vendor payment recorded successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to record vendor payment', details: err.message });
  }
};
