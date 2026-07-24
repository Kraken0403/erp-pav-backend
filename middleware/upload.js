const multer = require('multer')
const path = require('path')
const fs = require('fs')

// Base uploads directory can be overridden by environment variable UPLOADS_DIR
// In Hostinger, set UPLOADS_DIR to the absolute path of the nodejs/uploads folder.
// Default to a persistent uploads folder one level above the app cwd
// so deployments that replace the repo won't delete uploads.
const baseUploads = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(process.cwd(), '..', 'uploads')

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

// Ensure base exists at require-time
ensureDir(baseUploads)

const defaultStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, baseUploads)
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_')
    cb(null, uniqueName)
  }
})

const upload = multer({ storage: defaultStorage })

// Helper to create a storage that writes into a subfolder under baseUploads
const storageFor = (subfolder) => {
  const folder = path.join(baseUploads, subfolder || '')
  ensureDir(folder)
  return multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, folder)
    },
    filename: function (req, file, cb) {
      const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_')
      cb(null, uniqueName)
    }
  })
}

// Backwards-compatible default export: the `upload` multer instance.
// Also attach helpers as properties so existing requires continue to work.
upload.baseUploads = baseUploads
upload.ensureDir = ensureDir
upload.storageFor = storageFor

module.exports = upload
