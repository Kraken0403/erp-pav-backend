const db = require('../config/db');

const ACTIVITY_TYPES = new Set(['call', 'email', 'meeting', 'task', 'note', 'deadline']);
const ACTIVITY_STATUSES = new Set(['open', 'completed']);

const normalizeNullable = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeActivityPayload = (body = {}) => {
  const type = String(body.type || '').trim().toLowerCase();
  const status = String(body.status || 'open').trim().toLowerCase();

  return {
    type,
    title: normalizeNullable(body.title),
    description: normalizeNullable(body.description),
    due_date: normalizeNullable(body.due_date),
    due_time: normalizeNullable(body.due_time),
    status,
  };
};

const validateActivityPayload = (payload) => {
  if (!ACTIVITY_TYPES.has(payload.type)) {
    return `Invalid activity type. Allowed values: ${[...ACTIVITY_TYPES].join(', ')}`;
  }
  if (!ACTIVITY_STATUSES.has(payload.status)) {
    return `Invalid activity status. Allowed values: ${[...ACTIVITY_STATUSES].join(', ')}`;
  }
  if (!payload.title) return 'Activity title is required.';
  return null;
};

/* ----------------------------------------------
   ADD ACTIVITY
---------------------------------------------- */
exports.addActivity = async (req, res) => {
  try {
    const { leadId } = req.params;
    const payload = normalizeActivityPayload(req.body);
    const validationError = validateActivityPayload(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const createdBy = req.user?.username || req.user?.name || 'Unknown';

    const [result] = await db.query(
      `INSERT INTO activities
       (lead_id, type, title, description, due_date, due_time, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        payload.type,
        payload.title,
        payload.description,
        payload.due_date,
        payload.due_time,
        payload.status,
        createdBy,
      ],
    );

    return res.status(201).json({
      message: 'Activity added',
      activityId: result.insertId,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Failed to add activity',
      details: err.message,
    });
  }
};

/* ----------------------------------------------
   GET ACTIVITIES FOR A LEAD
---------------------------------------------- */
exports.getActivitiesByLead = async (req, res) => {
  try {
    const { leadId } = req.params;

    const [rows] = await db.query(
      `SELECT * FROM activities
       WHERE lead_id = ?
       ORDER BY created_at DESC`,
      [leadId],
    );

    return res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Failed to fetch activities',
      details: err.message,
    });
  }
};

/* ----------------------------------------------
   UPDATE ACTIVITY
---------------------------------------------- */
exports.updateActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = normalizeActivityPayload(req.body);
    const validationError = validateActivityPayload(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const [result] = await db.query(
      `UPDATE activities
       SET type = ?,
           title = ?,
           description = ?,
           due_date = ?,
           due_time = ?,
           status = ?
       WHERE id = ?`,
      [
        payload.type,
        payload.title,
        payload.description,
        payload.due_date,
        payload.due_time,
        payload.status,
        id,
      ],
    );

    if (!result.affectedRows) return res.status(404).json({ error: 'Activity not found' });
    return res.status(200).json({ message: 'Activity updated' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Failed to update activity',
      details: err.message,
    });
  }
};

/* ----------------------------------------------
   DELETE ACTIVITY
---------------------------------------------- */
exports.deleteActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM activities WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Activity not found' });
    return res.status(200).json({ message: 'Activity deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Failed to delete activity',
      details: err.message,
    });
  }
};
