const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");
const { stripInternalReplyBlocks } = require("./reply-cleaning");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";
const STREAMING_REPLY_MIN_CHARS = 8;
const STREAMING_REPLY_TARGET_CHARS = 220;

class StreamDelivery {
  constructor({ channelAdapter, sessionStore, onDeferredSystemReply, systemReplyRetryScheduleMs, sameTokenRetryDelayMs }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.systemReplyRetryScheduleMs = Array.isArray(systemReplyRetryScheduleMs) && systemReplyRetryScheduleMs.length
      ? systemReplyRetryScheduleMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    this.deferredReplyPrefixByBindingKey = new Map();
    this.stateByRunKey = new Map();
    this.mutedRunKeys = new Set();
    this.mutedThreadIds = new Set();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    if (!bindingKey || !target?.userId || !target?.contextToken) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, {
      userId: String(target.userId).trim(),
      contextToken: String(target.contextToken).trim(),
      provider: normalizeText(target.provider),
    });
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
    }
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return normalizeReplyTarget(state.replyTarget);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return normalizeReplyTarget(exactTurnTarget);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return normalizeReplyTarget(queuedTargets[0]);
    }

    const linked = this.sessionStore.findBindingForThreadId(normalizedThreadId);
    if (!linked?.bindingKey) {
      return null;
    }
    return normalizeReplyTarget(this.replyTargetByBindingKey.get(linked.bindingKey));
  }

  muteRun({ threadId = "", turnId = "" } = {}) {
    const runKey = buildRunKey(normalizeText(threadId), normalizeText(turnId));
    if (!runKey || runKey === ":pending") {
      return;
    }
    this.mutedRunKeys.add(runKey);
    const state = this.stateByRunKey.get(runKey);
    if (state) {
      state.muted = true;
    }
  }

  isRunMuted({ threadId = "", turnId = "" } = {}) {
    const runKey = buildRunKey(normalizeText(threadId), normalizeText(turnId));
    return this.mutedRunKeys.has(runKey);
  }

  muteThread(threadId = "") {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    this.mutedThreadIds.add(normalizedThreadId);
    for (const state of this.stateByRunKey.values()) {
      if (state.threadId === normalizedThreadId) {
        state.muted = true;
      }
    }
  }

  isThreadMuted(threadId = "") {
    const normalizedThreadId = normalizeText(threadId);
    return normalizedThreadId ? this.mutedThreadIds.has(normalizedThreadId) : false;
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }
    if (this.isThreadMuted(threadId)) {
      if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
        this.disposeRunState(buildRunKey(threadId, turnId));
      }
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.attachReplyTarget(state);
        return;
      }
      case "runtime.reply.delta": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
        });
        await this.flush(state, { force: false, streaming: true });
        return;
      }
      case "runtime.reply.completed": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
        });
        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.captureTurnCompletionText(state, event.payload.text);
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed":
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      deferredReplyPrefix: "",
      turnId: normalizeText(turnId),
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
      muted: this.mutedRunKeys.has(runKey),
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    state.bindingKey = linked.bindingKey;
    if (!state.replyTarget) {
      const target = this.replyTargetByBindingKey.get(linked.bindingKey);
      state.replyTarget = target;
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized || state.itemOrder.length > 0) {
      return;
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
    });
  }

  upsertItem(state, { itemId, text, completed }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
        sentTextLength: 0,
      });
    }

    const current = state.items.get(itemId);
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
        sentTextLength: 0,
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  async flush(state, { force, streaming = false }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force, streaming }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force, streaming = false }) {
    if (state.muted) {
      return;
    }
    if (!state.replyTarget) {
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force, streaming });
    if (!pendingDeliveries.length) {
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        await this.sendReplyDelivery(state, delivery, {
          prependDeferredPrefix: index === 0 && Boolean(state.deferredReplyPrefix),
        });
        this.markReplyDeliverySent(state, delivery);
        if (index === 0 && state.deferredReplyPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
    }).catch((error) => {
      const failedDelivery = pendingDeliveries[0];
      const failedText = buildDeliveryPreviewText(failedDelivery);
      void this.deferSystemReply(state, buildEffectiveReplyText(state.deferredReplyPrefix, failedText), error, "plain_reply");
      console.error(`[st-character-wechat] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  markReplyDeliverySent(state, delivery) {
    const item = state.items.get(delivery.itemId);
    if (!item) {
      state.sentItemIds.add(delivery.itemId);
      return;
    }
    if (Number.isFinite(delivery.sentTextEnd) && delivery.sentTextEnd > 0) {
      item.sentTextLength = Math.max(Number(item.sentTextLength) || 0, delivery.sentTextEnd);
      const fullText = getItemReplySourceText(item);
      if (item.completed && item.sentTextLength >= fullText.length) {
        state.sentItemIds.add(delivery.itemId);
      }
      return;
    }
    state.sentItemIds.add(delivery.itemId);
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const replyText = buildReplyText(state, { completedOnly: false });
    const resolved = resolveSystemReplyAction(replyText);
    if (resolved.kind === "silent") {
      this.markAllItemsSent(state);
      console.log(
        `[st-character-wechat] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      return;
    }

    if (resolved.kind !== "send_message") {
      console.error(
        `[st-character-wechat] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, resolved.message);
      this.markAllItemsSent(state);
    }).catch((error) => {
      console.error(`[st-character-wechat] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }

    if (delivery.kind === "silent") {
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[st-character-wechat] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      return;
    }

    const baseText = delivery.kind === "action" ? delivery.message : delivery.text;
    if (!baseText) {
      return;
    }

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, baseText) : baseText,
      contextToken: state.replyTarget.contextToken,
      singleLine: !prependDeferredPrefix,
    };
    if (prependDeferredPrefix) {
      payload.preserveBlock = true;
    }
    await this.sendTextWithRetry(state, payload, { kind: "plain_reply" });
  }

  async sendSystemReply(state, text) {
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
      singleLine: true,
    };
    await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const initialTarget = state.replyTarget;
    try {
      await this.channelAdapter.sendText(payload);
      return;
    } catch (error) {
      const retryTarget = this.resolveRetriableReplyTarget(initialTarget, error);
      if (!retryTarget) {
        const deferred = await this.deferSystemReply(state, payload.text, error, kind);
        if (deferred) {
          return;
        }
        throw error;
      }
      console.warn(
        `[st-character-wechat] system reply retrying with refreshed context token thread=${state.threadId} user=${retryTarget.userId}`
      );
      try {
        const retryPayload = {
          userId: retryTarget.userId,
          text: payload.text,
          contextToken: retryTarget.contextToken,
          singleLine: Boolean(payload.singleLine),
        };
        if (payload.preserveBlock) {
          retryPayload.preserveBlock = true;
        }
        await this.channelAdapter.sendText(retryPayload);
        state.replyTarget = retryTarget;
        if (state.bindingKey) {
          this.replyTargetByBindingKey.set(state.bindingKey, {
            userId: retryTarget.userId,
            contextToken: retryTarget.contextToken,
            provider: retryTarget.provider,
          });
        }
      } catch (retryError) {
        const deferred = await this.deferSystemReply(state, payload.text, retryError, kind);
        if (deferred) {
          return;
        }
        throw retryError;
      }
    }
  }

  async deferSystemReply(state, text, error, kind = "plain_reply") {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    if (!isSystemReplyContextFailure(error)) {
      return false;
    }
    const target = state?.replyTarget || {};
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
      });
      console.warn(
        `[st-character-wechat] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[st-character-wechat] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return {
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
    };
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    const state = this.stateByRunKey.get(normalizedRunKey) || null;
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.mutedRunKeys.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
    if (!state?.threadId) {
      return;
    }
    const hasOtherActiveRuns = [...this.stateByRunKey.values()].some((entry) => entry.threadId === state.threadId);
    if (!hasOtherActiveRuns) {
      this.mutedThreadIds.delete(state.threadId);
    }
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = {
      userId: target.userId,
      contextToken: target.contextToken,
      provider: target.provider,
    };
    state.threadReplyTargetAttached = true;
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function collectPendingReplyDeliveries(state, { force, streaming = false }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    const source = resolvePlainReplySourceText(item, { force, streaming });
    if (!source?.text) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(source.text);
    if (structuredAction) {
      pending.push({
        ...buildActionDelivery(itemId, source.text, structuredAction),
        sentTextEnd: source.end,
      });
      continue;
    }
    const plainText = markdownToPlainText(source.text);
    const sanitizedText = sanitizeReplyText(plainText);
    if (!sanitizedText) {
      continue;
    }
    pending.push({ itemId, kind: "plain", text: sanitizedText, sentTextEnd: source.end });
  }
  return pending;
}

function resolvePlainReplySourceText(item, { force, streaming = false } = {}) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const fullText = getItemReplySourceText(item);
  const sentTextLength = clampSentTextLength(item.sentTextLength, fullText.length);
  if (sentTextLength >= fullText.length) {
    return null;
  }
  if (item.completed || force) {
    return {
      text: trimOuterBlankLines(fullText.slice(sentTextLength)),
      end: fullText.length,
    };
  }
  if (!streaming || sentTextLength > 0 && looksLikeStructuredActionText(fullText)) {
    return null;
  }
  if (sentTextLength === 0 && looksLikeStructuredActionText(fullText)) {
    return null;
  }
  const boundary = findStreamingBubbleBoundary(fullText, sentTextLength);
  if (boundary <= sentTextLength) {
    return null;
  }
  return {
    text: trimOuterBlankLines(fullText.slice(sentTextLength, boundary)),
    end: boundary,
  };
}

function getItemReplySourceText(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  return item.completed
    ? trimOuterBlankLines(item.completedText || item.currentText || "")
    : trimOuterBlankLines(item.currentText || "");
}

function clampSentTextLength(value, maxLength) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.min(Math.floor(numeric), Math.max(0, maxLength));
}

function findStreamingBubbleBoundary(fullText, startIndex = 0) {
  const text = normalizeLineEndings(fullText);
  const safeStart = Math.max(0, Math.min(Number(startIndex) || 0, text.length));
  const tail = text.slice(safeStart);
  if (tail.length < STREAMING_REPLY_MIN_CHARS) {
    return 0;
  }

  const strongBoundary = findLastNaturalBoundary(text, safeStart, { strongOnly: true });
  if (strongBoundary > safeStart) {
    const candidate = text.slice(safeStart, strongBoundary);
    if (candidate.trim().length >= STREAMING_REPLY_MIN_CHARS || tail.length >= STREAMING_REPLY_TARGET_CHARS) {
      return strongBoundary;
    }
  }

  if (tail.length < STREAMING_REPLY_TARGET_CHARS) {
    return 0;
  }

  const relaxedBoundary = findLastNaturalBoundary(text, safeStart, { strongOnly: false });
  if (relaxedBoundary > safeStart) {
    return relaxedBoundary;
  }
  return 0;
}

function findLastNaturalBoundary(text, startIndex, { strongOnly }) {
  let best = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      const next = text[index + 1] || "";
      if (next === "\n" && isBalancedNaturalSlice(text.slice(startIndex, index + 1))) {
        best = index + 1;
      }
      continue;
    }
    if (/[”"』」）)\]】》]/u.test(char)) {
      const next = text[index + 1] || "";
      const candidate = text.slice(startIndex, index + 1);
      if ((!next || /\s/u.test(next)) && /[。！？!?.…]/u.test(candidate) && isBalancedNaturalSlice(candidate)) {
        best = index + 1;
      }
      continue;
    }
    const boundary = resolveSentenceBoundaryEnd(text, index, { strongOnly });
    if (boundary > 0 && isBalancedNaturalSlice(text.slice(startIndex, boundary))) {
      best = boundary;
    }
  }
  return best;
}

function resolveSentenceBoundaryEnd(text, index, { strongOnly }) {
  const char = text[index];
  const isStrong = /[。！？!?…]/u.test(char);
  const isWeak = char === ".";
  if (!isStrong && (!isWeak || strongOnly || isLikelyDecimalPoint(text, index))) {
    return 0;
  }

  let end = index + 1;
  while (end < text.length && /[”"』」）)\]】》]/u.test(text[end])) {
    end += 1;
  }
  const next = text[end] || "";
  if (next && !/[\s，,。！？!?…、；;：:）)\]】》”"』」]/u.test(next)) {
    return 0;
  }
  return end;
}

function isLikelyDecimalPoint(text, index) {
  return /\d/u.test(text[index - 1] || "") && /\d/u.test(text[index + 1] || "");
}

function isBalancedNaturalSlice(value) {
  const text = String(value || "");
  const stack = [];
  const pairs = new Map([
    ["(", ")"],
    ["（", "）"],
    ["[", "]"],
    ["【", "】"],
    ["《", "》"],
  ]);
  const closers = new Set([...pairs.values()]);
  let asciiDoubleQuoteOpen = false;
  let chineseDoubleQuoteOpen = false;
  for (const char of text) {
    if (pairs.has(char)) {
      stack.push(pairs.get(char));
      continue;
    }
    if (closers.has(char)) {
      if (stack[stack.length - 1] === char) {
        stack.pop();
      }
      continue;
    }
    if (char === "\"") {
      asciiDoubleQuoteOpen = !asciiDoubleQuoteOpen;
      continue;
    }
    if (char === "“" || char === "「" || char === "『") {
      chineseDoubleQuoteOpen = true;
      continue;
    }
    if (char === "”" || char === "」" || char === "』") {
      chineseDoubleQuoteOpen = false;
    }
  }
  return stack.length === 0 && !asciiDoubleQuoteOpen && !chineseDoubleQuoteOpen;
}

function looksLikeStructuredActionText(value) {
  return /^[\s\r\n]*(?:\{|\[)/u.test(String(value || ""));
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = stripInternalReplyBlocks(normalizeLineEndings(String(plainReplyText || "")));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return trimOuterBlankLines(protocolSanitized.text || "");
}

function resolveSystemReplyAction(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }

  const candidate = extractSystemActionJsonCandidate(normalized) || normalized;
  const parsed = tryParseJson(candidate);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  const action = normalizeSystemActionName(parsed.action || parsed.st_character_wechat_action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(stripInternalReplyBlocks(normalizeLineEndings(String(parsed.message || parsed.text || "")))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

function normalizeSystemActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSystemActionJsonCandidate(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  for (let index = normalized.lastIndexOf("{"); index >= 0; index = normalized.lastIndexOf("{", index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      continue;
    }
    if ("action" in parsed || "st_character_wechat_action" in parsed) {
      return candidate;
    }
  }
  return "";
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = { StreamDelivery };
