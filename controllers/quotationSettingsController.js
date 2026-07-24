const db = require('../config/db');

const ensureKotPrintPageSizeColumn = async () => {
  try {
    const [dbRows] = await db.query(`SELECT DATABASE() AS dbName`);
    const dbName = dbRows?.[0]?.dbName;

    if (!dbName) return;

    const [columnRows] = await db.query(
      `
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'quotation_settings'
        AND COLUMN_NAME = 'kot_print_page_size'
      LIMIT 1
      `,
      [dbName]
    );

    if (!columnRows.length) {
      await db.query(
        `
        ALTER TABLE quotation_settings
        ADD COLUMN kot_print_page_size ENUM('SLIP', 'A4') DEFAULT 'SLIP'
        `
      );
    }
  } catch (err) {
    console.warn('ensureKotPrintPageSizeColumn warning:', err.message);
  }
};

/* ---------------------------------------------------------
   Get Quotation Settings
--------------------------------------------------------- */
const getQuotationSettings = async (req, res) => {
  try {
    await ensureKotPrintPageSizeColumn();

    const [results] = await db.query(
      `SELECT * FROM quotation_settings LIMIT 1`
    );

    if (!results.length) {
      return res.status(200).json({
        id: 1,
        layout_option: 'minimal',
        logo_url: '',
        terms_conditions_html: '',
        cover_letter_html: '',
        footer_notes_html: '',
        prefix: 'QT',
        sequence_start: 1,
        number_format: '{prefix}/{year}/{seq}',
        numbering_mode: 'continuous',
        kot_print_page_size: 'SLIP'
      });
    }

    return res.status(200).json({
      ...results[0],
      kot_print_page_size: results[0].kot_print_page_size || 'SLIP',
    });

  } catch (err) {
    console.error('getQuotationSettings error:', err);
    return res.status(500).json({
      error: 'Failed to fetch settings',
      details: err.message
    });
  }
};

/* ---------------------------------------------------------
   Save / Upsert Settings
--------------------------------------------------------- */
const saveQuotationSettings = async (req, res) => {
  const {
    layout_option,
    logo_url,
    terms_conditions_html,
    cover_letter_html,
    footer_notes_html,
    prefix,
    sequence_start,
    number_format,
    numbering_mode,
    kot_print_page_size
  } = req.body;

  try {
    await ensureKotPrintPageSizeColumn();

    // If the client omits `logo_url`, pass NULL so the DB keeps the existing value.
    const logoParam = Object.prototype.hasOwnProperty.call(req.body, 'logo_url')
      ? logo_url
      : null;

    await db.query(
      `
      INSERT INTO quotation_settings
      (
        id,
        layout_option,
        logo_url,
        terms_conditions_html,
        cover_letter_html,
        footer_notes_html,
        prefix,
        sequence_start,
        number_format,
        numbering_mode,
        kot_print_page_size
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        layout_option = VALUES(layout_option),
        logo_url = COALESCE(VALUES(logo_url), logo_url),
        terms_conditions_html = VALUES(terms_conditions_html),
        cover_letter_html = VALUES(cover_letter_html),
        footer_notes_html = VALUES(footer_notes_html),
        prefix = VALUES(prefix),
        sequence_start = VALUES(sequence_start),
        number_format = VALUES(number_format),
        numbering_mode = VALUES(numbering_mode),
        kot_print_page_size = VALUES(kot_print_page_size)
      `,
      [
        layout_option || 'minimal',
        logoParam,
        terms_conditions_html || '',
        cover_letter_html || '',
        footer_notes_html || '',
        prefix || 'QT',
        sequence_start || 1,
        number_format || '{prefix}/{year}/{seq}',
        numbering_mode || 'continuous',
        kot_print_page_size === 'A4' ? 'A4' : 'SLIP'
      ]
    );

    return res.status(200).json({
      message: 'Quotation settings saved successfully'
    });

  } catch (err) {
    console.error('saveQuotationSettings error:', err);
    return res.status(500).json({
      error: 'Failed to save settings',
      details: err.message
    });
  }
};

module.exports = {
  getQuotationSettings,
  saveQuotationSettings
};