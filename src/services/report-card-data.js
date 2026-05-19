const FORBIDDEN_REPORT_CONTENT_RE = /(?:MVU|\[InitVar\]|getvar|setvar|status_current_variables|status_bar|状态栏|狀態欄|变量|變量|角色状态|角色狀態|character\s*state|characterState|roleState|role_state|internal\s*state|好感度|affection|relationship\s*state|state\s*machinery)/iu;

function parseReportJson(text) {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) {
    throw new Error("Report JSON is empty.");
  }

  const candidates = [
    normalized,
    unwrapJsonCodeFence(normalized),
    extractBalancedJsonObject(normalized),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Runtime did not return a JSON object for the report card.");
}

function sanitizeReportPayload(value) {
  if (typeof value === "string") {
    return stripForbiddenReportText(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeReportPayload(item))
      .filter((item) => !isEmptySanitizedValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (FORBIDDEN_REPORT_CONTENT_RE.test(String(key || ""))) {
      continue;
    }
    const sanitized = sanitizeReportPayload(childValue);
    if (isEmptySanitizedValue(sanitized)) {
      continue;
    }
    output[key] = sanitized;
  }
  return output;
}

function stripForbiddenReportText(text) {
  const normalized = normalizeLineEndings(text);
  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !FORBIDDEN_REPORT_CONTENT_RE.test(line));
  return lines.join("\n").trim();
}

function normalizeString(value, fallback = "") {
  if (typeof value === "string") {
    const sanitized = stripForbiddenReportText(value);
    return sanitized || fallback;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  return stripForbiddenReportText(String(value)) || fallback;
}

function normalizeStringArray(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/\n|；|;|、/u) : []);
  const normalized = source
    .map((item) => {
      if (typeof item === "string") {
        return normalizeString(item);
      }
      if (item && typeof item === "object") {
        return normalizeString(item.text || item.title || item.summary || item.value || item.label);
      }
      return normalizeString(item);
    })
    .filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function normalizeMetricItems(value, fallback = []) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source
    .map((item) => {
      if (typeof item === "string") {
        return { label: normalizeString(item), value: "", detail: "", tone: "neutral" };
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const label = normalizeString(item.label || item.name || item.metric || item.title);
      const metricValue = normalizeString(item.value || item.status || item.level || item.score);
      const detail = normalizeString(item.detail || item.note || item.summary || item.description);
      const tone = normalizeTone(item.tone || item.kind || item.type || label);
      if (!label && !metricValue && !detail) {
        return null;
      }
      return {
        label: label || "状态",
        value: metricValue || "未记录",
        detail,
        tone,
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function normalizeTrendPoints(value, fallback = []) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source
    .map((item) => {
      if (typeof item === "string") {
        return { label: normalizeString(item), value: 0, detail: "" };
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const label = normalizeString(item.label || item.time || item.period || item.date || item.day);
      const rawValue = item.value ?? item.percent ?? item.score ?? item.level ?? 0;
      const valueNumber = clampPercentage(rawValue);
      const detail = normalizeString(item.detail || item.note || item.summary || item.text);
      if (!label && !detail && valueNumber === 0) {
        return null;
      }
      return {
        label: label || "未标记",
        value: valueNumber,
        detail,
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function formatDateInTimeZone(date = new Date(), timeZone = "Asia/Shanghai") {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safeDate);
}

function formatDateTimeInTimeZone(date = new Date(), timeZone = "Asia/Shanghai") {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const datePart = formatDateInTimeZone(safeDate, timeZone);
  const timePart = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(safeDate);
  return `${datePart} ${timePart}`;
}

function normalizeTone(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (/mood|心情|情绪|情緒/u.test(normalized)) return "mood";
  if (/stress|压力|壓力/u.test(normalized)) return "stress";
  if (/sleep|睡眠/u.test(normalized)) return "sleep";
  if (/progress|进度|進度/u.test(normalized)) return "progress";
  if (/gain|harvest|收获|收穫/u.test(normalized)) return "gain";
  return "neutral";
}

function clampPercentage(value) {
  const numeric = Number.parseFloat(String(value).replace("%", ""));
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function unwrapJsonCodeFence(text) {
  const match = normalizeLineEndings(text).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match ? String(match[1] || "").trim() : "";
}

function extractBalancedJsonObject(text) {
  const normalized = normalizeLineEndings(text);
  const start = normalized.indexOf("{");
  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(start, index + 1).trim();
      }
    }
  }
  return "";
}

function isEmptySanitizedValue(value) {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

module.exports = {
  FORBIDDEN_REPORT_CONTENT_RE,
  clampPercentage,
  formatDateInTimeZone,
  formatDateTimeInTimeZone,
  normalizeMetricItems,
  normalizeString,
  normalizeStringArray,
  normalizeTone,
  normalizeTrendPoints,
  parseReportJson,
  sanitizeReportPayload,
  stripForbiddenReportText,
};
