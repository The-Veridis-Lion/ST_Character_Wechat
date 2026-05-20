const test = require("node:test");
const assert = require("node:assert/strict");

const { CharacterWechatApp } = require("../src/core/app");
const {
  buildWeixinHelpText,
  listCommandGroups,
} = require("../src/core/command-registry");

function collectWeixinCommands() {
  return listCommandGroups()
    .flatMap((group) => group.actions)
    .filter((action) => action.status === "active")
    .flatMap((action) => action.weixin);
}

function baseMessage() {
  return {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  };
}

test("install command registry advertises current character-only commands", () => {
  const commands = collectWeixinCommands();
  for (const command of [
    "/char list",
    "/char use <name|number>",
    "/char current",
    "/char reload",
    "/char reset",
    "/dailycard",
    "/weeklycard",
    "/model",
    "/model <id>",
    "/compact",
    "/stop",
    "/help",
  ]) {
    assert.ok(commands.includes(command), `${command} should be advertised`);
  }

  for (const removedCommand of ["/new", "/diarycard", "/checkin", "/userstatus", "/statuscard"]) {
    assert.equal(commands.includes(removedCommand), false, `${removedCommand} should not be advertised`);
  }
});

test("install help text keeps reset and long-card commands but hides removed aliases", () => {
  const helpText = buildWeixinHelpText();

  assert.match(helpText, /\/char reset/u);
  assert.match(helpText, /\/dailycard/u);
  assert.match(helpText, /\/weeklycard/u);
  assert.doesNotMatch(helpText, /\/reread/u);
  assert.doesNotMatch(helpText, /\/compact/u);
  assert.doesNotMatch(helpText, /(^|[\s,])\/new($|[\s,])/u);
  assert.doesNotMatch(helpText, /\/diarycard/u);
  assert.doesNotMatch(helpText, /\/userstatus|\/statuscard/u);
});

test("char command routes reset and unknown subcommands correctly", async () => {
  const calls = [];
  const sent = [];
  const appLike = {
    async handleCharListCommand() {
      calls.push(["list"]);
    },
    async handleCharReloadCommand() {
      calls.push(["reload"]);
    },
    async handleCharUseCommand(_normalized, args) {
      calls.push(["use", args]);
    },
    async handleCharCurrentCommand() {
      calls.push(["current"]);
    },
    async handleCharResetCommand() {
      calls.push(["reset"]);
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleCharCommand.call(appLike, baseMessage(), { args: "reset" });
  await CharacterWechatApp.prototype.handleCharCommand.call(appLike, baseMessage(), { args: "use Ciel" });
  await CharacterWechatApp.prototype.handleCharCommand.call(appLike, baseMessage(), { args: "unknown" });

  assert.deepEqual(calls, [["reset"], ["use", "Ciel"]]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\/char reset/u);
  assert.doesNotMatch(sent[0], /\/new/u);
});

test("removed WeChat aliases fall back to help instead of doing work", async () => {
  const sent = [];
  const calls = [];
  const appLike = {
    async handleReportCardCommand(_normalized, kind) {
      calls.push(["report", kind]);
    },
    async handleCharCommand() {
      calls.push(["char"]);
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.dispatchChannelCommand.call(appLike, baseMessage(), { name: "new", args: "" });
  await CharacterWechatApp.prototype.dispatchChannelCommand.call(appLike, baseMessage(), { name: "diarycard", args: "" });

  assert.deepEqual(calls, []);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((text) => /Available commands/u.test(text)));
  assert.ok(sent.every((text) => /\/char reset/u.test(text)));
  assert.ok(sent.every((text) => !/\/diarycard|(^|[\s,])\/new($|[\s,])/u.test(text)));
});

test("daily and weekly card commands still dispatch to report generation", async () => {
  const calls = [];
  const appLike = {
    async handleReportCardCommand(_normalized, kind) {
      calls.push(kind);
    },
  };

  await CharacterWechatApp.prototype.dispatchChannelCommand.call(appLike, baseMessage(), { name: "dailycard", args: "" });
  await CharacterWechatApp.prototype.dispatchChannelCommand.call(appLike, baseMessage(), { name: "weeklycard", args: "" });

  assert.deepEqual(calls, ["daily", "weekly"]);
});
