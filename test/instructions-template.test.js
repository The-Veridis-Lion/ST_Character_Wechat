const test = require("node:test");
const assert = require("node:assert/strict");

const {
  renderInstructionTemplate,
  resolveUserDisplayName,
  resolveUserPronoun,
} = require("../src/core/instructions-template");

test("resolveUserDisplayName can choose from slash separated names", () => {
  assert.equal(resolveUserDisplayName("小希 / 希希 / 亲爱的", { random: () => 0 }), "小希");
  assert.equal(resolveUserDisplayName("小希 / 希希 / 亲爱的", { random: () => 0.5 }), "希希");
  assert.equal(resolveUserDisplayName("小希 / 希希 / 亲爱的", { random: () => 0.99 }), "亲爱的");
});

test("resolveUserPronoun supports configured gender", () => {
  assert.equal(resolveUserPronoun("female"), "她");
  assert.equal(resolveUserPronoun("male"), "他");
  assert.equal(resolveUserPronoun("neutral"), "TA");
});

test("renderInstructionTemplate substitutes user name and pronoun", () => {
  const rendered = renderInstructionTemplate("{{USER_NAME}} 今天说她很累。", {
    userName: "小希",
    userGender: "male",
  });
  assert.equal(rendered, "小希 今天说他很累。");
});
