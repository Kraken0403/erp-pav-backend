const {
    generatePdfViaPuppetApi,
    generatePdfViaPuppetApiFromPayload,
} = require('../services/quotationPdfPuppetService');

const encodeContentDispositionFilename = (filename) => {
  const safeFilename = String(filename || 'quotation.pdf').replace(/[\r\n"]/g, '').trim() || 'quotation.pdf';
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
};


exports.exportPdfPuppet = async (req, res) => {
    try {
        const quotationId = req.params.id;
        const pdfBuffer = await generatePdfViaPuppetApi(quotationId);

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
        console.error('Puppet API PDF export error:', error?.response?.data || error.message || error);

        if (!res.headersSent) {
            res.status(500).send(error.message || 'Failed to generate PDF via puppet API');
        }
    }
};

exports.exportPdfPuppetFromHtml = async (req, res) => {
    try {
        const payload = req.body;
        const pdfBuffer = await generatePdfViaPuppetApiFromPayload(payload);

        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': 'inline; filename=quotation-html.pdf',
        });

        res.end(pdfBuffer);
    } catch (error) {
        console.error('Puppet API HTML PDF export error:', error?.response?.data || error.message || error);

        if (!res.headersSent) {
            res.status(500).send(error.message || 'Failed to generate PDF via puppet API HTML payload');
        }
    }
};
