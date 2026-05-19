const fs = require("fs");
const path = require("path");

function ensureClaudeProjectMcpConfig({ workspaceRoot, projectHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Claude project tools.");
  }

  const configPath = path.join(normalizedWorkspaceRoot, ".mcp.json");
  const current = readJsonObject(configPath);
  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {}),
      st_character_wechat_tools: buildClaudeProjectMcpServerConfig({
        workspaceRoot: normalizedWorkspaceRoot,
        projectHome,
      }),
    },
  };

  if (!jsonEquals(current, next)) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  return {
    configPath,
    serverName: "st_character_wechat_tools",
    config: next,
  };
}

function buildClaudeProjectMcpServerConfig({ workspaceRoot, projectHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const home = normalizeText(projectHome) || process.env.ST_CHARACTER_WECHAT_HOME || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "st-character-wechat.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`ST Character WeChat MCP entrypoint not found: ${scriptPath}`);
  }
  return {
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "claudecode", "--workspace-root", normalizedWorkspaceRoot],
  };
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
};
