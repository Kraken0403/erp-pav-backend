const express = require("express");
const router = express.Router();
const authenticateJWT = require('../middleware/authMiddleware');

router.use(authenticateJWT);
const {
  getSettings,
  updateSettings,
  getNotificationChannelFlags,
} = require("../controllers/settingsController");

const upload = require("../middleware/upload");

// MOUNT THE ROUTES AS /settings
router.get("/settings", getSettings);
router.put("/settings", upload.single("company_logo"), updateSettings);
router.get('/settings/notification-channels', getNotificationChannelFlags);

module.exports = router;
