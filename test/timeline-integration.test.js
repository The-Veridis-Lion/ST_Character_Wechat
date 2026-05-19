const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTimelineSpawnSpec } = require("../src/integrations/timeline");

test("buildTimelineSpawnSpec keeps a spaced node.exe path as the direct command", () => {
  const binPath = "D:/ST_Character_Wechat/scripts/local-timeline.js";
  const args = ["read", "--date", "2026-05-03"];
  const nodePath = "C:\\Program Files\\nodejs\\node.exe";

  assert.deepEqual(buildTimelineSpawnSpec(binPath, args, nodePath), {
    command: nodePath,
    args: [binPath, ...args],
  });
});
