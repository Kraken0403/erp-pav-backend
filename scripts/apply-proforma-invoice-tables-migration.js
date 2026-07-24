#!/usr/bin/env node

/**
 * Pav ERP migration runner: creates/repairs dedicated proforma invoice tables.
 *
 * Run from backend root:
 *   node scripts/apply-proforma-invoice-tables-migration.js
 *
 * Why this exists:
 * - Your DB is missing proforma_invoices entirely.
 * - The old SQL migrations used MySQL 8-only IF NOT EXISTS syntax for columns/indexes,
 *   which often breaks on MariaDB / older MySQL.
 * - This script checks information_schema first, so it is safe to rerun.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const pool = require('../config/db');

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_]+$/;

function quoteId(identifier) {
  if (!SAFE_IDENTIFIER.test(String(identifier || ''))) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

async function getCount(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return Number(rows?.[0]?.count || 0);
}

async function tableExists(conn, tableName) {
  return (await getCount(
    conn,
    `SELECT COUNT(*) AS count
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  )) > 0;
}

async function columnExists(conn, tableName, columnName) {
  return (await getCount(
    conn,
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  )) > 0;
}

async function indexExists(conn, tableName, indexName) {
  return (await getCount(
    conn,
    `SELECT COUNT(*) AS count
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [tableName, indexName]
  )) > 0;
}

async function run(conn, label, sql, params = []) {
  try {
    await conn.query(sql, params);
    console.log(`✅ ${label}`);
  } catch (err) {
    if (['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR'].includes(err.code)) {
      console.log(`ℹ️  ${label} already exists`);
      return;
    }
    console.error(`❌ ${label}`);
    console.error(err?.message || err);
    throw err;
  }
}

async function ensureColumn(conn, tableName, columnName, definition) {
  if (await columnExists(conn, tableName, columnName)) {
    console.log(`ℹ️  ${tableName}.${columnName} already exists`);
    return;
  }

  await run(
    conn,
    `Add ${tableName}.${columnName}`,
    `ALTER TABLE ${quoteId(tableName)} ADD COLUMN ${quoteId(columnName)} ${definition}`
  );
}

async function ensureIndex(conn, tableName, indexName, columnNames) {
  if (await indexExists(conn, tableName, indexName)) {
    console.log(`ℹ️  ${tableName}.${indexName} already exists`);
    return;
  }

  const columns = Array.isArray(columnNames) ? columnNames : [columnNames];
  await run(
    conn,
    `Add ${tableName}.${indexName}`,
    `ALTER TABLE ${quoteId(tableName)} ADD INDEX ${quoteId(indexName)} (${columns.map(quoteId).join(', ')})`
  );
}

async function ensureProformaInvoicesTable(conn) {
  if (await tableExists(conn, 'proforma_invoices')) {
    console.log('ℹ️  proforma_invoices table already exists');
    return;
  }

  await run(
    conn,
    'Create proforma_invoices table',
    `CREATE TABLE proforma_invoices (
      id BIGINT NOT NULL AUTO_INCREMENT,
      proforma_number VARCHAR(64) NOT NULL,
      proforma_sequence INT DEFAULT 0,
      lead_id INT NULL,
      event_details JSON NULL,
      items JSON NULL,
      status VARCHAR(40) DEFAULT 'issued',
      subtotal DECIMAL(12,2) DEFAULT 0,
      cgst_total DECIMAL(12,2) DEFAULT 0,
      sgst_total DECIMAL(12,2) DEFAULT 0,
      igst_total DECIMAL(12,2) DEFAULT 0,
      grand_total DECIMAL(12,2) DEFAULT 0,
      rounding_amount DECIMAL(13,2) NOT NULL DEFAULT 0,
      source_type VARCHAR(50) NULL,
      source_id INT NULL,
      tax_invoice_id INT NULL,
      tax_invoice_exists TINYINT(1) NOT NULL DEFAULT 0,
      issue_date DATE NULL,
      due_date DATE NULL,
      notes TEXT NULL,
      billing_snapshot JSON NULL,
      shipping_snapshot JSON NULL,
      gst_pricing_mode VARCHAR(16) DEFAULT 'EXCLUSIVE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_proforma_lead_id (lead_id),
      KEY idx_proforma_source_id (source_id),
      KEY idx_proforma_number (proforma_number),
      KEY idx_proforma_tax_invoice_id (tax_invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function ensureProformaItemsTable(conn) {
  if (await tableExists(conn, 'proforma_items')) {
    console.log('ℹ️  proforma_items table already exists');
    return;
  }

  await run(
    conn,
    'Create proforma_items table',
    `CREATE TABLE proforma_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      proforma_id BIGINT NOT NULL,
      product_id INT NULL,
      description TEXT NULL,
      quantity DECIMAL(12,2) DEFAULT 0,
      unit_price DECIMAL(12,2) DEFAULT 0,
      gst_rate DECIMAL(8,2) DEFAULT 0,
      taxable_amount DECIMAL(12,2) DEFAULT 0,
      cgst_amount DECIMAL(12,2) DEFAULT 0,
      sgst_amount DECIMAL(12,2) DEFAULT 0,
      igst_amount DECIMAL(12,2) DEFAULT 0,
      line_total DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_proforma_items_proforma_id (proforma_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function repairProformaInvoicesColumns(conn) {
  await ensureColumn(conn, 'proforma_invoices', 'proforma_number', 'VARCHAR(64) NOT NULL');
  await ensureColumn(conn, 'proforma_invoices', 'proforma_sequence', 'INT DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'lead_id', 'INT NULL');
  await ensureColumn(conn, 'proforma_invoices', 'event_details', 'JSON NULL');
  await ensureColumn(conn, 'proforma_invoices', 'items', 'JSON NULL');
  await ensureColumn(conn, 'proforma_invoices', 'status', "VARCHAR(40) DEFAULT 'issued'");
  await ensureColumn(conn, 'proforma_invoices', 'subtotal', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'cgst_total', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'sgst_total', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'igst_total', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'grand_total', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'rounding_amount', 'DECIMAL(13,2) NOT NULL DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'source_type', 'VARCHAR(50) NULL');
  await ensureColumn(conn, 'proforma_invoices', 'source_id', 'INT NULL');
  await ensureColumn(conn, 'proforma_invoices', 'tax_invoice_id', 'INT NULL');
  await ensureColumn(conn, 'proforma_invoices', 'tax_invoice_exists', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn(conn, 'proforma_invoices', 'issue_date', 'DATE NULL');
  await ensureColumn(conn, 'proforma_invoices', 'due_date', 'DATE NULL');
  await ensureColumn(conn, 'proforma_invoices', 'notes', 'TEXT NULL');
  await ensureColumn(conn, 'proforma_invoices', 'billing_snapshot', 'JSON NULL');
  await ensureColumn(conn, 'proforma_invoices', 'shipping_snapshot', 'JSON NULL');
  await ensureColumn(conn, 'proforma_invoices', 'gst_pricing_mode', "VARCHAR(16) DEFAULT 'EXCLUSIVE'");
  await ensureColumn(conn, 'proforma_invoices', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn(conn, 'proforma_invoices', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

  await ensureIndex(conn, 'proforma_invoices', 'idx_proforma_lead_id', 'lead_id');
  await ensureIndex(conn, 'proforma_invoices', 'idx_proforma_source_id', 'source_id');
  await ensureIndex(conn, 'proforma_invoices', 'idx_proforma_number', 'proforma_number');
  await ensureIndex(conn, 'proforma_invoices', 'idx_proforma_tax_invoice_id', 'tax_invoice_id');
}

async function repairProformaItemsColumns(conn) {
  await ensureColumn(conn, 'proforma_items', 'proforma_id', 'BIGINT NOT NULL');
  await ensureColumn(conn, 'proforma_items', 'product_id', 'INT NULL');
  await ensureColumn(conn, 'proforma_items', 'description', 'TEXT NULL');
  await ensureColumn(conn, 'proforma_items', 'quantity', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'unit_price', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'gst_rate', 'DECIMAL(8,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'taxable_amount', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'cgst_amount', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'sgst_amount', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'igst_amount', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'line_total', 'DECIMAL(12,2) DEFAULT 0');
  await ensureColumn(conn, 'proforma_items', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn(conn, 'proforma_items', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

  await ensureIndex(conn, 'proforma_items', 'idx_proforma_items_proforma_id', 'proforma_id');
}

async function makeInvoiceSourceTypeFlexible(conn) {
  if (!(await tableExists(conn, 'invoices'))) {
    console.log('ℹ️  invoices table not found, skipped source_type repair');
    return;
  }

  if (!(await columnExists(conn, 'invoices', 'source_type'))) {
    console.log('ℹ️  invoices.source_type not found, skipped source_type repair');
    return;
  }

  await run(
    conn,
    'Make invoices.source_type support proforma/quotation values',
    `ALTER TABLE invoices MODIFY COLUMN source_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL'`
  );
}

async function backfillTaxLinks(conn) {
  if (!(await tableExists(conn, 'invoices'))) return;
  if (!(await columnExists(conn, 'invoices', 'source_type'))) return;
  if (!(await columnExists(conn, 'invoices', 'source_id'))) return;

  await run(
    conn,
    'Backfill tax links from proforma source invoices',
    `UPDATE proforma_invoices p
        JOIN invoices i
          ON UPPER(COALESCE(i.source_type, '')) IN ('PROFORMA', 'PROFORMA_INVOICE')
         AND CAST(i.source_id AS UNSIGNED) = p.id
       SET p.tax_invoice_id = COALESCE(p.tax_invoice_id, i.id),
           p.tax_invoice_exists = 1
     WHERE p.tax_invoice_id IS NULL`
  );

  await run(
    conn,
    'Backfill tax links from quotation invoices',
    `UPDATE proforma_invoices p
        JOIN invoices i
          ON UPPER(COALESCE(p.source_type, '')) LIKE '%QUOTATION%'
         AND UPPER(COALESCE(i.source_type, '')) = 'QUOTATION'
         AND CAST(i.source_id AS UNSIGNED) = CAST(p.source_id AS UNSIGNED)
       SET p.tax_invoice_id = COALESCE(p.tax_invoice_id, i.id),
           p.tax_invoice_exists = 1
     WHERE p.tax_invoice_id IS NULL`
  );
}

async function main() {
  const conn = await pool.getConnection();

  try {
    console.log('🚀 Applying full proforma invoice migration...');
    console.log(`Database: ${process.env.DB_NAME || '(not set)'}`);

    await ensureProformaInvoicesTable(conn);
    await ensureProformaItemsTable(conn);

    await repairProformaInvoicesColumns(conn);
    await repairProformaItemsColumns(conn);

    await makeInvoiceSourceTypeFlexible(conn);

    await run(
      conn,
      'Normalize proforma tax flags',
      `UPDATE proforma_invoices
          SET tax_invoice_exists = CASE WHEN tax_invoice_id IS NULL THEN 0 ELSE 1 END
        WHERE tax_invoice_exists IS NULL OR tax_invoice_exists = 0`
    );

    await backfillTaxLinks(conn);

    const [[result]] = await conn.query(
      `SELECT
         COUNT(*) AS total_proformas,
         SUM(CASE WHEN tax_invoice_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_tax_invoices,
         SUM(CASE WHEN tax_invoice_exists = 1 THEN 1 ELSE 0 END) AS marked_tax_invoice_exists
       FROM proforma_invoices`
    );

    console.log('📊 Result:', result || {});
    console.log('✅ Full proforma invoice migration completed.');
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('❌ Migration failed.');
  console.error(err?.stack || err?.message || err);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
