const express = require('express');
const router = express.Router();
const customFieldController = require('../controllers/customFieldController');
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);
// Create a new custom field
router.post('/custom-fields', customFieldController.createCustomField);

// Get all custom fields with options
router.get('/custom-fields', customFieldController.getAllCustomFields);

// Update a custom field
router.put('/custom-fields/:field_id', customFieldController.updateCustomField);

// Delete a custom field
router.delete('/custom-fields/:field_id', customFieldController.deleteCustomField);

module.exports = router;
