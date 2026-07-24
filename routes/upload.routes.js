const express = require('express')
const multer = require('multer')
const path = require('path')

const router = express.Router()
const authenticateJWT = require('../middleware/authMiddleware');
const uploadMiddleware = require('../middleware/upload')

router.use(authenticateJWT);

/* ======================================================
   EXISTING LOGO UPLOAD (DO NOT TOUCH)
   Used for quotation templates
====================================================== */

const logoStorage = uploadMiddleware.storageFor('')
const uploadLogo = multer({ storage: logoStorage })

router.post('/upload/logo', (req, res, next) => {
  uploadLogo.single('file')(req, res, function (err) {
    if (err) {
      console.error('[UPLOAD LOGO ERROR]', err);
      return res.status(500).json({ error: 'Upload failed', details: err.message || err });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    // Return app-relative URL so frontend can safely prepend BACKEND_URL
    // (avoids wrong host/base-path when behind reverse proxies like /backend).
    const url = `/uploads/${req.file.filename}`;
    res.json({ url });
  });
});

/* ======================================================
   NEW PRODUCT IMAGE UPLOAD (ADDED)
====================================================== */

const productImageStorage = uploadMiddleware.storageFor('products')

const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files allowed'), false)
    }
    cb(null, true)
  }
})

router.post(
  '/upload/product-image',
  uploadProductImage.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    // Keep upload URLs relative for consistent client-side resolution.
    const url = `/uploads/products/${req.file.filename}`
    res.json({ url })
  }
)

module.exports = router
