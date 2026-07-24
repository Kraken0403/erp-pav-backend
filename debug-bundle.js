const db = require('./config/db');

async function debugBundle() {
  try {
    // Get categories with food/fusion in name
    const [categories] = await db.query(
      `SELECT id, name, slug FROM categories WHERE slug LIKE '%food%' OR slug LIKE '%fusion%' OR name LIKE '%food%' OR name LIKE '%fusion%'`
    );

    console.log('\n📋 Categories with food/fusion:');
    console.table(categories);

    // Get products in those categories
    if (categories.length > 0) {
      const catIds = categories.map(c => c.id);
      const [products] = await db.query(
        `SELECT id, name, category_id, slug FROM products WHERE category_id IN (${catIds.map(() => '?').join(',')}) LIMIT 10`,
        catIds
      );

      console.log('\n🛍️  Products in those categories:');
      console.table(products);

      // Check if any have bundle items
      if (products.length > 0) {
        const prodIds = products.map(p => p.id);
        const [bundleItems] = await db.query(
          `SELECT bundle_product_id, COUNT(*) as count FROM product_bundle_items WHERE bundle_product_id IN (${prodIds.map(() => '?').join(',')}) GROUP BY bundle_product_id`,
          prodIds
        );

        console.log('\n📦 Products with bundle items:');
        console.table(bundleItems);

        if (bundleItems.length === 0) {
          console.log('\n⚠️  No bundle items found! You need to create some via the CRM.');
        }
      }
    } else {
      console.log('\n⚠️  No categories found with food/fusion in name');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

debugBundle();
