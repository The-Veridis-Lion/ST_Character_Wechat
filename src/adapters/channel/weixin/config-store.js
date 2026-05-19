const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_WEIXIN_CHUNK = 20;
const MAX_MIN_WEIXIN_CHUNK = 3800;
const DEFAULT_AUTO_COMPACT_ENABLED = true;
const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 75;
const MIN_AUTO_COMPACT_THRESHOLD_PERCENT = 1;
const MAX_AUTO_COMPACT_THRESHOLD_PERCENT = 100;

function loadWeixinConfig(config) {
  const filePath = config?.weixinConfigFile;
  const envDefault = normalizeMinChunkChars(
    config?.weixinMinChunkChars,
    DEFAULT_MIN_WEIXIN_CHUNK,
  );
  const defaults = buildDefaultWeixinConfig(envDefault);
  if (!filePath) {
    return defaults;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeWeixinConfig(parsed, defaults);
  } catch {
    return defaults;
  }
}

function saveWeixinConfig(config, values) {
  const filePath = config?.weixinConfigFile;
  if (!filePath) {
    return;
  }
  const defaults = buildDefaultWeixinConfig(DEFAULT_MIN_WEIXIN_CHUNK);
  const normalized = normalizeWeixinConfig(values, defaults);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(normalized, null, 2),
  );
}

function normalizeMinChunkChars(value, defaultValue = DEFAULT_MIN_WEIXIN_CHUNK) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_MIN_WEIXIN_CHUNK) {
    return parsed;
  }
  return defaultValue;
}

function buildDefaultWeixinConfig(minChunkChars = DEFAULT_MIN_WEIXIN_CHUNK) {
  return {
    minChunkChars: normalizeMinChunkChars(minChunkChars, DEFAULT_MIN_WEIXIN_CHUNK),
    autoCompact: {
      enabled: DEFAULT_AUTO_COMPACT_ENABLED,
      thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    },
  };
}

function normalizeWeixinConfig(value, defaults = buildDefaultWeixinConfig()) {
  const normalizedDefaults = buildDefaultWeixinConfig(defaults?.minChunkChars);
  const parsed = value && typeof value === "object" ? value : {};
  return {
    minChunkChars: normalizeMinChunkChars(parsed.minChunkChars, normalizedDefaults.minChunkChars),
    autoCompact: normalizeAutoCompactConfig(parsed.autoCompact, normalizedDefaults.autoCompact),
  };
}

function normalizeAutoCompactConfig(value, defaults) {
  const parsed = value && typeof value === "object" ? value : {};
  return {
    enabled: normalizeBoolean(parsed.enabled, defaults?.enabled ?? DEFAULT_AUTO_COMPACT_ENABLED),
    thresholdPercent: normalizeAutoCompactThresholdPercent(
      parsed.thresholdPercent,
      defaults?.thresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    ),
  };
}

function normalizeAutoCompactThresholdPercent(
  value,
  defaultValue = DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
) {
  return normalizeBoundedInteger(
    value,
    defaultValue,
    MIN_AUTO_COMPACT_THRESHOLD_PERCENT,
    MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
  );
}

function normalizeBoundedInteger(value, defaultValue, minValue, maxValue) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= minValue && parsed <= maxValue) {
    return parsed;
  }
  return defaultValue;
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === "boolean") {
    return value;
  }
  return defaultValue;
}

module.exports = {
  loadWeixinConfig,
  saveWeixinConfig,
  DEFAULT_MIN_WEIXIN_CHUNK,
  MAX_MIN_WEIXIN_CHUNK,
  DEFAULT_AUTO_COMPACT_ENABLED,
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  MIN_AUTO_COMPACT_THRESHOLD_PERCENT,
  MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
  normalizeMinChunkChars,
  normalizeAutoCompactThresholdPercent,
  normalizeWeixinConfig,
};
