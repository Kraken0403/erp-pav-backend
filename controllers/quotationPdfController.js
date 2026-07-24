const {
  generatePdf,
  generateHtml,
} = require('../services/quotationPdfService')

const encodeContentDispositionFilename = (filename) => {
  const safeFilename = String(filename || 'quotation.pdf').replace(/[\r\n"]/g, '').trim() || 'quotation.pdf';
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
};


exports.exportPdf = async (req, res) => {
  try {
    const quotationId = req.params.id

    const pdfBuffer = await generatePdf(quotationId)

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('PDF generation returned empty buffer')
    }

    // Build a friendly filename that includes quotation number + lead name when possible
    let filename = `quotation-${quotationId}.pdf`;
    try {
      const { buildPdfFilename } = require('../services/quotationPdfService');
      filename = await buildPdfFilename(quotationId);
      console.log('PDF filename:', filename); 
    } catch (e) {
      // fallback to default filename
       console.error('buildPdfFilename failed:', e.message); 
    }

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuffer.length,
      'Content-Disposition': encodeContentDispositionFilename(filename),
    })

    res.end(pdfBuffer)
  } catch (error) {
    console.error('PDF export error:', error)

    if (!res.headersSent) {
      res.status(500).send(error.message)
    }
  }
}

exports.previewHtml = async (req, res) => {
  try {
    const html = await generateHtml(req.params.id)
    res.setHeader('Content-Type', 'text/html')
    res.send(html)
  } catch (error) {
    console.error('PDF preview error:', error)
    res.status(500).send(error.message)
  }
}
