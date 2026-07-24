const express = require('express');
const router = express.Router();
// const fieldValues = require('../controllers/leadColumnsController')
const authenticateJWT = require('../middleware/authMiddleware');
const { getLeadFields, saveFieldOrder, getFieldOrder } = require('../controllers/leadColumnsController');

router.use(authenticateJWT);
// Route to fetch lead fields
router.get('/lead-fields', getLeadFields);
router.post('/lead-fields/save', saveFieldOrder);
router.get('/lead-fields/order', getFieldOrder);

module.exports = router;