const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { UserMemoryService, extractPlannedEvents } = require("../src/services/user-memory-service");

test("user memory stores future dated plans on the target day and recalls them later", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-user-memory-"));
  const service = new UserMemoryService({
    config: {
      userMemoryDir: dir,
      userMemoryTimeZone: "Asia/Shanghai",
      userMemoryRecentDays: 7,
      userMemoryUpcomingDays: 14,
    },
  });

  const result = service.appendTurn({
    accountId: "acct",
    senderId: "sender",
    characterId: "ciel",
    characterName: "Ciel",
    userText: "我最近压力很大，昨晚失眠。下周三下午3点要去体检，记得提醒我。",
    assistantText: "我记住了。",
    receivedAt: "2026-05-18T05:00:00.000Z",
    completedAt: "2026-05-18T05:00:10.000Z",
  });

  assert.equal(result.sourceDate, "2026-05-18");
  assert.deepEqual(result.plannedEventDates, ["2026-05-27"]);

  const sourceRecord = service.readDayRecord({
    senderId: "sender",
    characterId: "ciel",
    date: "2026-05-18",
  });
  assert.equal(sourceRecord.turns.length, 1);
  assert.ok(sourceRecord.stateSignals.some((signal) => signal.kind === "stress"));
  assert.ok(sourceRecord.stateSignals.some((signal) => signal.kind === "sleep"));

  const targetRecord = service.readDayRecord({
    senderId: "sender",
    characterId: "ciel",
    date: "2026-05-27",
  });
  assert.equal(targetRecord.plannedEvents.length, 1);
  assert.equal(targetRecord.plannedEvents[0].date, "2026-05-27");
  assert.equal(targetRecord.plannedEvents[0].time, "15:00");
  assert.match(targetRecord.plannedEvents[0].label, /体检/);

  const recall = service.buildRecallContext({
    senderId: "sender",
    characterId: "ciel",
    now: new Date("2026-05-27T01:00:00.000Z"),
    recentDays: 3,
    upcomingDays: 1,
  });
  assert.match(recall.text, /2026-05-27 15:00/);
  assert.match(recall.text, /体检/);
});

test("user memory keeps status scoped while sharing upcoming plans across characters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-user-memory-scope-"));
  const service = new UserMemoryService({
    config: {
      userMemoryDir: dir,
      userMemoryTimeZone: "Asia/Shanghai",
    },
  });

  service.appendTurn({
    senderId: "sender",
    characterId: "ciel",
    userText: "今天压力很大。明天下午2点要开会。",
    receivedAt: "2026-05-18T05:00:00.000Z",
  });
  const otherRecall = service.buildRecallContext({
    senderId: "sender",
    characterId: "other-character",
    now: new Date("2026-05-19T01:00:00.000Z"),
  });

  assert.match(otherRecall.text, /2026-05-19 14:00/);
  assert.match(otherRecall.text, /开会/);
  assert.doesNotMatch(otherRecall.text, /压力很大/);
});

test("semantic user memory can retrieve older memories outside the text date window", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/embeddings$/);
    const body = JSON.parse(String(options.body || "{}"));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        data: inputs.map((input) => ({
          embedding: buildTinyEmbedding(input),
        })),
      }),
    };
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-user-memory-semantic-"));
  const service = new UserMemoryService({
    config: {
      userMemoryDir: dir,
      userMemoryTimeZone: "Asia/Shanghai",
      userMemoryRecentDays: 1,
      userMemoryUpcomingDays: 1,
      userMemorySemanticEnabled: true,
      userMemorySemanticBaseUrl: "https://example.test/v1",
      userMemorySemanticApiKey: "test-key",
      userMemoryEmbeddingModel: "test-embedding",
      userMemorySemanticCandidateLimit: 10,
      userMemorySemanticTopK: 3,
    },
  });

  service.appendTurn({
    senderId: "sender",
    characterId: "ciel",
    userText: "我最喜欢蓝莓芝士蛋糕，今天很开心。",
    assistantText: "我记住你喜欢蓝莓芝士蛋糕。",
    receivedAt: "2026-04-01T05:00:00.000Z",
  });

  const plainRecall = service.buildRecallContext({
    senderId: "sender",
    characterId: "ciel",
    now: new Date("2026-05-18T01:00:00.000Z"),
    recentDays: 1,
    upcomingDays: 1,
  });
  assert.equal(plainRecall.text, "");

  const semanticRecall = await service.buildRecallContextAsync({
    senderId: "sender",
    characterId: "ciel",
    query: "蓝莓芝士蛋糕",
    now: new Date("2026-05-18T01:00:00.000Z"),
    recentDays: 1,
    upcomingDays: 1,
  });
  assert.match(semanticRecall.text, /Longer-term memory/);
  assert.match(semanticRecall.text, /蓝莓芝士蛋糕/);
  assert.ok(fs.existsSync(path.join(dir, "semantic-index.json")));
  const index = JSON.parse(fs.readFileSync(path.join(dir, "semantic-index.json"), "utf8"));
  assert.ok(index.items.some((item) => item.recallCount === 1 && item.lastRecalledAt));
});

test("semantic user memory skips weak passive matches but allows explicit recall", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/embeddings$/);
    const body = JSON.parse(String(options.body || "{}"));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        data: inputs.map((input) => ({
          embedding: buildTinyEmbedding(input),
        })),
      }),
    };
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-user-memory-threshold-"));
  const service = new UserMemoryService({
    config: {
      userMemoryDir: dir,
      userMemoryTimeZone: "Asia/Shanghai",
      userMemorySemanticEnabled: true,
      userMemorySemanticBaseUrl: "https://example.test/v1",
      userMemorySemanticApiKey: "test-key",
      userMemoryEmbeddingModel: "test-embedding",
      userMemorySemanticPassiveMinScore: 0.32,
      userMemorySemanticExplicitMinScore: 0.05,
    },
  });

  service.appendTurn({
    senderId: "sender",
    characterId: "ciel",
    userText: "我最喜欢蓝莓芝士蛋糕。",
    receivedAt: "2026-04-01T05:00:00.000Z",
  });

  const passiveRecall = await service.buildRecallContextAsync({
    senderId: "sender",
    characterId: "ciel",
    query: "今天只是普通聊天",
    now: new Date("2026-05-18T01:00:00.000Z"),
    recentDays: 1,
    upcomingDays: 1,
  });
  assert.equal(passiveRecall.text, "");

  const explicitRecall = await service.buildRecallContextAsync({
    senderId: "sender",
    characterId: "ciel",
    query: "你还记得我之前说过喜欢什么吗？",
    now: new Date("2026-05-18T01:00:00.000Z"),
    recentDays: 1,
    upcomingDays: 1,
  });
  assert.match(explicitRecall.text, /蓝莓芝士蛋糕/);
});

test("semantic rerank is skipped when the candidate pool is no larger than top k", async (t) => {
  const originalFetch = global.fetch;
  let rerankRequests = 0;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options = {}) => {
    if (/\/rerank$/u.test(String(url))) {
      rerankRequests += 1;
      throw new Error("rerank should not be called for a tiny candidate pool");
    }
    assert.match(String(url), /\/embeddings$/);
    const body = JSON.parse(String(options.body || "{}"));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        data: inputs.map((input) => ({
          embedding: buildTinyEmbedding(input),
        })),
      }),
    };
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-user-memory-rerank-skip-"));
  const service = new UserMemoryService({
    config: {
      userMemoryDir: dir,
      userMemoryTimeZone: "Asia/Shanghai",
      userMemorySemanticEnabled: true,
      userMemorySemanticBaseUrl: "https://example.test/v1",
      userMemorySemanticApiKey: "test-key",
      userMemoryEmbeddingModel: "test-embedding",
      userMemoryRerankEnabled: true,
      userMemoryRerankModel: "test-rerank",
      userMemorySemanticTopK: 10,
    },
  });

  service.appendTurn({
    senderId: "sender",
    characterId: "ciel",
    userText: "我最喜欢蓝莓芝士蛋糕。",
    receivedAt: "2026-04-01T05:00:00.000Z",
  });

  const recall = await service.buildRecallContextAsync({
    senderId: "sender",
    characterId: "ciel",
    query: "蓝莓芝士蛋糕",
    now: new Date("2026-05-18T01:00:00.000Z"),
  });
  assert.match(recall.text, /蓝莓芝士蛋糕/);
  assert.equal(rerankRequests, 0);
});

test("planned event extractor resolves common Chinese relative dates", () => {
  const events = extractPlannedEvents({
    text: "下周三下午3点要去体检，明天上午10点开会。",
    receivedAt: "2026-05-18T05:00:00.000Z",
    sourceDate: "2026-05-18",
    timeZone: "Asia/Shanghai",
    senderId: "sender",
    characterId: "ciel",
  });

  assert.deepEqual(events.map((event) => [event.date, event.time]), [
    ["2026-05-27", "15:00"],
    ["2026-05-19", "10:00"],
  ]);
});

function buildTinyEmbedding(value) {
  const text = String(value || "");
  return [
    /蓝莓|芝士|蛋糕/u.test(text) ? 1 : 0,
    /开心|心情/u.test(text) ? 0.5 : 0,
    0.1,
  ];
}
