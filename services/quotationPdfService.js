const db = require("../config/db");
const { loadTemplate } = require("./templateLoader");
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
    console.log(`[QuotationPDF] HTML template loaded successfully`);

    // Use Puppeteer's footer only. The visible quotation header is rendered
    // inside the quotation HTML table header, so the cover-letter page stays
    // clean and quotation pages still get a repeated logo/header.
    return generatePdfFromHtml(html, {
      payloadOverrides: {
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: buildHeaderTemplate(),
        footerTemplate: buildFooterTemplate(data.company),
        margin: {
          top: "15mm",
          bottom: "32mm",
          left: "15mm",
          right: "15mm",
        },
      },
    });
  } catch (error) {
    console.error(
      `[QuotationPDF] Error generating PDF for quotation ${quotationId}:`,
      error,
    );
    throw error;
  }
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildFooterTemplate(company) {
  const parts = [
    company.company_name,
    company.company_phone,
    company.company_email,
  ]
    .filter(Boolean)
    .map(escapeHtml);

  const companyLine = parts.join(" · ");

  return `
    <div style="
      width:100%;
      box-sizing:border-box;
      text-align:center;
      font-family:'Segoe UI', Arial, sans-serif;
      color:#8a98a5;
      font-size:9px;
      line-height:1.35;
      padding:6px 18px 0 18px;
    ">
      <div style="border-top:2px solid #2c3e50; margin:0 auto 4px auto; max-width:100%;"></div>
      <div style="color:#516873; font-weight:600; font-size:10px;">${companyLine}</div>
      <div>This is a computer-generated quotation and does not require a signature.</div>
    </div>
  `;
}

function buildHeaderTemplate() {
  return "<div></div>";
}

exports.generateHtml = async (quotationId) => {
  const data = await loadQuotationData(quotationId);
  return loadTemplate(data);
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
  const companyRaw = await getCompanySettings();
  console.log(
    `[loadQuotationData] Company GST Pricing Mode: ${companyRaw?.gst_pricing_mode || "EXCLUSIVE (default)"}`,
  );

  const preferredLogo = resolvePreferredPdfLogo(
    settingsRaw?.logo_url,
    companyRaw?.company_logo,
  );

  const settings = {
    ...settingsRaw,
    // Prefer quotation/internal logo; fallback to main settings logo.
    // For PDFs this may be a data URI, which avoids broken images when the
    // browser/PDF service cannot reach localhost, private uploads, or a reverse-proxy URL.
    logo_url: preferredLogo,
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

  const categories = await getAllCategories();
  const categoryMap = buildCategoryMap(categories);

  const categoryGroups = groupItemsByTopCategory(
    quotation.items || [],
    categoryMap,
    quotation,
    gstPricingMode,
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
    template: normalizeTemplateName(settingsRaw?.layout_option),
    mode: quotation.quotation_mode || "GENERAL",
    quotation,
    settings,
    company,
    gstPricingMode,
    today: formatDate(new Date()),
  };
}

function normalizeTemplateName(layoutOption) {
  const allowed = new Set(["general", "minimal", "classic", "modern"]);
  const normalized = String(layoutOption || "")
    .trim()
    .toLowerCase();
  return allowed.has(normalized) ? normalized : "general";
}

/* ---------------- DATA LOADERS (Promise-native) ---------------- */

function formatLocalDate(value) {
  if (!value) return "";
  const raw = value instanceof Date ? value : String(value).trim();
  if (!raw) return "";
  const parsed = value instanceof Date ? value : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatDate(parsed);
}

async function getQuotation(id) {
  const [rows] = await db.query(
    `
    SELECT 
      q.*,
      l.first_name,
      l.last_name,
      l.company_name,
      l.email,
      l.phone_number,
      l.gst_number,
      l.contact_name
    FROM quotations q
    LEFT JOIN leads l ON l.id = q.lead_id
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
      c.name AS category_name,
      c.parent_id AS category_parent_id
    FROM quotation_items qi
    LEFT JOIN products p ON p.id = qi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
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

async function getCompanySettings() {
  const [rows] = await db.query(
    `
    SELECT
      company_name,
      company_email,
      company_phone,
      company_logo,
      company_address_line1,
      company_address_line2,
      company_city,
      company_state,
      company_pincode,
      company_country,
      gst_number,
      gst_pricing_mode
    FROM settings
    WHERE id = 1
    LIMIT 1
    `,
  );

  return rows[0] || {};
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
      sku: i.variant_sku || "",
      qty,
      rate: displayRate,
      rateLabel: isCatering
        ? "per pax"
        : i.selling_price_unit
          ? `per ${i.selling_price_unit.charAt(0).toUpperCase()}${i.selling_price_unit.slice(1)}`
          : "",
      total: lineTotal,
      taxable: taxableAfterDiscount,
      discount,
      gst_rate: gstRate,
      tax,
      finalTotal,
    };

    let topCategory = null;
    if (i.category_id) {
      topCategory = getTopParentCategory(i.category_id, categoryMap);
    }

    const groupKey = topCategory?.id || "uncategorized";
    const groupName = topCategory?.name || "Uncategorized";

    if (!groups[groupKey]) {
      groups[groupKey] = {
        category_id: groupKey,
        category_name: groupName,
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
