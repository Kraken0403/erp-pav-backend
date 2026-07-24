const db = require('../config/db');
const { loadWorkOrderTemplate } = require('./workOrderTemplateLoader');
const { generatePdfFromHtml } = require('./puppetPdfService');
const { formatDate: formatDateUtil } = require('../utils/dateFormatter');

/* =========================================================
   PUBLIC API
========================================================= */

exports.generatePdf = async (workOrderId) => {
  const data = await loadWorkOrderData(workOrderId);
  const html = loadWorkOrderTemplate(data);

  return generatePdfFromHtml(html, {
    payloadOverrides: {
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '15mm',
        right: '15mm',
      },
    },
  });
};

exports.generateHtml = async (workOrderId) => {
  const data = await loadWorkOrderData(workOrderId);
  return loadWorkOrderTemplate(data);
};


/* =========================================================
   INTERNAL LOGIC
========================================================= */

async function loadWorkOrderData(workOrderId) {

  /* ---------- FORMATTERS ---------- */
  const parseLocalDate = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;

      const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateOnly) {
        const [, y, m, d] = dateOnly;
        const parsed = new Date(Number(y), Number(m) - 1, Number(d));
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const formatDate = (date) => {
    const parsed = parseLocalDate(date);
    if (!parsed) return '';
    return formatDateUtil(parsed);
  };

  const formatTime = (time) => {
    if (!time) return '';

    const raw = String(time).trim();
    const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
    if (!match) return raw;

    return new Date(`1970-01-01T${match[1]}:00`).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  /* ---------- LOAD WORK ORDER ---------- */

  const workOrder = await getWorkOrder(workOrderId);
  if (!workOrder) {
    throw new Error('Work Order not found');
  }

  /* ---------- LOAD SETTINGS ---------- */

  const settingsRaw = await getPdfSettings();

  const settings = {
    ...settingsRaw,
    logo_url: resolveAssetUrl(settingsRaw?.logo_url),
  };

  const isGeneralBusiness = String(settingsRaw?.business_type || 'GENERAL').trim().toUpperCase() === 'GENERAL';
  const isCateringMode = String(workOrder.mode || workOrder.quotation_mode || '').toUpperCase() === 'CATERING';

  /* ---------- FORMAT DATES ---------- */

  workOrder.issue_date_formatted = formatDate(workOrder.issue_date);
  workOrder.event_date_formatted = formatDate(workOrder.event_date);
  workOrder.event_start_date_formatted = formatDate(workOrder.event_start_date);
  workOrder.event_start_time_formatted = formatTime(workOrder.event_start_time);
  workOrder.event_end_date_formatted = formatDate(workOrder.event_end_date);
  workOrder.event_end_time_formatted = formatTime(workOrder.event_end_time);

  // preserve legacy field for templates that still use event_time
  if (workOrder.event_start_time && workOrder.event_end_time) {
    workOrder.event_time_formatted = `${workOrder.event_start_time_formatted} - ${workOrder.event_end_time_formatted}`;
  } else {
    workOrder.event_time_formatted = formatTime(workOrder.event_time);
  }

  /* ---------- CALCULATE GRAND TOTAL ---------- */

  const itemsGrandTotal = (workOrder.items || []).reduce(
    (sum, i) => sum + Number(i.line_total || 0),
    0
  );

  const sourceDiscount = Math.max(0, Number(workOrder.quotation_discount_amount || 0));
  const inferredDiscount = Math.max(
    0,
    Number(workOrder.subtotal || 0) -
      Number(workOrder.total_amount || workOrder.grand_total || 0)
  );
  const discount = sourceDiscount || inferredDiscount;
  const storedGrandTotal = Number(workOrder.grand_total || workOrder.total_amount || 0);

  workOrder.display_subtotal = Number(workOrder.subtotal || itemsGrandTotal || 0);
  workOrder.discount = discount;
  workOrder.discount_percent =
    String(workOrder.quotation_discount_type || '').toUpperCase() === 'PERCENT'
      ? Number(workOrder.quotation_discount_value || 0)
      : null;
  workOrder.grand_total =
    sourceDiscount > 0 && inferredDiscount === 0 && storedGrandTotal > 0
      ? Math.max(0, storedGrandTotal - sourceDiscount)
      : storedGrandTotal || Math.max(0, itemsGrandTotal - discount);

  /* ---------- RETURN TEMPLATE DATA ---------- */
  return {
    workOrder,
    settings,
    today: formatDate(new Date()),
    isCatering: !isGeneralBusiness && isCateringMode,
  };
}


/* =========================================================
   DATA LOADERS
========================================================= */

function resolveAssetUrl(url) {
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
}

async function getWorkOrder(id) {
  const [rows] = await db.query(
    `
    SELECT 
      wo.*,
      q.quotation_number,
      q.quotation_mode,
      q.quotation_discount_type,
      q.quotation_discount_value,
      q.quotation_discount_amount,
      l.first_name,
      l.last_name,
      l.company_name,
      l.email,
      l.phone_number,
      l.gst_number
    FROM work_orders wo
    LEFT JOIN quotations q ON q.id = wo.quotation_id
    LEFT JOIN leads l ON l.id = q.lead_id
    WHERE wo.id = ?
    `,
    [id]
  );

  if (!rows.length) return null;

  const wo = rows[0];

  const [items] = await db.query(
    `
    SELECT
      woi.*,
      p.name AS product_name,
      p.brand
    FROM work_order_items woi
    LEFT JOIN products p ON p.id = woi.product_id
    WHERE woi.work_order_id = ?
    ORDER BY woi.id ASC
    `,
    [id]
  );

  wo.items = items || [];

  return wo;
}


async function getPdfSettings() {
  const [quotationRows] = await db.query(`SELECT * FROM quotation_settings LIMIT 1`);
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
