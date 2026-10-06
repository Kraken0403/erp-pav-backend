const { resolveAssetUrl } = require('../utils/pdfAssetResolver');

const DEFAULT_COMPONENTS = [
  { id: 'cover-letter', type: 'cover_letter', enabled: true, label: 'Cover Letter', page_break_after: true },
  { id: 'company-header', type: 'company_header', enabled: true, label: 'Company Header', show_logo: true, show_company_name: true, show_address: true, show_contact: true },
  { id: 'document-header', type: 'document_header', enabled: true, label: 'Quotation Details', heading: 'Quotation', show_number: true, show_date: true, show_valid_until: true },
  { id: 'client-details', type: 'client_details', enabled: true, label: 'Client Details', heading: 'Prepared For' },
  { id: 'items-table', type: 'items_table', enabled: true, label: 'Products Table', heading: 'Quotation Items', show_heading: true },
  { id: 'totals', type: 'totals', enabled: true, label: 'Totals', show_subtotal: true, show_discount: true, show_grand_total: true },
  { id: 'notes', type: 'notes', enabled: true, label: 'Notes', heading: 'Notes' },
  { id: 'terms', type: 'terms_conditions', enabled: true, label: 'Terms & Conditions', heading: 'Terms & Conditions', page_break_before: true },
];

const DEFAULT_BUILDER_CONFIG = {
  version: 2,
  primary_color: '#2c3e50',
  accent_color: '#e67e22',
  text_color: '#253a43',
  muted_color: '#6b7b8d',
  font_family: 'Segoe UI',
  font_size: 12,
  section_spacing: 16,
  page_margin_top: 12,
  page_margin_right: 12,
  page_margin_bottom: 12,
  page_margin_left: 12,
  custom_header_html: '',
  custom_footer_html: '',
  header_height_mm: 12,
  footer_height_mm: 10,
  page_number_enabled: false,
  page_number_position: 'right',
  hide_empty_columns: true,
  components: DEFAULT_COMPONENTS,
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const stripHtml = (value) => String(value || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim();

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const safeColor = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(value || '').trim())
  ? String(value).trim()
  : fallback;

const safeFont = (value) => {
  const allowed = new Set(['Segoe UI', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma']);
  const raw = String(value || '').trim();
  return allowed.has(raw) ? raw : 'Segoe UI';
};

const parseMaybeJson = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
};

const cloneDefaultComponents = () => DEFAULT_COMPONENTS.map((component) => ({ ...component }));

const normalizeComponent = (component, index) => {
  const raw = component && typeof component === 'object' ? component : {};
  const type = String(raw.type || 'custom_content');
  return {
    ...raw,
    id: String(raw.id || `${type}-${index + 1}`),
    type,
    enabled: raw.enabled !== false,
    padding: clamp(raw.padding, 0, 48, 0),
    border_width: clamp(raw.border_width, 0, 6, 0),
    background_color: raw.background_color ? safeColor(raw.background_color, '#ffffff') : '',
    border_color: raw.border_color ? safeColor(raw.border_color, '#dfe3eb') : '',
    text_align: ['left', 'center', 'right'].includes(raw.text_align) ? raw.text_align : 'left',
    text_color: raw.text_color ? safeColor(raw.text_color, '') : '',
    font_size: clamp(raw.font_size, 0, 28, 0),
    border_radius: clamp(raw.border_radius, 0, 32, 0),
    max_width: clamp(raw.max_width, 0, 100, 0),
    // Terms are a document appendix and always begin on the page immediately
    // following the quotation body/order lines.
    page_break_before: type === 'terms_conditions' ? true : Boolean(raw.page_break_before),
    page_break_after: Boolean(raw.page_break_after),
  };
};

const migrateLegacyComponents = (legacy = {}) => {
  const components = cloneDefaultComponents();
  const byType = (type) => components.find((component) => component.type === type);

  byType('cover_letter').enabled = legacy.show_cover !== false;
  byType('company_header').enabled = legacy.show_company_header !== false;
  byType('client_details').enabled = legacy.show_client_section !== false;
  byType('terms_conditions').enabled = legacy.show_terms !== false;

  const insertBefore = (type, html, suffix) => {
    if (!stripHtml(html)) return;
    const index = components.findIndex((component) => component.type === type);
    components.splice(Math.max(index, 0), 0, {
      id: `legacy-${suffix}`,
      type: 'custom_content',
      enabled: true,
      label: 'Custom Content',
      html,
    });
  };

  const insertAfter = (type, html, suffix) => {
    if (!stripHtml(html)) return;
    const index = components.findIndex((component) => component.type === type);
    components.splice(index >= 0 ? index + 1 : components.length, 0, {
      id: `legacy-${suffix}`,
      type: 'custom_content',
      enabled: true,
      label: 'Custom Content',
      html,
    });
  };

  insertBefore('document_header', legacy.static_header_html, 'top');
  insertBefore('items_table', legacy.static_before_items_html, 'before-items');
  insertAfter('totals', legacy.static_after_items_html, 'after-items');
  insertAfter('notes', legacy.static_footer_html, 'bottom');

  return components;
};

const normalizeBuilderConfig = (rawValue, legacyLayout = 'minimal') => {
  const raw = parseMaybeJson(rawValue);
  let source = raw?.builder && typeof raw.builder === 'object' ? raw.builder : null;

  // The renderer and PDF generator both pass the normalized builder object
  // internally. Treat a v2/components object as builder data directly so it
  // is never mistaken for the old minimal/classic/modern config shape.
  if (!source && raw && typeof raw === 'object' && (Number(raw.version) >= 2 || Array.isArray(raw.components))) {
    source = raw;
  }

  if (!source) {
    const legacy = raw?.[legacyLayout] || raw?.minimal || raw?.classic || raw?.modern || raw || {};
    const pagePadding = clamp(legacy.page_padding, 0, 40, DEFAULT_BUILDER_CONFIG.page_margin_top);
    source = {
      ...legacy,
      page_margin_top: pagePadding,
      page_margin_right: pagePadding,
      page_margin_bottom: pagePadding,
      page_margin_left: pagePadding,
      components: migrateLegacyComponents(legacy),
    };
  }

  const components = Array.isArray(source.components) && source.components.length
    ? source.components.map(normalizeComponent)
    : cloneDefaultComponents().map(normalizeComponent);

  return {
    ...DEFAULT_BUILDER_CONFIG,
    ...source,
    version: 2,
    primary_color: safeColor(source.primary_color, DEFAULT_BUILDER_CONFIG.primary_color),
    accent_color: safeColor(source.accent_color, DEFAULT_BUILDER_CONFIG.accent_color),
    text_color: safeColor(source.text_color, DEFAULT_BUILDER_CONFIG.text_color),
    muted_color: safeColor(source.muted_color, DEFAULT_BUILDER_CONFIG.muted_color),
    font_family: safeFont(source.font_family),
    font_size: clamp(source.font_size, 9, 18, DEFAULT_BUILDER_CONFIG.font_size),
    section_spacing: clamp(source.section_spacing, 0, 48, DEFAULT_BUILDER_CONFIG.section_spacing),
    page_margin_top: clamp(source.page_margin_top, 0, 40, DEFAULT_BUILDER_CONFIG.page_margin_top),
    page_margin_right: clamp(source.page_margin_right, 0, 40, DEFAULT_BUILDER_CONFIG.page_margin_right),
    page_margin_bottom: clamp(source.page_margin_bottom, 0, 40, DEFAULT_BUILDER_CONFIG.page_margin_bottom),
    page_margin_left: clamp(source.page_margin_left, 0, 40, DEFAULT_BUILDER_CONFIG.page_margin_left),
    header_height_mm: clamp(source.header_height_mm, 6, 35, DEFAULT_BUILDER_CONFIG.header_height_mm),
    footer_height_mm: clamp(source.footer_height_mm, 6, 35, DEFAULT_BUILDER_CONFIG.footer_height_mm),
    page_number_position: ['left', 'center', 'right'].includes(source.page_number_position) ? source.page_number_position : 'right',
    page_number_enabled: Boolean(source.page_number_enabled),
    hide_empty_columns: source.hide_empty_columns !== false,
    custom_header_html: String(source.custom_header_html || ''),
    custom_footer_html: String(source.custom_footer_html || ''),
    components,
  };
};

const currency = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const componentStyle = (component) => {
  const styles = [];
  if (component.padding) styles.push(`padding:${component.padding}px`);
  if (component.background_color) styles.push(`background:${component.background_color}`);
  if (component.border_width) styles.push(`border:${component.border_width}px solid ${component.border_color || '#dfe3eb'}`);
  if (component.text_color) styles.push(`color:${component.text_color}`);
  if (component.font_size) styles.push(`font-size:${component.font_size}px`);
  if (component.border_radius) styles.push(`border-radius:${component.border_radius}px`);
  if (component.max_width) styles.push(`max-width:${component.max_width}%;${component.text_align === 'right' ? 'margin-left:auto' : component.text_align === 'center' ? 'margin-left:auto;margin-right:auto' : ''}`);
  if (component.text_align && component.text_align !== 'left') styles.push(`text-align:${component.text_align}`);
  return styles.length ? ` style="${styles.join(';')}"` : '';
};

const wrapComponent = (component, html) => {
  if (!html || component.enabled === false) return '';
  const classes = [
    'builder-component',
    `builder-component--${esc(component.type)}`,
    component.page_break_before ? 'builder-component--break-before' : '',
    component.page_break_after ? 'builder-component--break-after' : '',
  ].filter(Boolean).join(' ');
  return `<section class="${classes}"${componentStyle(component)}>${html}</section>`;
};

const renderCompanyHeader = (data, component) => {
  const company = data.company || {};
  const settings = data.settings || {};
  const logo = settings.logo_url || company.company_logo || '';
  const cityLine = [company.company_city, company.company_state, company.company_pincode].filter(Boolean).join(', ');
  const addressLines = [company.company_address_line1, company.company_address_line2, cityLine].filter(Boolean);
  const contactLines = [company.company_phone, company.company_email, company.website].filter(Boolean);

  return `
    <div class="company-header">
      <div class="company-header__identity">
        ${component.show_logo !== false && logo ? `<img src="${esc(resolveAssetUrl(logo) || logo)}" alt="Company logo" />` : ''}
      </div>
      <div class="company-header__meta">
        ${component.show_address !== false ? addressLines.map((line) => `<span>${esc(line)}</span>`).join('') : ''}
        ${component.show_contact !== false ? contactLines.map((line) => `<span>${esc(line)}</span>`).join('') : ''}
      </div>
    </div>`;
};

const renderDocumentHeader = (data, component) => {
  const quotation = data.quotation || {};
  const rows = [];
  if (component.show_number !== false && quotation.quotation_number) rows.push(['Quotation No', quotation.quotation_number]);
  if (component.show_date !== false && quotation.quotation_date_formatted) rows.push(['Date', quotation.quotation_date_formatted]);
  if (component.show_valid_until !== false && quotation.valid_until_formatted) rows.push(['Valid Until', quotation.valid_until_formatted]);
  return `
    <div class="document-header">
      <div><h1>${esc(component.heading || 'Quotation')}</h1><span class="document-header__accent"></span></div>
      ${rows.length ? `<table>${rows.map(([label, value]) => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`).join('')}</table>` : ''}
    </div>`;
};

const renderClientDetails = (data, component) => {
  const quotation = data.quotation || {};
  const name = [quotation.first_name, quotation.last_name].filter(Boolean).join(' ').trim();
  const lines = [quotation.company_name, quotation.email, quotation.phone_number].filter(Boolean);
  const address = [quotation.billing_address, quotation.billing_city, quotation.billing_state, quotation.billing_pincode].filter(Boolean).join(', ');
  if (address) lines.push(address);
  if (!name && !lines.length) return '';
  return `
    <div class="client-card">
      <span class="eyebrow">${esc(component.heading || 'Prepared For')}</span>
      ${name ? `<strong>${esc(name)}</strong>` : ''}
      ${lines.map((line) => `<span>${esc(line)}</span>`).join('')}
    </div>`;
};

const COLUMN_DEFS = {
  image: { label: 'Image', value: (item) => item.image_url || '' },
  brand: { label: 'Brand', value: (item) => item.brand || '' },
  product: { label: 'Product', value: (item) => item.title || '' },
  description: { label: 'Description', value: (item) => stripHtml(item.description) },
  sku: { label: 'SKU', value: (item) => item.sku || '' },
  quantity: { label: 'Qty', value: (item) => item.qty },
  unit_price: { label: 'Unit Price', value: (item) => item.rate },
  selling_price_unit: { label: 'Unit', value: (item) => item.selling_price_unit || '' },
  discount: { label: 'Discount', value: (item) => Number(item.discount || 0) > 0 ? item.discount : '' },
  gst_rate: { label: 'GST %', value: (item) => Number(item.gst_rate || 0) > 0 ? item.gst_rate : '' },
  hsn_sac: { label: 'HSN / SAC', value: (item) => item.hsn_sac || '' },
  total: { label: 'Total', value: (item) => item.finalTotal },
};

const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';

const filterDisplayColumns = (quotation, config) => {
  const requested = Array.isArray(quotation.displayColumns) && quotation.displayColumns.length
    ? quotation.displayColumns
    : ['brand', 'product', 'description', 'quantity', 'unit_price', 'discount', 'gst_rate', 'total'];
  const items = (quotation.categoryGroups || []).flatMap((group) => group.items || []);
  let result = requested.filter((key) => COLUMN_DEFS[key]);

  if (config.hide_empty_columns !== false && items.length) {
    result = result.filter((key) => items.some((item) => hasValue(COLUMN_DEFS[key].value(item))));
  }

  if (!result.includes('product') && items.some((item) => hasValue(item.title))) result.unshift('product');
  if (!result.includes('total') && items.length) result.push('total');
  return [...new Set(result)];
};

const renderCell = (key, item) => {
  if (key === 'image') return item.image_url ? `<img class="item-image" src="${esc(item.image_url)}" alt="" />` : '';
  if (key === 'product') return `<strong class="item-title">${esc(item.title || '')}</strong>`;
  if (key === 'description') return `<div class="item-description">${item.description || ''}</div>`;
  if (key === 'quantity') return esc(item.qty ?? '');
  if (key === 'unit_price') return currency(item.rate);
  if (key === 'discount') return Number(item.discount || 0) > 0 ? `- ${currency(item.discount)}` : '';
  if (key === 'gst_rate') return Number(item.gst_rate || 0) > 0 ? `${Number(item.gst_rate)}%` : '';
  if (key === 'total') return currency(item.finalTotal);
  return esc(COLUMN_DEFS[key]?.value(item) ?? '');
};

const renderItemsTable = (data, component, config) => {
  const quotation = data.quotation || {};
  const groups = quotation.categoryGroups || [];
  const columns = filterDisplayColumns(quotation, config);
  if (!groups.length || !columns.length) return '';

  const tables = groups.map((group) => `
    <div class="item-group">
      ${group.show_category_heading ? `<h3 class="category-title">${esc(group.category_name || '')}</h3>` : ''}
      <table class="items-table">
        <thead><tr>${columns.map((key) => `<th class="col-${esc(key)}">${esc(COLUMN_DEFS[key].label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${(group.items || []).map((item) => `<tr>${columns.map((key) => `<td class="col-${esc(key)}">${renderCell(key, item)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      ${group.show_category_heading ? `<div class="category-total"><span>Category Total</span><strong>${currency(group.grand_total)}</strong></div>` : ''}
    </div>`).join('');

  return `${component.show_heading === false ? '' : `<h2 class="section-heading">${esc(component.heading || 'Quotation Items')}</h2>`}${tables}`;
};

const renderTotals = (data, component) => {
  const quotation = data.quotation || {};
  const rows = [];
  if (component.show_subtotal !== false) rows.push(['Sub Total', currency(quotation.subtotal)]);
  if (component.show_discount !== false && Number(quotation.cumulative_discount || 0) > 0) rows.push(['Total Discount', `- ${currency(quotation.cumulative_discount)}`]);
  if (component.show_grand_total !== false) rows.push(['Grand Total', currency(quotation.grand_total), true]);
  if (!rows.length) return '';
  return `<div class="totals-card">${rows.map(([label, value, grand]) => `<div class="${grand ? 'is-grand' : ''}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`;
};

const renderNotes = (data, component) => {
  const quotation = data.quotation || {};
  const settings = data.settings || {};
  const blocks = [];
  if (stripHtml(quotation.notes)) blocks.push(quotation.notes);
  if (stripHtml(settings.footer_notes_html)) blocks.push(settings.footer_notes_html);
  if (!blocks.length) return '';
  return `<h2 class="section-heading">${esc(component.heading || 'Notes')}</h2><div class="rich-content">${blocks.join('')}</div>`;
};

const renderTerms = (data, component) => {
  const html = data.settings?.terms_conditions_html || '';
  if (!stripHtml(html)) return '';
  return `<h2 class="section-heading">${esc(component.heading || 'Terms & Conditions')}</h2><div class="rich-content">${html}</div>`;
};

const renderCover = (data) => {
  const html = data.settings?.cover_letter_html || '';
  if (!stripHtml(html)) return '';
  const company = data.company || {};
  const logo = data.settings?.logo_url || company.company_logo || '';
  const quotation = data.quotation || {};
  const clientName = [quotation.first_name, quotation.last_name].filter(Boolean).join(' ').trim();
  return `
    <div class="cover-letter">
      ${logo ? `<img src="${esc(resolveAssetUrl(logo) || logo)}" alt="Company logo" />` : ''}
      ${clientName || quotation.company_name ? `<div class="cover-letter__to"><span>To</span>${clientName ? `<strong>${esc(clientName)}</strong>` : ''}${quotation.company_name ? `<span>${esc(quotation.company_name)}</span>` : ''}</div>` : ''}
      <div class="rich-content">${html}</div>
    </div>`;
};

const renderComponent = (data, component, config) => {
  if (component.enabled === false) return '';
  switch (component.type) {
    case 'company_header': return wrapComponent(component, renderCompanyHeader(data, component));
    case 'document_header': return wrapComponent(component, renderDocumentHeader(data, component));
    case 'client_details': return wrapComponent(component, renderClientDetails(data, component));
    case 'items_table': return wrapComponent(component, renderItemsTable(data, component, config));
    case 'totals': return wrapComponent(component, renderTotals(data, component));
    case 'notes': return wrapComponent(component, renderNotes(data, component));
    case 'terms_conditions': return wrapComponent(component, renderTerms(data, component));
    case 'cover_letter': return wrapComponent(component, renderCover(data));
    case 'custom_content': return wrapComponent(component, stripHtml(component.html) ? `<div class="rich-content">${component.html}</div>` : '');
    case 'divider': return wrapComponent(component, '<hr class="builder-divider" />');
    case 'spacer': return wrapComponent(component, `<div style="height:${clamp(component.height, 4, 120, 24)}px"></div>`);
    default: return '';
  }
};

const renderScreenChrome = (config) => {
  const header = stripHtml(config.custom_header_html)
    ? `<div class="screen-running-header"><div>${config.custom_header_html}</div></div>`
    : '';
  const footerParts = [];
  if (stripHtml(config.custom_footer_html)) footerParts.push(`<div>${config.custom_footer_html}</div>`);
  if (config.page_number_enabled) footerParts.push('<div class="screen-page-number">Page 1</div>');
  const footer = footerParts.length
    ? `<div class="screen-running-footer screen-running-footer--${config.page_number_position}"><div>${footerParts.join('')}</div></div>`
    : '';
  return { header, footer };
};

const buildDocumentCss = (config) => `
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#eef2f6;color:${config.text_color};font-family:'${config.font_family}',Arial,sans-serif;font-size:${config.font_size}px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{min-height:100vh}.quotation-preview-stage{position:relative;min-height:297mm}.quotation-document{margin:16px auto;background:#fff;box-shadow:0 3px 18px rgba(33,51,67,.15)}
.document-shell{min-height:297mm;padding:${config.page_margin_top}mm ${config.page_margin_right}mm ${config.page_margin_bottom}mm ${config.page_margin_left}mm;display:flex;flex-direction:column}.document-body{display:block}.builder-component+.builder-component{margin-top:${config.section_spacing}px}
.builder-component{break-inside:auto}.builder-component--break-before,.builder-component--terms_conditions{break-before:page;page-break-before:always}.builder-component--break-after{break-after:page;page-break-after:always}.builder-component:empty{display:none}
@media screen{html,body{overflow-x:hidden}.quotation-preview-stage{width:100%}.quotation-document{position:absolute;top:16px;left:50%;width:210mm;min-height:297mm;margin:0;transform-origin:top center}.builder-component--break-before{margin-top:18mm;padding-top:8mm;border-top:2px dashed #b8c7d5}.builder-component--break-after{margin-bottom:18mm;padding-bottom:8mm;border-bottom:2px dashed #b8c7d5}}
.company-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-bottom:12px;border-bottom:1px solid #e3e9ee}.company-header__identity{display:flex;align-items:center;min-width:0;flex:0 1 45%}.company-header__identity img{max-width:150px;max-height:52px;object-fit:contain}.company-header__meta{display:grid;gap:1px;flex:0 1 45%;max-width:45%;min-width:0;text-align:right;color:${config.muted_color};font-size:.85em;overflow-wrap:anywhere;word-break:break-word}.company-header__meta span{max-width:100%}
.document-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}.document-header h1{margin:0;color:${config.primary_color};font-size:2.15em;line-height:1.05;text-transform:uppercase;letter-spacing:.04em}.document-header__accent{display:block;width:58px;height:3px;margin-top:8px;background:${config.accent_color}}.document-header table{border-collapse:collapse}.document-header td{padding:2px 0}.document-header td:first-child{padding-right:14px;color:${config.muted_color};text-align:right}.document-header td:last-child{font-weight:700}
.client-card{display:grid;gap:2px;padding:13px 15px;border:1px solid #dfe5eb;background:#f8fafb}.client-card .eyebrow{color:${config.muted_color};font-size:.75em;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.client-card strong{font-size:1.2em;color:${config.text_color}}
.section-heading{display:table;max-width:100%;margin:0 0 12px;padding-bottom:4px;border-bottom:2px solid ${config.accent_color};color:${config.primary_color};font-size:1em;text-transform:uppercase;letter-spacing:.05em}.category-title{margin:12px 0 8px;padding:6px 10px;border-left:3px solid ${config.accent_color};background:#f7f9fb;color:${config.primary_color};font-size:1em}
.item-group{break-inside:auto}.items-table{width:100%;border-collapse:collapse;font-size:.9em;table-layout:auto}.items-table thead{display:table-header-group}.items-table th{padding:7px 6px;background:${config.primary_color};color:#fff;font-size:.8em;text-transform:uppercase;letter-spacing:.03em;text-align:center;vertical-align:middle}.items-table td{padding:7px 6px;border-bottom:1px solid #e5ebef;text-align:center;vertical-align:top;overflow-wrap:anywhere}.items-table tbody tr:nth-child(even){background:#fafcfd}.items-table .col-product,.items-table .col-description,.items-table .col-brand{text-align:left}.item-image{width:44px;height:38px;object-fit:contain;display:block;margin:auto}.item-title{color:${config.text_color}}.item-description{font-size:.95em;color:${config.muted_color};line-height:1.45}.item-description p{margin:0 0 3px}.item-description ul,.item-description ol{margin:3px 0;padding-left:16px}.category-total{display:flex;justify-content:flex-end;gap:18px;padding:6px 8px;color:${config.muted_color}}.category-total strong{color:${config.text_color}}
.totals-card{width:min(280px,100%);margin-left:auto;border-top:2px solid ${config.primary_color}}.totals-card>div{display:flex;justify-content:space-between;gap:24px;padding:6px 10px;border-bottom:1px solid #e5ebef}.totals-card span{color:${config.muted_color}}.totals-card .is-grand{background:${config.primary_color};color:#fff;border:0}.totals-card .is-grand span,.totals-card .is-grand strong{color:#fff}
.rich-content{color:${config.muted_color};line-height:1.6}.rich-content p{margin:4px 0}.rich-content ul,.rich-content ol{margin:6px 0;padding-left:20px}.rich-content h1,.rich-content h2,.rich-content h3{color:${config.primary_color};margin:8px 0 4px}.rich-content img{max-width:100%;height:auto}.builder-divider{margin:0;border:0;border-top:1px solid #dfe5eb}
.cover-letter{min-height:245mm;display:flex;flex-direction:column;gap:24px}.cover-letter>img{display:block;max-width:180px;max-height:70px;object-fit:contain;margin:0 auto 8px}.cover-letter__to{display:grid;gap:2px}.cover-letter__to>span:first-child{color:${config.muted_color};font-size:.8em;text-transform:uppercase;letter-spacing:.08em}.cover-letter__to strong{font-size:1.15em}
.screen-running-header{height:${config.header_height_mm}mm;flex:0 0 ${config.header_height_mm}mm;display:flex;align-items:flex-end;overflow:hidden;color:${config.muted_color};font-size:${Math.max(8, config.font_size - 2)}px;line-height:1.35}.screen-running-header>div{width:100%;padding-bottom:3mm;border-bottom:1px solid #dfe5eb}.screen-running-header p,.screen-running-footer p{margin:0}.screen-running-header ul,.screen-running-header ol,.screen-running-footer ul,.screen-running-footer ol{margin:0;padding-left:16px}.screen-running-header img{max-height:${Math.max(12, config.header_height_mm - 4)}mm;max-width:100%;object-fit:contain}.screen-running-footer{height:${config.footer_height_mm}mm;flex:0 0 ${config.footer_height_mm}mm;display:flex;align-items:flex-start;margin-top:auto;overflow:hidden;color:${config.muted_color};font-size:${Math.max(8, config.font_size - 3)}px;line-height:1.3}.screen-running-footer>div{width:100%;padding-top:2.5mm;border-top:1px solid #dfe5eb}.screen-running-footer img{max-height:${Math.max(10, config.footer_height_mm - 4)}mm;max-width:100%;object-fit:contain}.screen-running-footer--left .screen-page-number{text-align:left}.screen-running-footer--center .screen-page-number{text-align:center}.screen-running-footer--right .screen-page-number{text-align:right}.screen-page-number{margin-top:1mm;white-space:nowrap}
@page{size:A4;margin:${config.page_margin_top}mm ${config.page_margin_right}mm ${config.page_margin_bottom}mm ${config.page_margin_left}mm}@media print{html,body{background:#fff}.quotation-preview-stage{position:static;min-height:0;height:auto!important}.quotation-document{position:static;width:auto;min-height:0;margin:0;transform:none!important;box-shadow:none}.document-shell{min-height:calc(297mm - ${config.page_margin_top}mm - ${config.page_margin_bottom}mm);padding:0}.builder-component--cover_letter{min-height:0}.cover-letter{min-height:0}tr,.client-card,.totals-card{break-inside:avoid;page-break-inside:avoid}.items-table{break-inside:auto}}
`;

// Keep browser previews at the same physical A4 width as exported PDFs, then
// scale the complete page to its iframe. A responsive document viewport would
// otherwise change wrapping, gaps and table widths before export.
const buildPreviewScaleScript = () => `<script>(function(){
  function fitQuotationPreview(){
    if(window.matchMedia&&window.matchMedia('print').matches)return;
    var stage=document.querySelector('.quotation-preview-stage');
    var page=document.querySelector('.quotation-document');
    if(!stage||!page)return;
    var available=Math.max(1,window.innerWidth-32);
    var scale=Math.min(1,available/page.offsetWidth);
    page.style.transform='translateX(-50%) scale('+scale+')';
    stage.style.height=Math.ceil((page.scrollHeight*scale)+32)+'px';
  }
  window.addEventListener('resize',fitQuotationPreview);
  window.addEventListener('load',fitQuotationPreview);
  document.addEventListener('DOMContentLoaded',fitQuotationPreview);
  setTimeout(fitQuotationPreview,0);
  setTimeout(fitQuotationPreview,250);
}());</script>`;

const renderQuotationDocument = (data = {}) => {
  const config = normalizeBuilderConfig(data.settings?.template_config || data.settings?.template_config_json, data.settings?.layout_option);
  const screenChrome = renderScreenChrome(config);
  const body = config.components.map((component) => renderComponent(data, component, config)).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>${buildDocumentCss(config)}</style></head><body><div class="quotation-preview-stage"><main class="quotation-document"><div class="document-shell">${screenChrome.header}<div class="document-body">${body}</div>${screenChrome.footer}</div></main></div>${buildPreviewScaleScript()}</body></html>`;
};

const getPdfPayloadOverrides = () => ({
    format: 'A4',
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: false,
    margin: {
      top: '0mm',
      right: '0mm',
      bottom: '0mm',
      left: '0mm',
    },
  });

module.exports = {
  DEFAULT_BUILDER_CONFIG,
  normalizeBuilderConfig,
  renderQuotationDocument,
  getPdfPayloadOverrides,
  filterDisplayColumns,
};
