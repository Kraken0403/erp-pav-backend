const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node debug_hb_tokens.js <template.html>');
  process.exit(2);
}

const src = fs.readFileSync(file, 'utf8');

const tokenRegex = /{{\s*(#|\/|\^|else|else if)?\s*([^}]*)}}/g;

const stack = [];
let m;
let line = 1;
const lines = src.split(/\r?\n/);

function toLine(pos) {
  let s = src.slice(0, pos);
  return s.split(/\r?\n/).length;
}

while ((m = tokenRegex.exec(src)) !== null) {
  const full = m[0];
  const kind = m[1] || '';
  const name = m[2].trim();
  const pos = m.index;
  const ln = toLine(pos);

  console.log('TOKEN at line', ln, ':', full.replace(/\n/g, '\\n'));

  if (kind === '#') {
    const blockName = name.split(/[\s\}]/)[0];
    console.log('  -> OPEN block', blockName);
    stack.push({name: blockName, line: ln});
  } else if (kind === '/') {
    const blockName = name.split(/[\s\}]/)[0];
    const top = stack.pop();
    console.log('  -> CLOSE block', blockName);
    if (!top) {
      console.log('Unmatched end block', blockName, 'at line', ln);
    } else if (top.name !== blockName) {
      console.log('Mismatched end block at line', ln, 'expected /' + top.name, 'got /' + blockName);
    }
  } else if (kind === '^') {
    const blockName = name.split(/[\s\}]/)[0];
    console.log('  -> OPEN inverse', blockName);
    stack.push({name: blockName, line: ln});
  } else if (kind === 'else' || (kind === 'else if')) {
    console.log('  -> ELSE token');
  }
}

if (stack.length) {
  console.log('Unclosed blocks:');
  stack.forEach(s => console.log('-', s.name, 'opened at line', s.line));
} else {
  console.log('No unclosed blocks found.');
}
