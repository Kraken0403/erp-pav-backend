const db = require('../config/db');

/* ============================================================
   ADD NOTE
============================================================ */
exports.addNote = async (req, res) => {
  const { leadId } = req.params;
  const { note_text } = req.body;
  const created_by = req.user?.username || 'Unknown';

  if (!note_text || !note_text.trim()) {
    return res.status(400).json({ error: 'Note text is required' });
  }

  try {
    const [result] = await db.query(
      `
      INSERT INTO notes (lead_id, note_text, created_by)
      VALUES (?, ?, ?)
      `,
      [leadId, note_text, created_by]
    );

    return res.status(201).json({
      message: 'Note added successfully',
      noteId: result.insertId
    });

  } catch (err) {
    console.error('ADD NOTE ERROR:', err);
    return res.status(500).json({
      error: 'Failed to add note',
      details: err.message
    });
  }
};


/* ============================================================
   GET NOTES FOR A LEAD
============================================================ */
exports.getNotesByLead = async (req, res) => {
  const { leadId } = req.params;

  try {
    const [rows] = await db.query(
      `
      SELECT * FROM notes 
      WHERE lead_id = ?
      ORDER BY created_at DESC
      `,
      [leadId]
    );

    return res.status(200).json(rows);

  } catch (err) {
    console.error('GET NOTES ERROR:', err);
    return res.status(500).json({
      error: 'Failed to fetch notes',
      details: err.message
    });
  }
};


/* ============================================================
   UPDATE NOTE
============================================================ */
exports.updateNote = async (req, res) => {
  const { id } = req.params;
  const { note_text } = req.body;

  if (!note_text || !note_text.trim()) {
    return res.status(400).json({ error: 'Note text is required' });
  }

  try {
    const [result] = await db.query(
      `
      UPDATE notes 
      SET note_text = ?
      WHERE id = ?
      `,
      [note_text, id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Note not found' });
    }

    return res.status(200).json({
      message: 'Note updated successfully'
    });

  } catch (err) {
    console.error('UPDATE NOTE ERROR:', err);
    return res.status(500).json({
      error: 'Failed to update note',
      details: err.message
    });
  }
};


/* ============================================================
   DELETE NOTE
============================================================ */
exports.deleteNote = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query(
      `DELETE FROM notes WHERE id = ?`,
      [id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Note not found' });
    }

    return res.status(200).json({
      message: 'Note deleted successfully'
    });

  } catch (err) {
    console.error('DELETE NOTE ERROR:', err);
    return res.status(500).json({
      error: 'Failed to delete note',
      details: err.message
    });
  }
};
