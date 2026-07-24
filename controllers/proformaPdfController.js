// controllers/proformaPdfController.js
const db = require('../config/db')
// You will need to implement generateProformaPdf and generateProformaHtml in your PDF service
const { generateProformaPdf, generateProformaHtml } = require('../services/invoicePdfService')

const getProformaFilename = async (id) => {
  const [rows] = await db.query(
    `SELECT proforma_number FROM proforma_invoices WHERE id = ? LIMIT 1`,
    [id]
  )
  const proforma = rows?.[0] || null
  return proforma ? `Proforma-Invoice-${proforma.proforma_number || id}.pdf` : `proforma-invoice-${id}.pdf`
}

const downloadProformaPdf = async (req, res) => {
  const { id } = req.params
  try {
    const pdfBuffer = await generateProformaPdf(id)
    const filename = await getProformaFilename(id)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send(pdfBuffer)
  } catch (err) {
    console.error('downloadProformaPdf error:', err)
    return res.status(500).json({ error: err.message })
  }
}

const previewProformaHtml = async (req, res) => {
  const { id } = req.params
  try {
    const html = await generateProformaHtml(id)
    res.setHeader('Content-Type', 'text/html')
    return res.send(html)
  } catch (err) {
    console.error('previewProformaHtml error:', err)
    return res.status(500).json({ error: err.message })
  }
}

module.exports = {
  downloadProformaPdf,
  previewProformaHtml,
}
