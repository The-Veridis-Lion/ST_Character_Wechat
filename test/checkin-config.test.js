const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CharacterWechatApp,
  buildScheduledReportMark,
  loadScheduledReportState,
  markScheduledReportSent,
  resolveScheduledReportDue,
} = require("../src/core/app");

test("handleCheckinCommand reports character-only disabled behavior", async () => {
  const sent = [];
  const appLike = {
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CharacterWechatApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "7-21",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "character-only 模式不使用旧 checkin 主动触发；请直接和当前角色聊天，后续用户状态长图会走 /dailycard 和 /weeklycard。");
  assert.equal(sent[0].singleLine, true);
});

test("handleChunkCommand reports current value and persists updates through the channel adapter", async () => {
  const sent = [];
  let minChunk = 20;
  const appLike = {
    channelAdapter: {
      getMinChunkChars() {
        return minChunk;
      },
      setMinChunkChars(value) {
        minChunk = value;
        return minChunk;
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CharacterWechatApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "",
  });
  await CharacterWechatApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "50",
  });

  assert.equal(sent[0].text, "💡 Current minimum merge chunk is 20 characters. Usage: /chunk <number> (e.g. /chunk 50)");
  assert.equal(sent[1].text, "✅ Minimum merge chunk set to 50 characters. Shorter fragments will be merged into one message up to this size.");
  assert.equal(minChunk, 50);
});

test("handleCompactCommand manages auto compact settings through the channel adapter", async () => {
  const sent = [];
  let config = {
    enabled: true,
    thresholdPercent: 75,
  };
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
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
        };
      },
    },
    channelAdapter: {
      getAutoCompactConfig() {
        return { ...config };
      },
      setAutoCompactConfig(values) {
        config = {
          ...config,
          ...values,
        };
        return { ...config };
      },
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleCompactCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "auto off",
  });
  await CharacterWechatApp.prototype.handleCompactCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "auto 82",
  });

  assert.equal(sent[0], "Auto compact disabled. Threshold stays at 75%.");
  assert.equal(sent[1], "Auto compact enabled at 82% used context.");
  assert.deepEqual(config, {
    enabled: true,
    thresholdPercent: 82,
  });
});

test("report card command requests runtime JSON and mutes the report turn", async () => {
  const sent = [];
  const typing = [];
  const muted = [];
  const pending = new Map();
  const card = { id: "ciel-abc", name: "Ciel" };
  const sessionStore = {
    getThreadIdForWorkspace() {
      return "thread-1";
    },
    getRuntimeParamsForWorkspace() {
      return { model: "model-a" };
    },
  };
  const appLike = {
    config: {
      userName: "User",
      reportTimeZone: "Asia/Shanghai",
    },
    projectServices: {
      dailyDiaryCard: {
        buildRuntimePrompt() {
          return "{\"kind\":\"daily\"}";
        },
        async renderFromRuntimeText() {
          throw new Error("not used");
        },
      },
    },
    runtimeAdapter: {
      async sendTextTurn(payload) {
        sent.push(payload.text);
        return { threadId: "thread-1", turnId: "turn-1" };
      },
    },
    pendingOperationByRunKey: pending,
    streamDelivery: {
      setReplyTarget() {},
      muteRun(payload) {
        muted.push(payload);
      },
    },
    turnGateStore: {
      begin() {
        return "scope-1";
      },
      attachThread() {},
      attachRun() {},
      releaseScope() {},
    },
    isTurnDispatchBlocked() {
      return false;
    },
    scheduleRuntimeEventWatchdog() {},
    async resolveActiveCharacterThreadTarget() {
      return {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        card,
        sessionStore,
      };
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
      async sendTyping(payload) {
        typing.push(payload);
      },
    },
  };

  await CharacterWechatApp.prototype.handleReportCardCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  }, "daily");

  assert.ok(sent.includes("{\"kind\":\"daily\"}"));
  assert.deepEqual(muted[0], { threadId: "thread-1", turnId: "turn-1" });
  assert.equal(pending.get("thread-1:turn-1").kind, "report_card");
  assert.equal(pending.get("thread-1:turn-1").reportKind, "daily");
  assert.equal(typing[0].status, 1);
});

test("legacy report commands point to long-card commands", async () => {
  const sent = [];
  const appLike = {
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleLegacyReportCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, "/weekly", "/weeklycard");

  assert.equal(sent[0], "/weekly 已替换为 /weeklycard；当前只生成长图报告。");
});

test("scheduled daily report skips after the same day is marked sent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-auto-report-"));
  const stateFile = path.join(tempDir, "auto-report-cards.json");
  try {
    const config = {
      autoReportStateFile: stateFile,
      autoDailyReportEnabled: true,
      autoDailyReportTime: "23:30",
    };
    const firstDue = resolveScheduledReportDue({
      now: new Date("2026-05-19T23:31:00.000Z"),
      timeZone: "UTC",
      reportKind: "daily",
      config,
      state: loadScheduledReportState(stateFile),
      accountId: "account-1",
      senderId: "sender-1",
    });

    assert.equal(firstDue.due, true);
    assert.equal(firstDue.mark.periodKey, "2026-05-19");

    markScheduledReportSent(firstDue.mark);
    const secondDue = resolveScheduledReportDue({
      now: new Date("2026-05-19T23:45:00.000Z"),
      timeZone: "UTC",
      reportKind: "daily",
      config,
      state: loadScheduledReportState(stateFile),
      accountId: "account-1",
      senderId: "sender-1",
    });

    assert.equal(secondDue.due, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("scheduled weekly report respects selected weekday and skips once sent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-auto-weekly-"));
  const stateFile = path.join(tempDir, "auto-report-cards.json");
  try {
    const baseConfig = {
      autoReportStateFile: stateFile,
      autoWeeklyReportEnabled: true,
      autoWeeklyReportTime: "23:30",
    };
    const wrongDay = resolveScheduledReportDue({
      now: new Date("2026-05-18T23:31:00.000Z"),
      timeZone: "UTC",
      reportKind: "weekly",
      config: { ...baseConfig, autoWeeklyReportWeekday: "sunday" },
      state: loadScheduledReportState(stateFile),
      accountId: "account-1",
      senderId: "sender-1",
    });
    const mondayDue = resolveScheduledReportDue({
      now: new Date("2026-05-18T23:31:00.000Z"),
      timeZone: "UTC",
      reportKind: "weekly",
      config: { ...baseConfig, autoWeeklyReportWeekday: "monday" },
      state: loadScheduledReportState(stateFile),
      accountId: "account-1",
      senderId: "sender-1",
    });

    assert.equal(wrongDay.due, false);
    assert.equal(mondayDue.due, true);
    assert.equal(mondayDue.mark.periodKey, "2026-05-11:2026-05-17");

    markScheduledReportSent(mondayDue.mark);
    const repeatDue = resolveScheduledReportDue({
      now: new Date("2026-05-18T23:50:00.000Z"),
      timeZone: "UTC",
      reportKind: "weekly",
      config: { ...baseConfig, autoWeeklyReportWeekday: "monday" },
      state: loadScheduledReportState(stateFile),
      accountId: "account-1",
      senderId: "sender-1",
    });

    assert.equal(repeatDue.due, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("finalized manual report records the scheduled report period after the file is sent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-manual-report-"));
  const stateFile = path.join(tempDir, "auto-report-cards.json");
  try {
    const sentFiles = [];
    const mark = buildScheduledReportMark({
      filePath: stateFile,
      reportKind: "daily",
      now: new Date("2026-05-19T20:00:00.000Z"),
      timeZone: "UTC",
      accountId: "account-1",
      senderId: "sender-1",
    });
    const appLike = {
      config: {
        userName: "User",
        reportTimeZone: "UTC",
      },
      projectServices: {
        dailyDiaryCard: {
          async renderFromRuntimeText() {
            return { filePath: path.join(tempDir, "daily.png") };
          },
        },
      },
      channelAdapter: {
        async sendFile(payload) {
          sentFiles.push(payload.filePath);
        },
        async sendTyping() {},
      },
    };

    await CharacterWechatApp.prototype.finalizeReportCardOperation.call(appLike, {
      reportKind: "daily",
      scheduledReportMark: mark,
      userId: "sender-1",
      contextToken: "ctx-1",
      reportNow: "2026-05-19T20:00:00.000Z",
      turnText: "{\"date\":\"2026-05-19\"}",
    }, {
      payload: {},
    });

    const state = loadScheduledReportState(stateFile);
    assert.deepEqual(sentFiles, [path.join(tempDir, "daily.png")]);
    assert.equal(state.sentByTarget[mark.key], "2026-05-19");
    assert.equal(state.sentDateByTarget[mark.key], "2026-05-19");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
