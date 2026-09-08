const db = require('../config/db');

const COMPANY_COLUMNS = {
  company_type: "VARCHAR(20) NOT NULL DEFAULT 'ISSUING'",
  legal_name: 'VARCHAR(255) NULL',
  logo_url: 'VARCHAR(500) NULL',
  registered_address: 'TEXT NULL',
  registered_city: 'VARCHAR(100) NULL',
  registered_state: 'VARCHAR(100) NULL',
  registered_pincode: 'VARCHAR(20) NULL',
  billing_address: 'TEXT NULL',
  billing_city: 'VARCHAR(100) NULL',
  billing_state: 'VARCHAR(100) NULL',
  billing_pincode: 'VARCHAR(20) NULL',
  shipping_address: 'TEXT NULL',
  shipping_city: 'VARCHAR(100) NULL',
  shipping_state: 'VARCHAR(100) NULL',
  shipping_pincode: 'VARCHAR(20) NULL',
};

async function ensureCompanySchema(connection = db) {
  const [columns] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies'");
  const existing = new Set(columns.map((row) => String(row.COLUMN_NAME).toLowerCase()));
  for (const [name, definition] of Object.entries(COMPANY_COLUMNS)) {
    if (!existing.has(name)) await connection.query(`ALTER TABLE companies ADD COLUMN ${name} ${definition}`);
  }
}

const companyPayload = (body = {}) => ({
  name: String(body.name || '').trim(),
  legal_name: body.legal_name || null,
  company_type: ['ISSUING', 'CUSTOMER', 'BOTH'].includes(String(body.company_type || '').toUpperCase()) ? String(body.company_type).toUpperCase() : 'ISSUING',
  gst_number: body.gst_number || null,
  pan_number: body.pan_number || null,
  email: body.email || null,
  phone: body.phone || null,
  website: body.website || null,
  logo_url: body.logo_url || null,
  address: body.registered_address || body.address || null,
  registered_address: body.registered_address || body.address || null,
  registered_city: body.registered_city || null,
  registered_state: body.registered_state || null,
  registered_pincode: body.registered_pincode || null,
  billing_address: body.billing_address || body.registered_address || body.address || null,
  billing_city: body.billing_city || body.registered_city || null,
  billing_state: body.billing_state || body.registered_state || null,
  billing_pincode: body.billing_pincode || body.registered_pincode || null,
  shipping_address: body.shipping_address || body.registered_address || body.address || null,
  shipping_city: body.shipping_city || body.registered_city || null,
  shipping_state: body.shipping_state || body.registered_state || null,
  shipping_pincode: body.shipping_pincode || body.registered_pincode || null,
});

const writable = ['name', 'legal_name', 'company_type', 'gst_number', 'pan_number', 'email', 'phone', 'website', 'logo_url', 'address', 'registered_address', 'registered_city', 'registered_state', 'registered_pincode', 'billing_address', 'billing_city', 'billing_state', 'billing_pincode', 'shipping_address', 'shipping_city', 'shipping_state', 'shipping_pincode'];

const createCompany = async (req, res) => {
  try {
    await ensureCompanySchema();
    const payload = companyPayload(req.body);
    if (!payload.name) return res.status(400).json({ error: 'Company name is required.' });
    const [result] = await db.query(`INSERT INTO companies (${writable.join(', ')}) VALUES (${writable.map(() => '?').join(', ')})`, writable.map((key) => payload[key]));
    const [[company]] = await db.query('SELECT * FROM companies WHERE id = ?', [result.insertId]);
    return res.status(201).json({ ...company, companyId: company.id });
  } catch (err) {
    console.error('CREATE COMPANY ERROR:', err);
    return res.status(500).json({ error: 'Failed to create company', details: err.message });
  }
};

const getCompanies = async (req, res) => {
  try {
    await ensureCompanySchema();
    const scope = String(req.query.scope || '').toUpperCase();
    const where = scope === 'ISSUING' ? " WHERE company_type IN ('ISSUING','BOTH')" : scope === 'CUSTOMER' ? " WHERE company_type IN ('CUSTOMER','BOTH')" : '';
    const [results] = await db.query(`SELECT * FROM companies${where} ORDER BY name ASC`);
    return res.status(200).json(results);
  } catch (err) {
    console.error('GET COMPANIES ERROR:', err);
    return res.status(500).json({ error: 'Failed to fetch companies', details: err.message });
  }
};

const getCompanyById = async (req, res) => {
  try {
    await ensureCompanySchema();
    const [[company]] = await db.query('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const [contacts] = await db.query(
      `SELECT * FROM leads
       WHERE company_id = ?
          OR (company_id IS NULL AND company_name = ?)
       ORDER BY created_at DESC, id DESC`,
      [company.id, company.name]
    );

    const leadIds = contacts.map((contact) => Number(contact.id)).filter(Boolean);
    let quotations = [];
    let activities = [];
    let invoices = [];

    if (leadIds.length) {
      [quotations] = await db.query(
        `SELECT q.*,
                CONCAT_WS(' ', l.first_name, l.last_name) AS lead_name,
                l.email AS lead_email
         FROM quotations q
         LEFT JOIN leads l ON l.id = q.lead_id
         WHERE q.lead_id IN (?)
         ORDER BY q.created_at DESC, q.id DESC`,
        [leadIds]
      );

      try {
        [activities] = await db.query(
          `SELECT a.*, CONCAT_WS(' ', l.first_name, l.last_name) AS lead_name
           FROM activities a
           LEFT JOIN leads l ON l.id = a.lead_id
           WHERE a.lead_id IN (?)
           ORDER BY a.created_at DESC, a.id DESC`,
          [leadIds]
        );
      } catch (_) {
        activities = [];
      }

      try {
        [invoices] = await db.query(
          `SELECT i.id, i.invoice_number, i.status, i.grand_total, i.created_at, i.lead_id
           FROM invoices i
           WHERE i.lead_id IN (?)
           ORDER BY i.created_at DESC, i.id DESC`,
          [leadIds]
        );
      } catch (_) {
        invoices = [];
      }
    }

    const revenue = invoices
      .filter((invoice) => !['cancelled', 'canceled', 'void'].includes(String(invoice.status || '').toLowerCase()))
      .reduce((sum, invoice) => sum + Number(invoice.grand_total || 0), 0);
    const quotedValue = quotations.reduce((sum, quotation) => sum + Number(quotation.total_amount || quotation.grand_total || 0), 0);

    return res.json({
      ...company,
      contacts,
      quotations,
      activities,
      invoices,
      stats: {
        contacts: contacts.length,
        quotations: quotations.length,
        invoices: invoices.length,
        quoted_value: quotedValue,
        revenue,
      },
    });
  } catch (err) {
    console.error('GET COMPANY DETAIL ERROR:', err);
    return res.status(500).json({ error: 'Failed to fetch company', details: err.message });
  }
};

const updateCompany = async (req, res) => {
  try {
    await ensureCompanySchema();
    const payload = companyPayload(req.body);
    if (!payload.name) return res.status(400).json({ error: 'Company name is required.' });
    const [result] = await db.query(`UPDATE companies SET ${writable.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, [...writable.map((key) => payload[key]), req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Company not found' });
    const [[company]] = await db.query('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    return res.json(company);
  } catch (err) {
    console.error('UPDATE COMPANY ERROR:', err);
    return res.status(500).json({ error: 'Failed to update company', details: err.message });
  }
};

const deleteCompany = async (req, res) => {
  try {
    await ensureCompanySchema();
    const [result] = await db.query('DELETE FROM companies WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Company not found' });
    return res.json({ message: 'Company deleted successfully.' });
  } catch (err) { return res.status(500).json({ error: 'Failed to delete company', details: err.message }); }
};

module.exports = { createCompany, getCompanies, getCompanyById, updateCompany, deleteCompany, ensureCompanySchema };
