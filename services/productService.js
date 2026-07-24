const db = require('../config/db');

async function createProductInternal(payload, connection = null) {
  const {
    name,
    brand = null,
    category_id = 1,
    description = '',
    image_url = null,

    cost_pricing_mode = 'absolute',
    cost_discount_percent = null,

    cost_price = 0,
    cost_price_unit = 'piece',
    cost_price_qty = 1,

    selling_price,
    selling_price_unit = 'piece',
    selling_price_qty = 1,

    gst_rate = 0,
    hsn_sac = null,

    stock = 0,
    sku = '',
    type = 'simple',
    is_active = 1
  } = payload;

  /* ===============================
     VALIDATIONS
  =============================== */

  if (!name || !String(name).trim()) {
    throw new Error('Product name is required');
  }

  if (selling_price == null || Number(selling_price) <= 0) {
    throw new Error('selling_price must be greater than 0');
  }

  if (gst_rate < 0 || gst_rate > 28) {
    throw new Error('Invalid gst_rate');
  }

  if (!['absolute', 'percentage'].includes(cost_pricing_mode)) {
    throw new Error('Invalid cost_pricing_mode');
  }

  if (cost_pricing_mode === 'percentage') {
    if (
      cost_discount_percent == null ||
      Number(cost_discount_percent) <= 0 ||
      Number(cost_discount_percent) > 100
    ) {
      throw new Error('cost_discount_percent must be between 0 and 100');
    }

    if (Number(cost_price) > 0) {
      throw new Error('Do not send cost_price in percentage mode');
    }
  }

  /* ===============================
     COST CALCULATION
  =============================== */

  let finalCostPrice = Number(cost_price || 0);

  if (cost_pricing_mode === 'percentage') {
    finalCostPrice =
      Number(selling_price) *
      (1 - Number(cost_discount_percent) / 100);

    // 🔥 financial rounding
    finalCostPrice = Number(finalCostPrice.toFixed(2));
  }

  /* ===============================
     INSERT
  =============================== */

  const query = `
    INSERT INTO products (
      name, brand, category_id, description, image_url,
      cost_pricing_mode, cost_discount_percent,
      cost_price, cost_price_unit, cost_price_qty,
      selling_price, selling_price_unit, selling_price_qty,
      gst_rate, hsn_sac,
      stock, sku, type, is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    name.trim(),
    brand,
    category_id,
    description,
    image_url,

    cost_pricing_mode,
    cost_pricing_mode === 'percentage'
      ? Number(cost_discount_percent)
      : null,

    finalCostPrice,
    cost_price_unit,
    Number(cost_price_qty || 1),

    Number(selling_price),
    selling_price_unit,
    Number(selling_price_qty || 1),

    Number(gst_rate || 0),
    hsn_sac,

    Number(stock || 0),
    sku,
    type,
    is_active ? 1 : 0
  ];

  const executor = connection || db; // ✅ assume db is mysql2/promise pool
  const [result] = await executor.query(query, params);

  return result.insertId;
}

module.exports = { createProductInternal };
