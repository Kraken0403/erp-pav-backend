const handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const db = require('../config/db');
const { generatePdfFromHtml } = require('./puppetPdfService');
const { formatDate } = require('../utils/dateFormatter');

// Register Handlebars helpers
const { registerHelpers } = require('./handlebarsHelpers');
registerHelpers(handlebars);

const loadLogoBase64 = async (logoUrl) => {
  if (!logoUrl) return '';

  let resolvedPath = '';

  if (logoUrl.startsWith('http://') || logoUrl.startsWith('https://')) {
    try {
      const parsed = new URL(logoUrl);
      const normalized = parsed.pathname.replace(/^\/+/, '');
      resolvedPath = path.join(__dirname, '..', normalized);
    } catch (err) {
      resolvedPath = '';
    }
  } else if (logoUrl.startsWith('/')) {
    resolvedPath = path.join(__dirname, '..', logoUrl.replace(/^\/+/, ''));
  } else {
    resolvedPath = path.isAbsolute(logoUrl)
      ? logoUrl
      : path.join(__dirname, '..', logoUrl);
  }

  if (!resolvedPath) return '';

  try {
    const logoBuffer = await fs.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${logoBuffer.toString('base64')}`;
  } catch (err) {
    console.warn('Logo not found:', err.message);
    return '';
  }
};

/**
 * Generate PDF for any report type
 */
exports.generateReportPdf = async (reportType, data, summary) => {
  try {
    // Prefer internal/module logo; fallback to main company logo.
    const [qSettingsRows] = await db.query('SELECT logo_url FROM quotation_settings LIMIT 1');
    const [globalSettingsRows] = await db.query('SELECT business_type, company_logo FROM settings LIMIT 1');

    const preferredLogo = qSettingsRows[0]?.logo_url || globalSettingsRows[0]?.company_logo || '';
    const logoBase64 = await loadLogoBase64(preferredLogo);
    const businessType = globalSettingsRows[0]?.business_type || 'GENERAL';

    // Load template
    const templatePath = path.join(__dirname, '..', 'templates', 'reports', `${reportType}.html`);
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    // Compile template
    const template = handlebars.compile(templateContent);

    // Prepare data
    const templateData = {
      logo: logoBase64,
      data: data,
      summary: summary,
      showEventDetails: String(businessType || 'GENERAL').trim().toUpperCase() !== 'GENERAL',
      generatedDate: formatDate(new Date()),
      generatedTime: new Date().toLocaleTimeString('en-IN')
    };

    const html = template(templateData);

    return generatePdfFromHtml(html, {
      payloadOverrides: {
        format: 'A4',
        margin: {
          top: '20mm',
          right: '15mm',
          bottom: '20mm',
          left: '15mm'
        },
        printBackground: true,
      },
    });
  } catch (error) {
    console.error('Error generating report PDF:', error);
    throw error;
  }
};

/**
 * Preview HTML for report
 */
exports.previewReportHtml = async (reportType, data, summary) => {
  try {
    // Prefer internal/module logo; fallback to main company logo.
    const [qSettingsRows] = await db.query('SELECT logo_url FROM quotation_settings LIMIT 1');
    const [globalSettingsRows] = await db.query('SELECT business_type, company_logo FROM settings LIMIT 1');

    const preferredLogo = qSettingsRows[0]?.logo_url || globalSettingsRows[0]?.company_logo || '';
    const logoBase64 = await loadLogoBase64(preferredLogo);
    const businessType = globalSettingsRows[0]?.business_type || 'GENERAL';

    // Load template
    const templatePath = path.join(__dirname, '..', 'templates', 'reports', `${reportType}.html`);
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    // Compile template
    const template = handlebars.compile(templateContent);

    // Prepare data
    const templateData = {
      logo: logoBase64,
      data: data,
      summary: summary,
      showEventDetails: String(businessType || 'GENERAL').trim().toUpperCase() !== 'GENERAL',
      generatedDate: formatDate(new Date()),
      generatedTime: new Date().toLocaleTimeString('en-IN')
    };

    return template(templateData);
  } catch (error) {
    console.error('Error generating report HTML:', error);
    throw error;
  }
};
