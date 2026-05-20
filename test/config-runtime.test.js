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
  "ST_CHARACTER_WECHAT_INBOUND_BATCH_WINDOW_SECONDS",
  "ST_CHARACTER_WECHAT_INBOUND_BATCH_MAX_MESSAGES",
  "ST_CHARACTER_WECHAT_TYPING_MIN_DELAY_SECONDS",
  "ST_CHARACTER_WECHAT_TYPING_MAX_DELAY_SECONDS",
  "ST_CHARACTER_WECHAT_API_STREAMING_ENABLED",
  "ST_CHARACTER_WECHAT_API_TIME_COMPACTION_ENABLED",
  "ST_CHARACTER_WECHAT_API_HISTORY_RECENT_DAYS",
  "ST_CHARACTER_WECHAT_API_HISTORY_WEEKLY_COMPACT_AFTER_DAYS",
  "ST_CHARACTER_WECHAT_API_HISTORY_WEEKLY_SUMMARY_CHARS",
  "ST_CHARACTER_WECHAT_API_HISTORY_MONTHLY_COMPACT_AFTER_DAYS",
  "ST_CHARACTER_WECHAT_API_HISTORY_MONTHLY_SUMMARY_CHARS",
  "ST_CHARACTER_WECHAT_API_HISTORY_SUMMARY_CHARS",
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

test("readConfig reads message pacing and API streaming options", () => {
  withRuntimeEnv({
    ST_CHARACTER_WECHAT_INBOUND_BATCH_WINDOW_SECONDS: "6",
    ST_CHARACTER_WECHAT_INBOUND_BATCH_MAX_MESSAGES: "3",
    ST_CHARACTER_WECHAT_TYPING_MIN_DELAY_SECONDS: "2",
    ST_CHARACTER_WECHAT_TYPING_MAX_DELAY_SECONDS: "9",
    ST_CHARACTER_WECHAT_API_STREAMING_ENABLED: "false",
    ST_CHARACTER_WECHAT_API_TIME_COMPACTION_ENABLED: "false",
    ST_CHARACTER_WECHAT_API_HISTORY_RECENT_DAYS: "5",
    ST_CHARACTER_WECHAT_API_HISTORY_WEEKLY_COMPACT_AFTER_DAYS: "12",
    ST_CHARACTER_WECHAT_API_HISTORY_WEEKLY_SUMMARY_CHARS: "700",
    ST_CHARACTER_WECHAT_API_HISTORY_MONTHLY_COMPACT_AFTER_DAYS: "40",
    ST_CHARACTER_WECHAT_API_HISTORY_MONTHLY_SUMMARY_CHARS: "1200",
  }, () => {
    const config = readConfig();
    assert.equal(config.inboundBatchWindowSeconds, 6);
    assert.equal(config.inboundBatchMaxMessages, 3);
    assert.equal(config.typingMinDelaySeconds, 2);
    assert.equal(config.typingMaxDelaySeconds, 9);
    assert.equal(config.apiStreamingEnabled, false);
    assert.equal(config.apiTimeCompactionEnabled, false);
    assert.equal(config.apiHistoryRecentDays, 5);
    assert.equal(config.apiHistoryWeeklyCompactAfterDays, 12);
    assert.equal(config.apiHistoryMonthlyCompactAfterDays, 40);
    assert.equal(config.apiHistoryWeeklySummaryChars, 700);
    assert.equal(config.apiHistoryMonthlySummaryChars, 1200);
  });
});

test("readConfig uses legacy API summary chars for split summary defaults", () => {
  withRuntimeEnv({
    ST_CHARACTER_WECHAT_API_HISTORY_SUMMARY_CHARS: "900",
  }, () => {
    const config = readConfig();
    assert.equal(config.apiHistorySummaryChars, 900);
    assert.equal(config.apiHistoryWeeklySummaryChars, 900);
    assert.equal(config.apiHistoryMonthlySummaryChars, 900);
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
