const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadWeixinConfig,
  saveWeixinConfig,
  DEFAULT_MIN_WEIXIN_CHUNK,
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
} = require("../src/adapters/channel/weixin/config-store");

function createConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-weixin-config-test-"));
  return {
    weixinConfigFile: path.join(dir, "weixin-config.json"),
    ...overrides,
  };
}

test("loadWeixinConfig clamps invalid env defaults back to the hard default", () => {
  const config = createConfig({ weixinMinChunkChars: 0 });
  assert.deepEqual(loadWeixinConfig(config), {
    minChunkChars: DEFAULT_MIN_WEIXIN_CHUNK,
    autoCompact: {
      enabled: true,
      thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    },
  });
});

test("loadWeixinConfig prefers a valid env default when the file is missing", () => {
  const config = createConfig({ weixinMinChunkChars: 50 });
  assert.deepEqual(loadWeixinConfig(config), {
    minChunkChars: 50,
    autoCompact: {
      enabled: true,
      thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    },
  });
});

test("loadWeixinConfig normalizes persisted values against the env-backed default", () => {
  const config = createConfig({ weixinMinChunkChars: 50 });
  saveWeixinConfig(config, { minChunkChars: 0 });
  assert.deepEqual(loadWeixinConfig(config), {
    minChunkChars: DEFAULT_MIN_WEIXIN_CHUNK,
    autoCompact: {
      enabled: true,
      thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    },
  });
});

test("saveWeixinConfig persists auto compact settings", () => {
  const config = createConfig();
  saveWeixinConfig(config, {
    minChunkChars: 30,
    autoCompact: {
      enabled: false,
      thresholdPercent: 82,
    },
  });

  assert.deepEqual(loadWeixinConfig(config), {
    minChunkChars: 30,
    autoCompact: {
      enabled: false,
      thresholdPercent: 82,
    },
  });
});
