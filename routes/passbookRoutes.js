const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');
const passbookController = require('../controllers/passbookController');

router.use(authenticateJWT);

router.get('/passbook/accounts', passbookController.listAccounts);
router.post('/passbook/accounts', passbookController.createAccount);
router.get('/passbook/entries', passbookController.listEntries);
router.post('/passbook/entries', passbookController.createEntry);
router.get('/passbook/summary', passbookController.getSummary);

module.exports = router;
