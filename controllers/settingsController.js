const db = require("../config/db");
const path = require("path");
const fs = require("fs");
const { isEmailEnabled, isWhatsAppEnabled } = require('../config/featureFlags');

/* --------------------------------------------------
   ENSURE SETTINGS ROW EXISTS (id = 1)
-------------------------------------------------- */
const ensureSettingsRowExists = async () => {
  const [rows] = await db.query(
    `SELECT id FROM settings WHERE id = 1`
  );

  if (rows.length > 0) return true;

  await db.query(
    `
    INSERT INTO settings (
      id,
      company_name,
      company_email,
      company_phone,
      currency_code,
      gst_enabled,
      gst_pricing_mode,
      company_country
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      1,
      '',
      '',
      '',
      'INR',
      1,
      'INCLUSIVE',
      'India'
    ]
  );

  return true;
};

/* --------------------------------------------------
   GET SETTINGS
-------------------------------------------------- */
exports.getSettings = async (req, res) => {
  try {
    await ensureSettingsRowExists();

    const [rows] = await db.query(
      `SELECT * FROM settings WHERE id = 1`
    );

    return res.status(200).json(rows[0] || {});

  } catch (error) {
    console.error('getSettings error:', error);
    return res.status(500).json({
      error: error.message
    });
  }
};


/* --------------------------------------------------
   UPDATE SETTINGS
-------------------------------------------------- */
exports.updateSettings = async (req, res) => {
  try {
    await ensureSettingsRowExists();

    const {
      company_name,
      company_email,
      company_phone,
      business_type,

      company_address_line1,
      company_address_line2,
      company_city,
      company_state,
      company_pincode,
      company_country,

      gst_enabled,
      gst_pricing_mode,
      gst_number,
      gst_state_code,

      currency_code
    } = req.body;

    const logoPath = req.file
      ? `/uploads/${req.file.filename}`
      : null;

    await db.query(
      `
      UPDATE settings
      SET
        company_name = ?,
        company_email = ?,
        company_phone = ?,
        business_type = ?,

        company_address_line1 = ?,
        company_address_line2 = ?,
        company_city = ?,
        company_state = ?,
        company_pincode = ?,
        company_country = ?,

        gst_enabled = ?,
        gst_pricing_mode = ?,
        gst_number = ?,
        gst_state_code = ?,

        currency_code = ?,
        company_logo = COALESCE(?, company_logo)

      WHERE id = 1
      `,
      [
        company_name || '',
        company_email || '',
        company_phone || '',
        business_type || 'GENERAL',

        company_address_line1 || '',
        company_address_line2 || '',
        company_city || '',
        company_state || '',
        company_pincode || '',
        company_country || 'India',

        gst_enabled !== undefined
          ? (gst_enabled ? 1 : 0)
          : 1,

        gst_pricing_mode || 'INCLUSIVE',
        gst_number || '',
        gst_state_code || '',
        currency_code || 'INR',
        logoPath
      ]
    );

    return res.status(200).json({
      message: 'Settings updated successfully',
      company_logo: logoPath || undefined
    });

  } catch (error) {
    console.error('updateSettings error:', error);
    return res.status(500).json({
      error: error.message
    });
  }
};

/* --------------------------------------------------
   NOTIFICATION CHANNEL FLAGS
-------------------------------------------------- */
exports.getNotificationChannelFlags = async (req, res) => {
  try {
    return res.status(200).json({
      allow_email: Boolean(isEmailEnabled()),
      allow_whatsapp: Boolean(isWhatsAppEnabled()),
    });
  } catch (error) {
    console.error('getNotificationChannelFlags error:', error);
    return res.status(500).json({
      error: error.message,
    });
  }
};

