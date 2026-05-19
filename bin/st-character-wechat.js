#!/usr/bin/env node

const { main } = require("../src/index");

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[st-character-wechat] ${message}`);
  process.exitCode = 1;
});

