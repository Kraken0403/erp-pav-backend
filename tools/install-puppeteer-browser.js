const { spawnSync } = require('child_process');

const truthy = new Set(['1', 'true', 'yes', 'y']);
const shouldInstall = truthy.has(String(process.env.PUPPETEER_INSTALL_BROWSER || '').toLowerCase());

if (!shouldInstall) {
    console.log('Skipping Puppeteer browser download. Set PUPPETEER_INSTALL_BROWSER=true to install bundled Chrome.');
    process.exit(0);
}

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npxCommand, ['puppeteer', 'browsers', 'install', 'chrome'], {
    stdio: 'inherit',
});

process.exit(result.status || 0);
