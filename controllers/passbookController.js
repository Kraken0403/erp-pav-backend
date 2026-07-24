const db = require('../config/db');
const { ensurePassbookSchema } = require('../utils/pavilionSchema');

const formatDateForSql = (value) => {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

exports.listAccounts = async (req, res) => {
  try {
    await ensurePassbookSchema(db);
    const [accounts] = await db.query(
      `SELECT a.*,
              a.starting_balance
              + COALESCE(SUM(CASE WHEN e.type = 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS current_balance
       FROM passbook_accounts a
       LEFT JOIN passbook_entries e ON e.account_id = a.id
       WHERE a.is_active = 1
       GROUP BY a.id
       ORDER BY a.created_at ASC`
    );
    return res.json({ data: accounts });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch passbook accounts', details: err.message });
  }
};

exports.createAccount = async (req, res) => {
  try {
    await ensurePassbookSchema(db);
    const accountName = String(req.body.account_name || '').trim();
    if (!accountName) return res.status(400).json({ error: 'Account name is required' });

    const [result] = await db.query(
      `INSERT INTO passbook_accounts (account_name, starting_balance, currency_code, notes, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [accountName, Number(req.body.starting_balance || 0), req.body.currency_code || 'INR', req.body.notes || null, req.user?.id || null]
    );

    const [[account]] = await db.query(`SELECT * FROM passbook_accounts WHERE id = ?`, [result.insertId]);
    return res.status(201).json({ message: 'Passbook account created successfully', data: account });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create passbook account', details: err.message });
  }
};

const buildEntryWhere = (query = {}, alias = 'e') => {
  const values = [];
  let where = '1=1';
  const accountId = Number(query.account_id || 0);
  const type = String(query.type || '').trim().toUpperCase();
  const exactDate = String(query.date || '').trim();
  const startDate = String(query.start_date || query.startDate || '').trim();
  const endDate = String(query.end_date || query.endDate || '').trim();
  const q = String(query.q || query.search || '').trim();

  if (accountId) { where += ` AND ${alias}.account_id = ?`; values.push(accountId); }
  if (['CREDIT', 'DEBIT'].includes(type)) { where += ` AND ${alias}.type = ?`; values.push(type); }
  if (exactDate) { where += ` AND ${alias}.entry_date = ?`; values.push(formatDateForSql(exactDate)); }
  if (startDate) { where += ` AND ${alias}.entry_date >= ?`; values.push(formatDateForSql(startDate)); }
  if (endDate) { where += ` AND ${alias}.entry_date <= ?`; values.push(formatDateForSql(endDate)); }
  if (q) {
    where += ` AND (LOWER(COALESCE(${alias}.category, '')) LIKE ? OR LOWER(COALESCE(${alias}.party_name, '')) LIKE ? OR LOWER(COALESCE(${alias}.notes, '')) LIKE ?)`;
    const like = `%${q.toLowerCase()}%`;
    values.push(like, like, like);
  }

  return { where, values, accountId };
};

exports.listEntries = async (req, res) => {
  try {
    await ensurePassbookSchema(db);
    const { where, values } = buildEntryWhere(req.query, 'e');

    const [entries] = await db.query(
      `SELECT e.*, a.account_name
       FROM passbook_entries e
       JOIN passbook_accounts a ON a.id = e.account_id
       WHERE ${where}
       ORDER BY e.entry_date DESC, e.id DESC`,
      values
    );
    return res.json({ data: entries });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch passbook entries', details: err.message });
  }
};

exports.createEntry = async (req, res) => {
  try {
    await ensurePassbookSchema(db);
    const accountId = Number(req.body.account_id || 0);
    const type = String(req.body.type || '').toUpperCase();
    const amount = Number(req.body.amount || 0);

    if (!accountId || !['CREDIT', 'DEBIT'].includes(type) || amount <= 0) {
      return res.status(400).json({ error: 'Account, type, and valid amount are required' });
    }

    const [result] = await db.query(
      `INSERT INTO passbook_entries (account_id, entry_date, type, category, party_type, party_id, party_name, reference_type, reference_id, amount, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, formatDateForSql(req.body.entry_date), type, req.body.category || null, req.body.party_type || null, req.body.party_id || null, req.body.party_name || null, req.body.reference_type || null, req.body.reference_id || null, amount, req.body.notes || null, req.user?.id || null]
    );

    const [[entry]] = await db.query(`SELECT * FROM passbook_entries WHERE id = ?`, [result.insertId]);
    return res.status(201).json({ message: 'Passbook entry added successfully', data: entry });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create passbook entry', details: err.message });
  }
};

exports.getSummary = async (req, res) => {
  try {
    await ensurePassbookSchema(db);
    const accountId = Number(req.query.account_id || 0);
    const accountValues = [];
    let accountWhere = '1=1';
    if (accountId) { accountWhere += ' AND a.id = ?'; accountValues.push(accountId); }

    const { where: creditWhere, values: creditValues } = buildEntryWhere({ ...req.query, type: 'CREDIT' }, 'e');
    const { where: debitWhere, values: debitValues } = buildEntryWhere({ ...req.query, type: 'DEBIT' }, 'e');

    const [[summary]] = await db.query(
      `SELECT
          COALESCE(SUM(a.starting_balance), 0) AS starting_balance,
          COALESCE((SELECT SUM(e.amount) FROM passbook_entries e WHERE ${creditWhere}), 0) AS total_credit,
          COALESCE((SELECT SUM(e.amount) FROM passbook_entries e WHERE ${debitWhere}), 0) AS total_debit
       FROM passbook_accounts a
       WHERE ${accountWhere}`,
      [...creditValues, ...debitValues, ...accountValues]
    );

    const result = summary || {};
    result.current_balance = Number(result.starting_balance || 0) + Number(result.total_credit || 0) - Number(result.total_debit || 0);
    return res.json({ data: result });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch passbook summary', details: err.message });
  }
};
