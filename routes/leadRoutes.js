const express = require('express');
const leadController = require('../controllers/leadController');
const leadBulkImportController = require('../controllers/leadBulkImportController');
const authenticateJWT = require('../middleware/authMiddleware'); // Import the middleware for protected routes
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const router = express.Router();

// Public routes for creating leads and retrieving them
router.post('/leads', leadController.createLead);
// NOTE: public /public/leads is exposed via routes/public.js
router.get('/leads', leadController.getAllLeads);
// Protected: get leads for authenticated user
router.get('/leads/my', authenticateJWT, leadController.getLeadsForUser);
router.get('/leads/:id', leadController.getLeadById);

// Protected routes for updating and deleting leads
router.put('/leads/:id', authenticateJWT, leadController.updateLead);
router.post('/leads/bulk-delete', authenticateJWT, leadController.bulkDeleteLeads);
// Bulk import leads (CSV / Excel). Protected route.
router.post('/leads/bulk-import', authenticateJWT, upload.single('file'), leadBulkImportController.bulkImportLeads);
router.delete('/leads/:id', authenticateJWT, leadController.deleteLead);

module.exports = router;
