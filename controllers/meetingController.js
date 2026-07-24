// meetingController.js
const db = require('../config/db');  // Import the updated db configuration

// Add a new meeting
exports.createMeeting = (req, res) => {
  const { lead_id, meeting_date, meeting_location, notes } = req.body;

  if (!lead_id || !meeting_date || !meeting_location) {
    return res.status(400).json({ error: 'Lead ID, meeting date, and location are required' });
  }

  const query = `INSERT INTO meetings (lead_id, meeting_date, meeting_location, notes) VALUES (?, ?, ?, ?)`;

  const values = [
    lead_id,
    meeting_date,
    meeting_location, 
    notes
  ]
  
  db.query(query, values, (err, result) => {
    if(err) {
      return res.status(500).json({ error: 'Failed to create meeting' });
    }
    res.status(201).json({ message: 'Meeting created successfully', leadId: result.insertId });
  })
};

// Get all meetings for a specific lead
exports.getMeetingsByLead = (req, res) => {
  const { leadId } = req.params;

  const query = `SELECT * FROM meetings WHERE lead_id = ? ORDER BY meeting_date DESC`;

  db.query(query, [leadId], (err, results) => {
    if (err) {
      console.error('Error fetching meetings:', err.message);
      return res.status(500).json({ error: 'Failed to fetch meetings' });
    }

    res.status(200).json(results);
  });
};

// Delete a meeting
exports.deleteMeeting = (req, res) => {
  const { id } = req.params;

  const query = `DELETE FROM meetings WHERE id = ?`;

  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error deleting meeting:', err.message);
      return res.status(500).json({ error: 'Failed to delete meeting' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    res.status(200).json({ message: 'Meeting deleted successfully' });
  });
};

