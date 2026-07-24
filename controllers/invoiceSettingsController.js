const db = require('../config/db')

/* ---------------------------------------------------------
   GET INVOICE SETTINGS
--------------------------------------------------------- */
exports.getInvoiceSettings = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM invoice_settings LIMIT 1`
    )

    if (!rows.length) {
      return res.status(200).json({
        prefix: 'INV',
        sequence_start: 1,
        number_format: '{prefix}/{year}/{seq}',
        numbering_mode: 'continuous',
        layout_option: 'minimal',
        proforma_prefix: 'PI',
        proforma_number_format: '{prefix}/{year}/{seq}',
        proforma_sequence_start: 1,
        proforma_numbering_mode: 'continuous',
        receipt_prefix: 'REC',
        receipt_number_format: '{prefix}/{year}/{seq}',
        receipt_sequence_start: 1,
        receipt_numbering_mode: 'continuous',
        cover_letter_html: '',
        terms_conditions_html: '',
        footer_notes_html: '',
      })
    }

    return res.status(200).json(rows[0])
  } catch (err) {
    console.error('getInvoiceSettings error:', err)
    return res.status(500).json({ error: err.message })
  }
}

/* ---------------------------------------------------------
   SAVE INVOICE SETTINGS
--------------------------------------------------------- */
exports.saveInvoiceSettings = async (req, res) => {
  const {
    prefix,
    sequence_start,
    number_format,
    numbering_mode,
    layout_option,
    proforma_prefix,
    proforma_number_format,
    proforma_sequence_start,
    proforma_numbering_mode,
    receipt_prefix,
    receipt_number_format,
    receipt_sequence_start,
    receipt_numbering_mode,
    cover_letter_html,
    terms_conditions_html,
    footer_notes_html,
  } = req.body

  try {
    const [existing] = await db.query(
      `SELECT id FROM invoice_settings LIMIT 1`
    )

    if (existing.length) {
      await db.query(
        `
        UPDATE invoice_settings
        SET
          prefix = ?,
          sequence_start = ?,
          number_format = ?,
          numbering_mode = ?,
          layout_option = ?,
          proforma_prefix = ?,
          proforma_number_format = ?,
          proforma_sequence_start = ?,
          proforma_numbering_mode = ?,
          receipt_prefix = ?,
          receipt_number_format = ?,
          receipt_sequence_start = ?,
          receipt_numbering_mode = ?,
          cover_letter_html = ?,
          terms_conditions_html = ?,
          footer_notes_html = ?
        WHERE id = ?
        `,
        [
          prefix,
          sequence_start,
          number_format,
          numbering_mode,
          layout_option,
          proforma_prefix || 'PI',
          proforma_number_format || '{prefix}/{year}/{seq}',
          proforma_sequence_start || 1,
          proforma_numbering_mode || 'continuous',
          receipt_prefix || 'REC',
          receipt_number_format || '{prefix}/{year}/{seq}',
          receipt_sequence_start || 1,
          receipt_numbering_mode || 'continuous',
          cover_letter_html || '',
          terms_conditions_html,
          footer_notes_html,
          existing[0].id,
        ]
      )
    } else {
      await db.query(
        `
        INSERT INTO invoice_settings
        (
          prefix,
          sequence_start,
          number_format,
          numbering_mode,
          layout_option,
          proforma_prefix,
          proforma_number_format,
          proforma_sequence_start,
          proforma_numbering_mode,
          receipt_prefix,
          receipt_number_format,
          receipt_sequence_start,
          receipt_numbering_mode,
          cover_letter_html,
          terms_conditions_html,
          footer_notes_html
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          prefix,
          sequence_start,
          number_format,
          numbering_mode,
          layout_option,
          proforma_prefix || 'PI',
          proforma_number_format || '{prefix}/{year}/{seq}',
          proforma_sequence_start || 1,
          proforma_numbering_mode || 'continuous',
          receipt_prefix || 'REC',
          receipt_number_format || '{prefix}/{year}/{seq}',
          receipt_sequence_start || 1,
          receipt_numbering_mode || 'continuous',
          cover_letter_html || '',
          terms_conditions_html,
          footer_notes_html,
        ]
      )
    }

    return res.status(200).json({
      message: 'Invoice settings saved successfully',
    })
  } catch (err) {
    console.error('saveInvoiceSettings error:', err)
    return res.status(500).json({ error: err.message })
  }
}
