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

const modifyColumnIfExists = async (connection, tableName, columnName, definition) => {
  if (!isSafeIdentifier(tableName) || !isSafeIdentifier(columnName)) {
    throw new Error(`Unsafe schema identifier: ${tableName}.${columnName}`);
  }
  const [rows] = await connection.query(
    `SELECT COLUMN_TYPE AS columnType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  if (!rows.length) return;

  const requestedType = String(definition || '').trim().split(/\s+/)[0].toLowerCase();
  const currentType = String(rows[0].columnType || '').trim().toLowerCase();
  if (requestedType && currentType === requestedType) return;

  await runSchemaStatement(connection, `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${columnName}\` ${definition}`);
};

const ensureCategorySchema = async (connection) => {
  await ensureColumn(connection, 'categories', 'shop_visible', 'TINYINT(1) NOT NULL DEFAULT 1');
};

const ensureProductCatalogSchema = async (connection) => {
  // This table is required by legacy product reads/saves in parts of the catalog.
  // Create it first and keep it FK-free so a legacy product id definition can never
  // prevent the schema bootstrap from fixing the missing-table error.
  await runSchemaStatement(connection, `
    CREATE TABLE IF NOT EXISTS product_bundle_items (
      id INT NOT NULL AUTO_INCREMENT,
      bundle_product_id INT NOT NULL,
      component_product_id INT NOT NULL,
      quantity DECIMAL(10,3) NOT NULL DEFAULT 1.000,
      unit VARCHAR(50) NOT NULL DEFAULT 'piece',
      description VARCHAR(255) NULL,
      display_order INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_bundle_items_bundle (bundle_product_id),
      KEY idx_bundle_items_component (component_product_id),
      KEY idx_bundle_items_order (display_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await ensureColumn(connection, 'products', 'is_favorite', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(connection, 'products', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

  // Units must be extensible from the UI, so the product unit columns cannot remain ENUMs.
  await modifyColumnIfExists(connection, 'products', 'cost_price_unit', "VARCHAR(50) NULL DEFAULT 'piece'");
  await modifyColumnIfExists(connection, 'products', 'selling_price_unit', "VARCHAR(50) NULL DEFAULT 'piece'");

  await runSchemaStatement(connection, `
    CREATE TABLE IF NOT EXISTS product_units (
      id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_product_unit_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await connection.query(`
    INSERT IGNORE INTO product_units (name) VALUES
      ('mg'), ('g'), ('kg'), ('tonne'), ('mm'), ('cm'), ('m'), ('metre'),
      ('ml'), ('l'), ('piece'), ('pair'), ('pcs'), ('box'), ('packet'), ('bag'), ('roll')
  `);

  await runSchemaStatement(connection, `
    CREATE TABLE IF NOT EXISTS product_addons (
      id INT NOT NULL AUTO_INCREMENT,
      product_id INT NOT NULL,
      addon_product_id INT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_product_addon (product_id, addon_product_id),
      KEY idx_product_addons_product (product_id),
      KEY idx_product_addons_addon (addon_product_id),
      CONSTRAINT fk_product_addons_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      CONSTRAINT fk_product_addons_addon_product FOREIGN KEY (addon_product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await runSchemaStatement(connection, `
    CREATE TABLE IF NOT EXISTS product_vendors (
      id INT NOT NULL AUTO_INCREMENT,
      product_id INT NOT NULL,
      vendor_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_product_vendor (product_id, vendor_id),
      KEY idx_product_vendors_product (product_id),
      KEY idx_product_vendors_vendor (vendor_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
};

const ensureQuotationShareSchema = async (connection) => {
  await ensureColumn(connection, 'quotations', 'public_token', 'VARCHAR(80) NULL');
  await ensureColumn(connection, 'quotations', 'public_access_code_hash', 'VARCHAR(255) NULL');
  await ensureColumn(connection, 'quotations', 'public_access_code_display', 'VARCHAR(6) NULL');
  await ensureColumn(connection, 'quotations', 'public_access_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(connection, 'quotations', 'public_acceptance_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(connection, 'quotations', 'public_viewed_at', 'DATETIME NULL');
  await ensureColumn(connection, 'quotations', 'accepted_at', 'DATETIME NULL');
  await ensureColumn(connection, 'quotations', 'company_id', 'INT NULL');
  await ensureColumn(connection, 'quotations', 'quotation_template', 'VARCHAR(50) NULL');
  await ensureColumn(connection, 'quotations', 'quotation_type', 'VARCHAR(50) NULL');
  await ensureColumn(connection, 'quotations', 'cover_letter_html', 'LONGTEXT NULL');
  await ensureColumn(connection, 'quotations', 'terms_conditions_html', 'LONGTEXT NULL');
  await ensureColumn(connection, 'quotations', 'company_logo_url', 'VARCHAR(500) NULL');
  await ensureColumn(connection, 'quotations', 'payment_terms', 'LONGTEXT NULL');
  await ensureColumn(connection, 'quotations', 'quotation_line_columns_json', 'LONGTEXT NULL');
  await ensureColumn(connection, 'quotations', 'group_items_by_top_category', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(connection, 'quotations', 'issuer_company_name', 'VARCHAR(255) NULL');
  await ensureColumn(connection, 'quotations', 'issuer_company_email', 'VARCHAR(255) NULL');
  await ensureColumn(connection, 'quotations', 'issuer_company_phone', 'VARCHAR(100) NULL');
  await ensureColumn(connection, 'quotations', 'issuer_company_address', 'TEXT NULL');
  await ensureColumn(connection, 'quotations', 'issuer_company_gst_number', 'VARCHAR(100) NULL');

  await runSchemaStatement(connection, `
    CREATE TABLE IF NOT EXISTS quotation_clarifications (
      id INT NOT NULL AUTO_INCREMENT,
      quotation_id INT NOT NULL,
      customer_name VARCHAR(255) NULL,
      customer_email VARCHAR(255) NULL,
      message TEXT NOT NULL,
      status ENUM('open','resolved') NOT NULL DEFAULT 'open',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_quotation_clarifications_quotation (quotation_id),
      KEY idx_quotation_clarifications_status (status),
      CONSTRAINT fk_quotation_clarifications_quotation FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
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

const ensureWorkOrderSettingsSchema = async (connection) => {
  await runSchemaStatement(connection, `
    CREATE TABLE IF NOT EXISTS work_order_settings (
      id INT NOT NULL,
      prefix VARCHAR(20) NOT NULL DEFAULT 'WO',
      number_format VARCHAR(100) NOT NULL DEFAULT '{prefix}/{year}/{seq}',
      numbering_mode ENUM('continuous','yearly','monthly') NOT NULL DEFAULT 'continuous',
      terms_conditions_html LONGTEXT NULL,
      footer_notes_html LONGTEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
  await connection.query(`INSERT IGNORE INTO work_order_settings (id) VALUES (1)`);
};

const ensurePavilionSchema = async (connection) => {
  await ensureCategorySchema(connection);
  await ensureProductCatalogSchema(connection);
  await ensureQuotationShareSchema(connection);
  await ensureCustomerSchema(connection);
  await ensureVendorSchema(connection);
  await ensurePassbookSchema(connection);
  await ensureWorkOrderSettingsSchema(connection);
};

module.exports = {
  ensureCategorySchema,
  ensureProductCatalogSchema,
  ensureQuotationShareSchema,
  ensureCustomerSchema,
  ensureVendorSchema,
  ensurePassbookSchema,
  ensureWorkOrderSettingsSchema,
  ensurePavilionSchema,
  ensureColumn,
};
