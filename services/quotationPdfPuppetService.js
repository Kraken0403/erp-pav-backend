const { generateHtml } = require('./quotationPdfService');
const {
    generatePdfFromHtml,
    generatePdfFromPayload,
} = require('./puppetPdfService');

exports.generatePdfViaPuppetApi = async (quotationId) => {
    if (!quotationId) {
        throw new Error('Quotation id is required');
    }

    const html = await generateHtml(quotationId);
    return generatePdfFromHtml(html, {
        payloadOverrides: {
            displayHeaderFooter: false,
            margin: {
                top: '20mm',
                bottom: '20mm',
                right: '15mm',
                left: '15mm',
            },
        },
    });
};

exports.generatePdfViaPuppetApiFromPayload = async (payload) => {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Valid payload is required');
    }

    if (!payload.content || typeof payload.content !== 'string') {
        throw new Error('Payload must include HTML content as a string');
    }

    return generatePdfFromPayload(payload);
};
