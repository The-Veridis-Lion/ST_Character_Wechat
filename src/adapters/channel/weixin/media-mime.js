const path = require("path");

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

function getMimeFromFilename(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

module.exports = { getMimeFromFilename };
