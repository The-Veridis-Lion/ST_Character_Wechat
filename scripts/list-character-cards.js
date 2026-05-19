#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const CARD_EXTENSIONS = new Set([".json", ".png"]);
const WORLDBOOK_OVERRIDE_SUFFIX = ".override.json";

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

function resolveCardDir() {
  const cwd = process.cwd();
  const env = readDotEnv(path.join(cwd, ".env"));
  const workspaceRoot = process.env.ST_CHARACTER_WECHAT_WORKSPACE_ROOT
    || env.ST_CHARACTER_WECHAT_WORKSPACE_ROOT
    || cwd;
  const configuredDir = process.env.ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR
    || env.ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR
    || "./character-cards";
  return path.isAbsolute(configuredDir)
    ? configuredDir
    : path.resolve(workspaceRoot, configuredDir);
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
    cards.push({
      name: entry.name,
      relativePath: path.relative(root, fullPath) || entry.name,
      size: stat.size,
    });
  }
  return cards.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isWorldbookOverrideFile(fileName) {
  return String(fileName || "").toLowerCase().endsWith(WORLDBOOK_OVERRIDE_SUFFIX);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const cardDir = resolveCardDir();
  fs.mkdirSync(cardDir, { recursive: true });
  const cards = collectCards(cardDir);
  console.log(`Character card folder: ${cardDir}`);
  if (!cards.length) {
    console.log("No SillyTavern .json or .png character cards found.");
    console.log("Put cards into ./character-cards, then run npm run cards:list again or use /char reload after starting WeChat.");
    return;
  }
  console.log(`Found ${cards.length} candidate character card(s):`);
  for (const [index, card] of cards.entries()) {
    console.log(`${index + 1}. ${card.relativePath} (${formatSize(card.size)})`);
  }
}

main();
