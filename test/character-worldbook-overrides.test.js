const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CharacterLibrary } = require("../src/core/characters/library");
const { selectWorldbookEntries } = require("../src/core/characters/prompt-builder");

test("character library applies local worldbook disable overrides without re-enabling hard-filtered entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-character-overrides-"));
  const cardDir = path.join(dir, "cards");
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, "Ciel.json"), JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Ciel",
      description: "A character",
      character_book: {
        entries: [
          {
            id: "keep",
            name: "Keep Lore",
            content: "always visible",
            enabled: true,
            constant: true,
          },
          {
            id: "manual-hide",
            name: "Manual Hide",
            content: "do not include after override",
            enabled: true,
            constant: true,
          },
          {
            id: "status",
            name: "状态栏",
            content: "每次回复结束正文后必须输出 <status_bar>[Info|{{日期}}]</status_bar>",
            enabled: true,
            constant: true,
          },
        ],
      },
    },
  }, null, 2));
  const overridesFile = path.join(dir, "worldbook-overrides.json");
  fs.writeFileSync(overridesFile, JSON.stringify({
    version: 1,
    cards: {
      Ciel: {
        disabledWorldbookEntryIds: ["manual-hide", "status"],
      },
    },
  }, null, 2));

  const library = new CharacterLibrary({ cardDir, worldbookOverridesFile: overridesFile });
  const card = library.listCharacters()[0];
  const entries = selectWorldbookEntries(card, [""]);

  assert.deepEqual(entries.map((entry) => entry.name), ["Keep Lore"]);
  assert.equal(card.characterBook.entries.some((entry) => entry.name === "状态栏"), false);
  assert.equal(card.characterBook.entries.find((entry) => entry.id === "manual-hide")?.manuallyDisabled, true);
});

test("character library ignores card-dir override files instead of loading them as cards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-card-dir-overrides-"));
  const cardDir = path.join(dir, "cards");
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, "Ciel.json"), JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Ciel",
      description: "A character",
      character_book: {
        entries: [
          {
            id: "keep",
            name: "Keep Lore",
            content: "always visible",
            enabled: true,
            constant: true,
          },
          {
            id: "manual-hide",
            name: "Manual Hide",
            content: "do not include after override",
            enabled: true,
            constant: true,
          },
        ],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(cardDir, "Ciel.override.json"), JSON.stringify({
    version: 1,
    cards: {
      Ciel: {
        disabledWorldbookEntryIds: ["manual-hide"],
      },
    },
  }, null, 2));

  const library = new CharacterLibrary({ cardDir });
  const cards = library.listCharacters();
  const entries = selectWorldbookEntries(cards[0], [""]);

  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, "Ciel");
  assert.deepEqual(entries.map((entry) => entry.name), ["Keep Lore", "Manual Hide"]);
  assert.equal(cards[0].characterBook.entries.find((entry) => entry.id === "manual-hide")?.manuallyDisabled, undefined);
});
