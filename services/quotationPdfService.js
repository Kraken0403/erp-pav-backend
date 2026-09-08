const db = require("../config/db");
const { loadTemplate } = require("./templateLoader");
const { normalizeBuilderConfig, getPdfPayloadOverrides } = require("./quotationTemplateRenderer");
const { formatDate } = require("../utils/dateFormatter");
const { generatePdfFromHtml } = require("./puppetPdfService");
const {
  resolveAssetUrl,
  resolvePreferredPdfLogo,
} = require("../utils/pdfAssetResolver");

/* ---------------- PUBLIC API ---------------- */

exports.generatePdf = async (quotationId) => {
  try {
    console.log(
      `[QuotationPDF] Starting PDF generation for quotation ID: ${quotationId}`,
    );
    const data = await loadQuotationData(quotationId);
    console.log(
      `[QuotationPDF] Quotation data loaded. GST Pricing Mode: ${data.gstPricingMode}`,
    );
    const html = loadTemplate(data);
    console.log(`[QuotationPDF] Builder HTML rendered successfully`);

    return generatePdfFromHtml(html, {
      payloadOverrides: getPdfPayloadOverrides(data.settings?.template_config),
    });
  } catch (error) {
    console.error(
      `[QuotationPDF] Error generating PDF for quotation ${quotationId}:`,
      error,
    );
    throw error;
  }
};

exports.generateHtml = async (quotationId) => {
  const data = await loadQuotationData(quotationId);
  return loadTemplate(data);
};

exports.generatePreviewHtml = async (payload = {}) => {
  const form = payload.form || {};
  const lead = payload.lead || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const totals = payload.totals || {};
  const settingsRaw = await getQuotationSettings();
  const companyBase = await getCompanySettings(form.company_id);
  const companyRaw = {
    ...companyBase,
    company_name: form.issuer_company_name || companyBase?.company_name,
    company_email: form.issuer_company_email || companyBase?.company_email,
    company_phone: form.issuer_company_phone || companyBase?.company_phone,
    company_address_line1: form.issuer_company_address || companyBase?.company_address_line1,
    gst_number: form.issuer_company_gst_number || companyBase?.gst_number,
  };
  const templateConfig = payload.template_config
    ? normalizeBuilderConfig({ version: 2, builder: payload.template_config }, 'builder')
    : normalizeBuilderConfig(settingsRaw?.template_config_json, settingsRaw?.layout_option);
  const preferredLogo = resolvePreferredPdfLogo(
    form.company_logo_url || settingsRaw?.logo_url,
    companyRaw?.company_logo,
  );
  const quotationTerms = [
    form.payment_terms ? `<h3>Payment terms</h3>${form.payment_terms}` : '',
    form.terms_conditions_html || settingsRaw?.terms_conditions_html || '',
  ].filter(Boolean).join('');
  const settings = {
    ...settingsRaw,
    cover_letter_html: form.cover_letter_html || settingsRaw?.cover_letter_html || '',
    terms_conditions_html: quotationTerms,
    footer_notes_html: settingsRaw?.footer_notes_html || '',
    logo_url: preferredLogo,
    template_config: templateConfig,
  };
  const company = { ...companyRaw, company_logo: preferredLogo };
  const gstPricingMode = String(companyRaw?.gst_pricing_mode || 'EXCLUSIVE').toUpperCase();
  const defaultColumns = ['brand', 'product', 'description', 'quantity', 'unit_price', 'discount', 'gst_rate', 'total'];
  const publicColumns = new Set(['image', 'brand', 'product', 'description', 'sku', 'quantity', 'unit_price', 'selling_price_unit', 'discount', 'gst_rate', 'hsn_sac', 'total']);
  const requestedColumns = Array.isArray(payload.quotationColumns) ? payload.quotationColumns : defaultColumns;
  const displayColumns = requestedColumns.filter((key) => publicColumns.has(key));
  if (!displayColumns.includes('product')) displayColumns.unshift('product');
  if (!displayColumns.includes('total')) displayColumns.push('total');
  const categoryGroups = buildPreviewCategoryGroups(items, gstPricingMode, Boolean(form.group_items_by_top_category));
  const itemsGrandTotal = categoryGroups.reduce((sum, group) => sum + Number(group.grand_total || 0), 0);
  const itemDiscount = Number(totals.itemDiscount || 0);
  const overallDiscount = Number(totals.overallDiscount || 0);
  const quotation = {
    ...form,
    first_name: lead.first_name || lead.name || 'Client',
    last_name: lead.last_name || '',
    company_name: form.customer_company || lead.company_name || '',
    email: form.customer_email || lead.email || '',
    phone_number: form.customer_phone || lead.phone_number || lead.phone || '',
    quotation_number: form.quotation_number || 'Draft quotation',
    quotation_date_formatted: formatDate(form.quotation_date, companyRaw?.date_format),
    valid_until_formatted: formatDate(form.valid_until, companyRaw?.date_format),
    notes: form.notes || '',
    displayColumns,
    categoryGroups,
    group_items_by_top_category: Boolean(form.group_items_by_top_category),
    subtotal: Number(totals.subtotal || 0),
    item_discount_total: itemDiscount,
    quotation_discount_amount: overallDiscount,
    total_discount: itemDiscount + overallDiscount,
    cumulative_discount: itemDiscount + overallDiscount,
    total_tax: Number(totals.tax || totals.totalTax || 0),
    grand_total: Number(totals.total || totals.grandTotal || itemsGrandTotal),
    items_grand_total: itemsGrandTotal,
  };
  return loadTemplate({
    template: 'builder',
    mode: form.quotation_mode || 'GENERAL',
    quotation,
    settings,
    company,
    gstPricingMode,
    today: formatDate(new Date(), companyRaw?.date_format),
  });
};

// Build a safe PDF filename using quotation number and lead/client name.
exports.buildPdfFilename = async (quotationId) => {
  const data = await loadQuotationData(quotationId);
  const q = data.quotation || {};

  const quotationNumber = q.quotation_number || `QT-${quotationId}`;
  const clientName = [q.first_name, q.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ') || String(q.contact_name || q.company_name || 'Client').trim();

  const safePart = (value, fallback) => {
    const cleaned = String(value || fallback || '')
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .replace(/_+/g, '_')
      .replace(/-+/g, '-')
      .replace(/^[-_.]+|[-_.]+$/g, '');

    return cleaned || fallback;
  };

  const numberPart = safePart(quotationNumber, `QT-${quotationId}`);
  const clientPart = safePart(clientName, 'Client');
  const filenameBase = `Quotation-${numberPart}-${clientPart}`.substring(0, 120);

  return `${filenameBase}.pdf`;
};

/* ---------------- INTERNAL ---------------- */

async function loadQuotationData(quotationId) {
  console.log(
    `[loadQuotationData] Loading data for quotation ID: ${quotationId}`,
  );
  const quotation = await getQuotation(quotationId);
  if (!quotation) {
    console.error(
      `[loadQuotationData] Quotation not found for ID: ${quotationId}`,
    );
    throw new Error("Quotation not found");
  }
  console.log(`[loadQuotationData] Quotation loaded successfully`);

  const settingsRaw = await getQuotationSettings();
  const companyBase = await getCompanySettings(quotation.company_id);
  const companyRaw = {
    ...companyBase,
    company_name: quotation.issuer_company_name || companyBase?.company_name,
    company_email: quotation.issuer_company_email || companyBase?.company_email,
    company_phone: quotation.issuer_company_phone || companyBase?.company_phone,
    company_address_line1: quotation.issuer_company_address || companyBase?.company_address_line1,
    gst_number: quotation.issuer_company_gst_number || companyBase?.gst_number,
  };
  quotation.quotation_date_formatted = formatDate(quotation.quotation_date, companyRaw?.date_format);
  quotation.valid_until_formatted = formatDate(quotation.valid_until, companyRaw?.date_format);
  console.log(
    `[loadQuotationData] Company GST Pricing Mode: ${companyRaw?.gst_pricing_mode || "EXCLUSIVE (default)"}`,
  );

  const preferredLogo = resolvePreferredPdfLogo(
    quotation.company_logo_url || settingsRaw?.logo_url,
    companyRaw?.company_logo,
  );

  const templateConfig = normalizeBuilderConfig(
    settingsRaw?.template_config_json,
    settingsRaw?.layout_option,
  );
  const quotationCoverLetter = quotation.cover_letter_html || settingsRaw?.cover_letter_html || '';
  const quotationTerms = [
    quotation.payment_terms ? `<h3>Payment terms</h3>${quotation.payment_terms}` : '',
    quotation.terms_conditions_html || settingsRaw?.terms_conditions_html || '',
  ].filter(Boolean).join('');

  const settings = {
    ...settingsRaw,
    cover_letter_html: quotationCoverLetter,
    terms_conditions_html: quotationTerms,
    default_payment_terms: quotation.payment_terms || settingsRaw?.default_payment_terms || '',
    // Prefer quotation/internal logo; fallback to main settings logo.
    // For PDFs this may be a data URI, which avoids broken images when the
    // browser/PDF service cannot reach localhost, private uploads, or a reverse-proxy URL.
    logo_url: preferredLogo,
    template_config: templateConfig,
  };

  const company = {
    ...companyRaw,
    // Keep header/footer logo aligned with the same fallback chain.
    company_logo: preferredLogo,
  };

  // Get GST pricing mode from company settings (default to EXCLUSIVE)
  const gstPricingMode = (
    companyRaw?.gst_pricing_mode || "EXCLUSIVE"
  ).toUpperCase();

  const defaultDisplayColumns = ['brand', 'product', 'description', 'quantity', 'unit_price', 'discount', 'gst_rate', 'total'];
  let configuredDisplayColumns = [];
  try {
    configuredDisplayColumns = Array.isArray(quotation.quotation_line_columns_json)
      ? quotation.quotation_line_columns_json
      : JSON.parse(quotation.quotation_line_columns_json || '[]');
  } catch (_) {
    configuredDisplayColumns = [];
  }
  const publicColumns = new Set(['image', 'brand', 'product', 'description', 'sku', 'quantity', 'unit_price', 'selling_price_unit', 'discount', 'gst_rate', 'hsn_sac', 'total']);
  quotation.displayColumns = (configuredDisplayColumns.length ? configuredDisplayColumns : defaultDisplayColumns).filter((key) => publicColumns.has(key));
  if (!quotation.displayColumns.includes('product')) quotation.displayColumns.unshift('product');
  if (!quotation.displayColumns.includes('total')) quotation.displayColumns.push('total');
  quotation.group_items_by_top_category = Boolean(Number(quotation.group_items_by_top_category || 0));

  const categories = await getAllCategories();
  const categoryMap = buildCategoryMap(categories);

  const categoryGroups = groupItemsByTopCategory(
    quotation.items || [],
    categoryMap,
    quotation,
    gstPricingMode,
    quotation.group_items_by_top_category,
  );

  quotation.categoryGroups = categoryGroups;
  const itemsGrandTotal = categoryGroups.reduce(
    (sum, g) => sum + Number(g.grand_total || 0),
    0,
  );
  quotation.items_grand_total = itemsGrandTotal;
  quotation.grand_total = Number(
    quotation.total_amount || quotation.grand_total || itemsGrandTotal || 0,
  );
  quotation.total_tax = Number(quotation.total_tax || 0);
  quotation.total_discount = Number(quotation.total_discount || 0);
  quotation.quotation_discount_amount = Number(
    quotation.quotation_discount_amount || 0,
  );
  quotation.subtotal = Number(quotation.subtotal || 0);

  // total_discount is persisted by quotationController as:
  // item-level discount + quotation-level overall discount.
  // Do not add quotation_discount_amount again here, otherwise a flat overall
  // discount of 33,200 is displayed as 66,400 in the PDF.
  const storedTotalDiscount = Number(quotation.total_discount || 0);
  const itemDiscountFromGroups = categoryGroups.reduce(
    (sum, group) => sum + Number(group.discount_total || 0),
    0,
  );
  const overallDiscount = Number(quotation.quotation_discount_amount || 0);
  quotation.item_discount_total = itemDiscountFromGroups;
  quotation.cumulative_discount =
    storedTotalDiscount > 0
      ? storedTotalDiscount
      : itemDiscountFromGroups + overallDiscount;

  return {
    template: 'builder',
    mode: quotation.quotation_mode || "GENERAL",
    quotation,
    settings,
    company,
    gstPricingMode,
    today: formatDate(new Date(), companyRaw?.date_format),
  };
}

/* ---------------- DATA LOADERS (Promise-native) ---------------- */

function formatLocalDate(value, dateFormat = 'DD/MM/YYYY') {
  if (!value) return "";
  const raw = value instanceof Date ? value : String(value).trim();
  if (!raw) return "";
  const parsed = value instanceof Date ? value : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatDate(parsed, dateFormat);
}

async function getQuotation(id) {
  const [rows] = await db.query(
    `
    SELECT 
      q.*,
      l.first_name,
      l.last_name,
      COALESCE(c.name, l.company_name) AS company_name,
      l.email,
      l.phone_number,
      COALESCE(c.gst_number, l.gst_number) AS gst_number,
      l.contact_name,
      COALESCE(c.billing_address, l.billing_address) AS billing_address,
      COALESCE(c.billing_city, l.billing_city) AS billing_city,
      COALESCE(c.billing_state, l.billing_state) AS billing_state,
      COALESCE(c.billing_pincode, l.billing_pincode) AS billing_pincode,
      COALESCE(c.shipping_address, l.shipping_address, c.billing_address, l.billing_address) AS shipping_address,
      COALESCE(c.shipping_city, l.shipping_city, c.billing_city, l.billing_city) AS shipping_city,
      COALESCE(c.shipping_state, l.shipping_state, c.billing_state, l.billing_state) AS shipping_state,
      COALESCE(c.shipping_pincode, l.shipping_pincode, c.billing_pincode, l.billing_pincode) AS shipping_pincode
    FROM quotations q
    LEFT JOIN leads l ON l.id = q.lead_id
    LEFT JOIN companies c ON c.id = l.company_id
    WHERE q.id = ?
    `,
    [id],
  );

  if (!rows.length) return null;

  const q = rows[0];

  const effectiveEventDate = q.event_start_date || q.event_date || null;
  const effectiveEventStartTime = q.event_start_time || q.event_time || "";
  const effectiveEventTime = q.event_time || (
    q.event_start_time && q.event_end_time
      ? `${q.event_start_time} - ${q.event_end_time}`
      : effectiveEventStartTime
  );

  // ✅ Normalize quotation + catering meta while supporting both old and new schemas.
  const quotation = {
    ...q,
    event_date: q.event_date || q.event_start_date || null,
    event_time: effectiveEventTime,
    event_start_date: q.event_start_date || q.event_date || null,
    event_start_time: effectiveEventStartTime,
    quotation_date_formatted: formatLocalDate(q.quotation_date),
    valid_until_formatted: formatLocalDate(q.valid_until),
    catering: {
      pax: Number(q.pax) || 0,
      event_name: q.event_name || "",
      event_date: formatLocalDate(effectiveEventDate),
      event_time: effectiveEventTime || "",
      event_start_date: formatLocalDate(effectiveEventDate),
      event_start_time: effectiveEventStartTime || "",
      event_end_date: formatLocalDate(q.event_end_date),
      event_end_time: q.event_end_time || "",
      event_location: q.event_location || "",
    },
    items: [],
  };

  const [items] = await db.query(
    `
    SELECT
      qi.*,
      p.brand,
      p.description AS product_description,
      p.image_url,
      p.category_id,
      p.sku AS product_sku,
      p.selling_price_unit AS product_selling_price_unit,
      p.cost_price AS product_cost_price,
      p.cost_price_unit AS product_cost_price_unit,
      p.hsn_sac AS product_hsn_sac,
      c.name AS category_name,
      c.parent_id AS category_parent_id,
      v.name AS vendor_name
    FROM quotation_items qi
    LEFT JOIN products p ON p.id = qi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN vendors v ON v.id = COALESCE(qi.vendor_id, p.vendor_id)
    WHERE qi.quotation_id = ?
    ORDER BY qi.id ASC
    `,
    [id],
  );

  quotation.items = items || [];

  return quotation;
}

async function getQuotationSettings() {
  const [rows] = await db.query(`SELECT * FROM quotation_settings LIMIT 1`);
  return rows[0] || {};
}

async function getCompanySettings(companyId) {
  const [rows] = await db.query(
    `
    SELECT *
    FROM settings
    WHERE id = 1
    LIMIT 1
    `,
  );

  const defaults = rows[0] || {};
  if (!companyId) return defaults;
  try {
    const [[company]] = await db.query('SELECT * FROM companies WHERE id = ? LIMIT 1', [companyId]);
    if (!company) return defaults;
    return {
      ...defaults,
      company_name: company.legal_name || company.name || defaults.company_name,
      company_email: company.email || defaults.company_email,
      company_phone: company.phone || defaults.company_phone,
      company_logo: company.logo_url || defaults.company_logo,
      company_address_line1: company.registered_address || company.address || defaults.company_address_line1,
      company_address_line2: '',
      company_city: company.registered_city || defaults.company_city,
      company_state: company.registered_state || defaults.company_state,
      company_pincode: company.registered_pincode || defaults.company_pincode,
      gst_number: company.gst_number || defaults.gst_number,
      pan_number: company.pan_number || defaults.pan_number,
      website: company.website || defaults.website,
    };
  } catch (_) {
    return defaults;
  }
}

async function getAllCategories() {
  const [rows] = await db.query(`SELECT id, name, parent_id FROM categories`);
  return rows || [];
}

/* ---------------- CATEGORY HELPERS ---------------- */

function buildCategoryMap(categories) {
  const map = {};
  for (const c of categories) {
    map[c.id] = c;
  }
  return map;
}

function getTopParentCategory(categoryId, categoryMap) {
  let current = categoryMap[categoryId];
  const seen = new Set(); // 🔥 prevents infinite loop if data is corrupted

  while (current && current.parent_id) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    current = categoryMap[current.parent_id];
  }

  return current;
}

function groupItemsByTopCategory(
  items,
  categoryMap,
  quotation,
  gstPricingMode = "EXCLUSIVE",
  groupByTopCategory = false,
) {
  console.log(
    `[groupItemsByTopCategory] Processing ${items.length} items with GST Pricing Mode: ${gstPricingMode}`,
  );
  const groups = {};

  const isCatering = quotation?.quotation_mode === "CATERING";
  const pax = isCatering ? Number(quotation?.pax || 0) : 0;

  for (const i of items) {
    const qty = isCatering ? pax : Number(i.quantity || 0);
    const rate = Number(i.selling_price || 0);
    const gstRate = Number(i.gst_rate || 0);

    // Show selling price inclusive of GST in the rate column.
    const multiplier = 1 + gstRate / 100;
    let inclusiveRate = rate;
    if ((gstPricingMode || "EXCLUSIVE").toUpperCase() === "INCLUSIVE") {
      // stored rate already inclusive
      inclusiveRate = rate;
    } else {
      // stored rate exclusive -> convert to inclusive for display
      inclusiveRate = rate * multiplier;
    }

    const lineTotal = qty * inclusiveRate;
    const discount = Number(i.discount || 0);
    const finalTotal = Math.max(0, lineTotal - discount);
    // We intentionally hide tax breakdown in PDFs; report zero tax internally for templates
    const tax = 0;
    const taxableAfterDiscount = finalTotal;
    const displayRate = inclusiveRate;

    const item = {
      title: i.product_name || "Item",
      brand: i.brand || "",
      description: i.product_description || "",
      image_url: resolveAssetUrl(i.image_url || ""),
      sku: i.variant_sku || i.product_sku || "",
      hsn_sac: i.hsn_sac || i.product_hsn_sac || "",
      vendor_name: i.vendor_name || "",
      cost_price: Number(i.cost_price ?? i.product_cost_price ?? 0),
      cost_price_unit: i.cost_price_unit || i.product_cost_price_unit || "",
      qty,
      rate: displayRate,
      selling_price_unit: i.selling_price_unit || i.product_selling_price_unit || "",
      rateLabel: isCatering
        ? "per pax"
        : (i.selling_price_unit || i.product_selling_price_unit)
          ? `per ${(i.selling_price_unit || i.product_selling_price_unit).charAt(0).toUpperCase()}${(i.selling_price_unit || i.product_selling_price_unit).slice(1)}`
          : "",
      total: lineTotal,
      taxable: taxableAfterDiscount,
      discount,
      gst_rate: gstRate,
      tax,
      finalTotal,
    };

    let topCategory = null;
    if (groupByTopCategory && i.category_id) {
      topCategory = getTopParentCategory(i.category_id, categoryMap);
    }

    const groupKey = groupByTopCategory ? (topCategory?.id || "uncategorized") : "all";
    const groupName = groupByTopCategory ? (topCategory?.name || "Uncategorized") : "Products & Services";

    if (!groups[groupKey]) {
      groups[groupKey] = {
        category_id: groupKey,
        category_name: groupName,
        show_category_heading: Boolean(groupByTopCategory),
        items: [],
        sub_total: 0,
        discount_total: 0,
        tax_total: 0,
        grand_total: 0,
      };
    }

    groups[groupKey].items.push(item);
    groups[groupKey].sub_total += lineTotal;
    groups[groupKey].discount_total += discount;
    groups[groupKey].tax_total += tax;
    groups[groupKey].grand_total += finalTotal;
  }

  return Object.values(groups);
}

function buildPreviewCategoryGroups(items, gstPricingMode, groupByTopCategory) {
  const groups = {};
  items.forEach((row) => {
    const qty = Number(row.quantity || 0);
    const rate = Number(row.unit_price ?? row.selling_price ?? 0);
    const gstRate = Number(row.gst_rate || 0);
    const inclusiveRate = gstPricingMode === 'INCLUSIVE' ? rate : rate * (1 + gstRate / 100);
    const discount = Number(row.discount || 0);
    const lineTotal = qty * inclusiveRate;
    const finalTotal = Math.max(0, lineTotal - discount);
    const groupName = groupByTopCategory ? (row.top_category_name || row.category_name || 'Uncategorized') : 'Products & Services';
    if (!groups[groupName]) {
      groups[groupName] = {
        category_name: groupName,
        show_category_heading: groupByTopCategory,
        items: [],
        sub_total: 0,
        discount_total: 0,
        tax_total: 0,
        grand_total: 0,
      };
    }
    groups[groupName].items.push({
      title: row.product_name || row.name || 'Item',
      brand: row.brand || '',
      description: row.description || row.product_description || '',
      image_url: resolveAssetUrl(row.image_url || ''),
      sku: row.sku || row.variant_sku || '',
      hsn_sac: row.hsn_sac || '',
      qty,
      rate: inclusiveRate,
      selling_price_unit: row.selling_price_unit || '',
      discount,
      gst_rate: gstRate,
      total: lineTotal,
      finalTotal,
    });
    groups[groupName].sub_total += lineTotal;
    groups[groupName].discount_total += discount;
    groups[groupName].grand_total += finalTotal;
  });
  return Object.values(groups);
}
