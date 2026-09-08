const db = require('../config/db');

const EXPECTED_TYPES = ['call', 'email', 'meeting', 'task', 'note', 'deadline'];

const main = async () => {
  try {
    const [[databaseRow]] = await db.query('SELECT DATABASE() AS database_name');
    const databaseName = databaseRow?.database_name;

    if (!databaseName) throw new Error('No database is selected. Check DB_NAME in backend/.env.');

    const [[column]] = await db.query(
      `SELECT COLUMN_TYPE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'activities'
         AND COLUMN_NAME = 'type'
       LIMIT 1`,
    );

    if (!column) throw new Error(`Table ${databaseName}.activities or column activities.type does not exist.`);

    const missingTypes = EXPECTED_TYPES.filter((type) => !String(column.COLUMN_TYPE || '').includes(`'${type}'`));
    if (!missingTypes.length) {
      console.log(`Activity type migration already applied on ${databaseName}.`);
      return;
    }

    console.log(`Applying activity type migration on ${databaseName}...`);
    await db.query(
      `ALTER TABLE activities
       MODIFY COLUMN type ENUM('call','email','meeting','task','note','deadline') NOT NULL`,
    );

    const [[updatedColumn]] = await db.query(
      `SELECT COLUMN_TYPE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'activities'
         AND COLUMN_NAME = 'type'
       LIMIT 1`,
    );

    console.log(`Done. activities.type is now ${updatedColumn?.COLUMN_TYPE || 'updated'}.`);
  } finally {
    await db.end();
  }
};

main().catch((error) => {
  console.error('Activity type migration failed:', error.message);
  process.exitCode = 1;
});
