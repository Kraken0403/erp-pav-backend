const db = require('../config/db');
const fs = require('fs');
const path = require('path');

/* ======================================================
   UPLOAD FILE
====================================================== */
exports.uploadFile = async (req, res) => {
  const { leadId } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const file_name = req.file.originalname;
  const file_path = req.file.path;
  const uploaded_by = req.user?.username || 'Unknown';

  try {
    const [result] = await db.query(
      `
      INSERT INTO files (lead_id, file_name, file_path, uploaded_by)
      VALUES (?, ?, ?, ?)
      `,
      [leadId, file_name, file_path, uploaded_by]
    );

    return res.status(201).json({
      message: 'File uploaded successfully',
      fileId: result.insertId
    });

  } catch (err) {
    console.error('UPLOAD FILE ERROR:', err);
    return res.status(500).json({
      error: 'Failed to upload file',
      details: err.message
    });
  }
};


/* ======================================================
   LIST FILES BY LEAD
====================================================== */
exports.getFilesByLead = async (req, res) => {
  const { leadId } = req.params;

  try {
    const [rows] = await db.query(
      'SELECT * FROM files WHERE lead_id = ? ORDER BY uploaded_at DESC',
      [leadId]
    );

    return res.status(200).json(rows);

  } catch (err) {
    console.error('GET FILES ERROR:', err);
    return res.status(500).json({
      error: 'Failed to fetch files',
      details: err.message
    });
  }
};


/* ======================================================
   DELETE FILE
====================================================== */
exports.deleteFile = async (req, res) => {
  const { id } = req.params;

  try {
    // 1️⃣ Get file path
    const [rows] = await db.query(
      'SELECT file_path FROM files WHERE id = ?',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'File not found' });
    }

    const filePath = rows[0].file_path;

    // 2️⃣ Delete physical file (safe)
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (fsErr) {
        console.error('File system delete failed:', fsErr);
        // We don't fail DB delete because of filesystem issue
      }
    }

    // 3️⃣ Delete DB record
    await db.query(
      'DELETE FROM files WHERE id = ?',
      [id]
    );

    return res.status(200).json({
      message: 'File deleted successfully'
    });

  } catch (err) {
    console.error('DELETE FILE ERROR:', err);
    return res.status(500).json({
      error: 'Failed to delete file',
      details: err.message
    });
  }
};
