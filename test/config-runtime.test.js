const assert = require("node:assert/strict");
const test = require("node:test");

const { readConfig } = require("../src/core/config");

const RUNTIME_KEYS = [
  "ST_CHARACTER_WECHAT_RUNTIME",
  "ST_CHARACTER_WECHAT_API_BASE_URL",
  "ST_CHARACTER_WECHAT_API_KEY",
  "ST_CHARACTER_WECHAT_API_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
];

test("readConfig defaults to codex when no runtime or API config is present", () => {
  withRuntimeEnv({}, () => {
    assert.equal(readConfig().runtime, "codex");
  });
});

test("readConfig infers API runtime when API config exists and runtime is omitted", () => {
  withRuntimeEnv({
    ST_CHARACTER_WECHAT_API_BASE_URL: "https://api.example.test/v1",
    ST_CHARACTER_WECHAT_API_KEY: "test-key",
    ST_CHARACTER_WECHAT_API_MODEL: "test-model",
  }, () => {
    assert.equal(readConfig().runtime, "api");
  });
});

test("readConfig respects an explicit runtime even when API config exists", () => {
  withRuntimeEnv({
    ST_CHARACTER_WECHAT_RUNTIME: "codex",
    ST_CHARACTER_WECHAT_API_KEY: "test-key",
  }, () => {
    assert.equal(readConfig().runtime, "codex");
  });
});

function withRuntimeEnv(values, fn) {
  const previous = {};
  for (const key of RUNTIME_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of RUNTIME_KEYS) {
      if (previous[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}
