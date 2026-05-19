const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CharacterWechatApp } = require("../src/core/app");

test("system messages bypass normal inbound wrapping", async () => {
  const prepared = await CharacterWechatApp.prototype.prepareIncomingMessageForRuntime.call({}, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
  }, "/tmp");

  assert.deepEqual(prepared, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    originalText: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    localTime: "",
    attachments: [],
    attachmentFailures: [],
  });
});

test("image attachments inject view_image instructions for runtimes that support it", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await CharacterWechatApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
      },
      runtimeAdapter: {
        describe() {
          return { id: "codex" };
        },
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, "/workspace");

    assert.match(prepared.text, /For images, use `view_image`/i);
    assert.doesNotMatch(prepared.text, /Do not use `Read` or shell commands on image files/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("image attachments tell claudecode to use Read on the saved local image file", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await CharacterWechatApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
      },
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, "/workspace");

    assert.match(prepared.text, /You must read these files before replying to User/i);
    assert.match(prepared.text, /For images, use `Read` on the saved local image file/i);
    assert.doesNotMatch(prepared.text, /Do not use shell commands or wrappers/i);
    assert.doesNotMatch(prepared.text, /view_image/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("location arrive_home trigger is ignored in character-only mode", () => {
  const queued = [];
  CharacterWechatApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-1",
        trigger: "arrive_home",
        timestamp: "2026-04-18T16:00:00.000Z",
        receivedAt: "2026-04-18T16:00:01.000Z",
      },
      movementEvent: null,
    },
  });

  assert.equal(queued.length, 0);
});

test("location leave_home trigger and major move are ignored in character-only mode", () => {
  const queued = [];
  CharacterWechatApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-2",
        trigger: "leave_home",
        timestamp: "2026-04-18T17:00:00.000Z",
        receivedAt: "2026-04-18T17:00:02.000Z",
      },
      movementEvent: {
        id: "move-1",
        distanceMeters: 2400,
        fromAddress: "Home",
        toAddress: "Office",
        movedAt: "2026-04-18T17:20:00.000Z",
      },
    },
  });

  assert.equal(queued.length, 0);
});
