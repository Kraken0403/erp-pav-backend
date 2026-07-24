const express = require('express');
const router = express.Router();
const roleController = require('../controllers/roleController');
const authenticateJWT = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');

router.use(authenticateJWT);
router.use(requireAdmin);

router.get('/roles', roleController.getAllRoles);
router.get('/roles/:id', roleController.getRoleById);
router.get('/roles/:id/delete-impact', roleController.getRoleDeleteImpact);
router.post('/roles', roleController.createRole);
router.put('/roles/:id', roleController.updateRole);
router.post('/roles/:id/delete-with-reassignment', roleController.deleteRoleWithReassignment);
router.delete('/roles/:id', roleController.deleteRole);

module.exports = router;
