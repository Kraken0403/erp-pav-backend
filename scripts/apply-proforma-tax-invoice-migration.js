#!/usr/bin/env node

/**
 * Pav ERP migration runner: proforma invoice -> tax invoice tracking columns.
 *
 * What it fixes:
 *   - Adds proforma_invoices.tax_invoice_id
 *   - Adds proforma_invoices.tax_invoice_exists
 *   - Adds index idx_proforma_tax_invoice_id
 *   - Backfills tax_invoice_exists from existing tax_invoice_id / invoice source references where possible
 *
 * Run from backend root:
 *   node scripts/apply-proforma-tax-invoice-migration.js
 *
 * This does not need mysql CLI. It uses backend/config/db.js and backend .env.
 */

const path = require('path');
const dotenv = require('dotenv');

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

const getCount = async (conn, sql, params = []) => {
  const [rows] = await conn.query(sql, params);
  return Number(rows?.[0]?.count || 0);
};

const tableExists = async (conn, tableName) => {
  return (await getCount(
    conn,
    `SELECT COUNT(*) AS count
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName],
  )) > 0;
};

const columnExists = async (conn, tableName, columnName) => {
  return (await getCount(
    conn,
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName],
  )) > 0;
};

const indexExists = async (conn, tableName, indexName) => {
  return (await getCount(
    conn,
    `SELECT COUNT(*) AS count
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [tableName, indexName],
  )) > 0;
};

const run = async (conn, label, sql, params = []) => {
  try {
    await conn.query(sql, params);
    console.log(`✅ ${label}`);
  } catch (err) {
    if (['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(err.code)) {
      console.log(`ℹ️  ${label} already exists`);
      return;
    }
    console.error(`❌ ${label}`);
    console.error(err?.message || err);
    throw err;
  }
};

const ensureColumn = async (conn, tableName, columnName, definition) => {
  const hasColumn = await columnExists(conn, tableName, columnName);
  if (hasColumn) {
    console.log(`ℹ️  ${tableName}.${columnName} already exists`);
    return;
  }

  await run(
    conn,
    `Add ${tableName}.${columnName}`,
    `ALTER TABLE ${quoteId(tableName)} ADD COLUMN ${quoteId(columnName)} ${definition}`,
  );
};

const ensureIndex = async (conn, tableName, indexName, columnName) => {
  const hasIndex = await indexExists(conn, tableName, indexName);
  if (hasIndex) {
    console.log(`ℹ️  ${tableName}.${indexName} already exists`);
    return;
  }

  await run(
    conn,
    `Add ${tableName}.${indexName}`,
    `ALTER TABLE ${quoteId(tableName)} ADD INDEX ${quoteId(indexName)} (${quoteId(columnName)})`,
  );
};

const getInvoiceColumns = async (conn) => {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'invoices'`,
  );
  return new Set(rows.map((row) => row.COLUMN_NAME));
};

const backfillFromInvoices = async (conn) => {
  const hasInvoices = await tableExists(conn, 'invoices');
  if (!hasInvoices) {
    console.log('ℹ️  invoices table not found, skipped invoice backfill');
    return;
  }

  const invoiceColumns = await getInvoiceColumns(conn);

  // This project uses source_type/source_id in a few ways:
  //   - Manual/generic proforma tax invoice: invoices.source_type = 'PROFORMA', source_id = proforma_invoices.id
  //   - Quotation proforma tax invoice: invoices.source_type = 'QUOTATION', source_id = proforma_invoices.source_id
  //   - Work order proforma tax invoice: invoices.source_type = 'WORK_ORDER', source_id = proforma_invoices.source_id
  if (invoiceColumns.has('source_type') && invoiceColumns.has('source_id')) {
    await run(
      conn,
      'Backfill generic proforma tax invoice links',
      `UPDATE proforma_invoices p
          JOIN invoices i
            ON UPPER(COALESCE(i.source_type, '')) IN ('PROFORMA','PROFORMA_INVOICE')
           AND CAST(i.source_id AS UNSIGNED) = p.id
         SET p.tax_invoice_id = COALESCE(p.tax_invoice_id, i.id),
             p.tax_invoice_exists = 1
       WHERE p.tax_invoice_id IS NULL`,
    );

    await run(
      conn,
      'Backfill quotation proforma tax invoice links',
      `UPDATE proforma_invoices p
          JOIN invoices i
            ON UPPER(COALESCE(p.source_type, '')) LIKE '%QUOTATION%'
           AND UPPER(COALESCE(i.source_type, '')) = 'QUOTATION'
           AND CAST(i.source_id AS UNSIGNED) = CAST(p.source_id AS UNSIGNED)
         SET p.tax_invoice_id = COALESCE(p.tax_invoice_id, i.id),
             p.tax_invoice_exists = 1
       WHERE p.tax_invoice_id IS NULL`,
    );

    await run(
      conn,
      'Backfill work-order proforma tax invoice links',
      `UPDATE proforma_invoices p
          JOIN invoices i
            ON UPPER(COALESCE(p.source_type, '')) LIKE '%WORK_ORDER%'
           AND UPPER(COALESCE(i.source_type, '')) = 'WORK_ORDER'
           AND CAST(i.source_id AS UNSIGNED) = CAST(p.source_id AS UNSIGNED)
         SET p.tax_invoice_id = COALESCE(p.tax_invoice_id, i.id),
             p.tax_invoice_exists = 1
       WHERE p.tax_invoice_id IS NULL`,
    );
    return;
  }

  console.log('ℹ️  invoices.source_type/source_id not found, skipped invoice relationship backfill');
};

const main = async () => {
  const conn = await pool.getConnection();

  try {
    console.log('🚀 Applying proforma tax invoice migration...');
    console.log(`Database: ${process.env.DB_NAME || '(not set)'}`);

    const hasProforma = await tableExists(conn, 'proforma_invoices');
    if (!hasProforma) {
      throw new Error('Missing required table: proforma_invoices');
    }

    await ensureColumn(conn, 'proforma_invoices', 'tax_invoice_id', 'INT NULL AFTER source_id');
    await ensureColumn(conn, 'proforma_invoices', 'tax_invoice_exists', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER tax_invoice_id');
    await ensureIndex(conn, 'proforma_invoices', 'idx_proforma_tax_invoice_id', 'tax_invoice_id');

    await run(
      conn,
      'Normalize empty tax_invoice_exists values',
      `UPDATE proforma_invoices
          SET tax_invoice_exists = CASE
            WHEN tax_invoice_id IS NULL THEN 0
            ELSE 1
          END
        WHERE tax_invoice_exists IS NULL OR tax_invoice_exists = 0`,
    );

    await backfillFromInvoices(conn);

    const [sample] = await conn.query(
      `SELECT
         COUNT(*) AS total_proformas,
         SUM(CASE WHEN tax_invoice_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_tax_invoices,
         SUM(CASE WHEN tax_invoice_exists = 1 THEN 1 ELSE 0 END) AS marked_tax_invoice_exists
       FROM proforma_invoices`,
    );

    console.log('📊 Result:', sample?.[0] || {});
    console.log('✅ Proforma tax invoice migration completed.');
  } finally {
    conn.release();
    await pool.end();
  }
};

main().catch(async (err) => {
  console.error('❌ Migration failed.');
  console.error(err?.stack || err?.message || err);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
