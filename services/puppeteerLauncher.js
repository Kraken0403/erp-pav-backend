const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
];

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const expandWildcardPath = (candidatePath) => {
    const normalizedPath = path.normalize(candidatePath);
    if (!normalizedPath.includes('*')) return [normalizedPath];

    const { root } = path.parse(normalizedPath);
    const segments = normalizedPath
        .slice(root.length)
        .split(path.sep)
        .filter(Boolean);
    let matches = [root || '.'];

    for (const segment of segments) {
        const nextMatches = [];
        const hasWildcard = segment.includes('*');
        const matcher = hasWildcard
            ? new RegExp(`^${segment.split('*').map(escapeRegExp).join('.*')}$`)
            : null;

        for (const basePath of matches) {
            if (!hasWildcard) {
                nextMatches.push(path.join(basePath, segment));
                continue;
            }

            try {
                for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
                    if (matcher.test(entry.name)) {
                        nextMatches.push(path.join(basePath, entry.name));
                    }
                }
            } catch (error) {
                // Ignore missing cache directories and continue with other candidates.
            }
        }

        matches = nextMatches;
    }

    return matches;
};

const getCandidateExecutablePaths = () => {
    const candidates = [];
    const addCandidate = (candidatePath) => {
        if (candidatePath) candidates.push(candidatePath);
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        addCandidate(process.env.PUPPETEER_EXECUTABLE_PATH);
    }

    try {
        const detected = puppeteer.executablePath();
        addCandidate(detected);
    } catch (error) {
        // Ignore and continue with common browser install paths.
    }

    [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        '/opt/render/project/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ].forEach(addCandidate);

    return [...new Set(candidates.flatMap(expandWildcardPath))].filter((candidatePath) => {
        return fs.existsSync(candidatePath);
    });
};

const launchPdfBrowser = async () => {
    const commonOptions = {
        headless: 'new',
        args: BASE_ARGS,
    };

    try {
        return await puppeteer.launch(commonOptions);
    } catch (firstError) {
        const candidatePaths = getCandidateExecutablePaths();
        let lastError = firstError;

        for (const executablePath of candidatePaths) {
            try {
                return await puppeteer.launch({
                    ...commonOptions,
                    executablePath,
                });
            } catch (error) {
                lastError = error;
            }
        }

        const errorMessage = String(lastError?.message || firstError?.message || 'Failed to launch Chrome');
        throw new Error(
            `${errorMessage}. Install Chrome/Edge, set PUPPETEER_EXECUTABLE_PATH, or run \"npm run install:browser\" during build.`
        );
    }
};

module.exports = {
    launchPdfBrowser,
};
