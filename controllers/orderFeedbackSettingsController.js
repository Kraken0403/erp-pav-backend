const db = require('../config/db');

const DEFAULT_SETTINGS = {
  is_email_enabled: 1,
  delay_minutes: 30,
  email_subject: 'How was your order?',
};

const sanitizeDelayMinutes = (value) => {
  const num = Number(value);
  if (!Number.isInteger(num)) return DEFAULT_SETTINGS.delay_minutes;
  return Math.min(Math.max(num, 1), 1440);
};

const sanitizeSubject = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_SETTINGS.email_subject;
  return raw.slice(0, 255);
};

const ensureSettingsRow = async () => {
  const [rows] = await db.query(`SELECT id FROM order_feedback_settings LIMIT 1`);

  if (rows.length) return rows[0].id;

  const [result] = await db.query(
    `
    INSERT INTO order_feedback_settings
    (is_email_enabled, delay_minutes, email_subject)
    VALUES (?, ?, ?)
    `,
    [
      DEFAULT_SETTINGS.is_email_enabled,
      DEFAULT_SETTINGS.delay_minutes,
      DEFAULT_SETTINGS.email_subject,
    ]
  );

  return result.insertId;
};

const getOrderFeedbackSettings = async (req, res) => {
  try {
    await ensureSettingsRow();

    const [rows] = await db.query(`SELECT * FROM order_feedback_settings LIMIT 1`);

    return res.status(200).json(rows[0]);
  } catch (error) {
    console.error('getOrderFeedbackSettings error:', error);
    return res.status(500).json({ error: error.message });
  }
};

const saveOrderFeedbackSettings = async (req, res) => {
  const { is_email_enabled, delay_minutes, email_subject } = req.body || {};

  try {
    const settingsId = await ensureSettingsRow();

    await db.query(
      `
      UPDATE order_feedback_settings
      SET
        is_email_enabled = ?,
        delay_minutes = ?,
        email_subject = ?
      WHERE id = ?
      `,
      [
        is_email_enabled ? 1 : 0,
        sanitizeDelayMinutes(delay_minutes),
        sanitizeSubject(email_subject),
        settingsId,
      ]
    );

    return res.status(200).json({ message: 'Order feedback settings saved successfully' });
  } catch (error) {
    console.error('saveOrderFeedbackSettings error:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getOrderFeedbackSettings,
  saveOrderFeedbackSettings,
};
