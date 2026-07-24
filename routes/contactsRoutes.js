// routes/contactsRoutes.js
const express = require('express');
const router = express.Router();
const contactsController = require('../controllers/contactsController');
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);
// Retrieve all contacts
router.get('/contacts', contactsController.getContacts);

// Retrieve a specific contact by ID
router.get('/contacts/:id', contactsController.getContactById);

// Create a new contact
router.post('/contacts', contactsController.createContact);

// Update an existing contact
router.put('/contacts/:id', contactsController.updateContact);

// Delete a contact
router.delete('/contacts/:id', contactsController.deleteContact);

module.exports = router;
