const { generateHtml } = require('./quotationPdfService');
const { generatePdfFromHtml } = require('./puppetPdfService');

exports.generatePdfViaBrowserless = async (quotationId) => {
    const html = await generateHtml(quotationId);

    return generatePdfFromHtml(html, {
        payloadOverrides: {
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: false,
            margin: {
                top: '20mm',
                bottom: '28mm',
                left: '15mm',
                right: '15mm',
            },
        },
    });
};
