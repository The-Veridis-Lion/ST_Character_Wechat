class TurnGateStore {
  constructor() {
    this.threadStateById = new Map();
    this.pendingScopeKeys = new Set();
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingScopeKeys.add(scopeKey);
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    this.threadStateById.set(normalizedThreadId, {
      scopeKey: normalizedScopeKey,
      activeRunKey: "",
    });
  }

  attachRun(threadId, turnId) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId || !normalizedTurnId) {
      return;
    }
    const current = this.threadStateById.get(normalizedThreadId);
    if (!current?.scopeKey) {
      return;
    }
    this.threadStateById.set(normalizedThreadId, {
      ...current,
      activeRunKey: buildRunKey(normalizedThreadId, normalizedTurnId),
    });
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(scopeKey);
  }

  releaseThread(threadId, turnId = "") {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const current = this.threadStateById.get(normalizedThreadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!current?.scopeKey) {
      return;
    }
    if (normalizedTurnId && current.activeRunKey) {
      const candidateRunKey = buildRunKey(normalizedThreadId, normalizedTurnId);
      if (candidateRunKey !== current.activeRunKey) {
        return;
      }
    }
    this.pendingScopeKeys.delete(current.scopeKey);
    this.threadStateById.delete(normalizedThreadId);
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function buildRunKey(threadId, turnId) {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  if (!normalizedThreadId || !normalizedTurnId) {
    return "";
  }
  return `${normalizedThreadId}:${normalizedTurnId}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
