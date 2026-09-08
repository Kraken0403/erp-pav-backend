const db = require('../config/db');
const { ensureWorkOrderSettingsSchema } = require('../utils/pavilionSchema');

exports.getWorkOrderSettings = async (req, res) => {
  try {
    await ensureWorkOrderSettingsSchema(db);
    const [[settings]] = await db.query('SELECT * FROM work_order_settings WHERE id = 1');
    return res.json(settings || {});
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch work order settings', details: error.message });
  }
};

exports.saveWorkOrderSettings = async (req, res) => {
  const { prefix = 'WO', number_format = '{prefix}/{year}/{seq}', numbering_mode = 'continuous', terms_conditions_html = '', footer_notes_html = '' } = req.body || {};
  try {
    await ensureWorkOrderSettingsSchema(db);
    await db.query(`
      INSERT INTO work_order_settings (id, prefix, number_format, numbering_mode, terms_conditions_html, footer_notes_html)
      VALUES (1, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE prefix=VALUES(prefix), number_format=VALUES(number_format), numbering_mode=VALUES(numbering_mode), terms_conditions_html=VALUES(terms_conditions_html), footer_notes_html=VALUES(footer_notes_html)
    `, [prefix, number_format, ['continuous', 'yearly', 'monthly'].includes(numbering_mode) ? numbering_mode : 'continuous', terms_conditions_html, footer_notes_html]);
    return res.json({ message: 'Work order settings saved' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to save work order settings', details: error.message });
  }
};
