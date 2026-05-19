const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./core/config");
const { CharacterWechatApp } = require("./core/app");
const { buildTerminalHelpText } = require("./core/command-registry");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");

function ensureDefaultStateDirectory() {
  fs.mkdirSync(path.join(os.homedir(), ".st-character-wechat"), { recursive: true });
}

function loadEnv() {
  ensureDefaultStateDirectory();
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".st-character-wechat", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

function ensureRuntimeEnv() {
  if (!process.env.ST_CHARACTER_WECHAT_HOME) {
    process.env.ST_CHARACTER_WECHAT_HOME = path.resolve(__dirname, "..");
  }
}

function printHelp() {
  console.log(buildTerminalHelpText());
}

let runtimeErrorHooksInstalled = false;

function installRuntimeErrorHooks() {
  if (runtimeErrorHooksInstalled) {
    return;
  }
  runtimeErrorHooksInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[st-character-wechat] unhandled rejection ${message}`);
  });

  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[st-character-wechat] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  installRuntimeErrorHooks();
  const argv = process.argv.slice(2);
  const config = readConfig();
  const command = config.mode || "help";
  let app = null;
  const getApp = () => {
    if (!app) {
      app = new CharacterWechatApp(config);
    }
    return app;
  };

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildTerminalHelpText());
    return;
  }

  if (command === "doctor") {
    getApp().printDoctor();
    return;
  }

  if (command === "login") {
    await getApp().login();
    return;
  }

  if (command === "accounts") {
    getApp().printAccounts();
    return;
  }

  if (command === "start") {
    await getApp().start();
    return;
  }

  if (command === "tool-mcp-server") {
    const runtimeId = readFlagValue(argv.slice(1), "--runtime-id") || "";
    const workspaceRoot = readFlagValue(argv.slice(1), "--workspace-root") || process.cwd();
    const { toolHost } = createProjectTooling(config);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = { main };

function readFlagValue(args, flag) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}
