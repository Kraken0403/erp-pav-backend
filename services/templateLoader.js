const { renderQuotationDocument } = require('./quotationTemplateRenderer');

// Compatibility entry point for quotation rendering.
// Legacy HTML files under templates/quotations are intentionally no longer read.
// Every quotation preview, public view and PDF now renders from the single
// quotation builder configuration stored in quotation_settings.template_config_json.
exports.loadTemplate = (data) => renderQuotationDocument(data);
