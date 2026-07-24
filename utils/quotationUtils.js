// utils/quotationUtils.js
async function getRootQuotationId(conn, quotationId) {
  let currentId = quotationId;

  while (true) {
    const [rows] = await conn.query(
      `SELECT id, parent_id FROM quotations WHERE id = ?`,
      [currentId]
    );

    const row = rows[0];

    if (!row) {
      throw new Error('Quotation not found');
    }

    if (!row.parent_id) {
      return row.id;
    }

    currentId = row.parent_id;
  }
}

module.exports = { getRootQuotationId };
