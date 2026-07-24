const fs = require('fs')
const path = require('path')
const Handlebars = require('handlebars')

require('./handlebarsHelpers')

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const buildQuotationPageHeader = (data = {}) => {
  const company = data.company || {}
  const settings = data.settings || {}
  const logo = settings.logo_url || company.company_logo || ''
  const cityLine = [company.company_city, company.company_state, company.company_pincode]
    .filter(Boolean)
    .join(', ')

  const addressLines = [
    company.company_address_line1,
    company.company_address_line2,
    cityLine,
    company.company_phone ? `Ph: ${company.company_phone}` : '',
    company.company_email,
  ].filter(Boolean)

  return `
<table class="pdf-page-table">
  <thead>
    <tr>
      <td>
        <div class="pdf-page-header">
          <div class="pdf-page-header-logo">
            ${logo ? `<img src="${escapeHtml(logo)}" alt="Company logo" />` : ''}
          </div>
          <div class="pdf-page-header-address">
            ${addressLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
          </div>
        </div>
      </td>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>
`
}

const wrapQuotationContentWithRepeatingHeader = (html, data) => {
  const openMarker = /<div class="quotation-content">/i
  const closeMarker = /<\/div>\s*<!--\s*\/\.quotation-content\s*-->/i

  if (!openMarker.test(html) || !closeMarker.test(html)) {
    return html
  }

  const header = buildQuotationPageHeader(data)

  return html
    .replace(openMarker, `${header}<div class="quotation-content">`)
    .replace(closeMarker, (match) => `${match}
      </td>
    </tr>
  </tbody>
</table>`)
}

exports.loadTemplate = (data) => {
  // ✅ TEMPLATE IS INDEPENDENT OF MODE
  const templateName = data.template || 'general'

  const templatePath = path.join(
    __dirname,
    `../templates/quotations/${templateName}.html`
  )

  console.log('📄 USING TEMPLATE:', templatePath)

  const cssPath = path.join(
    __dirname,
    '../templates/quotations/base.css'
  )

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Quotation template not found: ${templateName}.html`)
  }

  const templateSource = fs.readFileSync(templatePath, 'utf8')
  const baseCss = fs.readFileSync(cssPath, 'utf8')

  // Inject CSS via string replacement BEFORE Handlebars compilation.
  // This is formatter-proof: <style id="base-css"></style> won't be
  // mangled by HTML/Prettier formatters unlike {{{baseCss}}}.
  const sourceWithCss = templateSource.replace(
    '<style id="base-css"></style>',
    `<style>${baseCss}</style>`
  )

  const template = Handlebars.compile(sourceWithCss)

  let html = template(data)

  html = wrapQuotationContentWithRepeatingHeader(html, data)

  // Inject window.quotationNotes and window.footerNotesHtml for JS Notes logic
  // Find </body> and inject before it
  const notesScript = `\n<script>\nwindow.quotationNotes = ${JSON.stringify(data.quotation?.notes || '')};\nwindow.footerNotesHtml = ${JSON.stringify(data.settings?.footer_notes_html || '')};\n</script>\n`;
  html = html.replace(/<\/body>/i, notesScript + '</body>');
  return html
}
