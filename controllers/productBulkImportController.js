const XLSX = require('xlsx');
const fs = require('fs');
const db = require('../config/db');
const { createProductInternal } = require('../services/productService');

const resolveCategoryId = async (categoryPath) => {
  if (!categoryPath) return 1;

  const parts = categoryPath.split('>').map(p => p.trim());
  let parentId = null;

  for (const name of parts) {
    const [rows] = await db.query(
      'SELECT id FROM categories WHERE name = ? AND parent_id <=> ?',
      [name, parentId]
    );
    if (!rows.length) return null;
    parentId = rows[0].id;
  }
  return parentId;
};

const bulkImportProducts = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Excel file required' });
  }

  const workbook = XLSX.readFile(req.file.path);
  const sheet = workbook.Sheets['Products'];
  if (!sheet) {
    return res.status(400).json({ error: 'Products sheet missing' });
  }

  const rows = XLSX.utils.sheet_to_json(sheet);
  const result = {
    total: rows.length,
    success: 0,
    failed: 0,
    errors: []
  };

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        const category_id = await resolveCategoryId(row.category);
        if (!category_id) throw new Error('Invalid category');

        await createProductInternal({
          name: row.name,
          brand: row.brand,
          category_id,
          description: row.description,
          image_url: row.image_url,

          cost_pricing_mode: row.cost_pricing_mode || 'absolute',
          cost_discount_percent: row.cost_discount_percent,

          cost_price: row.cost_price || 0,
          cost_price_unit: row.cost_price_unit || 'piece',
          cost_price_qty: row.cost_price_qty || 1,

          selling_price: row.selling_price,
          selling_price_unit: row.selling_price_unit || 'piece',
          selling_price_qty: row.selling_price_qty || 1,

          gst_rate: row.gst_rate || 0,
          hsn_sac: row.hsn_sac,

          stock: row.stock || 0,
          sku: row.sku || `SKU-${Date.now()}-${i}`,
          type: 'simple',
          is_active: row.is_active ?? 1
        }, connection);

        result.success++;
      } catch (err) {
        result.failed++;
        result.errors.push({
          row: i + 2,
          product: row.name || 'Unnamed',
          error: err.message
        });
      }
    }

    await connection.commit();
    connection.release();
    fs.unlinkSync(req.file.path);

    res.json(result);

  } catch (err) {
    await connection.rollback();
    connection.release();
    fs.unlinkSync(req.file.path);

    res.status(500).json({
      error: 'Bulk import failed',
      details: err.message
    });
  }
};

module.exports = { bulkImportProducts };
