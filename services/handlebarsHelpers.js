const Handlebars = require('handlebars')

const registerHelpers = (hb = Handlebars) => {
  hb.registerHelper('inc', (v) => Number(v) + 1)

  hb.registerHelper('eq', (a, b) => a === b)

  hb.registerHelper('hasColumn', (columns, key) => Array.isArray(columns) && columns.includes(key))

  hb.registerHelper('currency', (v) => {
    const n = Number(v)
    if (Number.isNaN(n)) return ''
    return `₹ ${n.toFixed(2)}`
  })
}

// Register on the default instance for existing imports
registerHelpers(Handlebars)

module.exports = { registerHelpers }
