const crypto = require("crypto");
const { EventEmitter } = require("events");
const { buildOpeningTurnText } = require("../shared-instructions");
const { SessionStore } = require("../codex/session-store");
const { ApiThreadStore } = require("./thread-store");

const DEFAULT_API_HISTORY_LIMIT = 80;
const DEFAULT_API_RECENT_DAYS = 3;
const DEFAULT_API_WEEKLY_COMPACT_AFTER_DAYS = 7;
const DEFAULT_API_MONTHLY_COMPACT_AFTER_DAYS = 30;
const DEFAULT_API_TIME_COMPACT_SUMMARY_CHARS = 1800;
const API_HISTORY_SUMMARY_MARKER = "[ST Character WeChat API history summary]";

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
    const text = config.apiStreamingEnabled === false
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
  const recentCutoffMs = nowMs - policy.recentDays * 24 * 60 * 60 * 1000;
  const weeklyCutoffMs = nowMs - policy.weeklyAfterDays * 24 * 60 * 60 * 1000;
  const monthlyCutoffMs = nowMs - policy.monthlyAfterDays * 24 * 60 * 60 * 1000;
  const recent = [];
  const preservedSummaries = [];
  const dailyGroups = new Map();
  const weeklyGroups = new Map();
  const monthlyGroups = new Map();
  let regroupedSummaryCount = 0;

  for (const message of messages) {
    if (isApiHistorySummaryMessage(message)) {
      const createdMs = normalizeDateMs(message.createdAt);
      const level = normalizeText(message.summaryLevel).toLowerCase();
      if ((level === "daily" || !level) && createdMs && createdMs < monthlyCutoffMs) {
        regroupedSummaryCount += 1;
        addGroupedMessage(monthlyGroups, formatMonthKey(createdMs), message);
      } else if ((level === "daily" || !level) && createdMs && createdMs < weeklyCutoffMs) {
        regroupedSummaryCount += 1;
        addGroupedMessage(weeklyGroups, formatWeekKey(createdMs), message);
      } else if (level === "weekly" && createdMs && createdMs < monthlyCutoffMs) {
        regroupedSummaryCount += 1;
        addGroupedMessage(monthlyGroups, formatMonthKey(createdMs), message);
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
      addGroupedMessage(dailyGroups, formatDateKey(createdMs), message);
    } else if (createdMs >= monthlyCutoffMs) {
      addGroupedMessage(weeklyGroups, formatWeekKey(createdMs), message);
    } else {
      addGroupedMessage(monthlyGroups, formatMonthKey(createdMs), message);
    }
  }

  const summaryMessages = []
    .concat(preservedSummaries.map(cloneMessage))
    .concat(buildSummaryMessagesFromGroups(monthlyGroups, "长期 API 历史摘要", "monthly", policy.monthlySummaryChars))
    .concat(buildSummaryMessagesFromGroups(weeklyGroups, "每周 API 历史摘要", "weekly", policy.weeklySummaryChars))
    .concat(buildSummaryMessagesFromGroups(dailyGroups, "每日 API 历史摘要", "daily", policy.weeklySummaryChars));
  const compactedMessages = summaryMessages.concat(recent.map(cloneMessage));
  const changed = force
    ? summaryMessages.length > preservedSummaries.length || regroupedSummaryCount > 0
    : summaryMessages.length > preservedSummaries.length || regroupedSummaryCount > 0 || compactedMessages.length !== messages.length;
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
    weeklySummaryChars: positiveInteger(
      config.apiHistoryWeeklySummaryChars,
      positiveInteger(config.apiHistorySummaryChars, DEFAULT_API_TIME_COMPACT_SUMMARY_CHARS),
    ),
    monthlySummaryChars: positiveInteger(
      config.apiHistoryMonthlySummaryChars,
      positiveInteger(config.apiHistorySummaryChars, DEFAULT_API_TIME_COMPACT_SUMMARY_CHARS),
    ),
  };
}

function buildSummaryMessagesFromGroups(groups, label, summaryLevel, summaryChars) {
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, messages]) => {
      const body = summarizeApiHistoryMessages(messages, summaryChars);
      if (!body) {
        return null;
      }
      return {
        role: "system",
        text: `${API_HISTORY_SUMMARY_MARKER}\n${label} ${key}\n${body}`,
        createdAt: resolveGroupCreatedAt(messages),
        compacted: true,
        summaryLevel,
        periodKey: key,
      };
    })
    .filter(Boolean);
}

function summarizeApiHistoryMessages(messages = [], maxChars = DEFAULT_API_TIME_COMPACT_SUMMARY_CHARS) {
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

function formatDateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatWeekKey(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return `${date.toISOString().slice(0, 10)} week`;
}

function formatMonthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateByChars(value, maxChars) {
  const text = String(value || "").trim();
  const limit = positiveInteger(maxChars, DEFAULT_API_TIME_COMPACT_SUMMARY_CHARS);
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

module.exports = {
  createApiRuntimeAdapter,
  buildApiChatCompletionsUrl,
  extractApiResponseText,
};
