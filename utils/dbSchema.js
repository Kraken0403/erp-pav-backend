const columnCache = new Map();

function normalizeTableName(tableName) {
  return String(tableName || '').replace(/[^a-zA-Z0-9_]/g, '');
}

async function getTableColumns(conn, tableName, { refresh = false } = {}) {
  const safeTable = normalizeTableName(tableName);
  if (!safeTable) return new Set();

  const cacheKey = safeTable.toLowerCase();
  if (!refresh && columnCache.has(cacheKey)) {
    return columnCache.get(cacheKey);
  }

  const [rows] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [safeTable]
  );

  const columns = new Set((rows || []).map((row) => String(row.COLUMN_NAME).toLowerCase()));
  columnCache.set(cacheKey, columns);
  return columns;
}

async function columnExists(conn, tableName, columnName) {
  const columns = await getTableColumns(conn, tableName);
  return columns.has(String(columnName || '').toLowerCase());
}

async function addColumnIfMissing(conn, tableName, columnName, definition) {
  const safeTable = normalizeTableName(tableName);
  const safeColumn = normalizeTableName(columnName);

  if (!safeTable || !safeColumn) {
    throw new Error('Invalid table or column name');
  }

  if (await columnExists(conn, safeTable, safeColumn)) {
    return false;
  }

  await conn.query(`ALTER TABLE \`${safeTable}\` ADD COLUMN \`${safeColumn}\` ${definition}`);
  await getTableColumns(conn, safeTable, { refresh: true });
  return true;
}

function buildInsertStatement(tableName, rowData, existingColumns) {
  const safeTable = normalizeTableName(tableName);
  const entries = Object.entries(rowData || {}).filter(([column, value]) => {
    return value !== undefined && existingColumns.has(String(column).toLowerCase());
  });

  if (!entries.length) {
    throw new Error(`No insertable columns supplied for ${safeTable}`);
  }

  const columns = entries.map(([column]) => `\`${normalizeTableName(column)}\``).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  const values = entries.map(([, value]) => value);

  return {
    sql: `INSERT INTO \`${safeTable}\` (${columns}) VALUES (${placeholders})`,
    values,
  };
}

function buildUpdateParts(rowData, existingColumns) {
  const fields = [];
  const values = [];

  Object.entries(rowData || {}).forEach(([column, value]) => {
    if (value === undefined) return;
    if (!existingColumns.has(String(column).toLowerCase())) return;
    fields.push(`\`${normalizeTableName(column)}\` = ?`);
    values.push(value);
  });

  return { fields, values };
}

module.exports = {
  getTableColumns,
  columnExists,
  addColumnIfMissing,
  buildInsertStatement,
  buildUpdateParts,
};
