const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const syntaxDirs = ["bin", "scripts", "src", "test"];
const skippedInstallTests = new Set([
  // This one launches a real browser channel to render PNGs. Keep it for full
  // developer test runs, but do not make first-time installation depend on it.
  "report-card-render-service.test.js",
]);

function collectJsFiles(dir) {
  const absoluteDir = path.join(repoRoot, dir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(path.relative(repoRoot, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    throw new Error(`${label} failed`);
  }
}

function main() {
  const jsFiles = syntaxDirs.flatMap(collectJsFiles).sort();
  for (const file of jsFiles) {
    runNode(["--check", file], `syntax check ${path.relative(repoRoot, file)}`);
  }
  console.log(`[install-check] syntax checked ${jsFiles.length} JavaScript file(s)`);

  const testDir = path.join(repoRoot, "test");
  const testFiles = fs.readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js"))
    .filter((name) => !skippedInstallTests.has(name))
    .sort()
    .map((name) => path.join(testDir, name));

  runNode(["--test", ...testFiles], "install unit tests");
}

try {
  main();
} catch (error) {
  console.error(`[install-check] ${error.message}`);
  process.exit(process.exitCode || 1);
}
