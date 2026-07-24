const db = require('../config/db');

/* ----------------------------------------------
   ADD ACTIVITY
---------------------------------------------- */
exports.addActivity = async (req, res) => {
  try {
    const { leadId } = req.params;
    const {
      type,
      title,
      description,
      due_date,
      due_time,
      status
    } = req.body;

    const created_by = req.user?.username || 'Unknown';

    const query = `
      INSERT INTO activities 
      (lead_id, type, title, description, due_date, due_time, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(query, [
      leadId,
      type,
      title,
      description,
      due_date,
      due_time,
      status || 'open',
      created_by
    ]);

    res.status(201).json({
      message: 'Activity added',
      activityId: result.insertId
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to add activity',
      details: err.message
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
      [leadId]
    );

    res.status(200).json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to fetch activities',
      details: err.message
    });
  }
};


/* ----------------------------------------------
   UPDATE ACTIVITY
---------------------------------------------- */
exports.updateActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const { type, title, description, due_date, due_time, status } = req.body;

    const query = `
      UPDATE activities 
      SET type = ?, 
          title = ?, 
          description = ?, 
          due_date = ?, 
          due_time = ?, 
          status = ?
      WHERE id = ?
    `;

    await db.query(query, [
      type,
      title,
      description,
      due_date,
      due_time,
      status,
      id
    ]);

    res.status(200).json({ message: 'Activity updated' });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to update activity',
      details: err.message
    });
  }
};


/* ----------------------------------------------
   DELETE ACTIVITY
---------------------------------------------- */
exports.deleteActivity = async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(
      `DELETE FROM activities WHERE id = ?`,
      [id]
    );

    res.status(200).json({ message: 'Activity deleted' });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to delete activity',
      details: err.message
    });
  }
};
