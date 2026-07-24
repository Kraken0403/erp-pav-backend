const XLSX = require('xlsx');
const fs = require('fs');
const db = require('../config/db');

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const splitFullName = (fullName = '') => {
  const cleaned = String(fullName).trim().replace(/\s+/g, ' ');
  if (!cleaned) return { firstName: null, lastName: null };
  const [firstName, ...rest] = cleaned.split(' ');
  return { firstName: firstName || null, lastName: rest.length ? rest.join(' ') : null };
};

const normalizeDateTime = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(raw)) return raw.replace('T', ' ') + ':00';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)) return raw.replace('T', ' ');
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  const seconds = String(parsed.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const bulkImportLeads = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV / Excel file required' });

  const workbook = XLSX.readFile(req.file.path);
  const sheetName = workbook.SheetNames.includes('Leads') ? 'Leads' : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return res.status(400).json({ error: 'No readable sheet found in file' });

  const rows = XLSX.utils.sheet_to_json(sheet);
  const result = { total: rows.length, success: 0, failed: 0, errors: [] };

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // detect available columns in leads table
    const [colRows] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'"
    );
    const actualCols = new Set((colRows || []).map(r => String(r.COLUMN_NAME).toLowerCase()));

    const desiredOrder = [
      'first_name','last_name','company_name','lead_status','email','phone_number',
      'gst_number','contact_name','follow_up_date','priority','assigned_salesperson',
      'hotness','amount','notes','created_by',
      'shipping_address','shipping_landmark','shipping_city','shipping_state','shipping_pincode',
      'billing_address','billing_landmark','billing_city','billing_state','billing_pincode',
      'source','event_type','event_date','event_time','event_start_date','event_start_time','event_end_date','event_end_time',
      'event_location','pax','product_id','product_name'
    ];

    const columns = desiredOrder.filter(c => actualCols.has(c));

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      try {
        // normalize row keys (case-insensitive)
        const row = {};
        for (const k of Object.keys(raw)) row[String(k).trim().toLowerCase()] = raw[k];

        const name = row.name || '';
        const { firstName, lastName } = splitFullName(name);
        const finalFirstName = hasValue(row.first_name) ? row.first_name : firstName;
        const finalLastName = hasValue(row.last_name) ? row.last_name : lastName;

        const paramMap = {
          first_name: finalFirstName,
          last_name: finalLastName,
          company_name: row.company_name || null,
          lead_status: row.lead_status || 'New',
          email: row.email || null,
          phone_number: row.phone_number || row.phone || null,
          gst_number: row.gst_number || null,
          contact_name: row.contact_name || (name || null),
          follow_up_date: normalizeDateTime(row.follow_up_date || row.followup_date),
          priority: row.priority || null,
          assigned_salesperson: row.assigned_salesperson || null,
          hotness: row.hotness || null,
          amount: row.amount || null,
          notes: row.notes || null,
          created_by: (req.user && req.user.username) || 'bulk-import',
          shipping_address: row.shipping_address || null,
          shipping_landmark: row.shipping_landmark || null,
          shipping_city: row.shipping_city || null,
          shipping_state: row.shipping_state || null,
          shipping_pincode: row.shipping_pincode || null,
          billing_address: row.billing_address || null,
          billing_landmark: row.billing_landmark || null,
          billing_city: row.billing_city || null,
          billing_state: row.billing_state || null,
          billing_pincode: row.billing_pincode || null,
          source: row.source || 'bulk-import',
          event_type: row.event_type || null,
          event_date: normalizeDateTime(row.event_date),
          event_time: row.event_time || null,
          event_start_date: normalizeDateTime(row.event_start_date || row.eventdate),
          event_start_time: row.event_start_time || null,
          event_end_date: normalizeDateTime(row.event_end_date),
          event_end_time: row.event_end_time || null,
          event_location: row.event_location || null,
          pax: row.pax || null,
          product_id: row.product_id ? Number(row.product_id) : null,
          product_name: row.product_name || null
        };

        const insertParams = columns.map(c => paramMap[c] !== undefined ? paramMap[c] : null);
        const placeholders = Array(columns.length).fill('?').join(', ');
        const builtSql = `INSERT INTO leads (${columns.join(', ')}) VALUES (${placeholders})`;

        await connection.query(builtSql, insertParams);
        result.success++;
      } catch (err) {
        result.failed++;
        result.errors.push({ row: i + 2, error: err.message });
      }
    }

    await connection.commit();
    connection.release();
    fs.unlinkSync(req.file.path);

    return res.json(result);
  } catch (err) {
    if (connection) await connection.rollback();
    if (connection) connection.release();
    try { fs.unlinkSync(req.file.path); } catch (e) { }
    console.error('LEADS BULK IMPORT ERROR:', err);
    return res.status(500).json({ error: 'Bulk import failed', details: err.message });
  }
};

module.exports = { bulkImportLeads };
