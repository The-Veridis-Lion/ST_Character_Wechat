#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const subcommand = String(process.argv[2] || "").trim();
const args = process.argv.slice(3);

try {
  switch (subcommand) {
    case "read":
      printJson({
        exists: false,
        eventCount: 0,
        events: [],
        date: readOption("--date") || "",
        local: true,
      });
      break;
    case "categories":
      printJson({ categoryCount: 0, categories: [], local: true });
      break;
    case "proposals":
      printJson({ proposalCount: 0, proposals: [], date: readOption("--date") || "", local: true });
      break;
    case "write":
      console.log("status: local-disabled");
      console.log("events: 0");
      console.log("Local timeline compatibility layer is bundled for install safety; timeline writing is not part of character-only mode.");
      break;
    case "build":
      console.log("Local timeline compatibility layer: build skipped.");
      break;
    case "serve":
      console.log("timeline dashboard: http://127.0.0.1:0");
      break;
    case "dev":
      console.log("timeline dev: http://127.0.0.1:0");
      break;
    case "screenshot": {
      const output = readOption("--output");
      if (!output) {
        throw new Error("Missing --output for local timeline screenshot.");
      }
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
      console.log(`timeline screenshot saved: ${output}`);
      break;
    }
    default:
      throw new Error(`Unknown local timeline subcommand: ${subcommand || "(empty)"}`);
  }
} catch (error) {
  console.error(`Error: ${error?.message || String(error)}`);
  process.exitCode = 1;
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return "";
  }
  return String(args[index + 1] || "");
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
