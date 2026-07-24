const db = require('../config/db');

/* =====================================================
   CREATE COMPANY
===================================================== */
const createCompany = async (req, res) => {
  try {
    const { name, gst_number, pan_number, email, phone, website, address } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Company name is required.' });
    }

    const [result] = await db.query(
      `
      INSERT INTO companies 
      (name, gst_number, pan_number, email, phone, website, address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [name, gst_number, pan_number, email, phone, website, address]
    );

    res.status(201).json({
      message: 'Company created successfully',
      companyId: result.insertId,
    });

  } catch (err) {
    console.error('CREATE COMPANY ERROR:', err);
    res.status(500).json({
      error: 'Failed to create company',
      details: err.message,
    });
  }
};


/* =====================================================
   GET ALL COMPANIES
===================================================== */
const getCompanies = async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM companies');

    res.status(200).json(results);

  } catch (err) {
    console.error('GET COMPANIES ERROR:', err);
    res.status(500).json({
      error: 'Failed to fetch companies',
      details: err.message,
    });
  }
};


/* =====================================================
   GET COMPANY BY ID
===================================================== */
const getCompanyById = async (req, res) => {
  try {
    const { id } = req.params;

    const [results] = await db.query(
      'SELECT * FROM companies WHERE id = ?',
      [id]
    );

    if (!results.length) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.status(200).json(results[0]);

  } catch (err) {
    console.error('GET COMPANY ERROR:', err);
    res.status(500).json({
      error: 'Failed to fetch company',
      details: err.message,
    });
  }
};


/* =====================================================
   UPDATE COMPANY
===================================================== */
const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, gst_number, pan_number, email, phone, website, address } = req.body;

    const [result] = await db.query(
      `
      UPDATE companies 
      SET name = ?, 
          gst_number = ?, 
          pan_number = ?, 
          email = ?, 
          phone = ?, 
          website = ?, 
          address = ?
      WHERE id = ?
      `,
      [name, gst_number, pan_number, email, phone, website, address, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.status(200).json({ message: 'Company updated successfully.' });

  } catch (err) {
    console.error('UPDATE COMPANY ERROR:', err);
    res.status(500).json({
      error: 'Failed to update company',
      details: err.message,
    });
  }
};


/* =====================================================
   DELETE COMPANY
===================================================== */
const deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      'DELETE FROM companies WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.status(200).json({ message: 'Company deleted successfully.' });

  } catch (err) {
    console.error('DELETE COMPANY ERROR:', err);
    res.status(500).json({
      error: 'Failed to delete company',
      details: err.message,
    });
  }
};


module.exports = {
  createCompany,
  getCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
};
