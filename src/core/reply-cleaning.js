const KNOWN_INTERNAL_BLOCK_TAGS = [
  "think",
  "thinking",
  "UpdateVariable",
  "变量更新",
  "状态",
  "思维链",
  "status_bar",
  "internal_update",
  "phone_module",
  "chat_history",
  "message",
  "group_message",
  "analysis",
  "cot",
];

const XML_TAG_NAME_PATTERN = "[\\p{L}_][\\p{L}\\p{N}_:.-]*";

function stripInternalReplyBlocks(value) {
  let result = normalizeLineEndings(value);
  if (!result) {
    return "";
  }

  result = stripKnownInternalBlocks(result);
  result = stripAnyClosedTagBlocks(result);
  result = stripAnySelfClosingTags(result);
  result = stripAnyClosingTags(result);
  result = stripAnyDanglingOpenTag(result);
  result = stripChainOfThoughtLabelBlocks(result);
  result = result.replace(/[ \t]*\n[ \t]*\n+/g, "\n");
  return trimOuterBlankLines(result);
}

function stripKnownInternalBlocks(value) {
  let result = normalizeLineEndings(value);
  if (!result) {
    return "";
  }

  for (const tag of KNOWN_INTERNAL_BLOCK_TAGS) {
    result = stripClosedTagBlocks(result, tag);
  }

  result = stripDanglingClosingKnownTags(result);

  for (const tag of KNOWN_INTERNAL_BLOCK_TAGS) {
    result = stripDanglingOpenTag(result, tag);
  }

  result = result.replace(/<StatusPlaceHolderImpl\s*\/?>/gi, "");
  result = stripChainOfThoughtLabelBlocks(result);
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function stripAnyClosedTagBlocks(text) {
  let result = String(text || "");
  let previous = "";
  const pattern = new RegExp(`<(${XML_TAG_NAME_PATTERN})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`, "gu");
  while (result !== previous) {
    previous = result;
    result = result.replace(pattern, "");
  }
  return result;
}

function stripAnySelfClosingTags(text) {
  const pattern = new RegExp(`<(${XML_TAG_NAME_PATTERN})(?:\\s[^>]*)?\\s*\\/>`, "gu");
  return String(text || "").replace(pattern, "");
}

function stripAnyClosingTags(text) {
  const pattern = new RegExp(`<\\/(${XML_TAG_NAME_PATTERN})\\s*>`, "gu");
  return String(text || "").replace(pattern, "");
}

function stripAnyDanglingOpenTag(text) {
  const pattern = new RegExp(`<(${XML_TAG_NAME_PATTERN})(?:\\s[^>]*)?>[\\s\\S]*$`, "gu");
  return String(text || "").replace(pattern, "");
}

function stripClosedTagBlocks(text, tag) {
  const escapedTag = escapeRegExp(tag);
  const pattern = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedTag}\\s*>`, "giu");
  return String(text || "").replace(pattern, "");
}

function stripDanglingOpenTag(text, tag) {
  const escapedTag = escapeRegExp(tag);
  const pattern = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*$`, "iu");
  return String(text || "").replace(pattern, "");
}

function stripDanglingClosingKnownTags(text) {
  let result = String(text || "");
  for (const tag of KNOWN_INTERNAL_BLOCK_TAGS) {
    const escapedTag = escapeRegExp(tag);
    const closing = new RegExp(`<\\/${escapedTag}\\s*>`, "iu");
    const leadingBlock = new RegExp(`^[\\s\\S]*?<\\/${escapedTag}\\s*>`, "iu");
    while (closing.test(result)) {
      result = result.replace(leadingBlock, "");
    }
  }
  return result;
}

function stripChainOfThoughtLabelBlocks(text) {
  const labelPattern = new RegExp(
    `(^|\\n)\\s*(?:${[
      "\\u601d\\u7ef4\\u94fe",
      "\\u601d\\u8003\\u8fc7\\u7a0b",
      "\\u63a8\\u7406\\u8fc7\\u7a0b",
      "\\u63a8\\u7406",
      "\\u5206\\u6790\\u8fc7\\u7a0b",
      "chain\\s+of\\s+thought",
      "reasoning",
    ].join("|")})\\s*[:\\uff1a][\\s\\S]*?(?=\\n\\s*\\n|$)`,
    "gi"
  );
  return String(text || "").replace(labelPattern, "$1");
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  stripInternalReplyBlocks,
  stripKnownInternalBlocks,
  normalizeLineEndings,
  trimOuterBlankLines,
};
