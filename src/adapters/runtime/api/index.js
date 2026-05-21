const crypto = require("crypto");
const { EventEmitter } = require("events");
const { buildOpeningTurnText } = require("../shared-instructions");
const { SessionStore } = require("../codex/session-store");
const { ApiThreadStore } = require("./thread-store");
const { stripInternalReplyBlocks } = require("../../../core/reply-cleaning");

const DEFAULT_API_HISTORY_LIMIT = 80;
const DEFAULT_API_RECENT_DAYS = 3;
const DEFAULT_API_WEEKLY_COMPACT_AFTER_DAYS = 7;
const DEFAULT_API_MONTHLY_COMPACT_AFTER_DAYS = 30;
const DEFAULT_API_DAILY_SUMMARY_CHARS = 1200;
const DEFAULT_API_WEEKLY_SUMMARY_CHARS = 2200;
const DEFAULT_API_LONG_TERM_MEMORY_MAX_LINES = 80;
const DEFAULT_API_LONG_TERM_MEMORY_MAX_CHARS = 5000;
const API_HISTORY_SUMMARY_MARKER = "[ST Character WeChat API history summary]";
const API_LONG_TERM_MEMORY_MARKER = "<LTM v1>";
const API_LONG_TERM_MEMORY_END_MARKER = "</LTM>";
const API_LONG_TERM_MEMORY_INSTRUCTION = "Long-term memory lines: TYPE|id|weight|date|content. Types: F fact, L like, D dislike, B boundary, R relation, G goal, T task, S recurring state, X done.";
const LONG_TERM_MEMORY_TYPES = new Set(["F", "L", "D", "B", "R", "G", "T", "S", "X"]);
const LONG_TERM_MEMORY_TYPE_PRIORITY = new Map([
  ["B", 0],
  ["D", 1],
  ["L", 2],
  ["F", 3],
  ["R", 4],
  ["G", 5],
  ["T", 6],
  ["S", 7],
  ["X", 8],
]);

function createApiRuntimeAdapter(config, options = {}) {
  const runtimeId = resolveApiRuntimeId(config);
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId });
  const threadStore = new ApiThreadStore({
    filePath: config.apiThreadsFile,
    maxMessages: config.apiHistoryLimit || DEFAULT_API_HISTORY_LIMIT,
  });
  const emitter = new EventEmitter();
  const fetchImpl = options.fetch || global.fetch;
  const activeControllersByRunKey = new Map();

  function emit(event) {
    emitter.emit("event", event);
  }

  return {
    describe() {
      return {
        id: runtimeId,
        kind: "runtime",
        endpoint: resolveApiBaseUrl(config) || "(unset)",
        model: resolveApiModel(config) || "(unset)",
        streaming: config.apiStreamingEnabled !== false,
        sessionsFile: config.sessionsFile,
        threadsFile: config.apiThreadsFile,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getContextStats({ threadId } = {}) {
      const stats = threadStore.getThreadStats(threadId);
      return stats ? { kind: "api_history", ...stats } : null;
    },
    async initialize() {
      if (typeof fetchImpl !== "function") {
        throw new Error("API runtime requires global fetch. Use Node.js 22+.");
      }
      return {
        endpoint: resolveApiBaseUrl(config) || "(unset)",
        models: resolveApiModel(config) ? [{ id: resolveApiModel(config), model: resolveApiModel(config) }] : [],
      };
    },
    async close() {
      for (const controller of activeControllersByRunKey.values()) {
        controller.abort();
      }
      activeControllersByRunKey.clear();
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot }) {
      const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (threadId) {
        threadStore.deleteThread(threadId);
      }
      sessionStore.clearPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot);
      sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      return { workspaceRoot };
    },
    async respondApproval() {
      throw new Error("API runtime does not support approval requests.");
    },
    async cancelTurn({ threadId, turnId }) {
      const runKey = buildRunKey(threadId, turnId);
      const controller = activeControllersByRunKey.get(runKey);
      if (controller) {
        controller.abort();
        activeControllersByRunKey.delete(runKey);
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      return { threadId };
    },
    async compactThread({ threadId }) {
      const thread = threadStore.getThread(threadId);
      if (!thread) {
        throw new Error("API runtime thread not found.");
      }
      const compacted = compactApiThreadByTime({ threadStore, threadId, config, force: true });
      if (!compacted?.changed) {
        const historyLimit = config.apiHistoryLimit || DEFAULT_API_HISTORY_LIMIT;
        const kept = thread.messages.slice(-Math.max(2, Math.floor(historyLimit / 2)));
        threadStore.replaceMessages(threadId, kept);
      }
      return { threadId, turnId: "" };
    },
    async refreshThreadInstructions({ threadId }) {
      return { threadId };
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      await this.initialize();
      const turnId = `api-turn-${crypto.randomUUID()}`;
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      let outboundText = String(text || "").trim();
      if (!threadId) {
        threadId = `api-thread-${crypto.randomUUID()}`;
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
        threadStore.createThread({ threadId, workspaceRoot, metadata });
        if (!metadata?.characterChat) {
          outboundText = buildOpeningTurnText(config, outboundText);
        }
      }
      threadStore.appendMessage(threadId, {
        role: "user",
        text: outboundText,
      });
      compactApiThreadByTime({ threadStore, threadId, config });

      setTimeout(() => {
        runApiTurn({
          fetchImpl,
          config,
          runtimeId,
          threadStore,
          activeControllersByRunKey,
          emit,
          threadId,
          turnId,
          model: model || resolveApiModel(config),
        }).catch(() => {});
      }, 0);

      return { threadId, turnId };
    },
  };
}

async function runApiTurn({
  fetchImpl,
  config,
  runtimeId,
  threadStore,
  activeControllersByRunKey,
  emit,
  threadId,
  turnId,
  model,
}) {
  const runKey = buildRunKey(threadId, turnId);
  const controller = new AbortController();
  activeControllersByRunKey.set(runKey, controller);
  emit({
    type: "runtime.turn.started",
    payload: { runtimeId, threadId, turnId },
  });

  try {
    const thread = threadStore.getThread(threadId);
    const itemId = `api-reply-${turnId}`;
    const rawText = config.apiStreamingEnabled === false
      ? extractApiResponseText(await callApiChatCompletions({
          fetchImpl,
          config,
          model,
          messages: buildApiRequestMessages(thread?.messages || []),
          signal: controller.signal,
        }))
      : await streamApiChatCompletions({
          fetchImpl,
          config,
          model,
          messages: buildApiRequestMessages(thread?.messages || []),
          signal: controller.signal,
          onDelta(deltaText) {
            emit({
              type: "runtime.reply.delta",
              payload: {
                runtimeId,
                threadId,
                turnId,
                itemId,
                text: deltaText,
              },
            });
          },
        });
    const text = sanitizeApiAssistantText(rawText);
    if (!text) {
      throw new Error("API runtime returned no text.");
    }
    threadStore.appendMessage(threadId, {
      role: "model",
      text,
    });
    emit({
      type: "runtime.reply.completed",
      payload: {
        runtimeId,
        threadId,
        turnId,
        itemId,
        text,
      },
    });
    emit({
      type: "runtime.turn.completed",
      payload: { runtimeId, threadId, turnId, text },
    });
  } catch (error) {
    const text = error?.name === "AbortError"
      ? "API runtime turn was cancelled."
      : error instanceof Error ? error.message : String(error || "API runtime turn failed.");
    emit({
      type: "runtime.turn.failed",
      payload: { runtimeId, threadId, turnId, text },
    });
  } finally {
    activeControllersByRunKey.delete(runKey);
  }
}

async function callApiChatCompletions({ fetchImpl, config, model, messages, signal }) {
  const endpoint = buildApiChatCompletionsUrl(resolveApiBaseUrl(config));
  if (!endpoint) {
    throw new Error("API runtime requires ST_CHARACTER_WECHAT_API_BASE_URL.");
  }
  const resolvedModel = normalizeText(model) || resolveApiModel(config);
  if (!resolvedModel) {
    throw new Error("API runtime requires ST_CHARACTER_WECHAT_API_MODEL.");
  }

  const headers = {
    "Content-Type": "application/json",
  };
  const apiKey = resolveApiKey(config);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: resolvedModel,
      messages: messages.map((message) => ({
        role: message.role === "model" ? "assistant" : "user",
        content: String(message.text || ""),
      })),
      stream: false,
    }),
    signal,
  });
  const bodyText = await response.text();
  const parsed = tryParseJson(bodyText);
  if (!response.ok) {
    const message = normalizeText(parsed?.error?.message) || normalizeText(bodyText) || `HTTP ${response.status}`;
    throw new Error(`API runtime request failed: ${message}`);
  }
  return parsed || {};
}

async function streamApiChatCompletions({ fetchImpl, config, model, messages, signal, onDelta }) {
  const endpoint = buildApiChatCompletionsUrl(resolveApiBaseUrl(config));
  if (!endpoint) {
    throw new Error("API runtime requires ST_CHARACTER_WECHAT_API_BASE_URL.");
  }
  const resolvedModel = normalizeText(model) || resolveApiModel(config);
  if (!resolvedModel) {
    throw new Error("API runtime requires ST_CHARACTER_WECHAT_API_MODEL.");
  }

  const headers = {
    "Content-Type": "application/json",
  };
  const apiKey = resolveApiKey(config);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: resolvedModel,
      messages: messages.map((message) => ({
        role: message.role === "model" ? "assistant" : "user",
        content: String(message.text || ""),
      })),
      stream: true,
    }),
    signal,
  });

  const contentType = normalizeText(response.headers?.get?.("content-type")).toLowerCase();
  if (!response.ok || !contentType.includes("text/event-stream") || !response.body) {
    const bodyText = await response.text();
    const parsed = tryParseJson(bodyText);
    if (!response.ok) {
      const message = normalizeText(parsed?.error?.message) || normalizeText(bodyText) || `HTTP ${response.status}`;
      throw new Error(`API runtime request failed: ${message}`);
    }
    return extractApiResponseText(parsed) || "";
  }

  let completedText = "";
  for await (const event of readServerSentEvents(response.body)) {
    const data = normalizeText(event.data);
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") {
        break;
      }
      continue;
    }
    const parsed = tryParseJson(data);
    if (!parsed) {
      continue;
    }
    const errorMessage = normalizeText(parsed?.error?.message);
    if (errorMessage) {
      throw new Error(`API runtime request failed: ${errorMessage}`);
    }
    const deltaText = extractApiDeltaText(parsed);
    if (!deltaText) {
      continue;
    }
    completedText += deltaText;
    if (typeof onDelta === "function") {
      onDelta(deltaText);
    }
  }
  return normalizeText(completedText);
}

function compactApiThreadByTime({ threadStore, threadId, config, now = new Date(), force = false } = {}) {
  const thread = threadStore.getThread(threadId);
  if (!thread) {
    return { changed: false };
  }
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  if (!messages.length) {
    return { changed: false };
  }

  const policy = resolveApiTimeCompactPolicy(config);
  if (!policy.enabled && !force) {
    return { changed: false };
  }

  const nowMs = normalizeDateMs(now) || Date.now();
  const timeZone = resolveApiHistoryTimeZone(config);
  const recentCutoffMs = nowMs - policy.recentDays * 24 * 60 * 60 * 1000;
  const weeklyCutoffMs = nowMs - policy.weeklyAfterDays * 24 * 60 * 60 * 1000;
  const monthlyCutoffMs = nowMs - policy.monthlyAfterDays * 24 * 60 * 60 * 1000;
  const recent = [];
  const preservedSummaries = [];
  const preservedLongTermMemory = [];
  const longTermSources = [];
  const dailyGroups = new Map();
  const weeklyGroups = new Map();
  let regroupedSummaryCount = 0;

  for (const message of messages) {
    if (isApiHistorySummaryMessage(message)) {
      const createdMs = normalizeDateMs(message.createdAt);
      const level = normalizeText(message.summaryLevel).toLowerCase();
      if (level === "ltm" || isApiLongTermMemoryMessage(message)) {
        preservedLongTermMemory.push(message);
      } else if (level === "monthly" || ((level === "daily" || !level) && createdMs && createdMs < monthlyCutoffMs)) {
        regroupedSummaryCount += 1;
        longTermSources.push(message);
      } else if ((level === "daily" || !level) && createdMs && createdMs < weeklyCutoffMs) {
        regroupedSummaryCount += 1;
        addGroupedMessage(weeklyGroups, formatMonthWeekKey(createdMs, timeZone), message);
      } else if (level === "weekly" && createdMs && createdMs < monthlyCutoffMs) {
        regroupedSummaryCount += 1;
        longTermSources.push(message);
      } else {
        preservedSummaries.push(message);
      }
      continue;
    }
    const createdMs = normalizeDateMs(message.createdAt);
    if (!createdMs) {
      recent.push(message);
      continue;
    }
    if (!force && createdMs >= recentCutoffMs) {
      recent.push(message);
    } else if (createdMs >= weeklyCutoffMs) {
      addGroupedMessage(dailyGroups, formatDateKey(createdMs, timeZone), message);
    } else if (createdMs >= monthlyCutoffMs) {
      addGroupedMessage(weeklyGroups, formatMonthWeekKey(createdMs, timeZone), message);
    } else {
      longTermSources.push(message);
    }
  }

  const longTermMemoryMessage = buildLongTermMemoryMessage({
    existingMessages: preservedLongTermMemory,
    sourceMessages: longTermSources,
    policy,
    timeZone,
  });
  const summaryMessages = []
    .concat(longTermMemoryMessage ? [longTermMemoryMessage] : preservedLongTermMemory.map(cloneMessage))
    .concat(preservedSummaries.map(cloneMessage))
    .concat(buildSummaryMessagesFromGroups(weeklyGroups, buildWeeklySummaryTitle, "weekly", policy.weeklySummaryChars))
    .concat(buildSummaryMessagesFromGroups(dailyGroups, buildDailySummaryTitle, "daily", policy.dailySummaryChars));
  const compactedMessages = fitCompactedMessagesToLimit({
    summaryMessages,
    recentMessages: recent.map(cloneMessage),
    limit: config.apiHistoryLimit || DEFAULT_API_HISTORY_LIMIT,
  });
  const changed = force
    ? summaryMessages.length > preservedSummaries.length + preservedLongTermMemory.length || regroupedSummaryCount > 0 || longTermSources.length > 0
    : summaryMessages.length > preservedSummaries.length + preservedLongTermMemory.length || regroupedSummaryCount > 0 || longTermSources.length > 0 || compactedMessages.length !== messages.length;
  if (!changed) {
    return { changed: false };
  }
  threadStore.replaceMessages(threadId, compactedMessages);
  return {
    changed: true,
    summaryCount: summaryMessages.length,
    retainedCount: recent.length,
  };
}

function buildApiRequestMessages(messages = []) {
  const latestUserIndex = findLatestApiUserMessageIndex(messages);
  return messages.map((message, index) => ({
    ...message,
    role: message.role === "system" ? "user" : message.role,
    text: isApiHistorySummaryMessage(message) || index === latestUserIndex
      ? message.text
      : extractApiConversationText(message.text) || message.text,
  }));
}

function findLatestApiUserMessageIndex(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isApiHistorySummaryMessage(message) && message?.role === "user") {
      return index;
    }
  }
  return -1;
}

function resolveApiTimeCompactPolicy(config = {}) {
  const recentDays = positiveNumber(config.apiHistoryRecentDays, DEFAULT_API_RECENT_DAYS);
  const weeklyAfterDays = Math.max(
    recentDays + 1,
    positiveNumber(config.apiHistoryWeeklyCompactAfterDays, DEFAULT_API_WEEKLY_COMPACT_AFTER_DAYS),
  );
  const monthlyAfterDays = Math.max(
    weeklyAfterDays + 1,
    positiveNumber(config.apiHistoryMonthlyCompactAfterDays, DEFAULT_API_MONTHLY_COMPACT_AFTER_DAYS),
  );
  return {
    enabled: config.apiTimeCompactionEnabled !== false,
    recentDays,
    weeklyAfterDays,
    monthlyAfterDays,
    dailySummaryChars: positiveInteger(
      config.apiHistoryDailySummaryChars,
      positiveInteger(config.apiHistorySummaryChars, DEFAULT_API_DAILY_SUMMARY_CHARS),
    ),
    weeklySummaryChars: positiveInteger(
      config.apiHistoryWeeklySummaryChars,
      positiveInteger(config.apiHistorySummaryChars, DEFAULT_API_WEEKLY_SUMMARY_CHARS),
    ),
    longTermMemoryMaxLines: positiveInteger(config.apiLongTermMemoryMaxLines, DEFAULT_API_LONG_TERM_MEMORY_MAX_LINES),
    longTermMemoryMaxChars: positiveInteger(config.apiLongTermMemoryMaxChars, DEFAULT_API_LONG_TERM_MEMORY_MAX_CHARS),
  };
}

function buildSummaryMessagesFromGroups(groups, buildTitle, summaryLevel, summaryChars) {
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, messages]) => {
      const body = summarizeApiHistoryMessages(messages, summaryChars);
      if (!body) {
        return null;
      }
      return {
        role: "system",
        text: `${API_HISTORY_SUMMARY_MARKER}\n${buildTitle(key, messages)}\n${body}`,
        createdAt: resolveGroupCreatedAt(messages),
        compacted: true,
        summaryLevel,
        periodKey: key,
      };
    })
    .filter(Boolean);
}

function summarizeApiHistoryMessages(messages = [], maxChars = DEFAULT_API_WEEKLY_SUMMARY_CHARS) {
  const lines = [];
  for (const message of messages) {
    const text = isApiHistorySummaryMessage(message)
      ? extractApiHistorySummaryBody(message.text)
      : extractApiConversationText(message.text);
    if (!text) {
      continue;
    }
    const prefix = message.role === "model" ? "角色" : message.role === "system" ? "历史" : "用户";
    lines.push(`${prefix}: ${compactWhitespace(text)}`);
  }
  return truncateByChars(lines.join("\n"), maxChars);
}

function buildDailySummaryTitle(key) {
  return `${formatChineseDateLabel(key)}总结：`;
}

function buildWeeklySummaryTitle(key) {
  return `${formatChineseMonthWeekLabel(key)}总结：`;
}

function buildLongTermMemoryMessage({ existingMessages = [], sourceMessages = [], policy = {}, timeZone = "Asia/Shanghai" } = {}) {
  const existingLines = existingMessages.flatMap((message) => parseLongTermMemoryLines(message?.text));
  const sourceLines = sourceMessages.flatMap((message) => buildLongTermMemoryLinesFromMessage(message, timeZone));
  const lines = mergeLongTermMemoryLines(existingLines.concat(sourceLines), policy);
  if (!lines.length) {
    return null;
  }
  return {
    role: "system",
    text: [
      API_HISTORY_SUMMARY_MARKER,
      API_LONG_TERM_MEMORY_INSTRUCTION,
      API_LONG_TERM_MEMORY_MARKER,
      ...lines.map(serializeLongTermMemoryLine),
      API_LONG_TERM_MEMORY_END_MARKER,
    ].join("\n"),
    createdAt: resolveGroupCreatedAt(existingMessages.concat(sourceMessages)),
    compacted: true,
    summaryLevel: "ltm",
    periodKey: "long-term",
  };
}

function buildLongTermMemoryLinesFromMessage(message = {}, timeZone = "Asia/Shanghai") {
  const parsed = parseLongTermMemoryLines(message?.text);
  if (parsed.length) {
    return parsed;
  }
  const rawText = isApiHistorySummaryMessage(message)
    ? extractApiHistorySummaryBody(message.text)
    : extractApiConversationText(message.text);
  const text = compactWhitespace(rawText);
  if (!text) {
    return [];
  }
  const content = buildLongTermMemoryContent(message, text);
  if (!content) {
    return [];
  }
  const type = classifyLongTermMemoryType(message, content);
  return [{
    type,
    id: buildLongTermMemoryId(type, content),
    weight: resolveLongTermMemoryWeight(type, content),
    date: resolveLongTermMemoryDate(message, timeZone),
    content,
  }];
}

function buildLongTermMemoryContent(message = {}, text = "") {
  const trimmed = truncateLongTermMemoryContent(text);
  if (!trimmed) {
    return "";
  }
  if (/^(?:用户|角色|历史|User|Assistant|System)[：:]/iu.test(trimmed)) {
    return trimmed;
  }
  if (message.role === "model") {
    return `角色：${trimmed}`;
  }
  if (message.role === "system" || isApiHistorySummaryMessage(message)) {
    return `历史：${trimmed}`;
  }
  return `用户：${trimmed}`;
}

function classifyLongTermMemoryType(message = {}, content = "") {
  const text = String(content || "");
  if (/隐私|不要上传|不要提交|不要保存|不能上传|不能提交|禁止|边界|boundary|privacy/iu.test(text)) {
    return "B";
  }
  if (/不喜欢|讨厌|雷点|别再|不要.*(?:示例|这样|这么)|dislike|hate/iu.test(text)) {
    return "D";
  }
  if (/喜欢|偏好|更想|希望|prefer|like/iu.test(text)) {
    return "L";
  }
  if (/目标|长期|想要|希望.*(?:做到|完成|实现)|goal/iu.test(text)) {
    return "G";
  }
  if (/待办|要做|还没|未完成|计划|安排|todo|task|open/iu.test(text)) {
    return "T";
  }
  if (/压力|焦虑|累|疲惫|睡眠|失眠|反复|经常|总是|状态|stress|sleep|mood/iu.test(text)) {
    return "S";
  }
  if (message.role === "model" || /角色|关系|互动|称呼|语气|relation/iu.test(text)) {
    return "R";
  }
  if (/已完成|解决|过期|不用了|done|resolved|expired/iu.test(text)) {
    return "X";
  }
  return "F";
}

function resolveLongTermMemoryWeight(type, content = "") {
  if (type === "B" || type === "D" || type === "T") {
    return "high";
  }
  if (/必须|永远|一定|非常|重要|high/iu.test(content)) {
    return "high";
  }
  return "med";
}

function buildLongTermMemoryId(type, content = "") {
  return `${String(type || "F").toLowerCase()}${crypto.createHash("sha1").update(String(content || "")).digest("hex").slice(0, 8)}`;
}

function resolveLongTermMemoryDate(message = {}, timeZone = "Asia/Shanghai") {
  const textDate = normalizeText(message.periodKey || message.createdAt);
  if (/^\d{4}-\d{2}(?:-\d{2})?/u.test(textDate)) {
    return textDate.slice(0, 10);
  }
  const ms = normalizeDateMs(message.createdAt);
  return ms ? formatDateKey(ms, timeZone) : "";
}

function parseLongTermMemoryLines(text = "") {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const blockMatch = normalized.match(/<LTM v1>\s*\n?([\s\S]*?)\n?<\/LTM>/u);
  const body = blockMatch ? blockMatch[1] : normalized;
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLongTermMemoryLine)
    .filter(Boolean);
}

function parseLongTermMemoryLine(line = "") {
  const parts = String(line || "").split("|");
  if (parts.length < 5) {
    return null;
  }
  const type = normalizeText(parts[0]).toUpperCase();
  if (!LONG_TERM_MEMORY_TYPES.has(type)) {
    return null;
  }
  const id = normalizeText(parts[1]) || buildLongTermMemoryId(type, parts.slice(4).join("|"));
  const weight = normalizeText(parts[2]) || "med";
  const date = normalizeText(parts[3]);
  const content = truncateLongTermMemoryContent(parts.slice(4).join("|"));
  if (!content) {
    return null;
  }
  return { type, id, weight, date, content };
}

function mergeLongTermMemoryLines(lines = [], policy = {}) {
  const byContent = new Map();
  for (const line of lines) {
    if (!line?.content) {
      continue;
    }
    const normalizedContent = normalizeMemoryContentKey(line.content);
    const existing = byContent.get(normalizedContent);
    if (!existing || compareLongTermMemoryLineFreshness(line, existing) > 0) {
      byContent.set(normalizedContent, {
        type: LONG_TERM_MEMORY_TYPES.has(line.type) ? line.type : "F",
        id: normalizeText(line.id) || buildLongTermMemoryId(line.type, line.content),
        weight: normalizeText(line.weight) || "med",
        date: normalizeText(line.date),
        content: truncateLongTermMemoryContent(line.content),
      });
    }
  }
  const maxLines = positiveInteger(policy.longTermMemoryMaxLines, DEFAULT_API_LONG_TERM_MEMORY_MAX_LINES);
  const maxChars = positiveInteger(policy.longTermMemoryMaxChars, DEFAULT_API_LONG_TERM_MEMORY_MAX_CHARS);
  const sorted = Array.from(byContent.values()).sort(compareLongTermMemoryLinesForContext);
  const kept = [];
  let charCount = 0;
  for (const line of sorted) {
    if (kept.length >= maxLines) {
      break;
    }
    const serialized = serializeLongTermMemoryLine(line);
    if (kept.length && charCount + serialized.length + 1 > maxChars) {
      break;
    }
    kept.push(line);
    charCount += serialized.length + 1;
  }
  return kept;
}

function compareLongTermMemoryLineFreshness(left, right) {
  const leftDate = normalizeText(left?.date);
  const rightDate = normalizeText(right?.date);
  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }
  return weightScore(left?.weight) - weightScore(right?.weight);
}

function compareLongTermMemoryLinesForContext(left, right) {
  const leftPriority = LONG_TERM_MEMORY_TYPE_PRIORITY.get(left.type) ?? 99;
  const rightPriority = LONG_TERM_MEMORY_TYPE_PRIORITY.get(right.type) ?? 99;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  const dateCompare = normalizeText(right.date).localeCompare(normalizeText(left.date));
  if (dateCompare) {
    return dateCompare;
  }
  return normalizeText(left.content).localeCompare(normalizeText(right.content), "zh-Hans-CN");
}

function weightScore(weight = "") {
  const normalized = normalizeText(weight).toLowerCase();
  if (normalized === "high") {
    return 3;
  }
  if (normalized === "low") {
    return 1;
  }
  return 2;
}

function serializeLongTermMemoryLine(line = {}) {
  const type = LONG_TERM_MEMORY_TYPES.has(line.type) ? line.type : "F";
  const id = normalizeText(line.id) || buildLongTermMemoryId(type, line.content);
  const weight = normalizeText(line.weight) || "med";
  const date = normalizeText(line.date);
  const content = truncateLongTermMemoryContent(line.content);
  return `${type}|${id}|${weight}|${date}|${content}`;
}

function truncateLongTermMemoryContent(value = "") {
  const text = compactWhitespace(value).replace(/[|\n\r]+/gu, " ");
  return truncateByChars(text, 180);
}

function normalizeMemoryContentKey(value = "") {
  return compactWhitespace(value)
    .replace(/^用户[：:]\s*/u, "")
    .replace(/^角色[：:]\s*/u, "")
    .replace(/^历史[：:]\s*/u, "")
    .toLowerCase();
}

function fitCompactedMessagesToLimit({ summaryMessages = [], recentMessages = [], limit = DEFAULT_API_HISTORY_LIMIT } = {}) {
  const maxMessages = positiveInteger(limit, DEFAULT_API_HISTORY_LIMIT);
  if (summaryMessages.length + recentMessages.length <= maxMessages) {
    return summaryMessages.concat(recentMessages);
  }
  const summarySlots = Math.min(summaryMessages.length, Math.max(1, Math.floor(maxMessages / 3)));
  const keptSummaries = summaryMessages.slice(0, summarySlots);
  const recentSlots = Math.max(0, maxMessages - keptSummaries.length);
  return keptSummaries.concat(recentMessages.slice(Math.max(0, recentMessages.length - recentSlots)));
}

function extractApiConversationText(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const userMessageMatch = normalized.match(/(?:^|\n)## User Message\s*\n([\s\S]*?)\s*$/u);
  if (userMessageMatch) {
    return userMessageMatch[1].trim();
  }
  return normalized;
}

function extractApiHistorySummaryBody(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized.startsWith(API_HISTORY_SUMMARY_MARKER)) {
    return normalized;
  }
  return normalized
    .split("\n")
    .slice(2)
    .join("\n")
    .trim();
}

function addGroupedMessage(groups, key, message) {
  if (!groups.has(key)) {
    groups.set(key, []);
  }
  groups.get(key).push(message);
}

function isApiHistorySummaryMessage(message) {
  return Boolean(message?.compacted) || String(message?.text || "").startsWith(API_HISTORY_SUMMARY_MARKER);
}

function isApiLongTermMemoryMessage(message) {
  return normalizeText(message?.summaryLevel).toLowerCase() === "ltm"
    || String(message?.text || "").includes(API_LONG_TERM_MEMORY_MARKER);
}

function resolveGroupCreatedAt(messages = []) {
  const first = messages.find((message) => normalizeText(message?.createdAt));
  return first?.createdAt || new Date().toISOString();
}

function cloneMessage(message) {
  return message && typeof message === "object" ? { ...message } : message;
}

function normalizeDateMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function resolveApiHistoryTimeZone(config = {}) {
  return resolveValidTimeZone(config.localTimeZone || config.userMemoryTimeZone || config.reportTimeZone || "Asia/Shanghai");
}

function resolveValidTimeZone(timeZone = "") {
  const normalized = normalizeText(timeZone) || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "Asia/Shanghai";
  }
}

function formatDateKey(ms, timeZone = "Asia/Shanghai") {
  return getLocalDateParts(ms, timeZone).dateKey || new Date(ms).toISOString().slice(0, 10);
}

function formatMonthWeekKey(ms, timeZone = "Asia/Shanghai") {
  const parts = getLocalDateParts(ms, timeZone);
  if (!parts.dateKey) {
    return `${new Date(ms).toISOString().slice(0, 10)}-W1`;
  }
  const firstWeekday = getWeekdayFromDateKey(`${parts.year}-${parts.month}-01`);
  const weekNumber = Math.max(1, Math.floor((Number(parts.day) + firstWeekday - 2) / 7) + 1);
  return `${parts.year}-${parts.month}-W${weekNumber}`;
}

function getLocalDateParts(ms, timeZone = "Asia/Shanghai") {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return { dateKey: "", year: "", month: "", day: "" };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const year = parts.year || "";
  const month = parts.month || "";
  const day = parts.day || "";
  return {
    dateKey: year && month && day ? `${year}-${month}-${day}` : "",
    year,
    month,
    day,
  };
}

function getWeekdayFromDateKey(dateKey = "") {
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return 1;
  }
  return parsed.getUTCDay() || 7;
}

function formatChineseDateLabel(dateKey = "") {
  const match = String(dateKey || "").match(/^\d{4}-(\d{2})-(\d{2})/u);
  if (!match) {
    return normalizeText(dateKey) || "日期";
  }
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function formatChineseMonthWeekLabel(key = "") {
  const match = String(key || "").match(/^(\d{4})-(\d{2})-W(\d+)$/u);
  if (!match) {
    return normalizeText(key) || "本月本周";
  }
  return `${Number(match[2])}月第${Number(match[3])}周`;
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateByChars(value, maxChars) {
  const text = String(value || "").trim();
  const limit = positiveInteger(maxChars, DEFAULT_API_WEEKLY_SUMMARY_CHARS);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(1, limit - 12)).trim()}...`;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildApiChatCompletionsUrl(baseUrl) {
  const trimmedBase = normalizeText(baseUrl).replace(/\/+$/g, "");
  if (!trimmedBase) {
    return "";
  }
  if (/\/chat\/completions$/iu.test(trimmedBase)) {
    return trimmedBase;
  }
  return `${trimmedBase}/chat/completions`;
}

function extractApiResponseText(response) {
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const content = choice?.message?.content ?? choice?.delta?.content ?? response?.output_text;
  if (typeof content === "string") {
    return normalizeText(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => normalizeText(part?.text || part?.content))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function extractApiDeltaText(response) {
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const content = choice?.delta?.content ?? choice?.message?.content ?? response?.output_text;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => normalizeText(part?.text || part?.content))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function* readServerSentEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseServerSentEvent(rawEvent);
      if (event) {
        yield event;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseServerSentEvent(buffer);
    if (event) {
      yield event;
    }
  }
}

function parseServerSentEvent(rawEvent) {
  const data = String(rawEvent || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data ? { data } : null;
}

function extractApiFailureText(response) {
  const errorMessage = normalizeText(response?.error?.message);
  if (errorMessage) {
    return errorMessage;
  }
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const finishReason = normalizeText(choice?.finish_reason || choice?.finishReason);
  return finishReason ? `finishReason=${finishReason}` : "";
}

function resolveApiRuntimeId(config = {}) {
  const runtime = normalizeText(config.runtime).toLowerCase();
  if (runtime && runtime !== "openai-compatible") {
    return runtime;
  }
  return "api";
}

function resolveApiBaseUrl(config = {}) {
  return normalizeText(config.apiBaseUrl);
}

function resolveApiKey(config = {}) {
  return normalizeText(config.apiKey);
}

function resolveApiModel(config = {}) {
  return normalizeText(config.apiModel);
}

function buildRunKey(threadId, turnId = "") {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeApiAssistantText(value) {
  return normalizeText(stripInternalReplyBlocks(normalizeText(value)));
}

module.exports = {
  createApiRuntimeAdapter,
  buildApiChatCompletionsUrl,
  extractApiResponseText,
};
