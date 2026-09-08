const { generatePdf } = require('./quotationPdfService');

exports.generatePdfViaBrowserless = async (quotationId) => {
    if (!quotationId) {
        throw new Error('Quotation id is required');
    }

    // Keep this compatibility endpoint on the exact same quotation builder
    // renderer/options as every other quotation PDF path.
    return generatePdf(quotationId);
};
