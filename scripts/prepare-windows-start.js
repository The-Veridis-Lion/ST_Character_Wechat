#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const envPath = path.join(repoRoot, ".env");
const CODEX_KEY = "ST_CHARACTER_WECHAT_CODEX_COMMAND";

function main() {
  if (process.platform !== "win32") {
    return;
  }

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = parseEnvLines(lines);
  const runtime = resolveRuntime(env);
  if (runtime !== "codex" || readConfigValue(env, "ST_CHARACTER_WECHAT_CODEX_ENDPOINT", "")) {
    return;
  }

  const currentCommand = stripOptionalQuotes(readConfigValue(env, CODEX_KEY, ""));
  if (currentCommand && isUsableAbsoluteExecutable(currentCommand) && !isWindowsAppsPath(currentCommand)) {
    return;
  }

  const bundledCodex = findBundledCodexExecutable();
  if (!bundledCodex) {
    if (!currentCommand || isWindowsAppsPath(currentCommand)) {
      console.warn("[ST Character WeChat] Could not find a local Codex executable outside WindowsApps.");
      console.warn("[ST Character WeChat] If startup fails with Access is denied, open Codex once or set ST_CHARACTER_WECHAT_CODEX_COMMAND in .env.");
    }
    return;
  }

  if (pathEquals(currentCommand, bundledCodex)) {
    return;
  }

  const nextLines = upsertEnvLine(lines, CODEX_KEY, bundledCodex);
  fs.writeFileSync(envPath, normalizeFinalNewline(nextLines.join(os.EOL)), "utf8");
  console.log(`[ST Character WeChat] Prepared local Codex command: ${bundledCodex}`);
}

function parseEnvLines(lines) {
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!key) {
      continue;
    }
    env[key] = stripOptionalQuotes(trimmed.slice(eq + 1).trim());
  }
  return env;
}

function readConfigValue(env, key, fallback) {
  const raw = process.env[key] || env[key] || fallback;
  return String(raw || "").trim();
}

function resolveRuntime(env) {
  const explicit = readConfigValue(env, "ST_CHARACTER_WECHAT_RUNTIME", "");
  if (explicit) {
    return explicit.toLowerCase();
  }
  return hasApiRuntimeConfig(env) ? "api" : "codex";
}

function hasApiRuntimeConfig(env) {
  return Boolean(
    readConfigValue(env, "ST_CHARACTER_WECHAT_API_BASE_URL", "")
    || readConfigValue(env, "ST_CHARACTER_WECHAT_API_KEY", "")
    || readConfigValue(env, "ST_CHARACTER_WECHAT_API_MODEL", "")
    || readConfigValue(env, "OPENAI_BASE_URL", "")
    || readConfigValue(env, "OPENAI_API_KEY", "")
    || readConfigValue(env, "OPENAI_MODEL", "")
    || readConfigValue(env, "DEEPSEEK_BASE_URL", "")
    || readConfigValue(env, "DEEPSEEK_API_KEY", "")
    || readConfigValue(env, "DEEPSEEK_MODEL", "")
  );
}

function stripOptionalQuotes(value) {
  const text = String(value || "").trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

function isUsableAbsoluteExecutable(command) {
  return path.isAbsolute(command) && fs.existsSync(command) && fs.statSync(command).isFile();
}

function isWindowsAppsPath(command) {
  return command.toLowerCase().includes(`${path.sep}windowsapps${path.sep}`);
}

function findBundledCodexExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!fs.existsSync(binRoot)) {
    return "";
  }
  const candidates = fs.readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(binRoot, entry.name, "codex.exe"))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .map((filePath) => ({
      filePath,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath || "";
}

function pathEquals(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function upsertEnvLine(lines, key, value) {
  let found = false;
  const next = lines.map((line) => {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push(`${key}=${value}`);
  }
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFinalNewline(value) {
  return value.endsWith("\n") || value.endsWith("\r\n") ? value : `${value}${os.EOL}`;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ST Character WeChat] Windows startup preparation failed: ${message}`);
  process.exit(1);
}
