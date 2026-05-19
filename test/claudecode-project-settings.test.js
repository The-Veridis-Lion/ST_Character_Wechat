const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");

test("ensureClaudeProjectMcpConfig upserts st-character-wechat MCP server into workspace .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const projectHome = path.join(root, "st-character-wechat-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(projectHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(projectHome, "bin", "st-character-wechat.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, projectHome });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.deepEqual(saved.mcpServers.st_character_wechat_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    projectHome,
  }));
});

test("ensureClaudeProjectMcpConfig rewrites stale st-character-wechat MCP server config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const projectHome = path.join(root, "st-character-wechat-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(projectHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(projectHome, "bin", "st-character-wechat.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      st_character_wechat_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, projectHome });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.st_character_wechat_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    projectHome,
  }));
});
