const db = require('../config/db');
const {
  createNotificationsForUsers,
  getAdminUserIds,
  getSystemNotifierUserId,
} = require('../services/notificationService');

const normalizeRating = (value) => {
  const num = Number(value);
  if (!Number.isInteger(num)) return null;
  if (num < 1 || num > 5) return null;
  return num;
};

const normalizeWholeQuantity = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
};

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

const getFeedbackForm = async (req, res) => {
  const { token } = req.params;

  if (!token) {
    return res.status(400).json({ error: 'Feedback token is required' });
  }

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
        feedback_json
      FROM order_feedback_requests
      WHERE feedback_token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Invalid feedback link' });
    }

    const feedbackRequest = rows[0];

    const [items] = await db.query(
      `
      SELECT product_name, quantity
      FROM work_order_items
      WHERE work_order_id = ?
      ORDER BY id ASC
      `,
      [feedbackRequest.work_order_id]
    );

    const existingFeedback =
      buildFeedbackFromColumns(feedbackRequest) || parseFeedback(feedbackRequest.feedback_json) || null;

    return res.status(200).json({
      work_order_number: feedbackRequest.work_order_number,
      customer_name: feedbackRequest.customer_name,
      customer_email: feedbackRequest.customer_email,
      customer_phone: feedbackRequest.customer_phone,
      submitted: !!feedbackRequest.submitted_at,
      submitted_at: feedbackRequest.submitted_at,
      items: (items || []).map((item) => ({
        ...item,
        quantity: normalizeWholeQuantity(item.quantity),
      })),
      feedback: existingFeedback,
    });
  } catch (error) {
    console.error('getFeedbackForm error:', error);
    return res.status(500).json({ error: error.message });
  }
};

const submitFeedback = async (req, res) => {
  const { token } = req.params;

  if (!token) {
    return res.status(400).json({ error: 'Feedback token is required' });
  }

  const {
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
  } = req.body || {};

  const ratings = {
    overall_rating: normalizeRating(overall_rating),
    food_quality_rating: normalizeRating(food_quality_rating),
    service_rating: normalizeRating(service_rating),
    delivery_rating: normalizeRating(delivery_rating),
    packaging_rating: normalizeRating(packaging_rating),
  };

  if (Object.values(ratings).some((value) => value === null)) {
    return res.status(400).json({ error: 'All ratings must be between 1 and 5' });
  }

  const feedbackPayload = {
    ...ratings,
    item_feedback: String(item_feedback || '').trim() || null,
    service_feedback: String(service_feedback || '').trim() || null,
    delivery_feedback: String(delivery_feedback || '').trim() || null,
    additional_comments: String(additional_comments || '').trim() || null,
    would_recommend: would_recommend === true || would_recommend === 'yes' || would_recommend === 'true',
  };

  try {
    const [rows] = await db.query(
      `
      SELECT id, submitted_at, work_order_id, work_order_number
      FROM order_feedback_requests
      WHERE feedback_token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Invalid feedback link' });
    }

    const feedbackRequest = rows[0];

    if (feedbackRequest.submitted_at) {
      return res.status(400).json({ error: 'Feedback has already been submitted' });
    }

    await db.query(
      `
      UPDATE order_feedback_requests
      SET
        overall_rating = ?,
        food_quality_rating = ?,
        service_rating = ?,
        delivery_rating = ?,
        packaging_rating = ?,
        item_feedback = ?,
        service_feedback = ?,
        delivery_feedback = ?,
        additional_comments = ?,
        would_recommend = ?,
        feedback_json = NULL,
        submitted_at = NOW(),
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        feedbackPayload.overall_rating,
        feedbackPayload.food_quality_rating,
        feedbackPayload.service_rating,
        feedbackPayload.delivery_rating,
        feedbackPayload.packaging_rating,
        feedbackPayload.item_feedback,
        feedbackPayload.service_feedback,
        feedbackPayload.delivery_feedback,
        feedbackPayload.additional_comments,
        feedbackPayload.would_recommend ? 1 : 0,
        feedbackRequest.id,
      ]
    );

    const notifierUserId = await getSystemNotifierUserId();
    if (notifierUserId) {
      const adminUserIds = await getAdminUserIds();
      await createNotificationsForUsers({
        byUserId: notifierUserId,
        toUserIds: adminUserIds,
        module: 'feedback',
        action: `Feedback Received - ${feedbackRequest.work_order_number || `#${feedbackRequest.work_order_id}`}`,
        sourceId: feedbackRequest.work_order_id,
        redirectUrl: '/feedbacks',
        skipSelf: false,
      });
    }

    return res.status(200).json({ message: 'Feedback submitted successfully' });
  } catch (error) {
    console.error('submitFeedback error:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getFeedbackForm,
  submitFeedback,
};
