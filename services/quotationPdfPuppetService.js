const { generatePdf } = require('./quotationPdfService');
const { generatePdfFromPayload } = require('./puppetPdfService');

exports.generatePdfViaPuppetApi = async (quotationId) => {
    if (!quotationId) {
        throw new Error('Quotation id is required');
    }

    // Use the same quotation builder renderer and PDF options as the primary
    // quotation PDF endpoint. No independent margins/header/footer live here.
    return generatePdf(quotationId);
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
