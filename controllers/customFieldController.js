const db = require('../config/db');

/* ====================================================================
   CREATE CUSTOM FIELD
==================================================================== */
exports.createCustomField = async (req, res) => {
  const { field_name, field_type, is_required, options, created_by } = req.body;

  if (!field_name || !field_type) {
    return res.status(400).json({ error: 'Field name and type are required' });
  }

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [result] = await connection.query(
      `
      INSERT INTO lead_custom_fields 
      (field_name, field_type, is_required, created_by)
      VALUES (?, ?, ?, ?)
      `,
      [field_name, field_type, is_required || false, created_by || null]
    );

    const fieldId = result.insertId;

    // Insert options if provided
    if (options && options.length > 0) {
      const optionValues = options.map(opt => [fieldId, opt]);

      await connection.query(
        `
        INSERT INTO lead_custom_fields_option (field_id, option_value)
        VALUES ?
        `,
        [optionValues]
      );
    }

    await connection.commit();

    res.status(201).json({
      message: "Custom field created successfully",
      field_id: fieldId
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("CREATE CUSTOM FIELD ERROR:", err);
    res.status(500).json({ error: "Failed to create custom field" });
  } finally {
    if (connection) connection.release();
  }
};


/* ====================================================================
   GET ALL FIELDS WITH OPTIONS
==================================================================== */
exports.getAllCustomFields = async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT cf.field_id, cf.field_name, cf.field_type, cf.is_required, cfo.option_value
      FROM lead_custom_fields cf
      LEFT JOIN lead_custom_fields_option cfo 
        ON cf.field_id = cfo.field_id
    `);

    const fieldsMap = {};

    for (const row of results) {
      const { field_id, field_name, field_type, is_required, option_value } = row;

      if (!fieldsMap[field_id]) {
        fieldsMap[field_id] = {
          field_id,
          field_name,
          field_type,
          is_required,
          options: []
        };
      }

      if (option_value) {
        fieldsMap[field_id].options.push(option_value);
      }
    }

    res.status(200).json(Object.values(fieldsMap));

  } catch (err) {
    console.error("GET CUSTOM FIELDS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch custom fields" });
  }
};


/* ====================================================================
   UPDATE CUSTOM FIELD
==================================================================== */
exports.updateCustomField = async (req, res) => {
  const { field_id } = req.params;
  const { field_name, field_type, is_required, options } = req.body;

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      `
      UPDATE lead_custom_fields
      SET field_name = ?, field_type = ?, is_required = ?
      WHERE field_id = ?
      `,
      [field_name, field_type, is_required, field_id]
    );

    // Delete existing options
    await connection.query(
      `DELETE FROM lead_custom_fields_option WHERE field_id = ?`,
      [field_id]
    );

    // Insert new options if provided
    if (options && options.length > 0) {
      const optionValues = options.map(opt => [field_id, opt]);

      await connection.query(
        `
        INSERT INTO lead_custom_fields_option (field_id, option_value)
        VALUES ?
        `,
        [optionValues]
      );
    }

    await connection.commit();

    res.status(200).json({ message: "Custom field updated successfully" });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("UPDATE CUSTOM FIELD ERROR:", err);
    res.status(500).json({ error: "Failed to update custom field" });
  } finally {
    if (connection) connection.release();
  }
};


/* ====================================================================
   DELETE CUSTOM FIELD
==================================================================== */
exports.deleteCustomField = async (req, res) => {
  const { field_id } = req.params;

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Delete options first (safety)
    await connection.query(
      `DELETE FROM lead_custom_fields_option WHERE field_id = ?`,
      [field_id]
    );

    const [result] = await connection.query(
      `DELETE FROM lead_custom_fields WHERE field_id = ?`,
      [field_id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Custom field not found" });
    }

    await connection.commit();

    res.status(200).json({ message: "Custom field deleted successfully" });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("DELETE CUSTOM FIELD ERROR:", err);
    res.status(500).json({ error: "Failed to delete custom field" });
  } finally {
    if (connection) connection.release();
  }
};
