const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCharacterCard,
  parsePngCharacterCard,
} = require("../src/core/characters/card-parser");

test("normalizes SillyTavern v3 cards and marks MVU worldbook entries", () => {
  const card = normalizeCharacterCard({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Ciel",
      description: "A character\n<UpdateVariable>secret</UpdateVariable>\n<变量更新>好感=10</变量更新>",
      extensions: {
        regex_scripts: [{ findRegex: "secret", replaceString: "state" }],
      },
      first_mes: "hello",
      alternate_greetings: ["alt"],
      character_book: {
        entries: [
          {
            name: "always",
            content: "constant lore",
            enabled: true,
            constant: true,
          },
          {
            name: "mvu",
            content: "[InitVar]\nstat_data",
            enabled: true,
            constant: true,
          },
          {
            name: "中文状态更新",
            content: "变量更新：\n好感度：10\n位置：咖啡店",
            enabled: true,
            constant: true,
          },
          {
            name: "状态栏",
            content: "每次回复结束正文后必须输出 <status_bar>[Info|{{日期}}]</status_bar>",
            enabled: true,
            constant: true,
          },
          {
            name: "變量更新",
            content: "<status_current_variables>{{getvar::stat_data}}</status_current_variables>",
            enabled: true,
            constant: true,
          },
          {
            name: "triggered",
            content: "keyword lore",
            enabled: true,
            keys: ["coffee"],
          },
        ],
      },
    },
  }, { filePath: "D:/cards/ciel.json", sourceType: "json" });

  assert.equal(card.name, "Ciel");
  assert.equal(card.description, "A character");
  assert.equal(card.firstMes, undefined);
  assert.equal(card.alternateGreetings, undefined);
  assert.equal(card.extensions, undefined);
  assert.equal(card.raw, undefined);
  assert.equal(card.characterBook.entries.length, 2);
  assert.equal(card.characterBook.entries[0].constant, true);
  assert.equal(card.characterBook.entries[1].keys[0], "coffee");
  assert.doesNotMatch(JSON.stringify(card.characterBook.entries), /变量更新|變量更新|好感度|咖啡店|状态栏|status_bar|status_current_variables/);
});

test("parses SillyTavern PNG chara metadata", () => {
  const rawCard = {
    spec: "chara_card_v2",
    data: {
      name: "Png Card",
      description: "from png",
      first_mes: "hi",
    },
  };
  const metadata = Buffer.from(JSON.stringify(rawCard), "utf8").toString("base64");
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk("tEXt", Buffer.concat([
      Buffer.from("chara\0", "latin1"),
      Buffer.from(metadata, "latin1"),
    ])),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);

  const parsed = parsePngCharacterCard(png);
  assert.equal(parsed.data.name, "Png Card");
});

function createPngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([
    length,
    Buffer.from(type, "ascii"),
    data,
    Buffer.alloc(4),
  ]);
}
