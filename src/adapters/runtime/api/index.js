const crypto = require("crypto");
const { EventEmitter } = require("events");
const { buildOpeningTurnText } = require("../shared-instructions");
const { SessionStore } = require("../codex/session-store");
const { ApiThreadStore } = require("./thread-store");

const DEFAULT_API_HISTORY_LIMIT = 80;

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
      const historyLimit = config.apiHistoryLimit || DEFAULT_API_HISTORY_LIMIT;
      const kept = thread.messages.slice(-Math.max(2, Math.floor(historyLimit / 2)));
      threadStore.deleteThread(threadId);
      threadStore.createThread({
        threadId,
        workspaceRoot: thread.workspaceRoot,
        metadata: thread.metadata,
      });
      for (const message of kept) {
        threadStore.appendMessage(threadId, message);
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
    const response = await callApiChatCompletions({
      fetchImpl,
      config,
      model,
      messages: thread?.messages || [],
      signal: controller.signal,
    });
    const text = extractApiResponseText(response);
    if (!text) {
      throw new Error(extractApiFailureText(response) || "API runtime returned no text.");
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
        itemId: `api-reply-${turnId}`,
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
