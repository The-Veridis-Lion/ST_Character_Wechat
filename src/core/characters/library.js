const fs = require("fs");
const path = require("path");
const { parseCharacterCardFile } = require("./card-parser");
const { applyWorldbookOverrides, loadWorldbookOverrides } = require("./worldbook-overrides");

const CARD_EXTENSIONS = new Set([".json", ".png"]);
const WORLDBOOK_OVERRIDE_SUFFIX = ".override.json";

class CharacterLibrary {
  constructor({ cardDir, worldbookOverridesFile = "" }) {
    this.cardDir = normalizePath(cardDir);
    this.worldbookOverridesFile = normalizePath(worldbookOverridesFile);
    this.cards = [];
    this.errors = [];
    this.loaded = false;
    this.loadedAt = "";
  }

  reload() {
    const worldbookOverrides = loadWorldbookOverrides(this.worldbookOverridesFile);
    const result = scanCharacterCards(this.cardDir, { worldbookOverrides });
    this.cards = result.cards;
    this.errors = result.errors;
    this.loaded = true;
    this.loadedAt = new Date().toISOString();
    return this.snapshot();
  }

  ensureLoaded() {
    if (!this.loaded) {
      return this.reload();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      cardDir: this.cardDir,
      cards: this.cards.slice(),
      errors: this.errors.slice(),
      loadedAt: this.loadedAt,
    };
  }

  listCharacters() {
    this.ensureLoaded();
    return this.cards.slice();
  }

  getCharacter(id) {
    const normalizedId = normalizeLookupText(id);
    if (!normalizedId) {
      return null;
    }
    this.ensureLoaded();
    return this.cards.find((card) => normalizeLookupText(card.id) === normalizedId) || null;
  }

  findCharacter(query) {
    this.ensureLoaded();
    const normalizedQuery = normalizeLookupText(query);
    if (!normalizedQuery) {
      return null;
    }

    const numeric = Number.parseInt(normalizedQuery, 10);
    if (String(numeric) === normalizedQuery && numeric >= 1 && numeric <= this.cards.length) {
      return this.cards[numeric - 1];
    }

    return this.cards.find((card) => normalizeLookupText(card.id) === normalizedQuery)
      || this.cards.find((card) => normalizeLookupText(card.name) === normalizedQuery)
      || this.cards.find((card) => normalizeLookupText(path.basename(card.filePath, path.extname(card.filePath))) === normalizedQuery)
      || this.cards.find((card) => normalizeLookupText(card.name).includes(normalizedQuery))
      || this.cards.find((card) => normalizeLookupText(card.id).includes(normalizedQuery))
      || null;
  }
}

function scanCharacterCards(cardDir, options = {}) {
  return scanCharacterCardsWithOptions(cardDir, options);
}

function scanCharacterCardsWithOptions(cardDir, { worldbookOverrides = null } = {}) {
  const normalizedDir = normalizePath(cardDir);
  const files = listCardFiles(normalizedDir);
  const cards = [];
  const errors = [];
  const seenIds = new Set();

  for (const filePath of files) {
    try {
      const card = applyWorldbookOverrides(parseCharacterCardFile(filePath), worldbookOverrides);
      if (seenIds.has(card.id)) {
        errors.push({
          filePath,
          reason: `duplicate character id: ${card.id}`,
        });
        continue;
      }
      seenIds.add(card.id);
      cards.push(card);
    } catch (error) {
      errors.push({
        filePath,
        reason: error instanceof Error ? error.message : String(error || "unknown error"),
      });
    }
  }

  cards.sort(compareCharacters);
  return { cardDir: normalizedDir, cards, errors };
}

function listCardFiles(cardDir) {
  if (!cardDir) {
    return [];
  }
  let stats;
  try {
    stats = fs.statSync(cardDir);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) {
    return [];
  }

  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile()
        && CARD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        && !isWorldbookOverrideFile(entry.name)) {
        out.push(absolutePath);
      }
    }
  };
  walk(cardDir);
  return out.sort((left, right) => left.localeCompare(right));
}

function isWorldbookOverrideFile(fileName) {
  return String(fileName || "").toLowerCase().endsWith(WORLDBOOK_OVERRIDE_SUFFIX);
}

function compareCharacters(left, right) {
  const byName = String(left?.name || "").localeCompare(String(right?.name || ""), "zh-Hans-CN", {
    sensitivity: "base",
    numeric: true,
  });
  if (byName !== 0) {
    return byName;
  }
  return String(left?.filePath || "").localeCompare(String(right?.filePath || ""));
}

function normalizeLookupText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePath(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  CharacterLibrary,
  scanCharacterCards,
  scanCharacterCardsWithOptions,
  listCardFiles,
  isWorldbookOverrideFile,
};
