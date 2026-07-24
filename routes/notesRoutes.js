const express = require('express');
const authenticateJWT = require('../middleware/authMiddleware');
const notesController = require('../controllers/notesController');

const router = express.Router();

// Add note
router.post('/leads/:leadId/notes', authenticateJWT, notesController.addNote);

// Get notes for a lead
router.get('/leads/:leadId/notes', notesController.getNotesByLead);

// Update a note
router.put('/notes/:id', authenticateJWT, notesController.updateNote);

// Delete note
router.delete('/notes/:id', authenticateJWT, notesController.deleteNote);

module.exports = router;
