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

const getKotSettings = async (req, res) => {
  try {
    await ensureKotPrintPageSizeColumn();

    const [rows] = await db.query(
      `SELECT kot_print_page_size FROM quotation_settings WHERE id = 1 LIMIT 1`
    );

    return res.status(200).json({
      kot_print_page_size: rows?.[0]?.kot_print_page_size || 'SLIP',
    });
  } catch (err) {
    console.error('getKotSettings error:', err);
    return res.status(500).json({ error: 'Failed to fetch KOT settings', details: err.message });
  }
};

const saveKotSettings = async (req, res) => {
  const { kot_print_page_size } = req.body;
  const normalized = String(kot_print_page_size || '').toUpperCase() === 'A4' ? 'A4' : 'SLIP';

  try {
    await ensureKotPrintPageSizeColumn();

    await db.query(
      `
      INSERT INTO quotation_settings (id, kot_print_page_size)
      VALUES (1, ?)
      ON DUPLICATE KEY UPDATE
        kot_print_page_size = VALUES(kot_print_page_size)
      `,
      [normalized]
    );

    return res.status(200).json({ message: 'KOT settings saved successfully' });
  } catch (err) {
    console.error('saveKotSettings error:', err);
    return res.status(500).json({ error: 'Failed to save KOT settings', details: err.message });
  }
};

module.exports = {
  getKotSettings,
  saveKotSettings,
};
