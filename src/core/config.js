const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.ST_CHARACTER_WECHAT_STATE_DIR || path.join(os.homedir(), ".st-character-wechat");
  const runtime = resolveRuntime();
  const workspaceRoot = readTextEnv("ST_CHARACTER_WECHAT_WORKSPACE_ROOT") || process.cwd();
  const apiDefaults = resolveApiRuntimeDefaults(runtime);
  const localTimeZone = readTextEnv("ST_CHARACTER_WECHAT_LOCAL_TIME_ZONE")
    || readTextEnv("ST_CHARACTER_WECHAT_USER_MEMORY_TIME_ZONE")
    || readTextEnv("ST_CHARACTER_WECHAT_REPORT_TIME_ZONE")
    || "Asia/Shanghai";
  const userMemoryDir = readTextEnv("ST_CHARACTER_WECHAT_USER_MEMORY_DIR") || path.join(stateDir, "user-memory");

  return {
    mode,
    argv,
    stateDir,
    characterCardDir: readTextEnv("ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR") || path.join(workspaceRoot, "character-cards"),
    characterWorldbookOverridesFile: readTextEnv("ST_CHARACTER_WECHAT_CHARACTER_WORLDBOOK_OVERRIDES_FILE")
      || path.join(stateDir, "characters", "worldbook-overrides.json"),
    characterStateFile: path.join(stateDir, "character-state.json"),
    workspaceId: readTextEnv("ST_CHARACTER_WECHAT_WORKSPACE_ID") || "default",
    workspaceRoot,
    userName: readTextEnv("ST_CHARACTER_WECHAT_USER_NAME") || "用户",
    userGender: readTextEnv("ST_CHARACTER_WECHAT_USER_GENDER") || "female",
    localTimeZone,
    localLocation: readTextEnv("ST_CHARACTER_WECHAT_LOCAL_LOCATION"),
    allowedUserIds: readListEnv("ST_CHARACTER_WECHAT_ALLOWED_USER_IDS"),
    channel: readTextEnv("ST_CHARACTER_WECHAT_CHANNEL") || "weixin",
    runtime,
    timelineCommand: readTextEnv("ST_CHARACTER_WECHAT_TIMELINE_COMMAND") || "local-timeline",
    accountId: readTextEnv("ST_CHARACTER_WECHAT_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("ST_CHARACTER_WECHAT_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("ST_CHARACTER_WECHAT_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("ST_CHARACTER_WECHAT_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("ST_CHARACTER_WECHAT_WEIXIN_QR_BOT_TYPE") || "3",
    inboundBatchWindowSeconds: resolveNonNegativeNumberEnv("ST_CHARACTER_WECHAT_INBOUND_BATCH_WINDOW_SECONDS", 15),
    inboundBatchMaxMessages: resolvePositiveIntEnv("ST_CHARACTER_WECHAT_INBOUND_BATCH_MAX_MESSAGES", 4),
    typingMinDelaySeconds: resolveNonNegativeNumberEnv("ST_CHARACTER_WECHAT_TYPING_MIN_DELAY_SECONDS", 5),
    typingMaxDelaySeconds: resolveNonNegativeNumberEnv("ST_CHARACTER_WECHAT_TYPING_MAX_DELAY_SECONDS", 10),
    replyBubbleMinDelaySeconds: resolveNonNegativeNumberEnv("ST_CHARACTER_WECHAT_REPLY_BUBBLE_MIN_DELAY_SECONDS", 1.2),
    replyBubbleMaxDelaySeconds: resolveNonNegativeNumberEnv("ST_CHARACTER_WECHAT_REPLY_BUBBLE_MAX_DELAY_SECONDS", 6),
    replyBubbleCharsPerSecond: resolvePositiveNumberEnv("ST_CHARACTER_WECHAT_REPLY_BUBBLE_CHARS_PER_SECOND", 18),
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    diaryDir: path.join(stateDir, "diary"),
    userMemoryDir,
    userMemoryTimeZone: readTextEnv("ST_CHARACTER_WECHAT_USER_MEMORY_TIME_ZONE") || localTimeZone,
    userMemoryRecentDays: readIntEnv("ST_CHARACTER_WECHAT_USER_MEMORY_RECENT_DAYS") || 7,
    userMemoryUpcomingDays: readIntEnv("ST_CHARACTER_WECHAT_USER_MEMORY_UPCOMING_DAYS") || 21,
    userMemorySemanticEnabled: readBoolEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_ENABLED"),
    userMemorySemanticBaseUrl: readTextEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_BASE_URL"),
    userMemorySemanticApiKey: readTextEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_API_KEY"),
    userMemoryEmbeddingModel: readTextEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_EMBEDDING_MODEL"),
    userMemoryRerankEnabled: readBoolEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_RERANK_ENABLED"),
    userMemoryRerankModel: readTextEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_RERANK_MODEL"),
    userMemorySemanticIndexFile: path.join(userMemoryDir, "semantic-index.json"),
    userMemorySemanticCandidateLimit: readIntEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_CANDIDATE_LIMIT") || 30,
    userMemorySemanticTopK: readIntEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_TOP_K") || 8,
    userMemorySemanticPassiveMinScore: readNumberEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_PASSIVE_MIN_SCORE") ?? 0.32,
    userMemorySemanticExplicitMinScore: readNumberEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_EXPLICIT_MIN_SCORE") ?? 0.12,
    userMemoryRerankMinScore: readNumberEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_RERANK_MIN_SCORE") ?? 0.05,
    userMemorySemanticCooldownHours: readNumberEnv("ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_COOLDOWN_HOURS") ?? 24,
    reportCardOutputDir: readTextEnv("ST_CHARACTER_WECHAT_REPORT_CARD_OUTPUT_DIR") || path.join(stateDir, "report-cards"),
    reportCardTemplateDir: readTextEnv("ST_CHARACTER_WECHAT_REPORT_CARD_TEMPLATE_DIR") || path.resolve(__dirname, "..", "..", "templates", "cards"),
    reportCardWidth: readIntEnv("ST_CHARACTER_WECHAT_REPORT_CARD_WIDTH") || 720,
    reportCardDeviceScaleFactor: readNumberEnv("ST_CHARACTER_WECHAT_REPORT_CARD_DEVICE_SCALE_FACTOR") || 2,
    reportTimeZone: readTextEnv("ST_CHARACTER_WECHAT_REPORT_TIME_ZONE") || localTimeZone,
    autoReportStateFile: path.join(stateDir, "auto-report-cards.json"),
    autoDailyReportEnabled: readBoolEnv("ST_CHARACTER_WECHAT_AUTO_DAILY_REPORT_ENABLED"),
    autoDailyReportTime: resolveClockTimeEnv("ST_CHARACTER_WECHAT_AUTO_DAILY_REPORT_TIME", "23:30"),
    autoWeeklyReportEnabled: readBoolEnv("ST_CHARACTER_WECHAT_AUTO_WEEKLY_REPORT_ENABLED"),
    autoWeeklyReportWeekday: resolveWeekdayEnv("ST_CHARACTER_WECHAT_AUTO_WEEKLY_REPORT_WEEKDAY", "monday"),
    autoWeeklyReportTime: resolveClockTimeEnv("ST_CHARACTER_WECHAT_AUTO_WEEKLY_REPORT_TIME", "23:30"),
    proactiveChatStateFile: path.join(stateDir, "proactive-chat.json"),
    proactiveChatEnabled: readBoolEnv("ST_CHARACTER_WECHAT_PROACTIVE_CHAT_ENABLED"),
    proactiveChatStartTime: resolveClockTimeEnv("ST_CHARACTER_WECHAT_PROACTIVE_CHAT_START_TIME", "10:00"),
    proactiveChatEndTime: resolveClockTimeEnv("ST_CHARACTER_WECHAT_PROACTIVE_CHAT_END_TIME", "23:30"),
    proactiveChatMinDelayMinutes: resolvePositiveIntEnv("ST_CHARACTER_WECHAT_PROACTIVE_CHAT_MIN_DELAY_MINUTES", 15),
    proactiveChatMaxDelayMinutes: resolvePositiveIntEnv("ST_CHARACTER_WECHAT_PROACTIVE_CHAT_MAX_DELAY_MINUTES", 120),
    proactiveChatPendingLimit: resolveProactiveChatPendingLimitEnv("ST_CHARACTER_WECHAT_PROACTIVE_CHAT_PENDING_LIMIT", 1),
    dailyWeatherReminderFile: path.join(stateDir, "daily-weather-reminder.json"),
    dailyWeatherReminderEnabled: readBoolEnv("ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_ENABLED"),
    dailyWeatherReminderHour: resolveDailyWeatherReminderHour(),
    playwrightBrowserExecutable: readTextEnv("ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_EXECUTABLE"),
    playwrightBrowserChannel: readTextEnv("ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_CHANNEL"),
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("ST_CHARACTER_WECHAT_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("ST_CHARACTER_WECHAT_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("ST_CHARACTER_WECHAT_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("ST_CHARACTER_WECHAT_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("ST_CHARACTER_WECHAT_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("ST_CHARACTER_WECHAT_CODEX_COMMAND"),
    claudeCommand: readTextEnv("ST_CHARACTER_WECHAT_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("ST_CHARACTER_WECHAT_CLAUDE_MODEL") || "",
    claudeContextWindow: readIntEnv("ST_CHARACTER_WECHAT_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("ST_CHARACTER_WECHAT_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("ST_CHARACTER_WECHAT_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("ST_CHARACTER_WECHAT_CLAUDE_EXTRA_ARGS"),
    apiBaseUrl: readTextEnv("ST_CHARACTER_WECHAT_API_BASE_URL") || readTextEnv("OPENAI_BASE_URL") || readTextEnv("DEEPSEEK_BASE_URL") || apiDefaults.baseUrl,
    apiKey: readTextEnv("ST_CHARACTER_WECHAT_API_KEY") || readTextEnv("OPENAI_API_KEY") || readTextEnv("DEEPSEEK_API_KEY") || apiDefaults.apiKey,
    apiModel: readTextEnv("ST_CHARACTER_WECHAT_API_MODEL") || readTextEnv("OPENAI_MODEL") || readTextEnv("DEEPSEEK_MODEL") || apiDefaults.model,
    apiHistoryLimit: readIntEnv("ST_CHARACTER_WECHAT_API_HISTORY_LIMIT") || 80,
    apiStreamingEnabled: readOptionalBoolEnv("ST_CHARACTER_WECHAT_API_STREAMING_ENABLED") !== false,
    apiTimeCompactionEnabled: readOptionalBoolEnv("ST_CHARACTER_WECHAT_API_TIME_COMPACTION_ENABLED") !== false,
    apiHistoryRecentDays: 3,
    apiHistoryWeeklyCompactAfterDays: 7,
    apiHistoryMonthlyCompactAfterDays: 30,
    apiThreadsFile: path.join(stateDir, "api-threads.json"),
    sessionsFile: path.join(stateDir, "sessions.json"),
  };
}

function resolveApiRuntimeDefaults(runtime) {
  switch (runtime) {
    case "gemini":
      return {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "",
        model: "gemini-2.0-flash",
      };
    case "deepseek":
      return {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: readTextEnv("DEEPSEEK_API_KEY"),
        model: readTextEnv("DEEPSEEK_MODEL") || "deepseek-chat",
      };
    default:
      return {
        baseUrl: "",
        apiKey: "",
        model: "",
      };
  }
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveRuntime() {
  const explicit = readTextEnv("ST_CHARACTER_WECHAT_RUNTIME");
  if (explicit) {
    return explicit.toLowerCase();
  }
  return hasApiRuntimeConfig() ? "api" : "codex";
}

function hasApiRuntimeConfig() {
  return Boolean(
    readTextEnv("ST_CHARACTER_WECHAT_API_BASE_URL")
    || readTextEnv("ST_CHARACTER_WECHAT_API_KEY")
    || readTextEnv("ST_CHARACTER_WECHAT_API_MODEL")
    || readTextEnv("OPENAI_BASE_URL")
    || readTextEnv("OPENAI_API_KEY")
    || readTextEnv("OPENAI_MODEL")
    || readTextEnv("DEEPSEEK_BASE_URL")
    || readTextEnv("DEEPSEEK_API_KEY")
    || readTextEnv("DEEPSEEK_MODEL")
  );
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumberEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("ST_CHARACTER_WECHAT_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("ST_CHARACTER_WECHAT_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("ST_CHARACTER_WECHAT_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function resolveDailyWeatherReminderHour() {
  const explicitHour = readIntEnv("ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_HOUR");
  if (Number.isInteger(explicitHour) && explicitHour >= 0 && explicitHour <= 23) {
    return explicitHour;
  }
  const legacyTime = readTextEnv("ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_TIME");
  const match = legacyTime.match(/^(\d{1,2})(?::\d{2})?$/);
  if (match) {
    const hour = Number.parseInt(match[1], 10);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      return hour;
    }
  }
  return 8;
}

function resolveClockTimeEnv(name, fallback = "23:30") {
  const value = readTextEnv(name) || fallback;
  const match = value.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) {
    return fallback;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2] || "0", 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return fallback;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function resolvePositiveIntEnv(name, fallback) {
  const value = readIntEnv(name);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveNonNegativeNumberEnv(name, fallback) {
  const value = readNumberEnv(name);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function resolvePositiveNumberEnv(name, fallback) {
  const value = readNumberEnv(name);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveProactiveChatPendingLimitEnv(name, fallback = 1) {
  const raw = readTextEnv(name).toLowerCase();
  if (raw === "unlimited" || raw === "none" || raw === "no-limit" || raw === "nolimit") {
    return null;
  }
  const value = readIntEnv(name);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveWeekdayEnv(name, fallback = "monday") {
  const normalized = readTextEnv(name).trim().toLowerCase();
  const aliases = {
    "0": "sunday",
    "1": "monday",
    "2": "tuesday",
    "3": "wednesday",
    "4": "thursday",
    "5": "friday",
    "6": "saturday",
    sun: "sunday",
    sunday: "sunday",
    mon: "monday",
    monday: "monday",
    tue: "tuesday",
    tuesday: "tuesday",
    wed: "wednesday",
    wednesday: "wednesday",
    thu: "thursday",
    thursday: "thursday",
    fri: "friday",
    friday: "friday",
    sat: "saturday",
    saturday: "saturday",
  };
  return aliases[normalized] || fallback;
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

module.exports = { readConfig };
