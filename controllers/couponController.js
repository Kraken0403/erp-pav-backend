const db = require('../config/db');

// List coupons for admin (with optional search)
const listCoupons = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.status(200).json(rows);
  } catch (err) {
    console.error('❌ listCoupons:', err);
    res.status(500).json({ error: 'Failed to list coupons', details: err.message });
  }
};

const getCoupon = async (req, res) => {
  const { id } = req.params;
  try {
    const [[row]] = await db.query('SELECT * FROM coupons WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Coupon not found' });
    res.status(200).json(row);
  } catch (err) {
    console.error('❌ getCoupon:', err);
    res.status(500).json({ error: 'Failed to fetch coupon', details: err.message });
  }
};

const createCoupon = async (req, res) => {
  const payload = req.body || {};
  try {
    const { code, description, type, value, min_order_amount, starts_at, ends_at, usage_limit, usage_limit_per_user, active } = payload;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const [result] = await db.query(
      `INSERT INTO coupons (code, description, type, value, min_order_amount, starts_at, ends_at, usage_limit, usage_limit_per_user, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code.trim().toUpperCase(), description || null, type || 'flat', Number(value || 0), Number(min_order_amount || 0), starts_at || null, ends_at || null, usage_limit || null, usage_limit_per_user || null, active ? 1 : 0]
    );

    const [[created]] = await db.query('SELECT * FROM coupons WHERE id = ?', [result.insertId]);
    res.status(201).json(created);
  } catch (err) {
    console.error('❌ createCoupon:', err);
    res.status(500).json({ error: 'Failed to create coupon', details: err.message });
  }
};

const updateCoupon = async (req, res) => {
  const { id } = req.params;
  const payload = req.body || {};
  try {
    const fields = [];
    const values = [];
    const allowed = ['description','type','value','min_order_amount','starts_at','ends_at','usage_limit','usage_limit_per_user','active','code'];
    for (const k of allowed) {
      if (payload[k] !== undefined) {
        fields.push(`${k} = ?`);
        if (k === 'code') values.push(String(payload[k] || '').trim().toUpperCase());
        else values.push(payload[k]);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'No updatable fields provided' });
    values.push(id);
    await db.query(`UPDATE coupons SET ${fields.join(', ')} WHERE id = ?`, values);
    const [[updated]] = await db.query('SELECT * FROM coupons WHERE id = ?', [id]);
    res.status(200).json(updated);
  } catch (err) {
    console.error('❌ updateCoupon:', err);
    res.status(500).json({ error: 'Failed to update coupon', details: err.message });
  }
};

const deleteCoupon = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM coupons WHERE id = ?', [id]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ deleteCoupon:', err);
    res.status(500).json({ error: 'Failed to delete coupon', details: err.message });
  }
};

// Public: list active coupons (minimal info)
// Optional query params:
// - user_id: filter out coupons already used up by this user (usage_limit_per_user)
// - total_amount or cart_total: filter out coupons with min_order_amount higher than this
const listPublicCoupons = async (req, res) => {
  try {
    const now = new Date();

    // Accept query params for contextual filtering
    const userId = req.query?.user_id ? Number(req.query.user_id) : null;
    const safeTotal = Number(req.query?.total_amount || req.query?.cart_total || 0);

    // Load active coupons with usage metadata
    const [rows] = await db.query(
      `SELECT id, code, description, type, value, min_order_amount, starts_at, ends_at, usage_limit, usage_limit_per_user, times_used
       FROM coupons WHERE active = 1
       AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
       ORDER BY created_at DESC`,
      [now, now]
    );

    const filtered = [];

    for (const c of rows) {
      // 1) Minimum order value
      if (Number(c.min_order_amount || 0) > safeTotal) continue;

      // 2) Global usage limit
      if (c.usage_limit && Number(c.times_used || 0) >= Number(c.usage_limit)) continue;

      // 3) Per-user usage limit (if user id provided)
      if (c.usage_limit_per_user && userId) {
        const [[countRow]] = await db.query('SELECT COUNT(*) AS cnt FROM coupon_usages WHERE coupon_id = ? AND customer_id = ?', [c.id, userId]);
        if (Number(countRow.cnt || 0) >= Number(c.usage_limit_per_user)) continue;
      }

      // Passed all checks — include minimal info
      filtered.push({
        id: c.id,
        code: c.code,
        description: c.description,
        type: c.type,
        value: c.value,
        min_order_amount: c.min_order_amount,
        starts_at: c.starts_at,
        ends_at: c.ends_at
      });
    }

    res.status(200).json(filtered);
  } catch (err) {
    console.error('❌ listPublicCoupons:', err);
    res.status(500).json({ error: 'Failed to list public coupons', details: err.message });
  }
};

// Public: validate coupon for an order/cart
const validateCoupon = async (req, res) => {
  const { code, total_amount, user_id } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });
  const safeTotal = Number(total_amount || 0);
  try {
    const [[coupon]] = await db.query('SELECT * FROM coupons WHERE UPPER(code) = ? AND active = 1', [String(code).trim().toUpperCase()]);
    if (!coupon) return res.status(404).json({ valid: false, error: 'Coupon not found' });

    const now = new Date();
    if (coupon.starts_at && new Date(coupon.starts_at) > now) return res.status(400).json({ valid: false, error: 'Coupon not yet active' });
    if (coupon.ends_at && new Date(coupon.ends_at) < now) return res.status(400).json({ valid: false, error: 'Coupon expired' });

    if (Number(coupon.min_order_amount || 0) > safeTotal) {
      return res.status(400).json({ valid: false, error: `Minimum order amount ₹${coupon.min_order_amount} required` });
    }

    // Check global usage limit
    if (coupon.usage_limit && Number(coupon.times_used || 0) >= Number(coupon.usage_limit)) {
      return res.status(400).json({ valid: false, error: 'Coupon usage limit reached' });
    }

    // Check per-customer usage (accept either a users.id or customers.id in user_id)
    if (coupon.usage_limit_per_user && user_id) {
      // Resolve to customers.id when possible
      let resolvedCustomerId = null
      try {
        const [[custByUser]] = await db.query('SELECT id FROM customers WHERE user_id = ? LIMIT 1', [user_id]);
        if (custByUser && custByUser.id) resolvedCustomerId = Number(custByUser.id)
      } catch (e) {
        // ignore
      }
      if (!resolvedCustomerId) {
        // assume supplied id may already be a customer id
        resolvedCustomerId = Number(user_id)
      }

      const [[countRow]] = await db.query('SELECT COUNT(*) AS cnt FROM coupon_usages WHERE coupon_id = ? AND customer_id = ?', [coupon.id, resolvedCustomerId]);
      if (Number(countRow.cnt || 0) >= Number(coupon.usage_limit_per_user)) {
        return res.status(400).json({ valid: false, error: 'You have already used this coupon the maximum allowed times' });
      }
    }

    // Compute discount
    let discount = 0;
    if (coupon.type === 'percent') {
      discount = Math.round((safeTotal * Number(coupon.value || 0)) * 100) / 10000; // percent of total; value is percent e.g., 10 -> 10%
      // Actually compute correctly: percent / 100 * total
      discount = Math.round((safeTotal * (Number(coupon.value || 0) / 100)) * 100) / 100;
    } else {
      discount = Math.round((Number(coupon.value || 0)) * 100) / 100;
    }

    // cap discount to total
    if (discount > safeTotal) discount = safeTotal;

    const newTotal = Math.round((safeTotal - discount) * 100) / 100;

    return res.status(200).json({ valid: true, coupon: { id: coupon.id, code: coupon.code, type: coupon.type, value: Number(coupon.value || 0) }, discount, new_total: newTotal });
  } catch (err) {
    console.error('❌ validateCoupon:', err);
    res.status(500).json({ error: 'Failed to validate coupon', details: err.message });
  }
};

// Record coupon usage (call after order is created)
const recordCouponUsage = async (couponId, userId, workOrderId, connection = null) => {
  const conn = connection || db;

  // Resolve customer id from provided identifier. The API historically
  // used the `user_id` column in `coupon_usages` to store customers.id.
  // Accept either a users.id (linked via customers.user_id) or a customers.id.
  const resolveCustomerId = async (maybeId) => {
    if (!maybeId) return null;
    // 1) try to find a customer whose user_id matches maybeId
    try {
      const [[custByUser]] = await conn.query('SELECT id FROM customers WHERE user_id = ? LIMIT 1', [maybeId]);
      if (custByUser && custByUser.id) return Number(custByUser.id);
    } catch (e) {
      // ignore lookup errors
    }
    // 2) try to find a customer with id = maybeId
    try {
      const [[custById]] = await conn.query('SELECT id FROM customers WHERE id = ? LIMIT 1', [maybeId]);
      if (custById && custById.id) return Number(custById.id);
    } catch (e) {
      // ignore
    }
    return null;
  };

  // Re-check limits under the same connection to avoid client-side bypass/race
  let coupon;
  try {
    const [[c]] = await conn.query('SELECT * FROM coupons WHERE id = ? LIMIT 1', [couponId]);
    coupon = c;
  } catch (e) {
    console.error('[Coupon] failed to fetch coupon row for id', couponId, e && e.message ? e.message : e);
    throw new Error('Failed to fetch coupon');
  }
  if (!coupon) {
    console.error('[Coupon] record attempted for missing coupon id', couponId);
    throw new Error('Coupon not found');
  }

  // Global usage limit
    if (coupon.usage_limit && Number(coupon.times_used || 0) >= Number(coupon.usage_limit)) {
    throw new Error('Coupon global usage limit reached');
  }

  // Per-user (per-customer) usage limit — resolve provided id to a customer id
  let customerIdToRecord = null;
  if (userId) customerIdToRecord = await resolveCustomerId(userId);

  if (coupon.usage_limit_per_user && customerIdToRecord) {
    const [[countRow]] = await conn.query('SELECT COUNT(*) AS cnt FROM coupon_usages WHERE coupon_id = ? AND customer_id = ?', [couponId, customerIdToRecord]);
    if (Number(countRow.cnt || 0) >= Number(coupon.usage_limit_per_user)) {
      throw new Error('User has already used this coupon the maximum allowed times');
    }
  }

  console.info('[Coupon] recording usage - inserting coupon_usages', { couponId, customerId: customerIdToRecord || null, workOrderId: workOrderId || null });
  let insertId = null
  try {
    const [ins] = await conn.query('INSERT INTO coupon_usages (coupon_id, customer_id, work_order_id) VALUES (?, ?, ?)', [couponId, customerIdToRecord || null, workOrderId || null]);
    insertId = ins && ins.insertId ? ins.insertId : null;
    console.info('[Coupon] insert result', { insertId });
  } catch (e) {
    console.error('[Coupon] failed to insert coupon_usages', { couponId, customerIdToRecord: customerIdToRecord || null, workOrderId: workOrderId || null, err: e && e.message ? e.message : e });
    throw e;
  }

  try {
    await conn.query('UPDATE coupons SET times_used = times_used + 1 WHERE id = ?', [couponId]);
  } catch (e) {
    console.warn('[Coupon] failed to update coupons.times_used after inserting usage', { couponId, err: e && e.message ? e.message : e });
  }

  try {
    const [[row]] = await conn.query('SELECT times_used FROM coupons WHERE id = ? LIMIT 1', [couponId]);
    const timesUsed = row ? Number(row.times_used || 0) : null;
    console.info('[Coupon] usage recorded', { couponId, userId: userId || null, workOrderId: workOrderId || null, timesUsed, insertId });
    return { insertId, timesUsed };
  } catch (e) {
    console.warn('[Coupon] could not fetch updated times_used', { couponId, err: e && e.message ? e.message : e });
    return { insertId, timesUsed: null };
  }
};

module.exports = {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  listPublicCoupons,
  recordCouponUsage
};
