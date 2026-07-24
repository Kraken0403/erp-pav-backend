const fs = require('fs')
const path = require('path')
const uploadMiddleware = require('../middleware/upload')

function getBackendBaseUrl() {
  return (
    process.env.BACKEND_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    `http://localhost:${process.env.PORT || 5000}`
  ).replace(/\/$/, '')
}

function extractUploadsPath(value) {
  const pathname = decodeURIComponent(String(value || '')).replace(/\\/g, '/')
  const match = pathname.match(/(?:^|\/)uploads\/.+$/i)
  return match ? match[0].replace(/^\/+/, '') : ''
}

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter((candidate) => {
    if (!candidate) return false
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function getLocalUploadPath(url) {
  if (!url) return ''
  const raw = String(url).trim()
  if (!raw || /^data:/i.test(raw)) return ''

  let uploadPath = ''

  if (/^https?:\/\//i.test(raw)) {
    try {
      uploadPath = extractUploadsPath(new URL(raw).pathname)
    } catch {
      uploadPath = extractUploadsPath(raw)
    }
  } else {
    uploadPath = extractUploadsPath(raw)
  }

  if (!uploadPath) return ''

  const relativeUploadPath = uploadPath.replace(/^uploads\/?/i, '')
  const candidates = uniquePaths([
    process.env.UPLOADS_DIR ? path.join(process.env.UPLOADS_DIR, relativeUploadPath) : '',
    uploadMiddleware.baseUploads ? path.join(uploadMiddleware.baseUploads, relativeUploadPath) : '',
    path.join(__dirname, '..', uploadPath),
    path.join(__dirname, '..', '..', uploadPath),
    path.resolve(process.cwd(), uploadPath),
    path.resolve(process.cwd(), '..', uploadPath),
  ])

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  }) || ''
}

function guessImageMime(filePathOrUrl) {
  const clean = String(filePathOrUrl || '').split('?')[0].split('#')[0].toLowerCase()
  if (clean.endsWith('.png')) return 'image/png'
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg'
  if (clean.endsWith('.webp')) return 'image/webp'
  if (clean.endsWith('.gif')) return 'image/gif'
  if (clean.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

function resolveAssetUrl(url) {
  if (!url) return ''
  const raw = String(url).trim()
  const baseUrl = getBackendBaseUrl()

  if (/^data:/i.test(raw)) return raw

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      const uploadPath = extractUploadsPath(parsed.pathname)
      if (uploadPath) {
        return `${baseUrl}/${uploadPath}${parsed.search || ''}${parsed.hash || ''}`
      }
    } catch {
      // keep raw when parse fails
    }
    return raw
  }

  return `${baseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`
}

function resolvePdfAsset(url, options = {}) {
  if (!url) return ''
  const raw = String(url).trim()
  if (!raw) return ''
  if (/^data:/i.test(raw)) return raw

  const localPath = getLocalUploadPath(raw)
  if (localPath) {
    try {
      const buffer = fs.readFileSync(localPath)
      return `data:${guessImageMime(localPath)};base64,${buffer.toString('base64')}`
    } catch (error) {
      console.warn('[PDFAssetResolver] Failed to inline PDF asset:', error.message)
    }
  }

  if (options.requireLocalUpload && extractUploadsPath(raw)) {
    return ''
  }

  return resolveAssetUrl(raw)
}

function resolvePreferredPdfLogo(...urls) {
  for (const url of urls) {
    const resolved = resolvePdfAsset(url, { requireLocalUpload: true })
    if (resolved) return resolved
  }
  return ''
}

module.exports = {
  extractUploadsPath,
  getLocalUploadPath,
  resolveAssetUrl,
  resolvePdfAsset,
  resolvePreferredPdfLogo,
}
