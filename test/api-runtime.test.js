const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createApiRuntimeAdapter,
  buildApiChatCompletionsUrl,
  extractApiResponseText,
} = require("../src/adapters/runtime/api");
const { ApiThreadStore } = require("../src/adapters/runtime/api/thread-store");

test("API URL builder targets chat completions", () => {
  assert.equal(
    buildApiChatCompletionsUrl("https://api.deepseek.com/v1/"),
    "https://api.deepseek.com/v1/chat/completions"
  );
  assert.equal(
    buildApiChatCompletionsUrl("https://example.test/v1/chat/completions"),
    "https://example.test/v1/chat/completions"
  );
  assert.equal(
    buildApiChatCompletionsUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  );
});

test("extractApiResponseText reads OpenAI-compatible message content", () => {
  assert.equal(extractApiResponseText({
    choices: [{
      message: {
        content: "在呢",
      },
    }],
  }), "在呢");
});

test("API runtime emits completed turn events and stores local thread history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-test-"));
  const calls = [];
  const adapter = createApiRuntimeAdapter({
    runtime: "deepseek",
    sessionsFile: path.join(dir, "sessions.json"),
    apiThreadsFile: path.join(dir, "api-threads.json"),
    apiBaseUrl: "https://api.deepseek.test/v1",
    apiKey: "test-key",
    apiModel: "deepseek-chat",
    apiHistoryLimit: 10,
  }, {
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [{
              message: { content: "在呢" },
            }],
          });
        },
      };
    },
  });

  const events = [];
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.sendTextTurn({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    text: "你好",
    metadata: { characterChat: true },
  });

  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));

  assert.ok(turn.threadId.startsWith("api-thread-"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.test/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
  assert.equal(calls[0].body.model, "deepseek-chat");
  assert.deepEqual(calls[0].body.messages.at(-1), {
    role: "user",
    content: "你好",
  });
  assert.ok(events.some((event) => event.type === "runtime.reply.completed" && event.payload.text === "在呢"));
});

test("API runtime stores only visible assistant text in local history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-clean-history-test-"));
  const adapter = createApiRuntimeAdapter({
    runtime: "api",
    sessionsFile: path.join(dir, "sessions.json"),
    apiThreadsFile: path.join(dir, "api-threads.json"),
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    apiModel: "chat-model",
    apiHistoryLimit: 10,
  }, {
    fetch: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({
          choices: [{
            message: { content: "<think>hidden reasoning</think>\n可见回复" },
          }],
        });
      },
    }),
  });

  const events = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.sendTextTurn({
    bindingKey: "binding-clean",
    workspaceRoot: "/workspace",
    text: "你好",
    metadata: { characterChat: true },
  });

  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));

  const stored = JSON.parse(fs.readFileSync(path.join(dir, "api-threads.json"), "utf8"));
  const messages = Object.values(stored.threads)[0].messages;
  assert.equal(messages.at(-1).role, "model");
  assert.equal(messages.at(-1).text, "可见回复");
  assert.ok(events.some((event) => event.type === "runtime.reply.completed" && event.payload.text === "可见回复"));
  assert.ok(!JSON.stringify(stored).includes("hidden reasoning"));
});

test("API thread store cleans hidden reasoning from existing model history on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-clean-existing-test-"));
  const filePath = path.join(dir, "api-threads.json");
  fs.writeFileSync(filePath, JSON.stringify({
    threads: {
      "thread-1": {
        threadId: "thread-1",
        workspaceRoot: "/workspace",
        messages: [
          { role: "user", text: "用户提到 <think> 这个字面标签" },
          { role: "model", text: "<think>MODEL_SECRET</think>\n可见回复" },
          { role: "assistant", text: "思维链: MODEL_SECRET_TWO\n\n第二条可见回复" },
        ],
      },
    },
  }, null, 2));

  const store = new ApiThreadStore({ filePath, maxMessages: 10 });
  const thread = store.getThread("thread-1");

  assert.equal(thread.messages[0].text, "用户提到 <think> 这个字面标签");
  assert.equal(thread.messages[1].text, "可见回复");
  assert.equal(thread.messages[2].text, "第二条可见回复");
  const persisted = fs.readFileSync(filePath, "utf8");
  assert.ok(!persisted.includes("MODEL_SECRET"));
  assert.ok(!persisted.includes("MODEL_SECRET_TWO"));
});

test("API thread store reports local history character stats", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-stats-test-"));
  const filePath = path.join(dir, "api-threads.json");
  fs.writeFileSync(filePath, JSON.stringify({
    threads: {
      "thread-1": {
        threadId: "thread-1",
        messages: [
          { role: "user", text: "你好" },
          { role: "model", text: "hello" },
          { role: "system", text: "[ST Character WeChat API history summary]\n摘要", compacted: true },
        ],
      },
    },
  }, null, 2));

  const store = new ApiThreadStore({ filePath, maxMessages: 10 });
  const stats = store.getThreadStats("thread-1");

  assert.equal(stats.messageCount, 3);
  assert.equal(stats.userChars, 2);
  assert.equal(stats.assistantChars, 5);
  assert.equal(stats.summaryMessages, 1);
  assert.equal(stats.summaryChars, 44);
  assert.equal(stats.requestChars, 51);
  assert.equal(stats.estimatedTokens, 16);
});

test("API runtime emits streaming delta events from SSE responses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-stream-test-"));
  const calls = [];
  const adapter = createApiRuntimeAdapter({
    runtime: "api",
    sessionsFile: path.join(dir, "sessions.json"),
    apiThreadsFile: path.join(dir, "api-threads.json"),
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    apiModel: "chat-model",
    apiHistoryLimit: 10,
    apiStreamingEnabled: true,
  }, {
    fetch: async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(init.body),
      });
      return createSseResponse([
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好。" } }] },
      ]);
    },
  });

  const events = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.sendTextTurn({
    bindingKey: "binding-stream",
    workspaceRoot: "/workspace",
    text: "你好",
    metadata: { characterChat: true },
  });

  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));

  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(
    events
      .filter((event) => event.type === "runtime.reply.delta")
      .map((event) => event.payload.text),
    ["你", "好。"]
  );
  assert.ok(events.some((event) => event.type === "runtime.reply.completed" && event.payload.text === "你好。"));
});

test("API runtime compacts older local history into plain text summaries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-compact-test-"));
  const calls = [];
  let fetchCount = 0;
  const runtimeConfig = {
    runtime: "api",
    sessionsFile: path.join(dir, "sessions.json"),
    apiThreadsFile: path.join(dir, "api-threads.json"),
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    apiModel: "chat-model",
    apiHistoryLimit: 40,
    apiStreamingEnabled: false,
    apiTimeCompactionEnabled: true,
    apiHistoryRecentDays: 3,
    apiHistoryWeeklyCompactAfterDays: 7,
    apiHistoryMonthlyCompactAfterDays: 30,
    apiHistoryWeeklySummaryChars: 500,
  };
  const runtimeOptions = {
    fetch: async (url, init) => {
      fetchCount += 1;
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [{
              message: { content: `reply-${fetchCount}` },
            }],
          });
        },
      };
    },
  };

  const events = [];
  let adapter = createApiRuntimeAdapter(runtimeConfig, runtimeOptions);
  adapter.onEvent((event) => events.push(event));
  const threadsFile = path.join(dir, "api-threads.json");
  await adapter.sendTextTurn({
    bindingKey: "binding-compact",
    workspaceRoot: "/workspace",
    text: "CHARACTER WECHAT CHAT MODE\n\n## Description\nold prompt should not repeat\n\n## User Message\nold hello",
    metadata: { characterChat: true },
  });
  await waitFor(() => events.filter((event) => event.type === "runtime.turn.completed").length >= 1);
  markStoredApiMessagesOlderThan(threadsFile, 20);

  adapter = createApiRuntimeAdapter(runtimeConfig, runtimeOptions);
  adapter.onEvent((event) => events.push(event));
  await adapter.sendTextTurn({
    bindingKey: "binding-compact",
    workspaceRoot: "/workspace",
    text: "CHARACTER WECHAT CHAT MODE\n\n## Description\nfresh prompt stays current\n\n## User Message\nfresh hello",
    metadata: { characterChat: true },
  });
  await waitFor(() => events.filter((event) => event.type === "runtime.turn.completed").length >= 2);

  const latestMessages = calls.at(-1).messages;
  assert.ok(latestMessages.some((message) => /月第\d+周总结：/u.test(message.content)));
  assert.ok(latestMessages.some((message) => /用户: old hello/u.test(message.content)));
  assert.ok(latestMessages.some((message) => /角色: reply-1/u.test(message.content)));
  assert.ok(latestMessages.some((message) => message.content.includes("fresh prompt stays current")));
  assert.ok(!latestMessages.some((message) => message.content.includes("old prompt should not repeat")));
});

test("API runtime moves history older than 30 days into long-term memory lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-api-ltm-test-"));
  const calls = [];
  let fetchCount = 0;
  const runtimeConfig = {
    runtime: "api",
    sessionsFile: path.join(dir, "sessions.json"),
    apiThreadsFile: path.join(dir, "api-threads.json"),
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    apiModel: "chat-model",
    apiHistoryLimit: 40,
    apiStreamingEnabled: false,
    apiTimeCompactionEnabled: true,
    apiHistoryRecentDays: 3,
    apiHistoryWeeklyCompactAfterDays: 7,
    apiHistoryMonthlyCompactAfterDays: 30,
    localTimeZone: "America/New_York",
  };
  const runtimeOptions = {
    fetch: async (url, init) => {
      fetchCount += 1;
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            choices: [{
              message: { content: `reply-${fetchCount}` },
            }],
          });
        },
      };
    },
  };

  const events = [];
  let adapter = createApiRuntimeAdapter(runtimeConfig, runtimeOptions);
  adapter.onEvent((event) => events.push(event));
  const threadsFile = path.join(dir, "api-threads.json");
  await adapter.sendTextTurn({
    bindingKey: "binding-ltm",
    workspaceRoot: "/workspace",
    text: "CHARACTER WECHAT CHAT MODE\n\n## Description\nold prompt should not repeat\n\n## User Message\n不要把隐私信息写进示例",
    metadata: { characterChat: true },
  });
  await waitFor(() => events.filter((event) => event.type === "runtime.turn.completed").length >= 1);
  markStoredApiMessagesOlderThan(threadsFile, 40);

  adapter = createApiRuntimeAdapter(runtimeConfig, runtimeOptions);
  adapter.onEvent((event) => events.push(event));
  await adapter.sendTextTurn({
    bindingKey: "binding-ltm",
    workspaceRoot: "/workspace",
    text: "fresh hello",
    metadata: { characterChat: true },
  });
  await waitFor(() => events.filter((event) => event.type === "runtime.turn.completed").length >= 2);

  const latestMessages = calls.at(-1).messages;
  const ltm = latestMessages.find((message) => message.content.includes("<LTM v1>"));
  assert.ok(ltm);
  assert.ok(ltm.content.includes("Long-term memory lines"));
  assert.match(ltm.content, /^B\|b[0-9a-f]{8}\|high\|\d{4}-\d{2}-\d{2}\|用户：不要把隐私信息写进示例/m);
  assert.ok(!ltm.content.includes("长期 API 历史摘要"));
  assert.ok(!latestMessages.some((message) => message.content.includes("old prompt should not repeat")));
});

function markStoredApiMessagesOlderThan(filePath, days) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const createdAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  for (const thread of Object.values(parsed.threads || {})) {
    for (const message of thread.messages || []) {
      message.createdAt = createdAt;
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
}

function createSseResponse(payloads) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return {
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "text/event-stream" : "";
      },
    },
    body,
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}
