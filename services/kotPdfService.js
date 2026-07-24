// services/kotPdfService.js
const handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const db = require('../config/db');
const { registerHelpers } = require('./handlebarsHelpers');
const { generatePdfFromHtml } = require('./puppetPdfService');
const { formatDate } = require('../utils/dateFormatter');

// Register handlebars helpers
registerHelpers(handlebars);

const parseLocalDate = (value) => {
  if (!value) return null;

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;

    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const [, y, m, d] = dateOnly;
      const parsed = new Date(Number(y), Number(m) - 1, Number(d));
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const dateTime = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (dateTime) {
      const [, y, m, d, hh, mm, ss = '00'] = dateTime;
      const parsed = new Date(
        Number(y),
        Number(m) - 1,
        Number(d),
        Number(hh),
        Number(mm),
        Number(ss)
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateOnly = (value) => {
  const parsed = parseLocalDate(value);
  if (!parsed) return '';
  return formatDate(parsed);
};

const formatTimeOnly = (value) => {
  if (!value) return '';
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
  if (!match) return raw;

  return new Date(`1970-01-01T${match[1]}:00`).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

const resolveAssetUrl = (url) => {
  if (!url) return '';
  const raw = String(url).trim();
  const baseUrl = (process.env.BACKEND_PUBLIC_URL || process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.pathname.startsWith('/uploads/')) {
        return `${baseUrl}${parsed.pathname}${parsed.search || ''}${parsed.hash || ''}`;
      }
    } catch {
      // keep raw if parse fails
    }
    return raw;
  }

  return `${baseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`;
};

/* ====================================
   GET KOT DATA
==================================== */
async function getKotData(kotId) {
  const [rows] = await db.query(
    `
    SELECT
      k.*,
      wo.work_order_number,
      wo.customer_name,
      wo.notes AS work_order_notes
    FROM kots k
    INNER JOIN work_orders wo ON wo.id = k.work_order_id
    WHERE k.id = ?
    LIMIT 1
    `,
    [kotId]
  );

  if (!rows.length) {
    throw new Error('KOT not found');
  }

  const kot = rows[0];

  // Get items
  const [items] = await db.query(
    `
    SELECT
      id,
      product_id,
      product_name,
      product_description,
      quantity
    FROM kot_items
    WHERE kot_id = ?
    ORDER BY id ASC
    `,
    [kotId]
  );

  kot.items = items;

  // Parse event snapshot
  if (typeof kot.event_snapshot === 'string') {
    try {
      kot.event_snapshot = JSON.parse(kot.event_snapshot);
    } catch (e) {
      kot.event_snapshot = {};
    }
  }

  kot.event_snapshot = kot.event_snapshot || {};
  kot.event_snapshot.formatted_date = formatDateOnly(kot.event_snapshot.date);
  kot.event_snapshot.formatted_time = formatTimeOnly(kot.event_snapshot.time);

  // expose work order notes to template
  kot.work_order_notes = kot.work_order_notes || '';

  return kot;
}

/* ====================================
   GET SETTINGS
==================================== */
async function getSettings() {
  const [quotationRows] = await db.query(
    `SELECT * FROM quotation_settings ORDER BY id DESC LIMIT 1`
  );
  const [mainRows] = await db.query(
    `SELECT company_logo, business_type FROM settings WHERE id = 1 LIMIT 1`
  );

  const quotationSettings = quotationRows[0] || {};
  const mainSettings = mainRows[0] || {};

  const internalLogo = resolveAssetUrl(quotationSettings.logo_url);
  const mainLogo = resolveAssetUrl(mainSettings.company_logo);

  return {
    ...quotationSettings,
    business_type: quotationSettings.business_type || mainSettings.business_type || 'GENERAL',
    logo_url: internalLogo || mainLogo,
  };
}

/* ====================================
   GENERATE KOT PDF
==================================== */
async function generateKotPdf(kotId) {
  // Load KOT data
  const kot = await getKotData(kotId);

  // Load settings
  const settings = await getSettings();

  // Logo already resolved with fallback: internal -> main.
  const showEventDetails = String(settings?.business_type || 'GENERAL').trim().toUpperCase() !== 'GENERAL';

  const pageSizeMode = String(settings.kot_print_page_size || 'SLIP').toUpperCase() === 'A4'
    ? 'A4'
    : 'SLIP';

  // Load template
  const templateName = pageSizeMode === 'A4' ? 'a4.html' : 'default.html';
  const templatePath = path.join(__dirname, '../templates/kots', templateName);
  const templateContent = await fs.readFile(templatePath, 'utf8');
  const template = handlebars.compile(templateContent);

  // Format dates (dd/mm/yyyy hh:mm AM/PM)
  const formatDateTime = (dt) => {
    const date = parseLocalDate(dt);
    if (!date) return '—';
    const dPart = formatDate(date);
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${dPart} ${hours}:${minutes} ${ampm}`;
  };

  const prettyStatus = (status) => {
    return (status || '').replace('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  };

  // Render HTML
  const html = template({
    kot,
    settings,
    showEventDetails,
    today: formatDate(new Date()),
    formatDateTime,
    prettyStatus
  });

  const payloadOverrides = pageSizeMode === 'A4'
    ? {
      format: 'A4',
      printBackground: true,
      margin: {
        top: '12mm',
        right: '10mm',
        bottom: '12mm',
        left: '10mm',
      },
    }
    : {
      width: '80mm',
      // A generous fixed height avoids clipping for slip mode when generated remotely.
      height: process.env.KOT_SLIP_PDF_HEIGHT || '600mm',
      printBackground: true,
      margin: {
        top: '2mm',
        right: '2mm',
        bottom: '2mm',
        left: '2mm',
      },
      preferCSSPageSize: false,
    };

  return generatePdfFromHtml(html, { payloadOverrides });
}

/* ====================================
   PREVIEW HTML
==================================== */
async function previewKotHtml(kotId) {
  const kot = await getKotData(kotId);
  const settings = await getSettings();

  // Logo already resolved with fallback: internal -> main.
  const showEventDetails = String(settings?.business_type || 'GENERAL').trim().toUpperCase() !== 'GENERAL';

  const pageSizeMode = String(settings.kot_print_page_size || 'SLIP').toUpperCase() === 'A4'
    ? 'A4'
    : 'SLIP';

  const templateName = pageSizeMode === 'A4' ? 'a4.html' : 'default.html';
  const templatePath = path.join(__dirname, '../templates/kots', templateName);
  const templateContent = await fs.readFile(templatePath, 'utf8');
  const template = handlebars.compile(templateContent);

  const formatDateTime = (dt) => {
    const date = parseLocalDate(dt);
    if (!date) return '—';
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const prettyStatus = (status) => {
    return (status || '').replace('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  };

  const html = template({
    kot,
    settings,
    showEventDetails,
    today: formatDate(new Date()),
    formatDateTime,
    prettyStatus
  });

  return html;
}

module.exports = {
  generateKotPdf,
  previewKotHtml
};
