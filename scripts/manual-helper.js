#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const CARD_EXTENSIONS = new Set([".json", ".png"]);
const WORLDBOOK_OVERRIDE_SUFFIX = ".override.json";
const HOST = "127.0.0.1";
const PORT = Number(process.env.ST_CHARACTER_WECHAT_MANUAL_PORT || 4317);
const ROOT = process.cwd();
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function isProjectRoot(root) {
  try {
    const packagePath = path.join(root, "package.json");
    const manualPath = path.join(root, "00_START_HERE.html");
    if (!fs.existsSync(packagePath) || !fs.existsSync(manualPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return pkg && pkg.name === "st-character-wechat";
  } catch {
    return false;
  }
}

function resolveRequestedRoot(requestedRoot) {
  const raw = String(requestedRoot || "").trim();
  if (!raw) return { root: ROOT, requested: false };
  const resolved = path.resolve(raw);
  if (!isProjectRoot(resolved)) {
    throw new Error(`not an ST Character WeChat project root: ${resolved}`);
  }
  return { root: resolved, requested: true };
}

function resolveCardDir(projectRoot = ROOT, { preferProjectRoot = false } = {}) {
  const env = readDotEnv(path.join(projectRoot, ".env"));
  const workspaceRoot = process.env.ST_CHARACTER_WECHAT_WORKSPACE_ROOT
    || (preferProjectRoot ? "" : env.ST_CHARACTER_WECHAT_WORKSPACE_ROOT)
    || ROOT;
  const baseRoot = preferProjectRoot ? projectRoot : workspaceRoot;
  const configuredDir = process.env.ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR
    || env.ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR
    || "./character-cards";
  return path.isAbsolute(configuredDir)
    ? configuredDir
    : path.resolve(baseRoot, configuredDir);
}

function collectCards(dir, root = dir) {
  const cards = [];
  if (!fs.existsSync(dir)) return cards;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cards.push(...collectCards(fullPath, root));
      continue;
    }
    if (!entry.isFile() || !CARD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (isWorldbookOverrideFile(entry.name)) continue;
    const stat = fs.statSync(fullPath);
    const relativePath = path.relative(root, fullPath) || entry.name;
    cards.push({
      name: entry.name,
      path: relativePath.split(path.sep).join("/"),
      size: stat.size,
      lastModified: stat.mtimeMs,
    });
  }
  return cards.sort((left, right) => left.path.localeCompare(right.path));
}

function isWorldbookOverrideFile(fileName) {
  return String(fileName || "").toLowerCase().endsWith(WORLDBOOK_OVERRIDE_SUFFIX);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES * 1.4) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function normalizeCardFileName(fileName) {
  const base = path.basename(String(fileName || "").trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  const extension = path.extname(base).toLowerCase();
  if (!CARD_EXTENSIONS.has(extension) || isWorldbookOverrideFile(base)) {
    throw new Error("only .json and .png character cards can be imported");
  }
  return base || `character${extension}`;
}

function resolveUniqueImportPath(cardDir, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(cardDir, fileName);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(cardDir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function decodeImportContent(payload) {
  const text = typeof payload?.contentBase64 === "string" ? payload.contentBase64.trim() : "";
  if (!text) {
    throw new Error("missing contentBase64");
  }
  const buffer = Buffer.from(text, "base64");
  if (!buffer.length) {
    throw new Error("imported file is empty");
  }
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new Error("imported file is too large");
  }
  return buffer;
}

async function handleImportCharacterCard(request, response) {
  try {
    const payload = await readJsonBody(request);
    const { root: projectRoot, requested } = resolveRequestedRoot(payload?.projectRoot);
    const cardDir = resolveCardDir(projectRoot, { preferProjectRoot: requested });
    fs.mkdirSync(cardDir, { recursive: true });
    const fileName = normalizeCardFileName(payload?.name);
    const bytes = decodeImportContent(payload);
    const filePath = resolveUniqueImportPath(cardDir, fileName);
    fs.writeFileSync(filePath, bytes);
    const stat = fs.statSync(filePath);
    sendJson(response, 200, {
      ok: true,
      root: projectRoot,
      folder: cardDir,
      written: {
        name: path.basename(filePath),
        path: path.relative(cardDir, filePath).split(path.sep).join("/"),
        size: stat.size,
        lastModified: stat.mtimeMs,
      },
      files: collectCards(cardDir),
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function handleReadEnv(response, projectRoot = ROOT) {
  try {
    const envPath = path.join(projectRoot, ".env");
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    sendJson(response, 200, {
      ok: true,
      root: projectRoot,
      path: envPath,
      content,
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

async function handleWriteEnv(request, response) {
  try {
    const payload = await readJsonBody(request);
    const { root: projectRoot } = resolveRequestedRoot(payload?.projectRoot);
    const content = typeof payload?.content === "string" ? payload.content : "";
    if (!content.trim()) {
      throw new Error("missing .env content");
    }
    const envPath = path.join(projectRoot, ".env");
    fs.writeFileSync(envPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    sendJson(response, 200, {
      ok: true,
      root: projectRoot,
      path: envPath,
      size: fs.statSync(envPath).size,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function sendFile(response, filePath, contentType) {
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(response);
}

function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/character-cards" && request.method === "GET") {
    try {
      const { root: projectRoot, requested } = resolveRequestedRoot(url.searchParams.get("root"));
      const cardDir = resolveCardDir(projectRoot, { preferProjectRoot: requested });
      fs.mkdirSync(cardDir, { recursive: true });
      sendJson(response, 200, {
        ok: true,
        root: projectRoot,
        folder: cardDir,
        files: collectCards(cardDir),
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
    return;
  }
  if (url.pathname === "/api/character-cards/import" && request.method === "POST") {
    handleImportCharacterCard(request, response);
    return;
  }
  if (url.pathname === "/api/env" && request.method === "GET") {
    try {
      const { root: projectRoot } = resolveRequestedRoot(url.searchParams.get("root"));
      handleReadEnv(response, projectRoot);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
    return;
  }
  if (url.pathname === "/api/env" && request.method === "POST") {
    handleWriteEnv(request, response);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/00_START_HERE.html") {
    sendFile(response, path.join(ROOT, "00_START_HERE.html"), "text/html; charset=utf-8");
    return;
  }
  if (url.pathname.startsWith("/templates/cards/") && /^[A-Za-z0-9._/-]+$/u.test(url.pathname)) {
    sendFile(response, path.join(ROOT, url.pathname.slice(1)), "text/html; charset=utf-8");
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
  }
}

function main() {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/00_START_HERE.html`;
    console.log(`Manual helper is running: ${url}`);
    console.log(`Project root: ${ROOT}`);
    console.log(`Character cards: ${resolveCardDir(ROOT)}`);
    console.log("The page can now scan ./character-cards and save .env directly through the local helper.");
    if (!process.argv.includes("--no-open") && process.env.ST_CHARACTER_WECHAT_MANUAL_OPEN !== "false") {
      openBrowser(url);
    }
  });
}

main();
