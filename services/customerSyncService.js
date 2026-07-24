const { ensureCustomerSchema } = require('../utils/pavilionSchema');

const buildCustomerName = (lead) => {
  const personal = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  return lead.company_name || personal || lead.email || lead.phone_number || 'Customer';
};

async function upsertCustomerFromLead(connection, leadId, userId = null) {
  if (!leadId) return null;
  await ensureCustomerSchema(connection);

  const [[lead]] = await connection.query(
    `SELECT id, first_name, last_name, company_name, email, phone_number, billing_address, billing_city, billing_state, billing_pincode, shipping_address
     FROM leads WHERE id = ? LIMIT 1`,
    [leadId]
  );

  if (!lead) return null;

  const name = buildCustomerName(lead);
  const email = lead.email || null;
  const phone = lead.phone_number || null;

  let existing = null;
  if (email || phone) {
    const [rows] = await connection.query(
      `SELECT id FROM customers WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?) LIMIT 1`,
      [email || '', phone || '']
    );
    existing = rows[0] || null;
  }

  const values = [
    userId || null,
    name,
    email,
    phone,
    lead.billing_address || lead.shipping_address || null,
    lead.billing_city || null,
    lead.billing_state || null,
    lead.billing_pincode || null,
    'LEAD',
    lead.id,
  ];

  if (existing) {
    await connection.query(
      `UPDATE customers SET user_id = COALESCE(?, user_id), name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone), address = COALESCE(?, address), city = COALESCE(?, city), state = COALESCE(?, state), pincode = COALESCE(?, pincode), source_type = ?, source_id = ?, updated_at = NOW() WHERE id = ?`,
      [...values, existing.id]
    );
    return existing.id;
  }

  const [result] = await connection.query(
    `INSERT INTO customers (user_id, name, email, phone, address, city, state, pincode, source_type, source_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    values
  );

  return result.insertId;
}

module.exports = { upsertCustomerFromLead };
