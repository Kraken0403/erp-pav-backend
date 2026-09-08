// routes/public.js
const express = require('express');
const apiPublicRouter = express.Router();
const publicRouter = express.Router();
const productController = require('../controllers/productController');
const leadController = require('../controllers/leadController');
const publicOrderController = require('../controllers/publicOrderController');
const orderFeedbackController = require('../controllers/orderFeedbackController');
const publicContactController = require('../controllers/publicContactController');
const invoicePdfController = require('../controllers/invoicePdfController');
const quotationPdfController = require('../controllers/quotationPdfController');
const proformaPdfController = require('../controllers/proformaPdfController');
const paymentController = require('../controllers/paymentController');
const { listMailPreviews, getMailPreviewById } = require('../services/brevoService');
const settingsController = require('../controllers/settingsController');
const couponController = require('../controllers/couponController');
const quotationController = require('../controllers/quotationController');

// Public products
apiPublicRouter.get('/products', productController.getPublicProducts);
apiPublicRouter.get('/products/:id', productController.getPublicProductById);
apiPublicRouter.get('/products-all', productController.getAllPublicProductsNoCategoryFilter);
publicRouter.get('/products-all', productController.getAllPublicProductsNoCategoryFilter);

// Public settings endpoint (no auth required)
apiPublicRouter.get('/settings', settingsController.getSettings);

// Public coupons endpoints (validate and list)
apiPublicRouter.post('/coupons/validate', couponController.validateCoupon);
apiPublicRouter.get('/coupons', couponController.listPublicCoupons);

// ✅ ADD THIS
apiPublicRouter.get('/categories', productController.getCategories);

apiPublicRouter.post('/order', publicOrderController.createOrder);
// Public lead creation endpoint (mounted at /api/public/leads)
apiPublicRouter.post('/leads', leadController.createLead);
// Public contact endpoint (mounted at /api/public/contact)
apiPublicRouter.post('/contact', publicContactController.createContact);
apiPublicRouter.get('/payment-status', paymentController.getPublicPaymentStatus);
apiPublicRouter.get('/quotations/:token', quotationController.getPublicQuotation);
apiPublicRouter.post('/quotations/:token/verify', quotationController.verifyPublicQuotation);
apiPublicRouter.post('/quotations/:token/accept', quotationController.acceptPublicQuotation);
apiPublicRouter.post('/quotations/:token/clarification', quotationController.requestPublicQuotationClarification);
apiPublicRouter.get('/order-feedback/:token', orderFeedbackController.getFeedbackForm);
apiPublicRouter.post('/order-feedback/:token', orderFeedbackController.submitFeedback);

// Public PDF routes for WhatsApp template document headers
publicRouter.get('/invoices/:id/pdf', invoicePdfController.streamInvoicePdfInline);
publicRouter.get('/quotations/:id/pdf', quotationPdfController.exportPdf);
// Serve proforma PDFs at root so external links (e.g., WhatsApp templates) can access them
publicRouter.get('/proforma-invoices/:id/pdf', proformaPdfController.downloadProformaPdf);
publicRouter.get('/documents/invoices/:id.pdf', invoicePdfController.streamInvoicePdfInline);
publicRouter.get('/documents/quotations/:id.pdf', quotationPdfController.exportPdf);
// Also expose a public /public/leads endpoint (mounted at /public/leads)
publicRouter.post('/leads', leadController.createLead);
// Public contact endpoint available at /public/contact
publicRouter.post('/contact', publicContactController.createContact);

// Public mail preview routes (available only when MAIL_MODE=console)
publicRouter.get('/mail-previews', (req, res) => {
	if (String(process.env.MAIL_MODE || '').toLowerCase() !== 'console') {
		return res.status(404).json({ error: 'Mail previews are available only when MAIL_MODE=console' });
	}

	return res.status(200).json({ previews: listMailPreviews() });
});

publicRouter.get('/mail-previews/:id', (req, res) => {
	if (String(process.env.MAIL_MODE || '').toLowerCase() !== 'console') {
		return res.status(404).json({ error: 'Mail previews are available only when MAIL_MODE=console' });
	}

	const preview = getMailPreviewById(req.params.id);

	if (!preview) {
		return res.status(404).send('Mail preview not found');
	}

	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	return res.status(200).send(preview.htmlContent || '<html><body><p>No content</p></body></html>');
});

module.exports = {
	apiPublicRouter,
	publicRouter,
};
