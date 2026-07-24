#!/usr/bin/env node

/**
 * Pavilion ERP general-business migration runner.
 *
 * Run from backend root:
 *   node scripts/apply-pavilion-general-migration.js
 *
 * This does NOT need the mysql CLI installed locally/server-side.
 * It uses backend/config/db.js and your backend .env DB credentials.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env from backend root even when this script is called from another cwd.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const pool = require('../config/db');

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_]+$/;

const assertSafeIdentifier = (identifier) => {
  if (!SAFE_IDENTIFIER.test(String(identifier || ''))) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
};

const quoteId = (identifier) => {
  assertSafeIdentifier(identifier);
  return `\`${identifier}\``;
};

const run = async (connection, label, sql, params = []) => {
  try {
    await connection.query(sql, params);
    console.log(`✅ ${label}`);
  } catch (err) {
    if (['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR'].includes(err.code)) {
      console.log(`ℹ️  ${label} already exists`);
      return;
    }
    console.error(`❌ ${label}`);
    console.error(err && err.message ? err.message : err);
    throw err;
  }
};

const tableExists = async (connection, tableName) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName],
  );
  return Number(rows?.[0]?.count || 0) > 0;
};

const columnExists = async (connection, tableName, columnName) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  return Number(rows?.[0]?.count || 0) > 0;
};

const ensureColumn = async (connection, tableName, columnName, definition) => {
  assertSafeIdentifier(tableName);
  assertSafeIdentifier(columnName);

  const hasTable = await tableExists(connection, tableName);
  if (!hasTable) {
    console.log(`⚠️  Skipped ${tableName}.${columnName}: table does not exist`);
    return;
  }

  const hasColumn = await columnExists(connection, tableName, columnName);
  if (hasColumn) {
    console.log(`ℹ️  ${tableName}.${columnName} already exists`);
    return;
  }

  await run(
    connection,
    `Add ${tableName}.${columnName}`,
    `ALTER TABLE ${quoteId(tableName)} ADD COLUMN ${quoteId(columnName)} ${definition}`,
  );
};

const createCustomersTable = async (connection) => {
  await run(connection, 'Create customers table', `
    CREATE TABLE IF NOT EXISTS customers (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      address TEXT NULL,
      landmark VARCHAR(255) NULL,
      city VARCHAR(100) NULL,
      state VARCHAR(100) NULL,
      pincode VARCHAR(20) NULL,
      source_type VARCHAR(50) NULL DEFAULT 'CRM',
      source_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_customers_email (email),
      KEY idx_customers_phone (phone),
      KEY idx_customers_source (source_type, source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
};

const createVendorsTable = async (connection) => {
  await run(connection, 'Create vendors table', `
    CREATE TABLE IF NOT EXISTS vendors (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      alternate_phone VARCHAR(50) NULL,
      gst_number VARCHAR(50) NULL,
      address TEXT NULL,
      city VARCHAR(100) NULL,
      state VARCHAR(100) NULL,
      pincode VARCHAR(20) NULL,
      brands TEXT NULL,
      payment_terms TEXT NULL,
      credit_days INT NULL DEFAULT 0,
      opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
      notes TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_vendors_name (name),
      KEY idx_vendors_phone (phone),
      KEY idx_vendors_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
};

const createVendorPayablesTable = async (connection) => {
  await run(connection, 'Create vendor_payables table', `
    CREATE TABLE IF NOT EXISTS vendor_payables (
      id INT NOT NULL AUTO_INCREMENT,
      vendor_id INT NOT NULL,
      work_order_id INT NULL,
      quotation_id INT NULL,
      product_id INT NULL,
      work_order_item_id INT NULL,
      description VARCHAR(500) NULL,
      amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
      paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
      status ENUM('pending','partial','paid','cancelled') NOT NULL DEFAULT 'pending',
      due_date DATE NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_vendor_payables_vendor (vendor_id),
      KEY idx_vendor_payables_work_order (work_order_id),
      KEY idx_vendor_payables_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
};

const createPassbookTables = async (connection) => {
  await run(connection, 'Create passbook_accounts table', `
    CREATE TABLE IF NOT EXISTS passbook_accounts (
      id INT NOT NULL AUTO_INCREMENT,
      account_name VARCHAR(255) NOT NULL,
      starting_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
      currency_code VARCHAR(10) NOT NULL DEFAULT 'INR',
      notes TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await run(connection, 'Create passbook_entries table', `
    CREATE TABLE IF NOT EXISTS passbook_entries (
      id INT NOT NULL AUTO_INCREMENT,
      account_id INT NOT NULL,
      entry_date DATE NOT NULL,
      type ENUM('CREDIT','DEBIT') NOT NULL,
      category VARCHAR(100) NULL,
      party_type VARCHAR(50) NULL,
      party_id INT NULL,
      party_name VARCHAR(255) NULL,
      reference_type VARCHAR(50) NULL,
      reference_id INT NULL,
      amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
      notes TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_passbook_entries_account (account_id),
      KEY idx_passbook_entries_date (entry_date),
      CONSTRAINT fk_passbook_entries_account
        FOREIGN KEY (account_id)
        REFERENCES passbook_accounts(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
};

const setBusinessTypeGeneral = async (connection) => {
  const hasSettings = await tableExists(connection, 'settings');
  if (!hasSettings) {
    console.log('⚠️  Skipped settings.business_type update: settings table does not exist');
    return;
  }

  const hasBusinessType = await columnExists(connection, 'settings', 'business_type');
  if (!hasBusinessType) {
    await ensureColumn(
      connection,
      'settings',
      'business_type',
      "ENUM('GENERAL','CATERING','HYBRID') DEFAULT 'GENERAL'",
    );
  }

  await run(connection, 'Set settings.business_type = GENERAL', `
    UPDATE settings
       SET business_type = 'GENERAL'
     WHERE id = 1
  `);
};

const main = async () => {
  const dbInfo = {
    host: process.env.DB_HOST || '(missing)',
    database: process.env.DB_NAME || '(missing)',
    user: process.env.DB_USER || '(missing)',
  };

  console.log('----------------------------------------');
  console.log('Pavilion ERP migration runner');
  console.log('DB:', dbInfo);
  console.log('----------------------------------------');

  if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER) {
    throw new Error('Missing DB_HOST, DB_NAME, or DB_USER in backend .env');
  }

  const connection = await pool.getConnection();

  try {
    await connection.query('SELECT 1');
    console.log('✅ DB connection OK');

    await ensureColumn(connection, 'categories', 'shop_visible', 'TINYINT(1) NOT NULL DEFAULT 1');

    await createCustomersTable(connection);
    await createVendorsTable(connection);

    await ensureColumn(connection, 'products', 'vendor_id', 'INT NULL');
    await ensureColumn(connection, 'variants', 'vendor_id', 'INT NULL');
    await ensureColumn(connection, 'quotation_items', 'vendor_id', 'INT NULL');
    await ensureColumn(connection, 'work_order_items', 'vendor_id', 'INT NULL');
    await ensureColumn(connection, 'work_orders', 'customer_id', 'INT NULL');
    await ensureColumn(connection, 'user_visibility_permissions', 'vendors', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn(connection, 'user_visibility_permissions', 'passbook', 'TINYINT(1) NOT NULL DEFAULT 1');

    await createVendorPayablesTable(connection);
    await createPassbookTables(connection);
    await setBusinessTypeGeneral(connection);

    console.log('----------------------------------------');
    console.log('✅ Pavilion/general migration completed successfully.');
    console.log('Now restart the backend process.');
    console.log('----------------------------------------');
  } finally {
    connection.release();
    await pool.end();
  }
};

main().catch(async (err) => {
  console.error('----------------------------------------');
  console.error('❌ Migration failed');
  console.error(err && err.stack ? err.stack : err);
  console.error('----------------------------------------');
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
