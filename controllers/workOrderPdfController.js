const {
    generatePdf,
    generateHtml,
  } = require('../services/workOrderPdfService')
  
  exports.exportPdf = async (req, res) => {
    try {
      const workOrderId = req.params.id
  
      const pdfBuffer = await generatePdf(workOrderId)
  
      if (!pdfBuffer || !pdfBuffer.length) {
        throw new Error('Empty PDF buffer')
      }
  
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdfBuffer.length,
        'Content-Disposition': `inline; filename=work-order-${workOrderId}.pdf`,
      })
  
      res.end(pdfBuffer)
    } catch (err) {
      console.error('WorkOrder PDF error:', err)
      if (!res.headersSent) {
        res.status(500).send(err.message)
      }
    }
  }
  
  exports.previewHtml = async (req, res) => {
    try {
      const html = await generateHtml(req.params.id)
      res.setHeader('Content-Type', 'text/html')
      res.send(html)
    } catch (err) {
      console.error('WorkOrder preview error:', err)
      res.status(500).send(err.message)
    }
  }
  