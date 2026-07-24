const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);

router.get('/users/me/profile', userController.getMyProfile);
router.put('/users/me/profile', userController.updateMyProfile);

router.get('/users', userController.getAllUsers)
router.get('/users/:id', userController.getUserById);
router.get('/users/:id/delete-impact', userController.getUserDeleteImpact);
router.get('/users/:id/visibility-permissions', userController.getUserVisibilityPermissions);
router.get('/users/:id/effective-visibility-permissions', userController.getUserEffectiveVisibilityPermissions);
// Update a user by ID
router.put('/users/:id', userController.updateUser);
router.put('/users/:id/visibility-permissions', userController.upsertUserVisibilityPermissions);
router.post('/users/:id/delete-with-reassignment', userController.deleteUserWithReassignment);

// Delete a user by ID
router.delete('/users/:id', userController.deleteUser);

module.exports = router;