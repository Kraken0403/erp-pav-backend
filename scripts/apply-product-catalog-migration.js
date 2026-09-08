const db = require('../config/db');
const { ensureProductCatalogSchema } = require('../utils/pavilionSchema');

async function tableExists(connection, tableName) {
  const [[row]] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(row?.count || 0) > 0;
}

async function columnType(connection, tableName, columnName) {
  const [[row]] = await connection.query(
    `SELECT COLUMN_TYPE AS columnType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return row?.columnType || null;
}

async function main() {
  const connection = await db.getConnection();

  try {
    const [[databaseRow]] = await connection.query('SELECT DATABASE() AS dbName');
    const connectedDatabase = databaseRow?.dbName || '';

    console.log('Applying product catalog migration...');
    console.log(`Configured DB_NAME: ${process.env.DB_NAME || '(not set)'}`);
    console.log(`Connected database: ${connectedDatabase || '(unknown)'}`);

    if (process.env.DB_NAME && connectedDatabase && process.env.DB_NAME !== connectedDatabase) {
      throw new Error(`Connected database ${connectedDatabase} does not match DB_NAME ${process.env.DB_NAME}`);
    }

    await ensureProductCatalogSchema(connection);

    for (const tableName of ['product_bundle_items', 'product_units', 'product_vendors']) {
      if (!(await tableExists(connection, tableName))) {
        throw new Error(`Required table was not created: ${tableName}`);
      }
      console.log(`OK ${tableName}`);
    }

    const sellingUnitType = await columnType(connection, 'products', 'selling_price_unit');
    const costUnitType = await columnType(connection, 'products', 'cost_price_unit');

    if (!String(sellingUnitType || '').toLowerCase().startsWith('varchar')) {
      throw new Error(`products.selling_price_unit must be VARCHAR, found ${sellingUnitType || 'missing'}`);
    }
    if (!String(costUnitType || '').toLowerCase().startsWith('varchar')) {
      throw new Error(`products.cost_price_unit must be VARCHAR, found ${costUnitType || 'missing'}`);
    }

    console.log(`OK products.selling_price_unit: ${sellingUnitType}`);
    console.log(`OK products.cost_price_unit: ${costUnitType}`);
    console.log('Product catalog migration completed.');
  } catch (error) {
    console.error('Product catalog migration failed.');
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    connection.release();
    await db.end();
  }
}

main();
