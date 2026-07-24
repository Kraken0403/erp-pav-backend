const { generatePdfViaBrowserless } = require('../services/quotationPdfBrowserlessService');

const encodeContentDispositionFilename = (filename) => {
  const safeFilename = String(filename || 'quotation.pdf').replace(/[\r\n"]/g, '').trim() || 'quotation.pdf';
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
};


exports.exportPdfBrowserless = async (req, res) => {
    try {
        const quotationId = req.params.id;
        const pdfBuffer = await generatePdfViaBrowserless(quotationId);

        if (!pdfBuffer || pdfBuffer.length === 0) {
            throw new Error('Browserless PDF generation returned empty buffer');
        }

        // Build friendly filename including quotation number + lead name when available
        let filename = `quotation-${quotationId}.pdf`;
        try {
            const { buildPdfFilename } = require('../services/quotationPdfService');
            filename = await buildPdfFilename(quotationId);
            console.log('PDF filename:', filename); 
        } catch (e) {
            // ignore and fallback
             console.error('buildPdfFilename failed:', e.message); 
        }

        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': encodeContentDispositionFilename(filename),
        });

        res.end(pdfBuffer);
    } catch (error) {
        console.error('Browserless PDF export error:', error);

        if (!res.headersSent) {
            res.status(500).send(error.message || 'Failed to generate PDF from browserless');
        }
    }
};
