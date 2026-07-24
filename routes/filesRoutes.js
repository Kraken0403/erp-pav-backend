const express = require('express');
const multer = require('multer');
const authenticateJWT = require('../middleware/authMiddleware');
const filesController = require('../controllers/filesController');

const router = express.Router();

// Storage location
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/leads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Upload file
router.post(
    '/leads/:leadId/files',
    authenticateJWT,
    upload.single('file'),
    filesController.uploadFile
);

// Get files for a lead
router.get('/leads/:leadId/files', filesController.getFilesByLead);

// Delete file
router.delete('/files/:id', authenticateJWT, filesController.deleteFile);

module.exports = router;
