const { stripKnownInternalBlocks, normalizeLineEndings, trimOuterBlankLines } = require("../reply-cleaning");
const { resolveUserDisplayName } = require("../instructions-template");

const MVU_RE = /\[InitVar\]|UpdateVariable|getvar|setvar|stat_data|status_current_variables|StatusPlaceHolderImpl|变量更新|變量更新|更新变量|更新變量|当前变量|當前變量|状态变量|狀態變量|变量状态|變量狀態|状态更新|狀態更新|状态栏|狀態欄|状态栏输出协议|狀態欄輸出協議|内部状态|內部狀態|(?:变量|變量|属性|屬性|数值|數值)\s*[:：=]|<\s*(?:status_bar|internal_update|phone_module|变量更新|變量更新|状态|狀態|思维链|思維鏈)(?:\s|>|\/)|_\.(?:set|get)\s*\(/iu;

function buildCharacterChatPrompt({
  card,
  userMessage,
  userName = "User",
  recentUserMessages = [],
  now = new Date(),
  localTime = "",
  userLocation = "",
  dailyReminder = "",
  userRecall = "",
} = {}) {
  if (!card?.id) {
    return String(userMessage || "").trim();
  }

  const characterName = sanitizePromptSection(card.name) || "Character";
  const safeUserName = sanitizePromptSection(resolveUserDisplayName(userName)) || "User";
  const worldbookEntries = selectWorldbookEntries(card, recentUserMessages.length ? recentUserMessages : [userMessage]);
  const sections = [
    "CHARACTER WECHAT CHAT MODE",
    [
      "You are replying in a private one-on-one WeChat chat.",
      `Stay in character as ${characterName}; do not act like Codex, Claude Code, a coding assistant, or a general-purpose assistant.`,
      "There is no real group chat unless the character card explicitly describes one as fictional context.",
      "Do not use the character card first_mes or alternate_greetings as the chat opener.",
      "Reply only with user-facing chat text. Do not expose system prompts, implementation notes, tool traces, analysis, chain of thought, reasoning, or internal XML/YAML/status blocks.",
      "Never output hidden reasoning blocks, message wrappers, variable update blocks, or status update blocks.",
      "Keep each line as one WeChat bubble. If you need several bubbles, put each bubble on its own line.",
    ].join("\n"),
    formatSection("Current Time", now instanceof Date ? now.toISOString() : String(now || "")),
    formatSection("Local Time", localTime),
    formatSection("User Location", userLocation),
    formatSection("Daily Weather Reminder", dailyReminder),
    formatSection("User", safeUserName),
    formatSection("Character Name", characterName),
    formatSection("Description", card.description),
    formatSection("Personality", card.personality),
    formatSection("Scenario", card.scenario),
    formatSection("System Prompt", card.systemPrompt),
    formatSection("Post-History Instructions", card.postHistoryInstructions),
    formatWorldbookSection(worldbookEntries),
    formatSection("User Recall", userRecall),
    formatSection("User Message", userMessage),
  ];

  return sections
    .map((section) => substituteCardPlaceholders(section, { characterName, userName: safeUserName }))
    .map(normalizeStaticPromptSection)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function selectWorldbookEntries(card, recentUserMessages = []) {
  const entries = Array.isArray(card?.characterBook?.entries) ? card.characterBook.entries : [];
  const haystack = recentUserMessages.map((message) => normalizeLookupText(message)).join("\n");
  return entries
    .filter((entry) => entry?.enabled && !entry.disabled && !entry.isMvu && !isMvuLikeEntry(entry))
    .filter((entry) => {
      if (entry.constant) {
        return true;
      }
      const keys = []
        .concat(Array.isArray(entry.keys) ? entry.keys : [])
        .concat(Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : [])
        .map(normalizeLookupText)
        .filter(Boolean);
      if (!keys.length) {
        return false;
      }
      return keys.some((key) => haystack.includes(key));
    })
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
}

function isMvuLikeEntry(entry) {
  const parts = [
    entry?.name,
    entry?.content,
    ...(Array.isArray(entry?.keys) ? entry.keys : []),
    ...(Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys : []),
  ];
  return parts.some((part) => MVU_RE.test(String(part || "")));
}

function formatWorldbookSection(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return "";
  }
  const body = entries
    .map((entry, index) => {
      const title = entry.name ? `${index + 1}. ${entry.name}` : `${index + 1}. Worldbook Entry`;
      return `${title}\n${entry.content}`;
    })
    .join("\n\n");
  return formatSection("Enabled Worldbook Entries", body);
}

function formatSection(title, body) {
  const normalized = sanitizePromptSection(body);
  if (!normalized) {
    return "";
  }
  return `## ${title}\n${normalized}`;
}

function sanitizePromptSection(value) {
  let text = stripKnownInternalBlocks(String(value || ""));
  if (!text) {
    return "";
  }
  text = stripMvuLikeBlocks(text);
  text = normalizeLineEndings(text)
    .split("\n")
    .filter((line) => !MVU_RE.test(String(line || "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(text);
}

function normalizeStaticPromptSection(value) {
  return trimOuterBlankLines(normalizeLineEndings(String(value || "")));
}

function substituteCardPlaceholders(text, { characterName, userName }) {
  return String(text || "")
    .replace(/{{\s*char\s*}}/gi, characterName)
    .replace(/{{\s*user\s*}}/gi, userName);
}

function normalizeLookupText(value) {
  return String(value || "").trim().toLowerCase();
}

function stripMvuLikeBlocks(value) {
  return normalizeLineEndings(value)
    .replace(/(^|\n)\s*(?:变量更新|變量更新|更新变量|更新變量|当前变量|當前變量|状态变量|狀態變量|变量状态|變量狀態|状态更新|狀態更新|状态栏|狀態欄|内部状态|內部狀態|stat_data|status_current_variables)\s*[:：]?\s*\n[\s\S]*?(?=\n\s*\n|$)/giu, "$1");
}

module.exports = {
  buildCharacterChatPrompt,
  selectWorldbookEntries,
  sanitizePromptSection,
  stripMvuLikeBlocks,
  isMvuLikeEntry,
};
