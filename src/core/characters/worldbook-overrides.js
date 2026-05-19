const fs = require("fs");
const path = require("path");

function loadWorldbookOverrides(filePath) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return createEmptyOverrides();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    return normalizeWorldbookOverrides(parsed);
  } catch {
    return createEmptyOverrides();
  }
}

function normalizeWorldbookOverrides(value) {
  const parsed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawCards = parsed.cards && typeof parsed.cards === "object" && !Array.isArray(parsed.cards)
    ? parsed.cards
    : {};
  const cards = {};
  for (const [key, override] of Object.entries(rawCards)) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) {
      continue;
    }
    cards[normalizedKey] = normalizeCardOverride(override);
  }
  return {
    version: Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 1,
    cards,
  };
}

function applyWorldbookOverrides(card, overrides) {
  if (!card || typeof card !== "object") {
    return card;
  }
  const cardOverride = resolveCardOverride(card, overrides);
  const entries = Array.isArray(card?.characterBook?.entries) ? card.characterBook.entries : [];
  if (!entries.length || !cardOverride) {
    return card;
  }

  const disabledIds = new Set(cardOverride.disabledWorldbookEntryIds.map(normalizeText).filter(Boolean));
  const disabledNames = new Set(cardOverride.disabledWorldbookEntryNames.map(normalizeText).filter(Boolean));
  if (!disabledIds.size && !disabledNames.size) {
    return card;
  }

  return {
    ...card,
    characterBook: {
      ...card.characterBook,
      entries: entries.map((entry) => {
        const entryId = normalizeText(entry?.id);
        const entryName = normalizeText(entry?.name);
        if ((entryId && disabledIds.has(entryId)) || (entryName && disabledNames.has(entryName))) {
          return {
            ...entry,
            enabled: false,
            disabled: true,
            manuallyDisabled: true,
          };
        }
        return entry;
      }),
    },
  };
}

function resolveCardOverride(card, overrides) {
  const cards = overrides?.cards && typeof overrides.cards === "object" ? overrides.cards : {};
  const keys = [
    card?.id,
    card?.name,
    card?.filePath ? path.basename(card.filePath) : "",
    card?.filePath ? path.basename(card.filePath, path.extname(card.filePath)) : "",
  ].map(normalizeText).filter(Boolean);

  const merged = createEmptyCardOverride();
  let found = false;
  for (const key of keys) {
    const override = cards[key];
    if (!override) {
      continue;
    }
    found = true;
    const normalized = normalizeCardOverride(override);
    merged.disabledWorldbookEntryIds.push(...normalized.disabledWorldbookEntryIds);
    merged.disabledWorldbookEntryNames.push(...normalized.disabledWorldbookEntryNames);
  }
  return found ? {
    disabledWorldbookEntryIds: uniqueTexts(merged.disabledWorldbookEntryIds),
    disabledWorldbookEntryNames: uniqueTexts(merged.disabledWorldbookEntryNames),
  } : null;
}

function normalizeCardOverride(value) {
  const parsed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    disabledWorldbookEntryIds: uniqueTexts([
      ...normalizeTextList(parsed.disabledWorldbookEntryIds),
      ...normalizeTextList(parsed.disabledEntryIds),
      ...normalizeTextList(parsed.disabledIds),
    ]),
    disabledWorldbookEntryNames: uniqueTexts([
      ...normalizeTextList(parsed.disabledWorldbookEntryNames),
      ...normalizeTextList(parsed.disabledEntryNames),
      ...normalizeTextList(parsed.disabledNames),
      ...normalizeTextList(parsed.disabledEntries),
    ]),
  };
}

function createEmptyOverrides() {
  return {
    version: 1,
    cards: {},
  };
}

function createEmptyCardOverride() {
  return {
    disabledWorldbookEntryIds: [],
    disabledWorldbookEntryNames: [],
  };
}

function normalizeTextList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }
  const text = normalizeText(value);
  return text ? [text] : [];
}

function uniqueTexts(values) {
  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = {
  loadWorldbookOverrides,
  normalizeWorldbookOverrides,
  applyWorldbookOverrides,
  resolveCardOverride,
};
