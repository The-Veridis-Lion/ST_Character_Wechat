const test = require("node:test");
const assert = require("node:assert/strict");

const { CharacterWechatApp } = require("../src/core/app");

test("handlePreparedMessage dispatches active character turns through a character-scoped binding", async () => {
  const dispatched = [];
  const replyTargets = [];
  const sessionStore = {
    buildBindingKey({ workspaceId, accountId, senderId }) {
      return `${workspaceId}:${accountId}:${senderId}`;
    },
  };
  const card = {
    id: "ciel-abc",
    name: "Ciel",
    description: "A character",
    characterBook: {
      entries: [],
    },
  };
  const appLike = {
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      getSessionStore() {
        return sessionStore;
      },
    },
    streamDelivery: {
      setReplyTarget(bindingKey, target) {
        replyTargets.push({ bindingKey, target });
      },
    },
    characterLibrary: {
      getCharacter(id) {
        return id === card.id ? card : null;
      },
    },
    characterStateStore: {
      getActiveCharacterId() {
        return card.id;
      },
    },
    channelAdapter: {
      async sendText() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        text: normalized.text,
      };
    },
    prepareCharacterRuntimeTurn: CharacterWechatApp.prototype.prepareCharacterRuntimeTurn,
    shouldBatchNormalInboundMessage() {
      return false;
    },
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
    },
  };

  await CharacterWechatApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acct",
    senderId: "sender",
    contextToken: "ctx",
    provider: "weixin",
    text: "hello",
    attachments: [],
    receivedAt: "2026-05-17T12:00:00.000Z",
  }, { allowCommands: false });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].bindingKey, "default:acct:sender:character:ciel-abc");
  assert.equal(dispatched[0].prepared.characterChat, true);
  assert.match(dispatched[0].prepared.text, /CHARACTER WECHAT CHAT MODE/);
  assert.match(dispatched[0].prepared.text, /Stay in character as Ciel/);
  assert.ok(replyTargets.some((entry) => entry.bindingKey === "default:acct:sender:character:ciel-abc"));
});

test("character prompt uses original user text without timestamp prefix", async () => {
  const dispatched = [];
  const card = {
    id: "ciel-abc",
    name: "Ciel",
    description: "A character",
    characterBook: {
      entries: [],
    },
  };
  const appLike = {
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey({ workspaceId, accountId, senderId }) {
            return `${workspaceId}:${accountId}:${senderId}`;
          },
        };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    characterLibrary: {
      getCharacter(id) {
        return id === card.id ? card : null;
      },
    },
    characterStateStore: {
      getActiveCharacterId() {
        return card.id;
      },
    },
    channelAdapter: {
      async sendText() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    prepareIncomingMessageForRuntime: CharacterWechatApp.prototype.prepareIncomingMessageForRuntime,
    prepareCharacterRuntimeTurn: CharacterWechatApp.prototype.prepareCharacterRuntimeTurn,
    shouldBatchNormalInboundMessage() {
      return false;
    },
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
    },
  };

  await CharacterWechatApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acct",
    senderId: "sender",
    contextToken: "ctx",
    provider: "weixin",
    text: "今晚喝咖啡吗？",
    attachments: [],
    receivedAt: "2026-05-17T12:00:00.000Z",
  }, { allowCommands: false });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.receivedAt, "2026-05-17T12:00:00.000Z");
  assert.equal(dispatched[0].prepared.localTime, "2026-05-17 20:00");
  assert.match(dispatched[0].prepared.text, /## Current Time\n2026-05-17T12:00:00\.000Z/);
  assert.equal(extractPromptSection(dispatched[0].prepared.text, "User Message"), "今晚喝咖啡吗？");
  assert.doesNotMatch(extractPromptSection(dispatched[0].prepared.text, "User Message"), /\[\d{4}-\d{2}-\d{2}/);
});

test("character prompt ignores old attachment tool instructions in prepared text", async () => {
  const card = {
    id: "ciel-abc",
    name: "Ciel",
    description: "A character",
    characterBook: {
      entries: [],
    },
  };
  const appLike = {
    config: {
      userName: "User",
    },
    characterLibrary: {
      getCharacter(id) {
        return id === card.id ? card : null;
      },
    },
    characterStateStore: {
      getActiveCharacterId() {
        return card.id;
      },
    },
    channelAdapter: {
      async sendText() {},
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    resolveCharacterRuntimeScope: CharacterWechatApp.prototype.resolveCharacterRuntimeScope,
  };

  const turn = await CharacterWechatApp.prototype.prepareCharacterRuntimeTurn.call(appLike, {
    normalized: {
      workspaceId: "default",
      accountId: "acct",
      senderId: "sender",
      contextToken: "ctx",
      provider: "weixin",
      text: "看这个附件",
      receivedAt: "2026-05-17T12:00:00.000Z",
    },
    baseBindingKey: "default:acct:sender",
    workspaceRoot: "/workspace",
    replyTarget: {
      userId: "sender",
      contextToken: "ctx",
      provider: "weixin",
    },
    runtimeScope: {
      bindingKey: "default:acct:sender:character:ciel-abc",
      baseBindingKey: "default:acct:sender",
      workspaceRoot: "/workspace",
      characterChat: true,
      characterId: card.id,
      characterName: card.name,
      card,
    },
    prepared: {
      workspaceId: "default",
      accountId: "acct",
      senderId: "sender",
      contextToken: "ctx",
      provider: "weixin",
      originalText: "看这个附件",
      characterUserMessage: "用户发来了 1 个附件。\n- image: cat.png\n当前角色聊天只知道附件存在；不要假装已经看过附件内容。",
      hasCharacterAttachmentContext: true,
      text: "[2026-05-17 20:00]\n看这个附件\nYou must read these files before replying to User.\nFor images, use `view_image`.",
      receivedAt: "2026-05-17T12:00:00.000Z",
    },
  });

  assert.equal(turn.prepared.characterChat, true);
  assert.doesNotMatch(turn.prepared.text, /You must read these files|view_image|use `Read`/);
  assert.match(extractPromptSection(turn.prepared.text, "User Message"), /用户发来了 1 个附件/);
});

test("cooldown pending merge rebuilds character prompt and keeps character metadata", async () => {
  const dispatched = [];
  const replyTargets = [];
  const card = {
    id: "ciel-abc",
    name: "Ciel",
    description: "A character",
    characterBook: {
      entries: [],
    },
  };
  const appLike = {
    config: {
      userName: "User",
    },
    pendingInboundByScope: new Map(),
    characterLibrary: {
      getCharacter(id) {
        return id === card.id ? card : null;
      },
    },
    characterStateStore: {
      getActiveCharacterId() {
        return card.id;
      },
    },
    channelAdapter: {
      async sendText() {},
    },
    streamDelivery: {
      setReplyTarget(bindingKey, target) {
        replyTargets.push({ bindingKey, target });
      },
    },
    isTurnDispatchBlocked() {
      return false;
    },
    clearPendingInboundDraftTimer: CharacterWechatApp.prototype.clearPendingInboundDraftTimer,
    reconcilePendingInboundDraft: CharacterWechatApp.prototype.reconcilePendingInboundDraft,
    queuePendingInboundFlush: CharacterWechatApp.prototype.queuePendingInboundFlush,
    prepareCharacterRuntimeTurn: CharacterWechatApp.prototype.prepareCharacterRuntimeTurn,
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };
  const runtimeScope = {
    bindingKey: "default:acct:sender:character:ciel-abc",
    baseBindingKey: "default:acct:sender",
    workspaceRoot: "/workspace",
    characterChat: true,
    characterId: card.id,
    characterName: card.name,
    card,
  };

  for (const prepared of [
    {
      workspaceId: "default",
      accountId: "acct",
      senderId: "sender",
      messageId: "101",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "第一条",
      text: "[2026-05-17 20:00]\n第一条",
      receivedAt: "2026-05-17T12:00:01.000Z",
    },
    {
      workspaceId: "default",
      accountId: "acct",
      senderId: "sender",
      messageId: "102",
      contextToken: "ctx-2",
      provider: "weixin",
      originalText: "第二条",
      text: "[2026-05-17 20:00]\n第二条",
      receivedAt: "2026-05-17T12:00:02.000Z",
    },
  ]) {
    CharacterWechatApp.prototype.bufferPendingInboundMessage.call(appLike, {
      bindingKey: runtimeScope.bindingKey,
      workspaceRoot: "/workspace",
      prepared,
      reason: "cooldown",
      runtimeScope,
    });
  }

  const draft = appLike.pendingInboundByScope.get("default:acct:sender:character:ciel-abc::/workspace");
  assert.ok(draft);
  draft.flushAtMs = Date.now() - 1;

  await CharacterWechatApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].bindingKey, "default:acct:sender:character:ciel-abc");
  assert.equal(dispatched[0].prepared.characterChat, true);
  assert.equal(dispatched[0].prepared.characterId, "ciel-abc");
  assert.equal(dispatched[0].prepared.characterName, "Ciel");
  assert.match(dispatched[0].prepared.text, /CHARACTER WECHAT CHAT MODE/);
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条/);
  assert.equal(extractPromptSection(dispatched[0].prepared.text, "User Message"), "第一条\n\n第二条");
  assert.doesNotMatch(extractPromptSection(dispatched[0].prepared.text, "User Message"), /Multiple new WeChat messages|\[\d{4}-\d{2}-\d{2}/);
  assert.ok(replyTargets.some((entry) => entry.bindingKey === "default:acct:sender:character:ciel-abc"));
});

test("model command reads and writes the active character binding", async () => {
  const calls = [];
  const sent = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "default:acct:sender";
          },
          getAvailableModelCatalog() {
            return { models: [{ model: "gpt-5.4" }] };
          },
          getRuntimeParamsForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["get", bindingKey, workspaceRoot]);
            return { model: "" };
          },
          setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params) {
            calls.push(["set", bindingKey, workspaceRoot, params.model]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleModelCommand.call(appLike, {
    workspaceId: "default",
    accountId: "acct",
    senderId: "sender",
    contextToken: "ctx",
  }, {
    args: "gpt-5.4",
  });

  assert.deepEqual(calls, [
    ["get", "default:acct:sender:character:ciel-abc", "/workspace"],
    ["set", "default:acct:sender:character:ciel-abc", "/workspace", "gpt-5.4"],
  ]);
  assert.match(sent[0], /character: Ciel/);
});

test("thread maintenance commands ask for an active character first", async () => {
  const sent = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "";
      },
    },
    characterLibrary: {
      getCharacter() {
        return null;
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "default:acct:sender";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleModelCommand.call(appLike, {
    workspaceId: "default",
    accountId: "acct",
    senderId: "sender",
    contextToken: "ctx",
  }, {
    args: "",
  });

  assert.deepEqual(sent, ["当前没有选择角色，先发送 /char list，然后 /char use 选择角色"]);
});

test("character-only mode accepts one WeChat sender and ignores others", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const configuredApp = {
      config: {
        allowedUserIds: ["user-1", "user-2"],
      },
      activeSenderId: "",
      warnedMultipleAllowedUsers: false,
    };

    assert.equal(
      CharacterWechatApp.prototype.isSingleSenderAllowed.call(configuredApp, { senderId: "user-1" }),
      true,
    );
    assert.equal(configuredApp.activeSenderId, "user-1");
    assert.equal(
      CharacterWechatApp.prototype.isSingleSenderAllowed.call(configuredApp, { senderId: "user-2" }),
      false,
    );
    assert.match(warnings.join("\n"), /supports one WeChat sender/);
    assert.match(warnings.join("\n"), /ignored message from non-active sender=user-2/);

    const firstSeenApp = {
      config: {},
      activeSenderId: "",
    };
    assert.equal(
      CharacterWechatApp.prototype.isSingleSenderAllowed.call(firstSeenApp, { senderId: "first-user" }),
      true,
    );
    assert.equal(firstSeenApp.activeSenderId, "first-user");
    assert.equal(
      CharacterWechatApp.prototype.isSingleSenderAllowed.call(firstSeenApp, { senderId: "second-user" }),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }
});

function extractPromptSection(prompt, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(prompt || "").match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n\\n## |$)`));
  return match ? match[1].trim() : "";
}
