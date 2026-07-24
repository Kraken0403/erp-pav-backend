const db = require('../config/db');
const { addColumnIfMissing, getTableColumns } = require('../utils/dbSchema');

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows?.[0]?.count || 0) > 0;
}

async function ensureColumn(conn, tableName, columnName, definition) {
  if (!(await tableExists(conn, tableName))) {
    console.log(`⏭️  Skipped ${tableName}.${columnName} because table does not exist`);
    return;
  }

  const added = await addColumnIfMissing(conn, tableName, columnName, definition);
  console.log(`${added ? '✅ Added' : '✓ Exists'} ${tableName}.${columnName}`);
}

async function backfillEventCompatibility(conn, tableName) {
  if (!(await tableExists(conn, tableName))) return;

  const columns = await getTableColumns(conn, tableName, { refresh: true });

  if (columns.has('event_start_date') && columns.has('event_date')) {
    await conn.query(
      `UPDATE ${tableName}
       SET event_start_date = event_date
       WHERE event_start_date IS NULL
         AND event_date IS NOT NULL`
    );
    console.log(`↪ Backfilled ${tableName}.event_start_date from legacy event_date where needed`);
  }

  if (columns.has('event_start_time') && columns.has('event_time')) {
    await conn.query(
      `UPDATE ${tableName}
       SET event_start_time = event_time
       WHERE event_start_time IS NULL
         AND event_time IS NOT NULL`
    );
    console.log(`↪ Backfilled ${tableName}.event_start_time from legacy event_time where needed`);
  }
}

async function main() {
  const conn = await db.getConnection();

  try {
    const [[dbInfo]] = await conn.query('SELECT DATABASE() AS dbName');
    console.log('🚀 Applying Pavilion ERP hotfix schema migration...');
    console.log(`Database: ${dbInfo?.dbName || '(unknown)'}`);

    await ensureColumn(conn, 'quotations', 'rounding_amount', 'DECIMAL(13,2) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'invoices', 'rounding_amount', 'DECIMAL(13,2) NOT NULL DEFAULT 0');
    await ensureColumn(conn, 'proforma_invoices', 'rounding_amount', 'DECIMAL(13,2) NOT NULL DEFAULT 0');

    // Nullable catering fields. GENERAL quotations do not require these, but keeping
    // them available preserves catering/hybrid compatibility without breaking Pavilion.
    await ensureColumn(conn, 'quotations', 'event_start_date', 'DATE DEFAULT NULL');
    await ensureColumn(conn, 'quotations', 'event_start_time', 'TIME DEFAULT NULL');
    await ensureColumn(conn, 'quotations', 'event_end_date', 'DATE DEFAULT NULL');
    await ensureColumn(conn, 'quotations', 'event_end_time', 'TIME DEFAULT NULL');

    await ensureColumn(conn, 'leads', 'event_start_date', 'DATE DEFAULT NULL');
    await ensureColumn(conn, 'leads', 'event_start_time', 'TIME DEFAULT NULL');
    await ensureColumn(conn, 'leads', 'event_end_date', 'DATE DEFAULT NULL');
    await ensureColumn(conn, 'leads', 'event_end_time', 'TIME DEFAULT NULL');

    await backfillEventCompatibility(conn, 'quotations');
    await backfillEventCompatibility(conn, 'leads');

    await ensureColumn(conn, 'quotation_settings', 'logo_url', 'TEXT NULL');

    console.log('🎉 Pavilion ERP hotfix schema migration completed.');
  } catch (error) {
    console.error('❌ Migration failed.');
    console.error(error);
    process.exitCode = 1;
  } finally {
    conn.release();
    await db.end();
  }
}

main();
