const express = require('express');
const router = express.Router();
const companyController = require('../controllers/companyController');
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);
// Create company
router.post('/companies', companyController.createCompany);

// Get all companies
router.get('/companies', companyController.getCompanies);

// Get single company
router.get('/companies/:id', companyController.getCompanyById);

// Update company
router.put('/companies/:id', companyController.updateCompany);

// Delete company
router.delete('/companies/:id', companyController.deleteCompany);

module.exports = router;
