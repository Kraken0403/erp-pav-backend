const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);
// Create a new meeting
router.post('/', meetingController.createMeeting);

// Get all meetings for a specific lead
router.get('/:leadId', meetingController.getMeetingsByLead);

// Delete a meeting
router.delete('/:id', meetingController.deleteMeeting);

module.exports = router;
