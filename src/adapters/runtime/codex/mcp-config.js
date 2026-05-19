const fs = require("fs");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");

function resolveCodexProjectToolMcpServerConfig({ projectHome = "" } = {}) {
  const home = normalizeNonEmptyString(projectHome)
    || process.env.ST_CHARACTER_WECHAT_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "st-character-wechat.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "st_character_wechat_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
  };
}

function buildCodexMcpConfigArgs(mcpServerConfig) {
  if (!mcpServerConfig || typeof mcpServerConfig !== "object") {
    return [];
  }
  const name = normalizeNonEmptyString(mcpServerConfig.name) || "st_character_wechat_tools";
  const command = normalizeNonEmptyString(mcpServerConfig.command);
  const args = Array.isArray(mcpServerConfig.args)
    ? mcpServerConfig.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
  if (!command) {
    return [];
  }
  const configArgs = [
    "-c",
    `mcp_servers.${name}.command=${quoteTomlString(command)}`,
    "-c",
    `mcp_servers.${name}.args=${formatTomlArray(args)}`,
  ];
  for (const toolName of listProjectToolNames()) {
    configArgs.push(
      "-c",
      `mcp_servers.${name}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
    );
  }
  return configArgs;
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCodexMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
};
