const fs = require('fs')
const path = require('path')

const { generateHtml } = require('../services/invoicePdfService')

async function run(id) {
  try {
    const html = await generateHtml(id)
    const out = path.join(require('os').tmpdir(), `invoice_preview_${id}.html`)
    fs.writeFileSync(out, html, 'utf8')
    console.log('WROTE', out)
    console.log('--- START ---')
    console.log(html.slice(0, 2000))
    console.log('--- END ---')
  } catch (err) {
    console.error('ERROR', err && err.message)
    if (err && err.stack) console.error(err.stack)
    process.exit(1)
  }
}

const id = process.argv[2] || '1'
run(id)
