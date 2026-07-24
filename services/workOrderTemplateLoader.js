const fs = require('fs')
const path = require('path')
const Handlebars = require('handlebars')

require('./handlebarsHelpers')

exports.loadWorkOrderTemplate = (data) => {
  const templatePath = path.join(
    __dirname,
    '../templates/workorders/default.html'
  )

  const cssPath = path.join(
    __dirname,
    '../templates/workorders/base.css'
  )

  if (!fs.existsSync(templatePath)) {
    throw new Error('Work Order template not found')
  }

  const templateSource = fs.readFileSync(templatePath, 'utf8')
  const baseCss = fs.readFileSync(cssPath, 'utf8')

  const template = Handlebars.compile(templateSource)

  return template({
    ...data,
    baseCss,
  })
}
