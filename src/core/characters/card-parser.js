const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { stripKnownInternalBlocks, normalizeLineEndings, trimOuterBlankLines } = require("../reply-cleaning");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MVU_RE = /\[InitVar\]|UpdateVariable|getvar|setvar|stat_data|status_current_variables|StatusPlaceHolderImpl|变量更新|變量更新|更新变量|更新變量|当前变量|當前變量|状态变量|狀態變量|变量状态|變量狀態|状态更新|狀態更新|状态栏|狀態欄|状态栏输出协议|狀態欄輸出協議|内部状态|內部狀態|(?:变量|變量|属性|屬性|数值|數值)\s*[:：=]|<\s*(?:status_bar|internal_update|phone_module|变量更新|變量更新|状态|狀態|思维链|思維鏈)(?:\s|>|\/)|_\.(?:set|get)\s*\(/iu;

function parseCharacterCardFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeCharacterCard(parsed, { filePath, sourceType: "json" });
  }
  if (extension === ".png") {
    const parsed = parsePngCharacterCard(fs.readFileSync(filePath));
    return normalizeCharacterCard(parsed, { filePath, sourceType: "png" });
  }
  throw new Error(`unsupported character card file type: ${extension || "(none)"}`);
}

function parsePngCharacterCard(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  const textChunks = extractPngTextChunks(buffer);
  const preferred = textChunks
    .filter((chunk) => /^(chara|ccv3|character)$/i.test(chunk.keyword))
    .concat(textChunks.filter((chunk) => !/^(chara|ccv3|character)$/i.test(chunk.keyword)));

  for (const chunk of preferred) {
    const parsed = parseCardPayloadText(chunk.text);
    if (parsed) {
      return parsed;
    }
  }
  throw new Error("PNG does not contain readable SillyTavern character metadata");
}

function extractPngTextChunks(buffer) {
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    if (offset + length + 4 > buffer.length) {
      break;
    }
    const data = buffer.subarray(offset, offset + length);
    offset += length + 4;

    const decoded = decodePngTextChunk(type, data);
    if (decoded?.keyword && decoded.text) {
      chunks.push(decoded);
    }
    if (type === "IEND") {
      break;
    }
  }
  return chunks;
}

function decodePngTextChunk(type, data) {
  if (type === "tEXt") {
    const split = data.indexOf(0);
    if (split < 0) {
      return null;
    }
    return {
      keyword: data.subarray(0, split).toString("latin1").trim(),
      text: data.subarray(split + 1).toString("latin1"),
    };
  }

  if (type === "zTXt") {
    const split = data.indexOf(0);
    if (split < 0 || split + 2 > data.length) {
      return null;
    }
    const compressionMethod = data[split + 1];
    if (compressionMethod !== 0) {
      return null;
    }
    return {
      keyword: data.subarray(0, split).toString("latin1").trim(),
      text: zlib.inflateSync(data.subarray(split + 2)).toString("utf8"),
    };
  }

  if (type === "iTXt") {
    return decodeInternationalTextChunk(data);
  }

  return null;
}

function decodeInternationalTextChunk(data) {
  const first = data.indexOf(0);
  if (first < 0 || first + 3 > data.length) {
    return null;
  }
  const keyword = data.subarray(0, first).toString("utf8").trim();
  const compressionFlag = data[first + 1];
  const compressionMethod = data[first + 2];
  let offset = first + 3;
  const languageEnd = data.indexOf(0, offset);
  if (languageEnd < 0) {
    return null;
  }
  offset = languageEnd + 1;
  const translatedEnd = data.indexOf(0, offset);
  if (translatedEnd < 0) {
    return null;
  }
  offset = translatedEnd + 1;
  const body = data.subarray(offset);
  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      return null;
    }
    return { keyword, text: zlib.inflateSync(body).toString("utf8") };
  }
  return { keyword, text: body.toString("utf8") };
}

function parseCardPayloadText(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const parsedRaw = tryParseJson(raw);
  if (parsedRaw) {
    return parsedRaw;
  }
  const decoded = decodeBase64Utf8(raw);
  if (!decoded) {
    return null;
  }
  return tryParseJson(decoded);
}

function normalizeCharacterCard(rawCard, { filePath = "", sourceType = "" } = {}) {
  if (!rawCard || typeof rawCard !== "object" || Array.isArray(rawCard)) {
    throw new Error("character card metadata is not an object");
  }

  const data = rawCard.data && typeof rawCard.data === "object" && !Array.isArray(rawCard.data)
    ? rawCard.data
    : rawCard;
  const name = sanitizeCardText(readFirstText(data.name, rawCard.name, path.basename(filePath, path.extname(filePath))));
  if (!name) {
    throw new Error("character card is missing a name");
  }

  const id = createCharacterId({ name, filePath });
  const characterBook = normalizeCharacterBook(readFirstObject(data.character_book, rawCard.character_book));

  return {
    id,
    name,
    filePath,
    sourceType,
    spec: readFirstText(rawCard.spec, data.spec),
    specVersion: readFirstText(rawCard.spec_version, data.spec_version),
    description: sanitizeCardText(readFirstText(data.description, rawCard.description)),
    personality: sanitizeCardText(readFirstText(data.personality, rawCard.personality)),
    scenario: sanitizeCardText(readFirstText(data.scenario, rawCard.scenario)),
    systemPrompt: sanitizeCardText(readFirstText(data.system_prompt, rawCard.system_prompt)),
    postHistoryInstructions: sanitizeCardText(readFirstText(data.post_history_instructions, rawCard.post_history_instructions)),
    characterBook,
    loadedAt: new Date().toISOString(),
  };
}

function normalizeCharacterBook(book) {
  const entries = Array.isArray(book?.entries)
    ? book.entries.map((entry, index) => normalizeWorldbookEntry(entry, index)).filter(Boolean)
    : [];
  return {
    name: sanitizeCardText(readFirstText(book?.name)),
    description: sanitizeCardText(readFirstText(book?.description)),
    entries,
  };
}

function normalizeWorldbookEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  if (isMvuWorldbookEntry(entry)) {
    return null;
  }
  const content = sanitizeCardText(readFirstText(entry.content, entry.entry, entry.prompt));
  if (!content) {
    return null;
  }
  const keys = normalizeTextList(readFirstArray(entry.keys, entry.key, entry.primary_keys));
  const secondaryKeys = normalizeTextList(readFirstArray(entry.secondary_keys, entry.secondaryKeys));
  const name = sanitizeCardText(readFirstText(entry.name, entry.comment, entry.memo, entry.id, `entry-${index + 1}`));
  const rawEnabled = entry.enabled;
  const disabled = entry.disabled === true || entry.disable === true || rawEnabled === false;
  const normalized = {
    id: readFirstText(entry.id, entry.uid, entry.keysecondary, `entry-${index + 1}`),
    name,
    keys,
    secondaryKeys,
    content,
    enabled: !disabled,
    disabled,
    constant: Boolean(entry.constant),
    selective: Boolean(entry.selective) || keys.length > 0 || secondaryKeys.length > 0,
    position: readFirstText(entry.position),
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : index,
    isMvu: isMvuWorldbookEntry(entry, { name, keys, secondaryKeys, content }),
  };
  return normalized;
}

function isMvuWorldbookEntry(rawEntry, normalized = {}) {
  const parts = [
    normalized.name,
    normalized.content,
    ...(Array.isArray(normalized.keys) ? normalized.keys : []),
    ...(Array.isArray(normalized.secondaryKeys) ? normalized.secondaryKeys : []),
  ];
  if (rawEntry && typeof rawEntry === "object") {
    parts.push(
      rawEntry.name,
      rawEntry.comment,
      rawEntry.memo,
      rawEntry.content,
      rawEntry.entry,
      rawEntry.prompt,
      rawEntry.scriptName,
      rawEntry.findRegex,
      rawEntry.replaceString,
      ...(Array.isArray(rawEntry.keys) ? rawEntry.keys : []),
      ...(Array.isArray(rawEntry.key) ? rawEntry.key : []),
      ...(Array.isArray(rawEntry.primary_keys) ? rawEntry.primary_keys : []),
      ...(Array.isArray(rawEntry.secondary_keys) ? rawEntry.secondary_keys : []),
      ...(Array.isArray(rawEntry.secondaryKeys) ? rawEntry.secondaryKeys : []),
    );
  }
  return parts.some((part) => MVU_RE.test(String(part || "")));
}

function sanitizeCardText(value) {
  let text = stripKnownInternalBlocks(readFirstText(value));
  if (!text) {
    return "";
  }
  text = stripMvuLikeBlocks(text);
  const lines = normalizeLineEndings(text)
    .split("\n")
    .filter((line) => !isMvuLine(line))
    .join("\n");
  text = lines.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(text);
}

function isMvuLine(line) {
  return MVU_RE.test(String(line || "").trim());
}

function stripMvuLikeBlocks(value) {
  return normalizeLineEndings(value)
    .replace(/(^|\n)\s*(?:变量更新|變量更新|更新变量|更新變量|当前变量|當前變量|状态变量|狀態變量|变量状态|變量狀態|状态更新|狀態更新|状态栏|狀態欄|内部状态|內部狀態|stat_data|status_current_variables)\s*[:：]?\s*\n[\s\S]*?(?=\n\s*\n|$)/giu, "$1");
}

function normalizeTextList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCardText(item)).filter(Boolean);
  }
  const text = sanitizeCardText(value);
  return text ? [text] : [];
}

function readFirstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return "";
}

function readFirstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      return [value];
    }
  }
  return [];
}

function readFirstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return {};
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeBase64Utf8(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return "";
  }
  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
    return decoded.startsWith("{") ? decoded : "";
  } catch {
    return "";
  }
}

function createCharacterId({ name, filePath }) {
  const hash = crypto
    .createHash("sha1")
    .update(`${path.resolve(filePath || "")}\n${name}`)
    .digest("hex")
    .slice(0, 10);
  const base = slugifyCharacterName(name) || "character";
  return `${base}-${hash}`;
}

function slugifyCharacterName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

module.exports = {
  parseCharacterCardFile,
  parsePngCharacterCard,
  extractPngTextChunks,
  normalizeCharacterCard,
  normalizeCharacterBook,
  normalizeWorldbookEntry,
  sanitizeCardText,
  isMvuWorldbookEntry,
  stripMvuLikeBlocks,
};
