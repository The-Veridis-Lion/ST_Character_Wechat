const fs = require("fs");
const path = require("path");

const DEFAULT_CARD_WIDTH = 720;
const DEFAULT_VIEWPORT_HEIGHT = 960;
const DEFAULT_DEVICE_SCALE_FACTOR = 2;

class CardRenderService {
  constructor({ config = {}, templateDir = "", outputDir = "" } = {}) {
    this.config = config;
    this.templateDir = templateDir || config.reportCardTemplateDir || path.resolve(__dirname, "..", "..", "templates", "cards");
    this.outputDir = outputDir || config.reportCardOutputDir || path.join(config.stateDir || process.cwd(), "report-cards");
  }

  async renderPng({
    templateName,
    data = {},
    outputFile = "",
    width = 0,
    viewportHeight = 0,
    deviceScaleFactor = 0,
  } = {}) {
    const resolvedTemplateName = normalizeTemplateName(templateName);
    if (!resolvedTemplateName) {
      throw new Error("Card templateName is required.");
    }

    const templatePath = path.join(this.templateDir, resolvedTemplateName);
    const template = await fs.promises.readFile(templatePath, "utf8");
    if (!template.includes("__CARD_DATA_JSON__")) {
      throw new Error(`Card template is missing __CARD_DATA_JSON__: ${templatePath}`);
    }

    const resolvedOutputFile = path.resolve(outputFile || path.join(this.outputDir, buildDefaultOutputName(resolvedTemplateName)));
    await fs.promises.mkdir(path.dirname(resolvedOutputFile), { recursive: true });

    const html = template.replace("__CARD_DATA_JSON__", escapeJsonForHtml(data));
    const browser = await launchBrowser(this.config);
    try {
      const cssWidth = normalizePositiveInt(width) || normalizePositiveInt(this.config.reportCardWidth) || DEFAULT_CARD_WIDTH;
      const cssHeight = normalizePositiveInt(viewportHeight) || DEFAULT_VIEWPORT_HEIGHT;
      const dpr = normalizePositiveNumber(deviceScaleFactor)
        || normalizePositiveNumber(this.config.reportCardDeviceScaleFactor)
        || DEFAULT_DEVICE_SCALE_FACTOR;
      const context = await browser.newContext({
        viewport: { width: cssWidth, height: cssHeight },
        deviceScaleFactor: dpr,
      });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : null).catch(() => {});
        await page.waitForTimeout(50);
        const pageHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
        await page.screenshot({
          path: resolvedOutputFile,
          type: "png",
          fullPage: true,
          animations: "disabled",
        });
        return {
          filePath: resolvedOutputFile,
          templateName: resolvedTemplateName,
          width: cssWidth,
          height: pageHeight,
          deviceScaleFactor: dpr,
        };
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
}

async function launchBrowser(config = {}) {
  const { chromium } = require("playwright-core");
  const executablePath = normalizeText(config.playwrightBrowserExecutable);
  const baseOptions = { headless: true };
  if (executablePath) {
    return chromium.launch({ ...baseOptions, executablePath });
  }

  const channels = [
    normalizeText(config.playwrightBrowserChannel),
    "msedge",
    "chrome",
  ].filter(Boolean);
  let lastError = null;
  const tried = new Set();
  for (const channel of channels) {
    if (tried.has(channel)) {
      continue;
    }
    tried.add(channel);
    try {
      return await chromium.launch({ ...baseOptions, channel });
    } catch (error) {
      lastError = error;
    }
  }

  try {
    return await chromium.launch(baseOptions);
  } catch (error) {
    lastError = error;
  }

  const detail = lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError || "unknown error");
  throw new Error(`Unable to launch a Playwright browser for report cards: ${detail}`);
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildDefaultOutputName(templateName) {
  const base = String(templateName || "card").replace(/\.[^.]+$/u, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}-${stamp}.png`;
}

function normalizeTemplateName(value) {
  const normalized = normalizeText(value).replace(/\\/g, "/");
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) {
    return "";
  }
  return normalized;
}

function normalizePositiveInt(value) {
  const numeric = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizePositiveNumber(value) {
  const numeric = Number.parseFloat(String(value || ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  CardRenderService,
  escapeJsonForHtml,
  launchBrowser,
};
