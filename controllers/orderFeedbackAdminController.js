const db = require('../config/db');

const parseFeedback = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const buildFeedbackFromColumns = (row) => {
  if (!row) return null;

  const feedback = {
    overall_rating: row.overall_rating !== null ? Number(row.overall_rating) : null,
    food_quality_rating: row.food_quality_rating !== null ? Number(row.food_quality_rating) : null,
    service_rating: row.service_rating !== null ? Number(row.service_rating) : null,
    delivery_rating: row.delivery_rating !== null ? Number(row.delivery_rating) : null,
    packaging_rating: row.packaging_rating !== null ? Number(row.packaging_rating) : null,
    item_feedback: row.item_feedback ?? null,
    service_feedback: row.service_feedback ?? null,
    delivery_feedback: row.delivery_feedback ?? null,
    additional_comments: row.additional_comments ?? null,
    would_recommend:
      row.would_recommend === null || row.would_recommend === undefined
        ? null
        : Number(row.would_recommend) === 1,
  };

  const hasAnyValue = Object.values(feedback).some((value) => value !== null);
  return hasAnyValue ? feedback : null;
};

const getOrderFeedbackResponses = async (req, res) => {
  const { search = '', submittedFrom = '', submittedTo = '' } = req.query;

  try {
    const filters = [`r.submitted_at IS NOT NULL`];
    const params = [];

    if (String(search).trim()) {
      filters.push(`(
        r.work_order_number LIKE ?
        OR r.customer_name LIKE ?
        OR r.customer_email LIKE ?
      )`);
      const q = `%${String(search).trim()}%`;
      params.push(q, q, q);
    }

    if (submittedFrom) {
      filters.push(`DATE(r.submitted_at) >= ?`);
      params.push(submittedFrom);
    }

    if (submittedTo) {
      filters.push(`DATE(r.submitted_at) <= ?`);
      params.push(submittedTo);
    }

    const [rows] = await db.query(
      `
      SELECT
        r.id,
        r.work_order_id,
        r.work_order_number,
        r.customer_name,
        r.customer_email,
        r.customer_phone,
        r.scheduled_for,
        r.sent_at,
        r.submitted_at,
        r.overall_rating,
        r.food_quality_rating,
        r.service_rating,
        r.delivery_rating,
        r.packaging_rating,
        r.item_feedback,
        r.service_feedback,
        r.delivery_feedback,
        r.additional_comments,
        r.would_recommend,
        r.feedback_json,
        r.created_at,
        r.updated_at
      FROM order_feedback_requests r
      WHERE ${filters.join(' AND ')}
      ORDER BY r.submitted_at DESC
      `,
      params
    );

    const feedbacks = rows.map((row) => {
      const columnFeedback = buildFeedbackFromColumns(row);
      const parsed = parseFeedback(row.feedback_json) || {};
      const resolved = columnFeedback || parsed;

      return {
        id: row.id,
        work_order_id: row.work_order_id,
        work_order_number: row.work_order_number,
        customer_name: row.customer_name,
        customer_email: row.customer_email,
        customer_phone: row.customer_phone,
        scheduled_for: row.scheduled_for,
        sent_at: row.sent_at,
        submitted_at: row.submitted_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        overall_rating: resolved.overall_rating || null,
        would_recommend: resolved.would_recommend === true,
      };
    });

    return res.status(200).json({ feedbacks });
  } catch (error) {
    console.error('getOrderFeedbackResponses error:', error);
    return res.status(500).json({ error: error.message });
  }
};

const getOrderFeedbackResponseById = async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `
      SELECT
        id,
        work_order_id,
        work_order_number,
        customer_name,
        customer_email,
        customer_phone,
        scheduled_for,
        sent_at,
        submitted_at,
        overall_rating,
        food_quality_rating,
        service_rating,
        delivery_rating,
        packaging_rating,
        item_feedback,
        service_feedback,
        delivery_feedback,
        additional_comments,
        would_recommend,
        feedback_json,
        created_at,
        updated_at
      FROM order_feedback_requests
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Feedback response not found' });
    }

    const row = rows[0];
    const feedback = buildFeedbackFromColumns(row) || parseFeedback(row.feedback_json) || {};

    const [items] = await db.query(
      `
      SELECT product_name, quantity
      FROM work_order_items
      WHERE work_order_id = ?
      ORDER BY id ASC
      `,
      [row.work_order_id]
    );

    return res.status(200).json({
      id: row.id,
      work_order_id: row.work_order_id,
      work_order_number: row.work_order_number,
      customer_name: row.customer_name,
      customer_email: row.customer_email,
      customer_phone: row.customer_phone,
      scheduled_for: row.scheduled_for,
      sent_at: row.sent_at,
      submitted_at: row.submitted_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      feedback,
      items: items || [],
    });
  } catch (error) {
    console.error('getOrderFeedbackResponseById error:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getOrderFeedbackResponses,
  getOrderFeedbackResponseById,
};
