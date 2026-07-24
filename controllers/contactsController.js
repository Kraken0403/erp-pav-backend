const db = require('../config/db');

const createContact = (req, res) => {
  const { first_name, last_name, email, phone, address, company_id } = req.body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'First and Last name are required.' });
  }

  const safeCompanyId = company_id || null;

  const query = `
    INSERT INTO contacts (first_name, last_name, email, phone, address, company_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.query(query, [first_name, last_name, email, phone, address, safeCompanyId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to create contact', details: err.message });
    }
    res.status(201).json({
      message: 'Contact created successfully',
      contactId: result.insertId
    });
  });
};
const getContacts = (req, res) => {
  const query = `
    SELECT c.*, co.name AS company_name 
    FROM contacts c
    LEFT JOIN companies co ON c.company_id = co.id
  `;
  db.query(query, (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch contacts', details: err.message });
    }
    res.status(200).json(results);
  });
};

const getContactById = (req, res) => {
  const query = `
    SELECT c.*, co.name AS company_name 
    FROM contacts c
    LEFT JOIN companies co ON c.company_id = co.id
    WHERE c.id = ?
  `;
  db.query(query, [req.params.id], (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch contact', details: err.message });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.status(200).json(results[0]);
  });
};

const updateContact = (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, email, phone, address, company_id } = req.body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'First and Last name are required.' });
  }

  const query = `
    UPDATE contacts
    SET first_name = ?, last_name = ?, email = ?, phone = ?, address = ?, company_id = ?
    WHERE id = ?
  `;

  db.query(query, [first_name, last_name, email, phone, address, company_id, id], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to update contact', details: err.message });
    }
    res.status(200).json({ message: 'Contact updated successfully.' });
  });
};

const deleteContact = (req, res) => {
  const query = 'DELETE FROM contacts WHERE id = ?';
  db.query(query, [req.params.id], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete contact', details: err.message });
    }
    res.status(200).json({ message: 'Contact deleted successfully.' });
  });
};

module.exports = {
  createContact,
  getContacts,
  getContactById,
  updateContact,
  deleteContact,
};
