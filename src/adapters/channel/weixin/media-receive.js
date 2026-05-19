const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_INBOX_DIR = "inbox";
const MAX_FILE_NAME_LENGTH = 120;

async function persistIncomingWeixinAttachments({
  attachments,
  stateDir,
  cdnBaseUrl,
  messageId = "",
  receivedAt = "",
}) {
  const saved = [];
  const failed = [];

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    try {
      const persisted = await persistSingleAttachment({
        attachment,
        stateDir,
        cdnBaseUrl,
        messageId,
        receivedAt,
      });
      saved.push(persisted);
    } catch (error) {
      failed.push({
        kind: attachment?.kind || "file",
        sourceFileName: attachment?.fileName || "",
        reason: error instanceof Error ? error.message : String(error || "unknown attachment error"),
      });
    }
  }

  return { saved, failed };
}

async function persistSingleAttachment({ attachment, stateDir, cdnBaseUrl, messageId, receivedAt }) {
  const download = await downloadAttachmentPayload(attachment, cdnBaseUrl);
  const plaintext = decodeAttachmentPayload(download.bytes, attachment, download.contentType);
  const fileName = buildTargetFileName({
    attachment,
    plaintext,
    contentType: download.contentType,
    messageId,
  });
  const targetDir = buildInboxDirectory(stateDir, receivedAt);
  const absolutePath = await writeUniqueFile(targetDir, fileName, plaintext);
  const relativePath = path.relative(stateDir, absolutePath).replace(/\\/g, "/");

  return {
    kind: attachment.kind || "file",
    contentType: download.contentType,
    isImage: isImageAttachment({
      kind: attachment.kind,
      contentType: download.contentType,
      fileName,
    }),
    sourceFileName: attachment.fileName || "",
    fileName: path.basename(absolutePath),
    absolutePath,
    relativePath,
    sizeBytes: plaintext.length,
  };
}

function buildInboxDirectory(stateDir, receivedAt) {
  const day = normalizeDateFolder(receivedAt);
  return path.join(stateDir, DEFAULT_INBOX_DIR, day);
}

function normalizeDateFolder(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

async function downloadAttachmentPayload(attachment, cdnBaseUrl) {
  const candidates = buildDownloadCandidates(attachment, cdnBaseUrl);
  if (!candidates.length) {
    throw new Error("attachment did not include a supported download reference");
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: "GET",
        headers: {
          Accept: "*/*",
        },
      });
      if (!response.ok) {
        lastError = new Error(`download failed with HTTP ${response.status}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        bytes: Buffer.from(arrayBuffer),
        contentType: normalizeContentType(response.headers.get("content-type")),
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("attachment download failed");
}

function buildDownloadCandidates(attachment, cdnBaseUrl) {
  const candidates = [];
  const seen = new Set();
  const directUrls = Array.isArray(attachment?.directUrls) ? attachment.directUrls : [];
  for (const directUrl of directUrls) {
    addCandidate(candidates, seen, directUrl);
  }

  const encryptedQueryParam = normalizeText(attachment?.mediaRef?.encryptQueryParam);
  if (encryptedQueryParam) {
    const normalizedCdnBaseUrl = String(cdnBaseUrl || "").replace(/\/+$/g, "");
    addCandidate(
      candidates,
      seen,
      `${normalizedCdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
    );

    const fileKey = normalizeText(attachment?.mediaRef?.fileKey);
    if (fileKey) {
      addCandidate(
        candidates,
        seen,
        `${normalizedCdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}&filekey=${encodeURIComponent(fileKey)}`
      );
    }
  }

  return candidates;
}

function addCandidate(candidates, seen, rawUrl) {
  const normalizedUrl = normalizeText(rawUrl);
  if (!normalizedUrl || seen.has(normalizedUrl)) {
    return;
  }
  seen.add(normalizedUrl);
  candidates.push(normalizedUrl);
}

function decodeAttachmentPayload(bytes, attachment, contentType) {
  const encryptType = Number(attachment?.mediaRef?.encryptType);
  const keyCandidates = buildAesKeyCandidates(attachment);
  if (encryptType !== 1 || keyCandidates.length === 0) {
    return bytes;
  }

  for (const key of keyCandidates) {
    try {
      return decryptAesEcb(bytes, key);
    } catch {
      // Try the next key encoding variant.
    }
  }

  if (looksLikePlainMedia(bytes, contentType)) {
    return bytes;
  }

  throw new Error("failed to decrypt attachment payload");
}

function buildAesKeyCandidates(attachment) {
  const candidates = [];
  const seen = new Set();
  const rawValues = [
    attachment?.mediaRef?.aesKeyHex,
    attachment?.mediaRef?.aesKey,
  ];

  for (const rawValue of rawValues) {
    const variants = decodeAesKeyVariants(rawValue);
    for (const variant of variants) {
      const signature = variant.toString("hex");
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      candidates.push(variant);
    }
  }

  return candidates;
}

function decodeAesKeyVariants(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  const candidates = [];
  if (/^[0-9a-f]{32}$/i.test(normalized)) {
    candidates.push(Buffer.from(normalized, "hex"));
  }
  if (normalized.length === 16) {
    candidates.push(Buffer.from(normalized, "utf8"));
  }

  try {
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.length === 16) {
      candidates.push(decoded);
    } else {
      const decodedText = decoded.toString("utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(decodedText)) {
        candidates.push(Buffer.from(decodedText, "hex"));
      }
    }
  } catch {
    // Ignore invalid base64 variants.
  }

  return candidates.filter((candidate) => candidate.length === 16);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function looksLikePlainMedia(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return false;
  }

  if (contentType.startsWith("text/")) {
    return true;
  }

  return detectExtensionFromBuffer(bytes) !== "";
}

function buildTargetFileName({ attachment, plaintext, contentType, messageId }) {
  const sourceName = sanitizeFileName(attachment?.fileName || "");
  if (sourceName) {
    const existingExt = path.extname(sourceName);
    if (existingExt) {
      return sourceName;
    }

    const inferredExt = inferExtension({
      contentType,
      plaintext,
      kind: attachment?.kind,
    });
    return `${sourceName}${inferredExt}`;
  }

  const baseName = sanitizeFileName([
    attachment?.kind || "file",
    messageId || Date.now(),
    String((attachment?.index ?? 0) + 1),
  ].join("-"));
  const inferredExt = inferExtension({
    contentType,
    plaintext,
    kind: attachment?.kind,
  });
  return `${baseName || "attachment"}${inferredExt}`;
}

function inferExtension({ contentType, plaintext, kind }) {
  const contentTypeExt = extensionFromContentType(contentType);
  if (contentTypeExt) {
    return contentTypeExt;
  }

  const bufferExt = detectExtensionFromBuffer(plaintext);
  if (bufferExt) {
    return bufferExt;
  }

  if (kind === "image") {
    return ".png";
  }
  if (kind === "video") {
    return ".mp4";
  }
  return ".bin";
}

function extensionFromContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[normalized] || "";
}

function isImageAttachment({ kind, contentType, fileName }) {
  if (normalizeText(kind).toLowerCase() === "image") {
    return true;
  }
  if (normalizeContentType(contentType).startsWith("image/")) {
    return true;
  }
  const extension = path.extname(normalizeText(fileName)).toLowerCase();
  return extension === ".png"
    || extension === ".jpg"
    || extension === ".jpeg"
    || extension === ".gif"
    || extension === ".webp"
    || extension === ".bmp"
    || extension === ".svg";
}

function detectExtensionFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return "";
  }

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return ".png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
    return ".jpg";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") {
    return ".gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return ".mp4";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return ".pdf";
  }
  return "";
}

function sanitizeFileName(value) {
  const parsed = path.parse(String(value || "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-"));
  const safeBaseName = parsed.name || "attachment";
  const safeExt = parsed.ext || "";
  return `${safeBaseName.slice(0, MAX_FILE_NAME_LENGTH)}${safeExt.slice(0, 16)}`;
}

async function writeUniqueFile(targetDir, fileName, plaintext) {
  await fs.mkdir(targetDir, { recursive: true });
  const parsed = path.parse(fileName);
  const baseName = parsed.name || "attachment";
  const extension = parsed.ext || "";
  for (let index = 0; index < 50; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(targetDir, `${baseName}${suffix}${extension}`);
    try {
      await fs.writeFile(candidate, plaintext, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("unable to allocate a unique attachment file name");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeContentType(value) {
  return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
}

module.exports = {
  persistIncomingWeixinAttachments,
};
