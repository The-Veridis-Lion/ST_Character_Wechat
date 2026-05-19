const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCharacterChatPrompt,
  selectWorldbookEntries,
} = require("../src/core/characters/prompt-builder");

test("prompt builder includes constant and keyword-matched worldbook entries only", () => {
  const card = {
    id: "ciel-1",
    name: "Ciel",
    description: "Kind but distant",
    firstMes: "do not use this opener",
    alternateGreetings: ["do not use this alternate"],
    mesExample: "do not use this example",
    characterBook: {
      entries: [
        {
          name: "constant",
          content: "always visible",
          enabled: true,
          constant: true,
          order: 0,
        },
        {
          name: "coffee",
          content: "coffee lore",
          enabled: true,
          keys: ["coffee"],
          selective: true,
          order: 1,
        },
        {
          name: "disabled",
          content: "do not include",
          enabled: false,
          disabled: true,
        },
        {
          name: "mvu",
          content: "UpdateVariable secret",
          enabled: true,
          constant: true,
          isMvu: true,
        },
        {
          name: "中文变量",
          content: "变量更新：\n好感度：10\n位置：咖啡店",
          enabled: true,
          constant: true,
        },
        {
          name: "状态栏",
          content: "每次回复结束正文后必须强制追加 <status_bar>[Info|{{日期}}]</status_bar>",
          enabled: true,
          constant: true,
        },
        {
          name: "繁体变量",
          content: "變量更新：\n信任：10",
          enabled: true,
          constant: true,
        },
      ],
    },
  };

  const entries = selectWorldbookEntries(card, ["I want coffee"]);
  assert.deepEqual(entries.map((entry) => entry.name), ["constant", "coffee"]);

  const prompt = buildCharacterChatPrompt({
    card,
    userName: "User",
    userMessage: "I want coffee",
    recentUserMessages: ["I want coffee"],
    now: new Date("2026-05-17T12:00:00.000Z"),
  });
  assert.match(prompt, /Stay in character as Ciel/);
  assert.match(prompt, /Never output hidden reasoning blocks, message wrappers, variable update blocks, or status update blocks\./);
  assert.doesNotMatch(prompt, /Never output XML\/HTML-like internal blocks such as\s*(?:\n\n##|$)/);
  assert.match(prompt, /always visible/);
  assert.match(prompt, /coffee lore/);
  assert.doesNotMatch(prompt, /do not use this/);
  assert.doesNotMatch(prompt, /do not include/);
  assert.doesNotMatch(prompt, /UpdateVariable/);
  assert.doesNotMatch(prompt, /变量更新|變量更新|好感度|位置：咖啡店|状态栏|status_bar|信任：10/);
  assert.doesNotMatch(prompt, /coding assistant, or a general-purpose assistant[\s\S]*User Message[\s\S]*coding assistant/);
});

test("prompt builder includes sanitized local user recall before the user message", () => {
  const prompt = buildCharacterChatPrompt({
    card: {
      id: "ciel-1",
      name: "Ciel",
      characterBook: { entries: [] },
    },
    userName: "User",
    userMessage: "今天怎么样？",
    userRecall: "Local User Memory - Upcoming plans:\n- 2026-05-27 15:00: 体检\n状态栏：角色好感度上升",
    now: new Date("2026-05-18T12:00:00.000Z"),
  });

  assert.match(prompt, /## User Recall[\s\S]*2026-05-27 15:00: 体检/);
  assert.match(prompt, /## User Recall[\s\S]*## User Message/);
  assert.doesNotMatch(prompt, /状态栏|好感度/u);
});
