const fs = require('fs');
const path = require('path');
const { loadTemplate } = require('../services/templateLoader');
const { formatDate } = require('../utils/dateFormatter');

(async () => {
  try {
    const data = {
      template: 'minimal',
      mode: 'GENERAL',
      quotation: {
        quotation_number: 'Q-0001',
        quotation_date_formatted: '18 Mar 2026',
        valid_until_formatted: '25 Mar 2026',
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'ACME Pvt Ltd',
        email: 'john@acme.test',
        phone_number: '9999999999',
        notes: '',
        categoryGroups: [
          {
            category_name: 'Default',
            items: [
              { title: 'Sample Item A', brand: 'BrandX', sku: 'SKU-A', description: 'A short description', qty: 2, rate: 500, finalTotal: 1000, discount: 0 }
            ],
            sub_total: 1000,
            discount_total: 0,
            tax_total: 0,
            grand_total: 1000
          }
        ],
        grand_total: 1000
      },
      settings: {
        cover_letter_html: '<p>This is a cover letter example.</p>',
        layout_option: 'minimal',
        terms_conditions_html: '<p>These are the terms and conditions.</p>',
        footer_notes_html: '',
        logo_url: ''
      },
      company: {
        company_name: 'Zoans',
        company_logo: '',
        company_address_line1: '123 Street',
        company_address_line2: '',
        company_city: 'City',
        company_state: 'State',
        company_pincode: '000000',
        company_phone: '0123456789',
        company_email: 'info@zoans.test',
        gst_number: ''
      },
      today: formatDate(new Date())
    };

    const html = loadTemplate(data);

    const outDir = path.join(__dirname, '..', 'tmp');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, 'quotation_preview_minimal.html');
    fs.writeFileSync(outPath, html, 'utf8');
    console.log('Wrote preview to', outPath);
  } catch (err) {
    console.error('Error rendering preview:', err);
    process.exit(1);
  }
})();
