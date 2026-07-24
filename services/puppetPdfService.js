const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const uploadMiddleware = require('../middleware/upload');

const DEFAULT_PUPPET_API_URL = 'https://puppetapi.lawsuitcasefinder.com/api/getPDFbyURL';

const getPuppetApiUrl = () => {
    return (
        process.env.PUPPET_PDF_API_URL ||
        process.env.PUPPET_API_URL ||
        DEFAULT_PUPPET_API_URL
    );
};

const normalizePdfBuffer = (data) => {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer);
    if (typeof data === 'string') {
        try {
            return Buffer.from(data, 'base64');
        } catch (_) {
            return Buffer.from(data);
        }
    }
    return Buffer.from(data || '');
};

const guessMimeType = (assetUrl, contentType = '') => {
    const headerMime = String(contentType || '').split(';')[0].trim();
    if (headerMime) return headerMime;

    const cleanUrl = String(assetUrl || '').split('?')[0].split('#')[0].toLowerCase();
    if (cleanUrl.endsWith('.png')) return 'image/png';
    if (cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg')) return 'image/jpeg';
    if (cleanUrl.endsWith('.gif')) return 'image/gif';
    if (cleanUrl.endsWith('.webp')) return 'image/webp';
    if (cleanUrl.endsWith('.svg')) return 'image/svg+xml';
    if (cleanUrl.endsWith('.css')) return 'text/css';
    return 'application/octet-stream';
};

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isSkippableAsset = (value) => {
    const url = String(value || '').trim().toLowerCase();
    return (
        !url ||
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url.startsWith('javascript:') ||
        url.startsWith('#')
    );
};

const resolveAssetUrl = (asset, baseUrl) => {
    const raw = String(asset || '').trim();
    if (isSkippableAsset(raw)) return '';

    if (/^https?:\/\//i.test(raw)) return raw;
    if (!baseUrl) return raw;

    try {
        return new URL(raw, baseUrl).toString();
    } catch (_) {
        return raw;
    }
};

const getBackendBaseUrl = () => {
    return (
        process.env.BACKEND_PUBLIC_URL ||
        process.env.BACKEND_URL ||
        `http://localhost:${process.env.PORT || 5000}`
    );
};

const getBackendPathPrefix = () => {
    try {
        const parsed = new URL(getBackendBaseUrl());
        const prefix = String(parsed.pathname || '').replace(/\/+$/, '');
        return prefix && prefix !== '/' ? prefix : '';
    } catch (_) {
        return '';
    }
};

const readLocalAsset = async (assetUrl) => {
    try {
        const parsed = new URL(assetUrl);
        const rawPathname = decodeURIComponent(parsed.pathname || '');
        const backendPrefix = getBackendPathPrefix();
        let pathname = rawPathname;

        // Normalize /backend/uploads/... -> uploads/...
        if (backendPrefix && pathname.startsWith(`${backendPrefix}/`)) {
            pathname = pathname.slice(backendPrefix.length);
        }
        pathname = pathname.replace(/^\/+/, '');
        const uploadsIdx = pathname.toLowerCase().indexOf('uploads/');
        if (uploadsIdx > 0) pathname = pathname.slice(uploadsIdx);

        const candidates = [path.join(__dirname, '..', pathname)];

        // uploads may live outside repo (UPLOADS_DIR / ../uploads); try that too.
        if (pathname.startsWith('uploads/')) {
            const relUploadPath = pathname.replace(/^uploads\/?/, '');
            candidates.push(path.join(uploadMiddleware.baseUploads || '', relUploadPath));
        }

        let buffer = null;
        let resolvedPath = '';
        for (const candidate of candidates) {
            try {
                buffer = await fs.readFile(candidate);
                resolvedPath = candidate;
                break;
            } catch (_) {
                // try next candidate
            }
        }

        if (!buffer) return null;

        return {
            data: buffer,
            contentType: guessMimeType(resolvedPath || pathname),
        };
    } catch (_) {
        return null;
    }
};

const downloadAsset = async (assetUrl) => {
    try {
        const response = await axios.get(assetUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });

        return {
            data: Buffer.from(response.data),
            contentType: response.headers?.['content-type'] || '',
        };
    } catch (_) {
        // Fallback for local/private URLs or any /uploads path unavailable over HTTP.
        if (/localhost|127\.0\.0\.1/i.test(assetUrl) || /\/uploads\//i.test(assetUrl)) {
            return readLocalAsset(assetUrl);
        }
        return null;
    }
};

const collectAssetUrls = (html) => {
    const urls = new Set();
    const source = String(html || '');

    const imgRegex = /<img\b[^>]*\bsrc=(['"])(.*?)\1/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(source)) !== null) {
        const value = String(imgMatch[2] || '').trim();
        if (!isSkippableAsset(value)) urls.add(value);
    }

    const cssUrlRegex = /url\((['"]?)([^'")]+)\1\)/gi;
    let cssMatch;
    while ((cssMatch = cssUrlRegex.exec(source)) !== null) {
        const value = String(cssMatch[2] || '').trim();
        if (!isSkippableAsset(value)) urls.add(value);
    }

    return Array.from(urls);
};

const inlineHtmlAssets = async (html, baseUrl) => {
    let resultHtml = String(html || '');
    const discoveredUrls = collectAssetUrls(resultHtml);
    if (!discoveredUrls.length) return resultHtml;

    const replacements = new Map();

    for (const originalUrl of discoveredUrls) {
        const absoluteUrl = resolveAssetUrl(originalUrl, baseUrl);
        if (isSkippableAsset(absoluteUrl)) continue;

        const asset = await downloadAsset(absoluteUrl);
        if (!asset || !asset.data || !asset.data.length) continue;

        const mimeType = guessMimeType(absoluteUrl, asset.contentType);
        const dataUri = `data:${mimeType};base64,${asset.data.toString('base64')}`;
        replacements.set(originalUrl, dataUri);

        // For absolute-path references that appear in CSS/HTML after URL normalization.
        const absolutePathOnly = absoluteUrl.replace(/^https?:\/\/[^/]+/i, '');
        if (absolutePathOnly && absolutePathOnly !== originalUrl) {
            replacements.set(absolutePathOnly, dataUri);
        }
    }

    for (const [from, to] of replacements.entries()) {
        resultHtml = resultHtml.replace(new RegExp(escapeRegExp(from), 'g'), to);
    }

    return resultHtml;
};

const buildDefaultPayload = (html) => {
    return {
        height: 0,
        format: 'A4',
        content: html,
        emulateMedia: 'print',
        sendmail: false,
        displayHeaderFooter: false,
        margin: {
            top: '20mm',
            bottom: '20mm',
            right: '15mm',
            left: '15mm',
        },
        printBackground: true,
        waitFor: 0,
    };
};

const requestPdf = async (payload) => {
    const response = await axios.post(getPuppetApiUrl(), payload, {
        responseType: 'arraybuffer',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/pdf, application/octet-stream, */*',
        },
        timeout: 180000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    const pdfBuffer = normalizePdfBuffer(response.data);
    if (!pdfBuffer || pdfBuffer.length === 0) {
        throw new Error('Puppet API returned an empty PDF buffer');
    }

    return pdfBuffer;
};

exports.generatePdfFromHtml = async (html, options = {}) => {
    const baseUrl = options.baseUrl || getBackendBaseUrl();
    const shouldInlineAssets = options.inlineAssets !== false;
    const preparedHtml = shouldInlineAssets
        ? await inlineHtmlAssets(html, baseUrl)
        : String(html || '');

    const payloadOverrides = { ...(options.payloadOverrides || {}) };
    if (shouldInlineAssets && payloadOverrides.headerTemplate) {
        payloadOverrides.headerTemplate = await inlineHtmlAssets(payloadOverrides.headerTemplate, baseUrl);
    }
    if (shouldInlineAssets && payloadOverrides.footerTemplate) {
        payloadOverrides.footerTemplate = await inlineHtmlAssets(payloadOverrides.footerTemplate, baseUrl);
    }

    const payload = {
        ...buildDefaultPayload(preparedHtml),
        ...payloadOverrides,
        content: preparedHtml,
    };

    return requestPdf(payload);
};

exports.generatePdfFromPayload = async (payload, options = {}) => {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Valid payload is required');
    }

    if (!payload.content || typeof payload.content !== 'string') {
        throw new Error('Payload must include HTML content as a string');
    }

    const baseUrl = options.baseUrl || getBackendBaseUrl();
    const shouldInlineAssets = options.inlineAssets !== false;
    const preparedHtml = shouldInlineAssets
        ? await inlineHtmlAssets(payload.content, baseUrl)
        : payload.content;

    let headerTemplate = payload.headerTemplate;
    let footerTemplate = payload.footerTemplate;
    if (shouldInlineAssets && headerTemplate) {
        headerTemplate = await inlineHtmlAssets(headerTemplate, baseUrl);
    }
    if (shouldInlineAssets && footerTemplate) {
        footerTemplate = await inlineHtmlAssets(footerTemplate, baseUrl);
    }

    const finalPayload = {
        ...payload,
        content: preparedHtml,
        headerTemplate,
        footerTemplate,
    };

    return requestPdf(finalPayload);
};
