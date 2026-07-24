const express = require('express');
const authenticateJWT = require('../middleware/authMiddleware');
const activityController = require('../controllers/activityController');

const router = express.Router();

// Add activity to a lead
router.post('/leads/:leadId/activities', authenticateJWT, activityController.addActivity);

// Get activities for a lead
router.get('/leads/:leadId/activities', activityController.getActivitiesByLead);

// Update activity
router.put('/activities/:id', authenticateJWT, activityController.updateActivity);

// Delete activity
router.delete('/activities/:id', authenticateJWT, activityController.deleteActivity);

module.exports = router;
