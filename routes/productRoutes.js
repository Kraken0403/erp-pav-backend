const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const productBulkImportController = require('../controllers/productBulkImportController');
const authenticateJWT = require('../middleware/authMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

// Protect all routes
router.use(authenticateJWT);

// -------------------- PRODUCTS --------------------
router.get('/products', productController.getAllProducts);
router.get('/products/name/:name', productController.getProductByName);
router.get('/products/:id', productController.getProductById);
router.post('/products', productController.createProduct);
router.put('/products/:id', productController.updateProduct);
router.delete('/products/:id', productController.deleteProduct);
router.post('/products/bulk-import', upload.single('file'), productBulkImportController.bulkImportProducts);


// -------------------- ATTRIBUTES --------------------
router.post('/attributes', productController.createAttribute);
router.get('/attributes', productController.getAllAttributes);
router.put('/attributes/:id', productController.updateAttribute);
router.delete('/attributes/:id', productController.deleteAttribute);
router.post('/attributes/:id/options', productController.createAttributeOption);
router.get('/attributes/:id/options', productController.getAttributeOptions);
router.delete('/attribute-options/:optionId', productController.deleteAttributeOption);

// -------------------- PRODUCT ATTRIBUTE ASSIGNMENT --------------------
router.post('/products/:productId/attributes', productController.assignAttributeToProduct);

// -------------------- VARIANTS --------------------
router.post('/variants', productController.createVariantWithAttributes);
router.get('/products/:productId/variants', productController.getVariantsByProduct);
// router.get('/variants/:id/attributes', productController.getVariantAttributes);


// -------------------- CATEGORIES --------------------
router.post('/categories', productController.createCategory);
router.get('/categories', productController.getCategories);
router.get('/categories/:id', productController.getCategoryById);
router.get('/categories/N/:name', productController.getCategoryByName);
router.post('/categories/check', productController.checkCategory);
router.put('/categories/:id', productController.updateCategory);     // ✅ ADD THIS
router.delete('/categories/:id', productController.deleteCategory);  // ✅ ADD THIS


// -------------------- PACKAGING --------------------
// Add/Get/Delete packaging for a product
router.post('/products/:productId/packaging', productController.addProductPackaging);
router.get('/products/:productId/packaging', productController.getProductPackaging);
router.delete('/products/:productId/packaging', productController.removeProductPackaging);

// Add/Get/Delete packaging for a variant
router.post('/variants/:variantId/packaging', productController.addVariantPackaging);
router.get('/variants/:variantId/packaging', productController.getVariantPackaging);
router.delete('/variants/:variantId/packaging', productController.removeVariantPackaging);

// -------------------- PRODUCT IMAGES --------------------
router.get('/products/:id/images', productController.getProductImages);
router.post('/products/:id/images', productController.addProductImage);
router.delete('/products/:id/images/:imageId', productController.deleteProductImage);

// -------------------- BUNDLE ITEMS --------------------
router.get('/products/:id/bundle-items', productController.getProductBundleItems);
router.put('/products/:id/bundle-items', productController.updateProductBundleItems);

// -------------------- INGREDIENTS --------------------
router.get('/ingredients', productController.getIngredients);
router.get('/products/:id/ingredients', productController.getProductIngredients);
router.put('/products/:id/ingredients', productController.updateProductIngredients);


module.exports = router;
