const db = require('../config/db');

/* ======================================================
   FETCH ACTUAL DB COLUMNS
====================================================== */
exports.getLeadFields = async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'leads' 
        AND TABLE_SCHEMA = DATABASE();
    `);

    const fieldNames = results.map(field => field.COLUMN_NAME);

    return res.status(200).json({ fields: fieldNames });

  } catch (err) {
    console.error('Error fetching lead fields:', err);
    return res.status(500).json({
      error: 'Failed to fetch lead fields.',
      details: err.message
    });
  }
};


/* ======================================================
   SAVE FIELD ORDER
====================================================== */
exports.saveFieldOrder = async (req, res) => {
  const { fields } = req.body;

  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ error: 'No fields provided.' });
  }

  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated.' });
  }

  const userId = req.user.id;
  const fieldsJson = JSON.stringify(fields);

  try {
    await db.query(
      `
      INSERT INTO field_order (user_id, fields)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE fields = ?;
      `,
      [userId, fieldsJson, fieldsJson]
    );

    return res.status(200).json({
      message: 'Field order saved successfully.'
    });

  } catch (err) {
    console.error('Error saving field order:', err);
    return res.status(500).json({
      error: 'Error saving field order.',
      details: err.message
    });
  }
};


/* ======================================================
   GET SAVED FIELD ORDER
====================================================== */
exports.getFieldOrder = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated.' });
  }

  const userId = req.user.id;

  try {
    const [result] = await db.query(
      `SELECT fields FROM field_order WHERE user_id = ?`,
      [userId]
    );

    // First time user
    if (!result.length) {
      return res.status(200).json({ fieldOrder: [] });
    }

    let parsed = [];

    try {
      parsed = JSON.parse(result[0].fields || '[]');
    } catch {
      parsed = [];
    }

    return res.status(200).json({
      fieldOrder: parsed
    });

  } catch (err) {
    console.error('Error fetching field order:', err);
    return res.status(500).json({
      error: 'Error fetching field order.',
      details: err.message
    });
  }
};
