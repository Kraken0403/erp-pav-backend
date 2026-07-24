const express = require('express');
const router = express.Router();

const {
  getPaymentReminderSettings,
  savePaymentReminderSettings,
  getPendingPaymentReminders,
  sendPaymentReminderByInvoiceId,
  sendPaymentReminderWhatsAppByInvoiceId,
} = require('../controllers/paymentReminderController');

router.get('/payment-reminders/settings', getPaymentReminderSettings);
router.post('/payment-reminders/settings', savePaymentReminderSettings);

router.get('/payment-reminders/pending', getPendingPaymentReminders);
router.post('/payment-reminders/:invoiceId/send-email', sendPaymentReminderByInvoiceId);
router.post('/payment-reminders/:invoiceId/send-whatsapp', sendPaymentReminderWhatsAppByInvoiceId);
router.post('/payment-reminders/run', require('../controllers/paymentReminderController').runPaymentRemindersNow);

module.exports = router;
