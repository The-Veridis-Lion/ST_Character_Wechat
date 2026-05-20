const fs = require("fs");
const path = require("path");
const { stripInternalReplyBlocks } = require("../../../core/reply-cleaning");

class ApiThreadStore {
  constructor({ filePath, maxMessages = 80 }) {
    this.filePath = filePath;
    this.maxMessages = normalizePositiveInteger(maxMessages) || 80;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const state = {
          ...createEmptyState(),
          ...parsed,
          threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
        };
        const normalized = normalizeLoadedState(state);
        this.state = normalized.state;
        if (normalized.changed) {
          this.save();
        }
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  createThread({ threadId, workspaceRoot = "", metadata = {} }) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      throw new Error("API thread id is required");
    }
    const now = new Date().toISOString();
    this.state.threads[normalizedThreadId] = {
      threadId: normalizedThreadId,
      workspaceRoot: normalizeText(workspaceRoot),
      metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return this.getThread(normalizedThreadId);
  }

  getThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    const thread = normalizedThreadId ? this.state.threads[normalizedThreadId] : null;
    if (!thread) {
      return null;
    }
    return {
      ...thread,
      metadata: { ...(thread.metadata || {}) },
      messages: Array.isArray(thread.messages) ? thread.messages.map((message) => ({ ...message })) : [],
    };
  }

  deleteThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId || !this.state.threads[normalizedThreadId]) {
      return false;
    }
    delete this.state.threads[normalizedThreadId];
    this.save();
    return true;
  }

  appendMessage(threadId, { role, text, createdAt = "" }) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedRole = normalizeApiRole(role);
    const normalizedText = normalizeText(text);
    if (!normalizedThreadId || !normalizedRole || !normalizedText) {
      return null;
    }
    const current = this.state.threads[normalizedThreadId] || this.createThread({ threadId: normalizedThreadId });
    const messages = Array.isArray(current.messages) ? current.messages.slice() : [];
    messages.push({
      role: normalizedRole,
      text: normalizedText,
      createdAt: normalizeText(createdAt) || new Date().toISOString(),
    });
    current.messages = messages.slice(Math.max(0, messages.length - this.maxMessages));
    current.updatedAt = new Date().toISOString();
    this.state.threads[normalizedThreadId] = current;
    this.save();
    return this.getThread(normalizedThreadId);
  }

  replaceMessages(threadId, messages = []) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId || !this.state.threads[normalizedThreadId]) {
      return null;
    }
    const normalizedMessages = Array.isArray(messages)
      ? messages.map(normalizeStoredMessage).filter(Boolean)
      : [];
    const current = this.state.threads[normalizedThreadId];
    current.messages = normalizedMessages.slice(Math.max(0, normalizedMessages.length - this.maxMessages));
    current.updatedAt = new Date().toISOString();
    this.state.threads[normalizedThreadId] = current;
    this.save();
    return this.getThread(normalizedThreadId);
  }
}

function createEmptyState() {
  return {
    threads: {},
  };
}

function normalizeApiRole(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "model" || normalized === "assistant") {
    return "model";
  }
  if (normalized === "system") {
    return "system";
  }
  if (normalized === "user") {
    return "user";
  }
  return "";
}

function normalizeStoredMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = normalizeApiRole(message.role);
  const text = role === "model"
    ? normalizeAssistantHistoryText(message.text)
    : normalizeText(message.text);
  if (!role || !text) {
    return null;
  }
  return {
    ...message,
    role,
    text,
    createdAt: normalizeText(message.createdAt) || new Date().toISOString(),
  };
}

function normalizeLoadedState(state) {
  const normalizedState = {
    ...createEmptyState(),
    ...state,
    threads: {},
  };
  let changed = false;
  for (const [threadId, thread] of Object.entries(state.threads || {})) {
    const normalizedThreadId = normalizeText(thread?.threadId) || normalizeText(threadId);
    if (!normalizedThreadId) {
      changed = true;
      continue;
    }
    const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];
    const messages = rawMessages.map(normalizeStoredMessage).filter(Boolean);
    if (messages.length !== rawMessages.length || messages.some((message, index) => message.text !== rawMessages[index]?.text || message.role !== normalizeApiRole(rawMessages[index]?.role))) {
      changed = true;
    }
    normalizedState.threads[normalizedThreadId] = {
      ...thread,
      threadId: normalizedThreadId,
      metadata: thread?.metadata && typeof thread.metadata === "object" ? { ...thread.metadata } : {},
      messages,
      workspaceRoot: normalizeText(thread?.workspaceRoot),
      createdAt: normalizeText(thread?.createdAt) || new Date().toISOString(),
      updatedAt: normalizeText(thread?.updatedAt) || new Date().toISOString(),
    };
  }
  return { state: normalizedState, changed };
}

function normalizeAssistantHistoryText(value) {
  return normalizeText(stripInternalReplyBlocks(normalizeText(value)));
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ApiThreadStore };
