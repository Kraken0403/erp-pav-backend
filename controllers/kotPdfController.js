// controllers/kotPdfController.js
const { generateKotPdf, previewKotHtml } = require('../services/kotPdfService');

/* ====================================
   EXPORT PDF
==================================== */
exports.exportPdf = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'KOT ID is required' });
    }

    const pdfBuffer = Buffer.from(await generateKotPdf(id));

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('KOT PDF generation returned empty buffer');
    }

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuffer.length,
      'Content-Disposition': `inline; filename=KOT-${id}.pdf`,
    });

    res.end(pdfBuffer);

  } catch (error) {
    console.error('KOT PDF export error:', error);
    return res.status(500).json({
      error: 'Failed to generate KOT PDF',
      details: error.message
    });
  }
};

/* ====================================
   PREVIEW HTML
==================================== */
exports.previewHtml = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'KOT ID is required' });
    }

    const html = await previewKotHtml(id);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('KOT HTML preview error:', error);
    return res.status(500).json({
      error: 'Failed to preview KOT HTML',
      details: error.message
    });
  }
};
