const SENSITIVE_FIELD_NAMES = [
  "context_token",
  "bot_token",
  "token",
  "authorization",
  "Authorization",
  "aeskey",
  "aes_key",
  "upload_param",
  "encrypted_query_param",
];

const JSON_FIELD_PATTERN = new RegExp(
  `"(${SENSITIVE_FIELD_NAMES.join("|")})"\\s*:\\s*"[^"]*"`,
  "g"
);

const QUERY_FIELD_PATTERN = new RegExp(
  `([?&](?:${SENSITIVE_FIELD_NAMES.join("|")})=)[^&\\s]+`,
  "g"
);

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

function redactSensitiveText(input, maxLen = 800) {
  const text = typeof input === "string" ? input : String(input || "");
  if (!text) {
    return "";
  }
  const redacted = text
    .replace(JSON_FIELD_PATTERN, '"$1":"<redacted>"')
    .replace(QUERY_FIELD_PATTERN, "$1<redacted>")
    .replace(BEARER_PATTERN, "Bearer <redacted>");
  if (redacted.length <= maxLen) {
    return redacted;
  }
  return `${redacted.slice(0, maxLen)}…(truncated, totalLen=${redacted.length})`;
}

module.exports = { redactSensitiveText };

