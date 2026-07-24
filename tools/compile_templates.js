const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const templatesDir = path.join(__dirname, '..', 'templates', 'quotations');

function compileFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  try {
    Handlebars.precompile(src);
    console.log('OK:', path.relative(process.cwd(), filePath));
    return null;
  } catch (err) {
    console.error('ERROR:', path.relative(process.cwd(), filePath));
    console.error(err && err.message ? err.message : err);
    return err;
  }
}

function main() {
  if (!fs.existsSync(templatesDir)) {
    console.error('Templates directory not found:', templatesDir);
    process.exit(2);
  }
  const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.html'));
  let failed = 0;
  for (const f of files) {
    const full = path.join(templatesDir, f);
    const err = compileFile(full);
    if (err) failed++;
  }
  if (failed) process.exit(1);
}

main();
