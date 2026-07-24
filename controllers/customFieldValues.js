const db = require('../config/db');

/* --------------------------------------------------
   GET CUSTOM FIELDS FOR A LEAD (PROMISE VERSION)
-------------------------------------------------- */
exports.getCustomFieldsByLeadId = async (leadId) => {
  if (!leadId) {
    throw new Error('Lead ID is required');
  }

  try {
    const [results] = await db.query(
      'SELECT * FROM lead_field_values WHERE lead_id = ?',
      [leadId]
    );

    return results;
  } catch (err) {
    throw new Error('Failed to fetch custom fields: ' + err.message);
  }
};


/* --------------------------------------------------
   ADD OR UPDATE CUSTOM FIELDS (TRANSACTION SAFE)
-------------------------------------------------- */
exports.addOrUpdateCustomFields = async (leadId, customFields, connection) => {
  if (!customFields || customFields.length === 0) {
    return; // nothing to update
  }

  const insertQuery = `
    INSERT INTO lead_field_values (lead_id, field_id, field_value)
    VALUES ?
    ON DUPLICATE KEY UPDATE field_value = VALUES(field_value)
  `;

  const values = customFields.map((field) => [
    leadId,
    field.field_id,
    field.field_value
  ]);

  try {
    await connection.query(insertQuery, [values]);
  } catch (err) {
    throw new Error('Failed to update custom fields: ' + err.message);
  }
};
