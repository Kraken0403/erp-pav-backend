const isSafeIdentifier = (value) => /^[a-zA-Z0-9_]+$/.test(String(value || ''));

const runSchemaStatement = async (connection, sql) => {
  try {
    await connection.query(sql);
  } catch (err) {
    if (err && ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(err.code)) return;
    throw err;
  }
};

const columnExists = async (connection, tableName, columnName) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows?.[0]?.count || 0) > 0;
};

const ensureColumn = async (connection, tableName, columnName, definition) => {
  if (!isSafeIdentifier(tableName) || !isSafeIdentifier(columnName)) {
    throw new Error(`Unsafe schema identifier: ${tableName}.${columnName}`);
  }
  const exists = await columnExists(connection, tableName, columnName);
  if (exists) return;
  await runSchemaStatement(connection, `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
};

const ensureCategorySchema = async (connection) => {
  await ensureColumn(connection, 'categories', 'shop_visible', 'TINYINT(1) NOT NULL DEFAULT 1');
};

const ensureCustomerSchema = async (connection) => {
  await runSchemaStatement(connection, `
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

const ensureVendorSchema = async (connection) => {
  await runSchemaStatement(connection, `
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

  await ensureColumn(connection, 'products', 'vendor_id', 'INT NULL');
  await ensureColumn(connection, 'variants', 'vendor_id', 'INT NULL');
  await ensureColumn(connection, 'quotation_items', 'vendor_id', 'INT NULL');
  await ensureColumn(connection, 'work_order_items', 'vendor_id', 'INT NULL');
  await ensureColumn(connection, 'work_orders', 'customer_id', 'INT NULL');
  await ensureColumn(connection, 'user_visibility_permissions', 'vendors', 'TINYINT(1) NOT NULL DEFAULT 1');
  await ensureColumn(connection, 'user_visibility_permissions', 'passbook', 'TINYINT(1) NOT NULL DEFAULT 1');

  await runSchemaStatement(connection, `
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

const ensurePassbookSchema = async (connection) => {
  await runSchemaStatement(connection, `
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

  await runSchemaStatement(connection, `
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
      CONSTRAINT fk_passbook_entries_account FOREIGN KEY (account_id) REFERENCES passbook_accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
};

const ensurePavilionSchema = async (connection) => {
  await ensureCategorySchema(connection);
  await ensureCustomerSchema(connection);
  await ensureVendorSchema(connection);
  await ensurePassbookSchema(connection);
};

module.exports = {
  ensureCategorySchema,
  ensureCustomerSchema,
  ensureVendorSchema,
  ensurePassbookSchema,
  ensurePavilionSchema,
  ensureColumn,
};
