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
