const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const {
  DEFAULT_MIN_WEIXIN_CHUNK,
  MAX_MIN_WEIXIN_CHUNK,
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  MIN_AUTO_COMPACT_THRESHOLD_PERCENT,
  MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
} = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { createApiRuntimeAdapter } = require("../adapters/runtime/api");
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const { buildWeixinHelpText } = require("./command-registry");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { CharacterLibrary } = require("./characters/library");
const { CharacterStateStore, buildCharacterBindingKey } = require("./characters/state-store");
const { buildCharacterChatPrompt } = require("./characters/prompt-builder");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const {
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { resolvePreferredSenderId } = require("./default-targets");
const { resolvePreviousWeekRange } = require("../services/weekly-review-card-service");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const INBOUND_IDLE_BATCH_WINDOW_MS = 15_000;
const INBOUND_IDLE_BATCH_MAX_MESSAGES = 4;
const FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS = 8_000;
const FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS = 45_000;
const STREAMING_REPLY_RUNTIME_STALL_TIMEOUT_MS = 60_000;
const COMPLETED_REPLY_RUNTIME_STALL_TIMEOUT_MS = 30_000;
const STARTED_RUNTIME_STALL_TIMEOUT_MS = 90_000;
const STARTED_RUNTIME_STALL_NOTICE_TEXT = "这轮像是卡住了，我先继续接你后面的消息";

function createRuntimeAdapter(config) {
  const runtime = normalizeText(config.runtime).toLowerCase();
  if (runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  if (isApiRuntime(runtime)) {
    return createApiRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

function isApiRuntime(runtime) {
  const normalized = normalizeText(runtime).toLowerCase();
  return normalized === "api" || normalized === "openai" || normalized === "openai-compatible" || normalized === "deepseek" || normalized === "gemini";
}

class CharacterWechatApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.characterLibrary = new CharacterLibrary({
      cardDir: config.characterCardDir,
      worldbookOverridesFile: config.characterWorldbookOverridesFile,
    });
    this.characterStateStore = new CharacterStateStore({ filePath: config.characterStateFile });
    this.threadStateStore = new ThreadStateStore();
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundByScope = new Map();
    this.pendingUserMemoryByRunKey = new Map();
    this.pendingProactiveChatByRunKey = new Map();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
    });
    this.pendingRuntimeEventWatchdogs = new Map();
    this.pendingRuntimeStallWatchdogs = new Map();
    this.pendingOperationByRunKey = new Map();
    this.abandonedRuntimeThreadIds = new Set();
    this.abandonedRuntimeRunKeys = new Set();
    this.runtimeEventChain = Promise.resolve();
    this.activeSenderId = "";
    this.runtimeAdapter.onEvent((event) => {
      this.ingestRuntimeEvent(event);
    });
  }

  ingestRuntimeEvent(event) {
    const normalizedThreadId = normalizeCommandArgument(event?.payload?.threadId);
    const normalizedTurnId = normalizeCommandArgument(event?.payload?.turnId);
    this.clearRuntimeEventWatchdog(normalizedThreadId);
    if (this.isRuntimeThreadAbandoned(normalizedThreadId, normalizedTurnId)) {
      console.log(
        `[st-character-wechat] ignored abandoned runtime event type=${event?.type || "(unknown)"} thread=${normalizedThreadId || ""} turn=${normalizedTurnId || ""}`
      );
      this.trackAbandonedRuntimeEvent?.(event);
      return;
    }
    this.threadStateStore.applyRuntimeEvent(event);
    this.runtimeEventChain = this.runtimeEventChain
      .catch(() => {})
      .then(() => this.handleRuntimeEvent(event))
      .catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[st-character-wechat] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
      });
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const characterScan = this.characterLibrary.reload();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    await this.restoreBoundThreadSubscriptions();

    console.log("[st-character-wechat] bootstrap ok");
    console.log(`[st-character-wechat] channel=${this.channelAdapter.describe().id}`);
    console.log(`[st-character-wechat] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[st-character-wechat] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[st-character-wechat] account=${account.accountId}`);
    console.log(`[st-character-wechat] baseUrl=${account.baseUrl}`);
    console.log(`[st-character-wechat] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[st-character-wechat] characterCardDir=${characterScan.cardDir || "(none)"}`);
    console.log(`[st-character-wechat] characters=${characterScan.cards.length}${characterScan.errors.length ? ` failed=${characterScan.errors.length}` : ""}`);
    console.log(`[st-character-wechat] knownContextTokens=${knownContextTokens}`);
    console.log(`[st-character-wechat] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[st-character-wechat] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[st-character-wechat] runtimeModels=${runtimeState.models?.length || 0}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[st-character-wechat] bridge loop started; waiting for WeChat messages.");

    const shutdown = createShutdownController(async () => {
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          await Promise.all([
            this.flushDueDailyWeatherReminder(account),
            this.flushDueProactiveChat(account),
            this.flushDueReminders(account),
            this.flushDueScheduledReportCards(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: this.channelAdapter.loadSyncBuffer(),
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertWeixinUpdateResponse(response);
          consecutiveFailures = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            await this.handleIncomingMessage(message);
          }
          await Promise.all([
            this.flushDueDailyWeatherReminder(account),
            this.flushDueProactiveChat(account),
            this.flushDueReminders(account),
            this.flushDueScheduledReportCards(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          consecutiveFailures += 1;
          console.error(`[st-character-wechat] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[st-character-wechat] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  handleLocationAccepted(result) {
    void result;
    console.log("[st-character-wechat] ignored location system trigger in character-only mode");
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async sendTextToCurrentChat({ senderId = "", text = "", preserveBlock = false } = {}) {
    const targetUserId = normalizeCommandArgument(senderId);
    if (!targetUserId) {
      throw new Error("Cannot determine which WeChat user should receive the message.");
    }
    const contextToken = this.channelAdapter.getKnownContextTokens?.()[targetUserId] || "";
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${targetUserId}. Let this user talk to the bot once first.`);
    }
    await this.channelAdapter.sendText({
      userId: targetUserId,
      text,
      contextToken,
      preserveBlock,
    });
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }
    if (!this.isSingleSenderAllowed(normalized)) {
      return;
    }

    this.primeDeferredRepliesForSender(normalized);
    this.noteProactiveChatUserMessage(normalized);
    await this.handlePreparedMessage(normalized, { allowCommands: true });
  }

  isSingleSenderAllowed(normalized) {
    const senderId = normalizeCommandArgument(normalized?.senderId);
    if (!senderId) {
      return false;
    }
    const allowedUserIds = Array.isArray(this.config?.allowedUserIds)
      ? this.config.allowedUserIds.map(normalizeCommandArgument).filter(Boolean)
      : [];
    const configuredSenderId = allowedUserIds[0] || "";
    if (allowedUserIds.length > 1 && !this.warnedMultipleAllowedUsers) {
      this.warnedMultipleAllowedUsers = true;
      console.warn(
        `[st-character-wechat] character-only mode supports one WeChat sender; using ${configuredSenderId} and ignoring ${allowedUserIds.length - 1} extra allowed user(s)`
      );
    }
    if (configuredSenderId) {
      if (senderId !== configuredSenderId) {
        console.warn(`[st-character-wechat] ignored message from non-active sender=${senderId}`);
        return false;
      }
      this.activeSenderId = configuredSenderId;
      return true;
    }
    if (!this.activeSenderId) {
      this.activeSenderId = senderId;
      return true;
    }
    if (senderId !== this.activeSenderId) {
      console.warn(`[st-character-wechat] ignored message from non-active sender=${senderId}`);
      return false;
    }
    return true;
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    });
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const prefix = formatDeferredSystemReplyBatch(pendingReplies);
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, prefix);
    const activeCharacterId = this.characterStateStore?.getActiveCharacterId?.(bindingKey) || "";
    if (activeCharacterId) {
      this.streamDelivery.setDeferredReplyPrefix(buildCharacterBindingKey(bindingKey, activeCharacterId), prefix);
    }
    console.warn(
      `[st-character-wechat] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const isSingleSenderAllowed = typeof this.isSingleSenderAllowed === "function"
      ? this.isSingleSenderAllowed(normalized)
      : CharacterWechatApp.prototype.isSingleSenderAllowed.call(this, normalized);
    if (!isSingleSenderAllowed) {
      return;
    }
    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const replyTarget = {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
    };
    this.streamDelivery.setReplyTarget(baseBindingKey, replyTarget);

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    const resolveRuntimeScope = typeof this.resolveCharacterRuntimeScope === "function"
      ? this.resolveCharacterRuntimeScope.bind(this)
      : CharacterWechatApp.prototype.resolveCharacterRuntimeScope.bind(this);
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    const runtimeScope = await resolveRuntimeScope({
      normalized,
      baseBindingKey,
      workspaceRoot,
      replyTarget,
    });
    if (!runtimeScope) {
      return;
    }
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot, {
      characterChat: Boolean(runtimeScope.characterChat),
    });
    if (!prepared) {
      return;
    }
    const bindingKey = runtimeScope.bindingKey || baseBindingKey;
    this.streamDelivery.setReplyTarget(bindingKey, replyTarget);

    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared, reason: "blocked", runtimeScope });
      return;
    }

    const shouldBatchNormally = typeof this.shouldBatchNormalInboundMessage === "function"
      ? this.shouldBatchNormalInboundMessage(prepared)
      : normalizeText(prepared?.provider).toLowerCase() !== "system";
    if (shouldBatchNormally) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared, reason: "cooldown", runtimeScope });
      return;
    }

    const runtimeTurn = typeof this.prepareCharacterRuntimeTurn === "function"
      ? await this.prepareCharacterRuntimeTurn({
          normalized,
          baseBindingKey,
          workspaceRoot,
          prepared,
          replyTarget,
          runtimeScope,
        })
      : { bindingKey, prepared };
    if (!runtimeTurn) {
      return;
    }
    const preparedForRuntime = runtimeTurn.prepared;
    await this.dispatchPreparedTurn({
      bindingKey: runtimeTurn.bindingKey || bindingKey,
      workspaceRoot,
      prepared: preparedForRuntime,
    });
  }

  shouldBatchNormalInboundMessage(prepared) {
    return normalizeText(prepared?.provider).toLowerCase() !== "system";
  }

  async resolveCharacterRuntimeScope({ normalized, baseBindingKey, workspaceRoot, replyTarget, characterId = "" }) {
    if (!this.characterLibrary || !this.characterStateStore || normalizeText(normalized?.provider).toLowerCase() === "system") {
      return {
        bindingKey: baseBindingKey,
        baseBindingKey,
        workspaceRoot,
        characterChat: false,
      };
    }

    const activeCharacterId = normalizeText(characterId) || this.characterStateStore.getActiveCharacterId(baseBindingKey);
    if (!activeCharacterId) {
      this.characterLibrary.ensureLoaded();
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "请先选择角色：/char list，然后 /char use 1",
        contextToken: normalized.contextToken,
      }).catch(() => {});
      return null;
    }

    const card = this.characterLibrary.getCharacter(activeCharacterId);
    if (!card) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "当前角色卡没有找到，请先 /char reload，再 /char use 选择角色",
        contextToken: normalized.contextToken,
      }).catch(() => {});
      return null;
    }

    const bindingKey = buildCharacterBindingKey(baseBindingKey, card.id);
    this.streamDelivery.setReplyTarget(bindingKey, replyTarget);
    return {
      bindingKey,
      baseBindingKey,
      workspaceRoot,
      characterChat: true,
      characterId: card.id,
      characterName: card.name,
      card,
    };
  }

  async prepareCharacterRuntimeTurn({ normalized, baseBindingKey, workspaceRoot, prepared, replyTarget, runtimeScope = null }) {
    const resolveRuntimeScope = typeof this.resolveCharacterRuntimeScope === "function"
      ? this.resolveCharacterRuntimeScope.bind(this)
      : CharacterWechatApp.prototype.resolveCharacterRuntimeScope.bind(this);
    const scope = runtimeScope || await resolveRuntimeScope({
      normalized,
      baseBindingKey,
      workspaceRoot,
      replyTarget,
    });
    if (!scope) {
      return null;
    }
    if (!scope.characterChat) {
      return { bindingKey: scope.bindingKey || baseBindingKey, prepared };
    }

    const card = scope.card || this.characterLibrary.getCharacter(scope.characterId);
    if (!card) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "当前角色卡没有找到，请先 /char reload，再 /char use 选择角色",
        contextToken: normalized.contextToken,
      }).catch(() => {});
      return null;
    }

    const originalUserText = normalizeText(prepared?.originalText) || normalizeText(normalized?.text);
    const characterUserMessage = normalizeText(prepared?.characterUserMessage);
    const hasCharacterAttachmentContext = Boolean(prepared?.hasCharacterAttachmentContext);
    const userMessage = hasCharacterAttachmentContext
      ? (characterUserMessage || originalUserText || normalizeText(prepared?.text))
      : (originalUserText || characterUserMessage || normalizeText(prepared?.text));
    const buildUserRecallContext = this.projectServices?.userMemory?.buildRecallContextAsync
      || this.projectServices?.userMemory?.buildRecallContext;
    const userRecallContext = await buildUserRecallContext?.call(this.projectServices?.userMemory, {
      accountId: normalized.accountId,
      senderId: normalized.senderId,
      characterId: card.id,
      characterName: card.name,
      query: userMessage,
      now: (prepared?.receivedAt || normalized?.receivedAt) ? new Date(prepared?.receivedAt || normalized.receivedAt) : new Date(),
    }) || null;
    const buildDailyWeatherReminderPayload = typeof this.buildDailyWeatherReminderPayload === "function"
      ? this.buildDailyWeatherReminderPayload.bind(this)
      : null;
    const missedDailyReminder = !buildDailyWeatherReminderPayload
      || normalizeText(normalized?.provider).toLowerCase() === "daily_weather"
      || prepared?.reportKind
      || prepared?.skipDailyWeatherReminder
      ? null
      : await buildDailyWeatherReminderPayload({
          accountId: normalized.accountId,
          senderId: normalized.senderId,
          mode: "missed_reply",
        });
    const prompt = buildCharacterChatPrompt({
      card,
      userName: this.config.userName || "User",
      userMessage,
      recentUserMessages: [originalUserText, userMessage].filter(Boolean),
      now: (prepared?.receivedAt || normalized?.receivedAt) ? new Date(prepared?.receivedAt || normalized.receivedAt) : new Date(),
      localTime: formatWechatLocalTime(prepared?.receivedAt || normalized?.receivedAt, resolveConfiguredTimeZone(this.config)),
      userLocation: this.config.localLocation || "",
      dailyReminder: missedDailyReminder?.prompt || "",
      userRecall: userRecallContext?.text || "",
    });
    const bindingKey = scope.bindingKey || buildCharacterBindingKey(baseBindingKey, card.id);
    this.streamDelivery.setReplyTarget(bindingKey, replyTarget);
    return {
      bindingKey,
      prepared: {
        ...prepared,
        text: prompt,
        characterChat: true,
        characterId: card.id,
        characterName: card.name,
        activeCharacterId: card.id,
        dailyWeatherReminderMark: missedDailyReminder?.mark || prepared.dailyWeatherReminderMark,
      },
    };
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    console.log("[st-character-wechat] turn gate begin reason=dispatch");

    try {
      const turn = await this.runtimeAdapter.sendTextTurn({
        bindingKey,
        workspaceRoot,
        text: prepared.text,
        model: this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          characterChat: Boolean(prepared.characterChat),
          characterId: prepared.characterId || "",
          characterName: prepared.characterName || "",
        },
      });
      if (prepared.dailyWeatherReminderMark) {
        markDailyWeatherReminderSent(prepared.dailyWeatherReminderMark);
      }
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      this.turnGateStore.attachRun(turn.threadId, turn.turnId);
      console.log(
        `[st-character-wechat] turn gate attached thread=${normalizeCommandArgument(turn.threadId) || ""} turn=${normalizeCommandArgument(turn.turnId) || ""}`
      );
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      const queueUserMemory = typeof this.queueUserMemoryForTurn === "function"
        ? this.queueUserMemoryForTurn.bind(this)
        : CharacterWechatApp.prototype.queueUserMemoryForTurn.bind(this);
      queueUserMemory({
        turn,
        bindingKey,
        workspaceRoot,
        prepared,
      });
      const trackProactiveChat = typeof this.trackProactiveChatTurn === "function"
        ? this.trackProactiveChatTurn.bind(this)
        : CharacterWechatApp.prototype.trackProactiveChatTurn.bind(this);
      trackProactiveChat({
        turn,
        bindingKey,
        workspaceRoot,
        prepared,
      });
      await this.channelAdapter.sendTyping({
        userId: prepared.senderId,
        status: 1,
        contextToken: prepared.contextToken,
      }).catch(() => {});
      this.scheduleRuntimeEventWatchdog({
        bindingKey,
        workspaceRoot,
        normalized: prepared,
        threadId: turn.threadId,
      });
      return true;
    } catch (error) {
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      console.log("[st-character-wechat] turn gate release reason=dispatch_failed");
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }
  }

  queueUserMemoryForTurn({ turn = {}, bindingKey = "", workspaceRoot = "", prepared = {} } = {}) {
    if (prepared?.skipUserMemory) {
      return;
    }
    if (!prepared?.characterChat || !prepared?.characterId || prepared?.reportKind) {
      return;
    }
    if (!this.pendingUserMemoryByRunKey?.set) {
      return;
    }
    const threadId = normalizeCommandArgument(turn.threadId);
    if (!threadId) {
      return;
    }
    const turnId = normalizeCommandArgument(turn.turnId);
    const runKey = buildRunKey(threadId, turnId);
    this.pendingUserMemoryByRunKey.set(runKey, {
      bindingKey,
      workspaceRoot,
      threadId,
      turnId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      characterId: prepared.characterId,
      characterName: prepared.characterName,
      receivedAt: prepared.receivedAt,
      userText: normalizeText(prepared.originalText)
        || normalizeText(prepared.characterUserMessage)
        || normalizeText(prepared.text),
      assistantText: "",
      itemOrder: [],
      itemTextById: {},
      streamingText: "",
      turnText: "",
    });
  }

  trackProactiveChatTurn({ turn = {}, bindingKey = "", workspaceRoot = "", prepared = {} } = {}) {
    if (!this.config?.proactiveChatEnabled || !this.pendingProactiveChatByRunKey?.set) {
      return;
    }
    if (!prepared?.characterChat || !prepared?.characterId || prepared?.reportKind) {
      return;
    }
    const threadId = normalizeCommandArgument(turn.threadId);
    if (!threadId) {
      return;
    }
    const provider = normalizeText(prepared.provider).toLowerCase();
    const kind = prepared?.proactiveChat
      ? "proactive"
      : (
          !prepared?.skipProactiveChatSchedule
          && provider !== "daily_weather"
          && provider !== "scheduled_report"
        )
          ? "user_reply"
          : "";
    if (!kind) {
      return;
    }
    const turnId = normalizeCommandArgument(turn.turnId);
    this.pendingProactiveChatByRunKey.set(buildRunKey(threadId, turnId), {
      kind,
      bindingKey,
      workspaceRoot,
      threadId,
      turnId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      characterId: prepared.characterId,
      characterName: prepared.characterName,
      receivedAt: prepared.receivedAt,
    });
  }

  noteProactiveChatUserMessage(normalized = {}) {
    if (!this.config?.proactiveChatEnabled || !normalized?.accountId || !normalized?.senderId) {
      return;
    }
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    if (!sessionStore?.buildBindingKey) {
      return;
    }
    const baseBindingKey = sessionStore.buildBindingKey({
      workspaceId: normalized.workspaceId || this.config.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const characterId = this.characterStateStore?.getActiveCharacterId?.(baseBindingKey) || "";
    if (!characterId) {
      return;
    }
    markProactiveChatUserMessage({
      filePath: this.config.proactiveChatStateFile,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
      characterId,
      now: new Date(normalized.receivedAt || Date.now()),
    });
  }

  finalizeProactiveChatTurn(pendingProactive, event) {
    if (!pendingProactive || !this.config?.proactiveChatEnabled) {
      return;
    }
    const now = new Date();
    if (pendingProactive.kind === "user_reply") {
      scheduleNextProactiveChat({
        filePath: this.config.proactiveChatStateFile,
        config: this.config,
        accountId: pendingProactive.accountId,
        senderId: pendingProactive.senderId,
        characterId: pendingProactive.characterId,
        now,
      });
      return;
    }
    if (pendingProactive.kind !== "proactive") {
      return;
    }
    markProactiveChatSent({
      filePath: this.config.proactiveChatStateFile,
      config: this.config,
      accountId: pendingProactive.accountId,
      senderId: pendingProactive.senderId,
      characterId: pendingProactive.characterId,
      now,
    });
    scheduleNextProactiveChat({
      filePath: this.config.proactiveChatStateFile,
      config: this.config,
      accountId: pendingProactive.accountId,
      senderId: pendingProactive.senderId,
      characterId: pendingProactive.characterId,
      now,
    });
  }

  trackPendingUserMemoryRuntimeEvent(event) {
    const found = findPendingRunState(this.pendingUserMemoryByRunKey, event);
    const pendingMemory = found?.operation || null;
    if (!pendingMemory) {
      return null;
    }
    const eventType = normalizeCommandArgument(event?.type);
    const payload = event?.payload || {};
    if (eventType === "runtime.reply.delta") {
      pendingMemory.streamingText = appendRuntimeTextFragment(
        pendingMemory.streamingText,
        normalizeText(payload.text)
      );
      return pendingMemory;
    }
    if (eventType === "runtime.reply.completed") {
      const itemId = normalizeCommandArgument(payload.itemId) || `item-${pendingMemory.itemOrder.length + 1}`;
      if (!pendingMemory.itemTextById || typeof pendingMemory.itemTextById !== "object") {
        pendingMemory.itemTextById = {};
      }
      if (!Array.isArray(pendingMemory.itemOrder)) {
        pendingMemory.itemOrder = [];
      }
      if (!pendingMemory.itemOrder.includes(itemId)) {
        pendingMemory.itemOrder.push(itemId);
      }
      pendingMemory.itemTextById[itemId] = normalizeText(payload.text);
      return pendingMemory;
    }
    if (eventType === "runtime.turn.completed") {
      pendingMemory.turnText = normalizeText(payload.text) || pendingMemory.turnText || "";
      return pendingMemory;
    }
    return pendingMemory;
  }

  finalizeUserMemoryForTurn(pendingMemory, event) {
    if (!pendingMemory || !this.projectServices?.userMemory?.appendTurn) {
      return null;
    }
    try {
      const assistantText = resolvePendingRunText(pendingMemory, event);
      return this.projectServices.userMemory.appendTurn({
        accountId: pendingMemory.accountId,
        senderId: pendingMemory.senderId,
        characterId: pendingMemory.characterId,
        characterName: pendingMemory.characterName,
        userText: pendingMemory.userText,
        assistantText,
        receivedAt: pendingMemory.receivedAt,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      console.error(`[st-character-wechat] user memory append failed: ${messageText}`);
      return null;
    }
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared, reason = "blocked", runtimeScope = null }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const now = Date.now();
    const nextReason = normalizePendingInboundReason(reason);
    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      reason: nextReason,
      firstBufferedAtMs: now,
      lastBufferedAtMs: 0,
      flushAtMs: 0,
      timer: null,
    };
    current.bindingKey = bindingKey;
    current.workspaceRoot = workspaceRoot;
    current.baseBindingKey = normalizeText(runtimeScope?.baseBindingKey) || current.baseBindingKey || bindingKey;
    current.characterChat = Boolean(runtimeScope?.characterChat || current.characterChat);
    current.characterId = normalizeText(runtimeScope?.characterId) || current.characterId || "";
    current.characterName = normalizeText(runtimeScope?.characterName) || current.characterName || "";
    current.reason = resolvePendingInboundDraftReason(current.reason, nextReason);
    current.firstBufferedAtMs = Number.isFinite(current.firstBufferedAtMs) && current.firstBufferedAtMs > 0
      ? current.firstBufferedAtMs
      : now;
    current.lastBufferedAtMs = now;
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      text: prepared.text,
      originalText: prepared.originalText,
      characterUserMessage: prepared.characterUserMessage,
      hasCharacterAttachmentContext: prepared.hasCharacterAttachmentContext,
      localTime: prepared.localTime,
      receivedAt: prepared.receivedAt,
    });
    this.pendingInboundByScope.set(scopeKey, current);
    this.reconcilePendingInboundDraft(scopeKey, current);
    console.log(
      `[st-character-wechat] pending inbound queued reason=${normalizePendingInboundReason(current.reason)} count=${current.messages.length}`
    );
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.clearPendingInboundDraftTimer?.(scopeKey, draft);
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (normalizePendingInboundReason(draft.reason) === "cooldown" && !isPendingInboundDraftDue(draft)) {
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const merged = mergePendingInboundDraft(draft);
      this.clearPendingInboundDraftTimer?.(scopeKey, draft);
      this.pendingInboundByScope.delete(scopeKey);
      if (!merged) {
        continue;
      }
      console.log(
        `[st-character-wechat] pending inbound flush reason=${normalizePendingInboundReason(draft.reason)} count=${Array.isArray(draft.messages) ? draft.messages.length : 0}`
      );
      const replyTarget = {
        userId: merged.senderId,
        contextToken: merged.contextToken,
        provider: merged.provider,
      };
      const baseBindingKey = normalizeText(merged.baseBindingKey) || merged.bindingKey;
      const normalized = {
        workspaceId: merged.workspaceId,
        accountId: merged.accountId,
        senderId: merged.senderId,
        messageId: merged.messageId,
        contextToken: merged.contextToken,
        provider: merged.provider,
        text: merged.text,
        receivedAt: merged.receivedAt,
      };
      const runtimeTurn = typeof this.prepareCharacterRuntimeTurn === "function"
        ? await this.prepareCharacterRuntimeTurn({
            normalized,
            baseBindingKey,
            workspaceRoot: merged.workspaceRoot,
            prepared: merged,
            replyTarget,
            runtimeScope: merged.characterChat
              ? {
                  bindingKey: merged.bindingKey,
                  baseBindingKey,
                  workspaceRoot: merged.workspaceRoot,
                  characterChat: true,
                  characterId: merged.characterId,
                  characterName: merged.characterName,
                }
              : null,
          })
        : { bindingKey: merged.bindingKey, prepared: merged };
      if (!runtimeTurn) {
        continue;
      }
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: runtimeTurn.bindingKey || merged.bindingKey,
        workspaceRoot: merged.workspaceRoot,
        prepared: runtimeTurn.prepared,
      });
      if (!dispatched) {
        draft.timer = null;
        this.pendingInboundByScope.set(scopeKey, draft);
      }
    }
  }

  reconcilePendingInboundDraft(scopeKey, draft) {
    if (!scopeKey || !draft) {
      return;
    }
    if (normalizePendingInboundReason(draft.reason) !== "cooldown") {
      draft.flushAtMs = 0;
      this.clearPendingInboundDraftTimer(scopeKey, draft);
      return;
    }

    const now = Date.now();
    draft.flushAtMs = now + INBOUND_IDLE_BATCH_WINDOW_MS;
    if (Array.isArray(draft.messages) && draft.messages.length >= INBOUND_IDLE_BATCH_MAX_MESSAGES) {
      draft.flushAtMs = now;
      this.clearPendingInboundDraftTimer(scopeKey, draft);
      this.queuePendingInboundFlush({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
      return;
    }

    this.clearPendingInboundDraftTimer(scopeKey, draft);
    draft.timer = setTimeout(() => {
      const latest = this.pendingInboundByScope.get(scopeKey);
      if (!latest?.bindingKey || !latest?.workspaceRoot) {
        return;
      }
      latest.timer = null;
      this.queuePendingInboundFlush({
        bindingKey: latest.bindingKey,
        workspaceRoot: latest.workspaceRoot,
      });
    }, INBOUND_IDLE_BATCH_WINDOW_MS);
  }

  clearPendingInboundDraftTimer(scopeKey, draft = null) {
    const current = draft || this.pendingInboundByScope.get(scopeKey) || null;
    if (current?.timer) {
      clearTimeout(current.timer);
    }
    if (current) {
      current.timer = null;
    }
  }

  queuePendingInboundFlush({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    this.runtimeEventChain = this.runtimeEventChain
      .catch(() => {})
      .then(() => this.flushPendingInboundMessages({ bindingKey, workspaceRoot, ignoreBoundary }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[st-character-wechat] pending inbound flush failed: ${message}`);
      });
  }

  scheduleRuntimeEventWatchdog({ bindingKey, workspaceRoot, normalized, threadId = "" }) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const candidateThreadId = normalizeCommandArgument(threadId)
      || sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const normalizedThreadId = normalizeCommandArgument(candidateThreadId);
    if (!normalizedThreadId) {
      return;
    }

    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const isCodex = runtimeName === "codex";

    this.clearRuntimeEventWatchdog(normalizedThreadId);
    const noticeTimer = setTimeout(async () => {
      const watchdog = this.pendingRuntimeEventWatchdogs.get(normalizedThreadId);
      if (!watchdog) {
        return;
      }
      const currentThreadState = this.threadStateStore.getThreadState(normalizedThreadId);
      if (currentThreadState?.status === "running" || currentThreadState?.turnId) {
        return;
      }
      watchdog.noticeSent = true;
      const noticeLines = isCodex
        ? [
            `⏳ This message has already reached the bridge, but ${runtimeName} has not returned the first event yet.`,
            "If your terminal is still reconnecting, this round is probably still stuck in shared-thread startup.",
            "You do not need to keep waiting in chat. If it reconnects later, the message will continue.",
            `workspace: ${workspaceRoot}`,
            `thread: ${normalizedThreadId}`,
          ]
        : [
            `⏳ This message has already reached the bridge, but ${runtimeName} has not returned the first event yet.`,
            "The runtime process may still be starting up.",
            "You do not need to keep waiting in chat. If it reconnects later, the message will continue.",
            `workspace: ${workspaceRoot}`,
            `thread: ${normalizedThreadId}`,
          ];
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: noticeLines.join("\n"),
      }).catch(() => {});
    }, FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS);
    const failureTimer = setTimeout(async () => {
      this.pendingRuntimeEventWatchdogs.delete(normalizedThreadId);
      const currentThreadState = this.threadStateStore.getThreadState(normalizedThreadId);
      if (currentThreadState?.status === "running" || currentThreadState?.turnId) {
        return;
      }
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      const failureLines = isCodex
        ? [
            `❌ This message has already reached the bridge, but ${runtimeName} still has not returned the first event.`,
            "If the reconnecting cycle in the terminal already finished 5 attempts, this shared thread most likely never started successfully.",
            `workspace: ${workspaceRoot}`,
            `thread: ${normalizedThreadId}`,
            "Check these first: whether the shared app-server is healthy, whether the terminal is attached to the same thread, and whether runtime actually started processing this message.",
            "Recommended order:",
            "1. Run `npm run shared:status` in the project directory",
            "2. If the bridge is down, run `npm run shared:start`",
            "3. Open another terminal and run `npm run shared:open`",
            "4. Confirm the terminal is attached to the same thread shown above, not a private thread",
          ]
        : [
            `❌ This message has already reached the bridge, but ${runtimeName} still has not returned the first event.`,
            "The runtime process may have failed to start or exited unexpectedly.",
            `workspace: ${workspaceRoot}`,
            `thread: ${normalizedThreadId}`,
            "Check whether the runtime process is still running, or run `npm run shared:status`.",
          ];
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: failureLines.join("\n"),
      }).catch(() => {});
    }, FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS);
    this.pendingRuntimeEventWatchdogs.set(normalizedThreadId, {
      noticeTimer,
      failureTimer,
      noticeSent: false,
    });
  }

  clearRuntimeEventWatchdog(threadId) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const watchdog = this.pendingRuntimeEventWatchdogs.get(normalizedThreadId);
    if (!watchdog) {
      return;
    }
    clearTimeout(watchdog.noticeTimer);
    clearTimeout(watchdog.failureTimer);
    this.pendingRuntimeEventWatchdogs.delete(normalizedThreadId);
  }

  refreshRuntimeStallWatchdog({ threadId = "", turnId = "", timeoutMs = STARTED_RUNTIME_STALL_TIMEOUT_MS } = {}) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (!normalizedThreadId || !normalizedTurnId) {
      return;
    }
    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    if (!runKey) {
      return;
    }
    this.clearRuntimeStallWatchdog({ threadId: normalizedThreadId, turnId: normalizedTurnId });
    const timer = setTimeout(() => {
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleStartedRuntimeStall({ threadId: normalizedThreadId, turnId: normalizedTurnId }))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || "unknown error");
          console.error(`[st-character-wechat] started-turn watchdog failed: ${message}`);
        });
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : STARTED_RUNTIME_STALL_TIMEOUT_MS);
    this.pendingRuntimeStallWatchdogs.set(runKey, {
      timer,
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
    });
  }

  clearRuntimeStallWatchdog({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (normalizedThreadId && normalizedTurnId) {
      const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
      const current = this.pendingRuntimeStallWatchdogs.get(runKey);
      if (!current) {
        return;
      }
      clearTimeout(current.timer);
      this.pendingRuntimeStallWatchdogs.delete(runKey);
      return;
    }
    if (!normalizedThreadId) {
      return;
    }
    for (const [runKey, current] of this.pendingRuntimeStallWatchdogs.entries()) {
      if (current?.threadId !== normalizedThreadId) {
        continue;
      }
      clearTimeout(current.timer);
      this.pendingRuntimeStallWatchdogs.delete(runKey);
    }
  }

  async handleStartedRuntimeStall({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (!normalizedThreadId || !normalizedTurnId || this.isRuntimeThreadAbandoned(normalizedThreadId, normalizedTurnId)) {
      return;
    }

    const currentThreadState = this.threadStateStore.getThreadState(normalizedThreadId);
    const currentTurnId = normalizeCommandArgument(currentThreadState?.turnId);
    if (currentThreadState?.status !== "running" || (currentTurnId && currentTurnId !== normalizedTurnId)) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(normalizedThreadId);
    const scopeKey = linked?.bindingKey && linked?.workspaceRoot
      ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
      : "";
    const replyTarget = normalizeReplyTarget(
      this.streamDelivery.resolveReplyTargetForRun({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
      })
    ) || normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    );

    if (scopeKey) {
      this.turnBoundaryScopeKeys.add(scopeKey);
    }
    try {
      this.markRuntimeRunAbandoned({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
      });
      if (linked?.bindingKey && linked?.workspaceRoot) {
        sessionStore.clearThreadIdForWorkspace(linked.bindingKey, linked.workspaceRoot);
        sessionStore.clearPendingThreadIdForWorkspace?.(linked.bindingKey, linked.workspaceRoot);
      }
      if (replyTarget) {
        await this.channelAdapter.sendTyping({
          userId: replyTarget.userId,
          status: 0,
          contextToken: replyTarget.contextToken,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: replyTarget.userId,
          text: STARTED_RUNTIME_STALL_NOTICE_TEXT,
          contextToken: replyTarget.contextToken,
          singleLine: true,
        }).catch(() => {});
      }
      if (linked?.bindingKey && linked?.workspaceRoot) {
        await this.flushPendingInboundMessages({
          bindingKey: linked.bindingKey,
          workspaceRoot: linked.workspaceRoot,
          ignoreBoundary: true,
        });
      } else {
        await this.flushPendingInboundMessages();
      }
      await this.flushPendingSystemMessages();
    } finally {
      if (scopeKey) {
        this.turnBoundaryScopeKeys.delete(scopeKey);
      }
    }
  }

  markRuntimeRunAbandoned({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (!normalizedThreadId) {
      return;
    }
    this.abandonedRuntimeThreadIds.add(normalizedThreadId);
    if (normalizedTurnId) {
      this.abandonedRuntimeRunKeys.add(buildRunKey(normalizedThreadId, normalizedTurnId));
    }
    this.clearRuntimeStallWatchdog({ threadId: normalizedThreadId, turnId: normalizedTurnId });
    console.warn(
      `[st-character-wechat] runtime stall recovered thread=${normalizedThreadId} turn=${normalizedTurnId}`
    );
    this.turnGateStore.releaseThread(normalizedThreadId, normalizedTurnId);
    this.streamDelivery.muteThread(normalizedThreadId);
  }

  isRuntimeThreadAbandoned(threadId = "", turnId = "") {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (!normalizedThreadId) {
      return false;
    }
    if (this.abandonedRuntimeThreadIds.has(normalizedThreadId)) {
      return true;
    }
    if (!normalizedTurnId) {
      return false;
    }
    return this.abandonedRuntimeRunKeys.has(buildRunKey(normalizedThreadId, normalizedTurnId));
  }

  trackAbandonedRuntimeEvent(event) {
    const normalizedThreadId = normalizeCommandArgument(event?.payload?.threadId);
    const normalizedTurnId = normalizeCommandArgument(event?.payload?.turnId);
    if (!normalizedThreadId) {
      return;
    }
    if (event?.type === "runtime.turn.started" && normalizedTurnId) {
      this.abandonedRuntimeRunKeys.add(buildRunKey(normalizedThreadId, normalizedTurnId));
      return;
    }
    if (
      event?.type === "runtime.turn.completed"
      || event?.type === "runtime.turn.failed"
      || event?.type === "runtime.approval.requested"
    ) {
      if (normalizedTurnId && this.pendingOperationByRunKey?.delete) {
        this.pendingOperationByRunKey.delete(buildRunKey(normalizedThreadId, normalizedTurnId));
      }
      this.clearRuntimeStallWatchdog({ threadId: normalizedThreadId, turnId: normalizedTurnId });
      this.abandonedRuntimeThreadIds.delete(normalizedThreadId);
      if (normalizedTurnId) {
        this.abandonedRuntimeRunKeys.delete(buildRunKey(normalizedThreadId, normalizedTurnId));
      }
    }
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot, options = {}) {
    const localTime = formatWechatLocalTime(normalized?.receivedAt, resolveConfiguredTimeZone(this.config));
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        localTime,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      if (options?.characterChat) {
        const characterText = buildCharacterInboundText(normalized, { saved: [], failed: [] }, this.config);
        return {
          ...normalized,
          originalText: normalized.text,
          localTime,
          characterUserMessage: characterText,
          hasCharacterAttachmentContext: false,
          text: characterText,
          attachments: [],
          attachmentFailures: [],
        };
      }
      return {
        ...normalized,
        originalText: normalized.text,
        localTime,
        text: buildInboundText(normalized, { saved: [], failed: [] }, this.config, {
          runtimeId: this.runtimeAdapter?.describe?.().id || "",
        }),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      stateDir: this.config.stateDir,
      cdnBaseUrl: this.config.weixinCdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });

    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const inboundText = options?.characterChat
      ? buildCharacterInboundText(normalized, persisted, this.config)
      : buildInboundText(normalized, persisted, this.config, {
        runtimeId: this.runtimeAdapter?.describe?.().id || "",
      });
    if (!inboundText) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return {
      ...normalized,
      originalText: normalized.text,
      localTime,
      characterUserMessage: options?.characterChat ? inboundText : "",
      hasCharacterAttachmentContext: Boolean(options?.characterChat && (persisted.saved.length || persisted.failed.length)),
      text: inboundText,
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    };
  }

  async flushPendingSystemMessages() {
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[st-character-wechat] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const dueCandidates = [];
    const nextDueAtMs = dueCandidates
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right)[0];
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueDailyWeatherReminder(account) {
    const senderId = this.activeSenderId || resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.runtimeAdapter?.getSessionStore?.(),
    });
    if (!senderId) {
      return;
    }
    const contextTokens = this.channelAdapter.getKnownContextTokens?.() || {};
    const contextToken = normalizeCommandArgument(contextTokens[senderId]);
    if (!contextToken) {
      return;
    }

    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: account.accountId,
      senderId,
    });
    const activeCharacterId = this.characterStateStore?.getActiveCharacterId?.(baseBindingKey) || "";
    if (!activeCharacterId) {
      return;
    }
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    const reminder = await this.buildDailyWeatherReminderPayload({
      accountId: account.accountId,
      senderId,
      mode: "proactive",
    });
    if (!reminder) {
      return;
    }
    const replyTarget = {
      userId: senderId,
      contextToken,
      provider: "daily_weather",
    };
    const normalized = {
      provider: "daily_weather",
      workspaceId: this.config.workspaceId,
      accountId: account.accountId,
      chatId: senderId,
      senderId,
      messageId: `daily-weather:${reminder.mark.dateKey}`,
      text: "",
      command: "message",
      contextToken,
      receivedAt: new Date().toISOString(),
      workspaceRoot,
    };
    const runtimeScope = await this.resolveCharacterRuntimeScope({
      normalized,
      baseBindingKey,
      workspaceRoot,
      replyTarget,
    });
    if (!runtimeScope?.characterChat) {
      return;
    }

    const prepared = {
      ...normalized,
      text: reminder.prompt,
      originalText: "",
      characterUserMessage: reminder.prompt,
      hasCharacterAttachmentContext: false,
      skipUserMemory: true,
      dailyWeatherReminderMark: reminder.mark,
    };
    const runtimeTurn = await this.prepareCharacterRuntimeTurn({
      normalized: { ...normalized, text: reminder.prompt },
      baseBindingKey,
      workspaceRoot,
      prepared,
      replyTarget,
      runtimeScope,
    });
    if (!runtimeTurn) {
      return;
    }
    if (this.isTurnDispatchBlocked(runtimeTurn.bindingKey || runtimeScope.bindingKey, workspaceRoot)) {
      return;
    }
    const dispatched = await this.dispatchPreparedTurn({
      bindingKey: runtimeTurn.bindingKey || runtimeScope.bindingKey,
      workspaceRoot,
      prepared: runtimeTurn.prepared,
    });
    if (!dispatched) {
      return;
    }
  }

  async flushDueProactiveChat(account) {
    if (!this.config.proactiveChatEnabled) {
      return;
    }
    const senderId = this.activeSenderId || resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.runtimeAdapter?.getSessionStore?.(),
    });
    if (!senderId) {
      return;
    }
    const contextTokens = this.channelAdapter.getKnownContextTokens?.() || {};
    const contextToken = normalizeCommandArgument(contextTokens[senderId]);
    if (!contextToken) {
      return;
    }
    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: account.accountId,
      senderId,
    });
    const activeCharacterId = this.characterStateStore?.getActiveCharacterId?.(baseBindingKey) || "";
    if (!activeCharacterId) {
      return;
    }
    const state = loadProactiveChatState(this.config.proactiveChatStateFile);
    const due = resolveProactiveChatDue({
      now: new Date(),
      timeZone: resolveConfiguredTimeZone(this.config),
      config: this.config,
      state,
      accountId: account.accountId,
      senderId,
      characterId: activeCharacterId,
    });
    if (due.stateChanged) {
      saveProactiveChatState(this.config.proactiveChatStateFile, state);
    }
    if (!due.due) {
      return;
    }
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    const runtimeScope = await this.resolveCharacterRuntimeScope({
      normalized: {
        provider: "proactive_chat",
        workspaceId: this.config.workspaceId,
        accountId: account.accountId,
        senderId,
        contextToken,
      },
      baseBindingKey,
      workspaceRoot,
      replyTarget: {
        userId: senderId,
        contextToken,
        provider: "proactive_chat",
      },
      characterId: activeCharacterId,
    });
    if (!runtimeScope?.characterChat) {
      return;
    }
    if (this.isTurnDispatchBlocked(runtimeScope.bindingKey, workspaceRoot) || this.hasPendingInboundMessage(runtimeScope.bindingKey, workspaceRoot)) {
      return;
    }
    const normalized = {
      provider: "proactive_chat",
      workspaceId: this.config.workspaceId,
      accountId: account.accountId,
      chatId: senderId,
      senderId,
      messageId: `proactive-chat:${due.nextAt || Date.now()}`,
      text: "",
      command: "message",
      contextToken,
      receivedAt: new Date().toISOString(),
      workspaceRoot,
    };
    const prepared = {
      ...normalized,
      text: "",
      originalText: "",
      characterUserMessage: buildProactiveChatUserMessage({
        pendingCount: due.pendingCount,
        pendingLimit: this.config.proactiveChatPendingLimit,
      }),
      hasCharacterAttachmentContext: false,
      skipUserMemory: true,
      skipDailyWeatherReminder: true,
      proactiveChat: true,
    };
    const runtimeTurn = await this.prepareCharacterRuntimeTurn({
      normalized,
      baseBindingKey,
      workspaceRoot,
      prepared,
      replyTarget: {
        userId: senderId,
        contextToken,
        provider: "proactive_chat",
      },
      runtimeScope,
    });
    if (!runtimeTurn) {
      return;
    }
    clearProactiveChatNextAt({
      filePath: this.config.proactiveChatStateFile,
      accountId: account.accountId,
      senderId,
      characterId: activeCharacterId,
      now: new Date(),
    });
    await this.dispatchPreparedTurn({
      bindingKey: runtimeTurn.bindingKey || runtimeScope.bindingKey,
      workspaceRoot,
      prepared: runtimeTurn.prepared,
    });
  }

  async buildDailyWeatherReminderPayload({ accountId = "", senderId = "", mode = "proactive" } = {}) {
    if (!this.config.dailyWeatherReminderEnabled) {
      return null;
    }
    const location = normalizeCommandArgument(this.config.localLocation);
    if (!location) {
      return null;
    }
    const reminderState = loadDailyWeatherReminderState(this.config.dailyWeatherReminderFile);
    const due = resolveDailyWeatherReminderDue({
      now: new Date(),
      timeZone: resolveConfiguredTimeZone(this.config),
      reminderHour: this.config.dailyWeatherReminderHour,
      state: reminderState,
      accountId,
      senderId,
    });
    if (due.stateChanged) {
      saveDailyWeatherReminderState(this.config.dailyWeatherReminderFile, reminderState);
    }
    if (!due.due) {
      return null;
    }
    if (mode === "proactive" && due.missed) {
      return null;
    }
    if (mode === "missed_reply" && !due.missed) {
      return null;
    }
    const weatherSummary = await fetchDailyWeatherSummary(location);
    return {
      prompt: buildDailyWeatherReminderPrompt({
        location,
        timeZone: resolveConfiguredTimeZone(this.config),
        localTime: due.localTime,
        scheduledLocalTime: due.scheduledLocalTime,
        missed: due.missed,
        weatherSummary,
      }),
      mark: {
        filePath: this.config.dailyWeatherReminderFile,
        state: reminderState,
        accountId,
        senderId,
        dateKey: due.dateKey,
      },
    };
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);
    if (dueReminders.length) {
      console.log(`[st-character-wechat] discarded ${dueReminders.length} due reminder(s) in character-only mode`);
    }
  }

  async flushDueScheduledReportCards(account) {
    await this.flushDueScheduledReportCard(account, "daily");
    await this.flushDueScheduledReportCard(account, "weekly");
  }

  async flushDueWeeklyReports(account) {
    await this.flushDueScheduledReportCards(account);
  }

  async flushDueScheduledReportCard(account, reportKind = "daily") {
    const senderId = this.activeSenderId || resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.runtimeAdapter?.getSessionStore?.(),
    });
    if (!senderId) {
      return;
    }
    const contextTokens = this.channelAdapter.getKnownContextTokens?.() || {};
    const contextToken = normalizeCommandArgument(contextTokens[senderId]);
    if (!contextToken) {
      return;
    }
    const reportState = loadScheduledReportState(this.config.autoReportStateFile);
    const due = resolveScheduledReportDue({
      now: new Date(),
      timeZone: resolveConfiguredTimeZone(this.config),
      reportKind,
      config: this.config,
      state: reportState,
      accountId: account.accountId,
      senderId,
    });
    if (!due.due) {
      return;
    }
    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: account.accountId,
      senderId,
    });
    const activeCharacterId = this.characterStateStore?.getActiveCharacterId?.(baseBindingKey) || "";
    if (!activeCharacterId) {
      return;
    }
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    const normalized = {
      provider: "scheduled_report",
      workspaceId: this.config.workspaceId,
      accountId: account.accountId,
      chatId: senderId,
      senderId,
      messageId: `scheduled-report:${reportKind}:${due.mark.periodKey}`,
      text: reportKind === "weekly" ? "/weeklycard" : "/dailycard",
      command: reportKind === "weekly" ? "weeklycard" : "dailycard",
      contextToken,
      receivedAt: new Date().toISOString(),
      workspaceRoot,
    };
    await this.handleReportCardCommand(normalized, reportKind, {
      quiet: true,
      reportNow: due.reportNow || new Date(),
      scheduledReportMark: due.mark,
    });
  }

  async dispatchSystemMessage(message) {
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    if (this.isCharacterOnlySystemMessageBlocked(prepared)) {
      console.log(
        `[st-character-wechat] skipped system message in character-only mode sender=${prepared.senderId || ""} id=${prepared.messageId || ""}`
      );
      return true;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    if (this.hasPendingInboundMessage(bindingKey, workspaceRoot)) {
      return false;
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  isCharacterOnlySystemMessageBlocked(prepared) {
    const provider = normalizeText(prepared?.provider).toLowerCase();
    return provider === "system";
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized, command);
        return;
      case "dailycard":
        await this.handleReportCardCommand(normalized, "daily");
        return;
      case "weeklycard":
        await this.handleReportCardCommand(normalized, "weekly");
        return;
      case "weekly":
        await this.handleLegacyReportCommand(normalized, "/weekly", "/weeklycard");
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "char":
        await this.handleCharCommand(normalized, command);
        return;
      case "userstatus":
      case "statuscard":
        await this.handleLegacyReportCommand(normalized, `/${command.name}`, "/dailycard 或 /weeklycard");
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const { bindingKey, workspaceRoot, card: activeCharacter } = target;
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const {
      threadId,
      pendingThreadId,
      threadState,
      runtimeName,
      context,
    } = typeof this.resolveContextState === "function"
      ? this.resolveContextState({ bindingKey, workspaceRoot })
      : resolveContextStateForApp(this, { bindingKey, workspaceRoot });
    const storedModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model || "";
    const isLikelyCodexModel = /gpt|o1|o3|codex/i.test(storedModel);
    const effectiveModel = (runtimeName === "claudecode" && isLikelyCodexModel)
      ? (this.config.claudeModel || "")
      : storedModel;

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🎭 character: ${activeCharacter.name}`,
      `🧵 thread: ${threadId || "(none)"}${pendingThreadId ? " (pending verification)" : ""}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
    ].filter(Boolean);
    if (pendingThreadId) {
      lines.splice(2, 0, `🔁 target: ${pendingThreadId}`);
    }
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleCharCommand(normalized, command) {
    const tokens = normalizeCommandArgument(command?.args).split(/\s+/).filter(Boolean);
    const subcommand = normalizeCommandName(tokens[0] || "list");
    const args = tokens.slice(1).join(" ").trim();
    switch (subcommand) {
      case "list":
        await this.handleCharListCommand(normalized);
        return;
      case "reload":
        await this.handleCharReloadCommand(normalized);
        return;
      case "use":
        await this.handleCharUseCommand(normalized, args);
        return;
      case "current":
        await this.handleCharCurrentCommand(normalized);
        return;
      case "reset":
        await this.handleCharResetCommand(normalized);
        return;
      default:
        await sendCharCommandTextForApp(this, normalized, [
          "可用命令：/char list",
          "/char use 1 或 /char use 角色名",
          "/char current",
          "/char reload",
          "/char reset",
        ].join("\n"));
    }
  }

  async handleCharListCommand(normalized) {
    const snapshot = this.characterLibrary.ensureLoaded();
    if (!snapshot.cards.length) {
      await sendCharCommandTextForApp(this, normalized, [
        "没有扫描到角色卡",
        `目录：${snapshot.cardDir || "(none)"}`,
        "把 SillyTavern .png/.json 放进去后发送 /char reload",
      ].join("\n"));
      return;
    }
    const lines = snapshot.cards.map((card, index) => {
      const worldbookCount = Array.isArray(card.characterBook?.entries) ? card.characterBook.entries.length : 0;
      return `${index + 1}. ${card.name} | worldbook ${worldbookCount}`;
    });
    await sendCharCommandTextForApp(this, normalized, lines.join("\n"));
  }

  async handleCharReloadCommand(normalized) {
    const snapshot = this.characterLibrary.reload();
    const lines = [
      `已重新扫描角色卡：${snapshot.cards.length} 个`,
      `目录：${snapshot.cardDir || "(none)"}`,
    ];
    if (snapshot.errors.length) {
      lines.push(`失败：${snapshot.errors.length} 个文件`);
      for (const error of snapshot.errors.slice(0, 5)) {
        lines.push(`${path.basename(error.filePath)}: ${error.reason}`);
      }
    }
    await sendCharCommandTextForApp(this, normalized, lines.join("\n"));
  }

  async handleCharUseCommand(normalized, query) {
    if (!normalizeCommandArgument(query)) {
      await sendCharCommandTextForApp(this, normalized, "用法：/char use 1 或 /char use Ciel");
      return;
    }
    const card = this.characterLibrary.findCharacter(query);
    if (!card) {
      await sendCharCommandTextForApp(this, normalized, "没有找到这个角色，先 /char list 看编号，或 /char reload 重新扫描");
      return;
    }
    const baseBindingKey = buildBaseBindingKeyForApp(this, normalized);
    this.characterStateStore.setActiveCharacterId(baseBindingKey, card.id);
    await sendCharCommandTextForApp(this, normalized, [
      `当前角色：${card.name}`,
      `角色线程：独立`,
    ].join("\n"));
  }

  async handleCharCurrentCommand(normalized) {
    const baseBindingKey = buildBaseBindingKeyForApp(this, normalized);
    const card = getActiveCharacterForBindingForApp(this, baseBindingKey);
    if (!card) {
      await sendCharCommandTextForApp(this, normalized, "当前没有选择角色，发送 /char list 后用 /char use 选择");
      return;
    }
    const characterBindingKey = buildCharacterBindingKey(baseBindingKey, card.id);
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(characterBindingKey, workspaceRoot);
    await sendCharCommandTextForApp(this, normalized, [
      `当前角色：${card.name}`,
      `角色ID：${card.id}`,
      `线程：${threadId || "(还没有开始)"}`,
    ].join("\n"));
  }

  async handleCharResetCommand(normalized) {
    const baseBindingKey = buildBaseBindingKeyForApp(this, normalized);
    const card = getActiveCharacterForBindingForApp(this, baseBindingKey);
    if (!card) {
      await sendCharCommandTextForApp(this, normalized, "当前没有选择角色，发送 /char list 后用 /char use 选择");
      return;
    }
    const characterBindingKey = buildCharacterBindingKey(baseBindingKey, card.id);
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey: characterBindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearPendingThreadIdForWorkspace?.(characterBindingKey, workspaceRoot);
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(characterBindingKey, workspaceRoot);
    await sendCharCommandTextForApp(this, normalized, `已重置 ${card.name} 的独立聊天线程`);
  }

  buildBaseBindingKeyForMessage(normalized) {
    return this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
  }

  getActiveCharacterForBinding(baseBindingKey) {
    const activeCharacterId = this.characterStateStore.getActiveCharacterId(baseBindingKey);
    return activeCharacterId ? this.characterLibrary.getCharacter(activeCharacterId) : null;
  }

  async resolveActiveCharacterThreadTarget(normalized, { sendIfMissing = true } = {}) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const baseBindingKey = buildBaseBindingKeyForApp(this, normalized);
    const workspaceRoot = this.resolveWorkspaceRoot(baseBindingKey);
    const activeCharacterId = this.characterStateStore?.getActiveCharacterId?.(baseBindingKey) || "";
    if (!activeCharacterId) {
      if (sendIfMissing) {
        await sendCharCommandTextForApp(this, normalized, "当前没有选择角色，先发送 /char list，然后 /char use 选择角色");
      }
      return null;
    }
    const card = this.characterLibrary?.getCharacter?.(activeCharacterId) || null;
    if (!card) {
      if (sendIfMissing) {
        await sendCharCommandTextForApp(this, normalized, "当前角色卡没有找到，请先 /char reload，再 /char use 选择角色");
      }
      return null;
    }
    const bindingKey = buildCharacterBindingKey(baseBindingKey, card.id);
    return {
      baseBindingKey,
      bindingKey,
      workspaceRoot,
      card,
      sessionStore,
    };
  }

  async sendCharCommandText(normalized, text) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
      singleLine: true,
    });
  }

  async handleReportCardCommand(normalized, reportKind = "daily", options = {}) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const { bindingKey, workspaceRoot, card, sessionStore } = target;
    const threadId = normalizeCommandArgument(sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot));
    const isWeekly = reportKind === "weekly";
    const label = isWeekly ? "每周回顾长图" : "每日小结长图";
    const reportNow = options?.reportNow instanceof Date ? options.reportNow : new Date();
    if (!threadId) {
      if (options?.quiet) {
        return;
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `${label}需要当前角色线程里已有聊天记录。先聊几句，再使用 ${isWeekly ? "/weeklycard" : "/dailycard"}。`,
        contextToken: normalized.contextToken,
        singleLine: true,
      });
      return;
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      if (options?.quiet) {
        return;
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `当前角色线程还有一轮在运行，稍后再生成${label}。`,
        contextToken: normalized.contextToken,
        singleLine: true,
      });
      return;
    }

    const service = resolveReportCardServiceForApp(this, reportKind);
    if (!service?.buildRuntimePrompt || !service?.renderFromRuntimeText) {
      if (options?.quiet) {
        return;
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `${label}服务不可用，请检查本地安装。`,
        contextToken: normalized.contextToken,
        singleLine: true,
      });
      return;
    }

    const replyTarget = {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
    };
    this.streamDelivery.setReplyTarget(bindingKey, replyTarget);
    await this.channelAdapter.sendTyping({
      userId: normalized.senderId,
      status: 1,
      contextToken: normalized.contextToken,
    }).catch(() => {});

    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    const pendingOperation = {
      kind: "report_card",
      reportKind,
      label,
      bindingKey,
      workspaceRoot,
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
      threadId,
      turnId: "",
      reportNow: reportNow.toISOString(),
      characterId: card.id,
      characterName: card.name,
      itemOrder: [],
      itemTextById: {},
      streamingText: "",
      turnText: "",
      accountId: normalized.accountId,
      senderId: normalized.senderId,
      scheduledReportMark: options?.scheduledReportMark || buildScheduledReportMark({
        filePath: this.config.autoReportStateFile,
        reportKind,
        now: reportNow,
        timeZone: resolveConfiguredTimeZone(this.config),
        accountId: normalized.accountId,
        senderId: normalized.senderId,
      }),
    };
    const pendingRunKey = buildRunKey(threadId, "");
    this.pendingOperationByRunKey.set(pendingRunKey, pendingOperation);
    try {
      const prompt = service.buildRuntimePrompt({
        now: reportNow,
        userName: this.config.userName || "User",
        timeZone: this.config.reportTimeZone,
        memoryContext: this.projectServices?.userMemory?.buildReportContext?.({
          senderId: normalized.senderId,
          characterId: card.id,
          reportKind,
          now: reportNow,
        }) || null,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const turn = await this.runtimeAdapter.sendTextTurn({
        bindingKey,
        workspaceRoot,
        text: prompt,
        model: runtimeParams.model,
        metadata: {
          reportKind,
          characterChat: true,
          characterId: card.id,
          characterName: card.name,
        },
      });
      const activeThreadId = normalizeCommandArgument(turn.threadId) || threadId;
      const activeTurnId = normalizeCommandArgument(turn.turnId);
      this.turnGateStore.attachThread(pendingScopeKey, activeThreadId);
      if (activeTurnId) {
        this.turnGateStore.attachRun(activeThreadId, activeTurnId);
        this.streamDelivery.muteRun?.({ threadId: activeThreadId, turnId: activeTurnId });
      }
      const activeRunKey = buildRunKey(activeThreadId, activeTurnId);
      this.pendingOperationByRunKey.delete(pendingRunKey);
      pendingOperation.threadId = activeThreadId;
      pendingOperation.turnId = activeTurnId;
      this.pendingOperationByRunKey.set(activeRunKey, pendingOperation);
      this.scheduleRuntimeEventWatchdog({
        bindingKey,
        workspaceRoot,
        normalized,
        threadId: activeThreadId,
      });
    } catch (error) {
      this.pendingOperationByRunKey.delete(pendingRunKey);
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      await this.sendReportCardFailure({
        reportKind,
        label,
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        error,
      });
    }
  }

  trackPendingReportCardRuntimeEvent(event) {
    const found = findPendingReportCardOperation(this.pendingOperationByRunKey, event);
    const pendingOperation = found?.operation || null;
    if (!pendingOperation) {
      return null;
    }
    const eventType = normalizeCommandArgument(event?.type);
    const payload = event?.payload || {};
    if (eventType === "runtime.reply.delta") {
      pendingOperation.streamingText = appendRuntimeTextFragment(
        pendingOperation.streamingText,
        normalizeText(payload.text)
      );
      return pendingOperation;
    }
    if (eventType === "runtime.reply.completed") {
      const itemId = normalizeCommandArgument(payload.itemId) || `item-${pendingOperation.itemOrder.length + 1}`;
      if (!pendingOperation.itemTextById || typeof pendingOperation.itemTextById !== "object") {
        pendingOperation.itemTextById = {};
      }
      if (!Array.isArray(pendingOperation.itemOrder)) {
        pendingOperation.itemOrder = [];
      }
      if (!pendingOperation.itemOrder.includes(itemId)) {
        pendingOperation.itemOrder.push(itemId);
      }
      pendingOperation.itemTextById[itemId] = normalizeText(payload.text);
      return pendingOperation;
    }
    if (eventType === "runtime.turn.completed") {
      pendingOperation.turnText = normalizeText(payload.text) || pendingOperation.turnText || "";
      return pendingOperation;
    }
    return pendingOperation;
  }

  async finalizeReportCardOperation(pendingOperation, event) {
    const service = resolveReportCardServiceForApp(this, pendingOperation.reportKind);
    try {
      const text = resolveReportCardRuntimeText(pendingOperation, event);
      if (!text) {
        throw new Error("Runtime completed without report JSON.");
      }
      const rendered = await service.renderFromRuntimeText({
        text,
        now: pendingOperation.reportNow ? new Date(pendingOperation.reportNow) : new Date(),
        context: {
          userName: this.config.userName || "User",
          timeZone: this.config.reportTimeZone,
          characterId: pendingOperation.characterId,
          characterName: pendingOperation.characterName,
        },
      });
      await this.channelAdapter.sendFile({
        userId: pendingOperation.userId,
        filePath: rendered.filePath,
        contextToken: pendingOperation.contextToken,
      });
      markScheduledReportSent(pendingOperation.scheduledReportMark);
      await this.channelAdapter.sendTyping({
        userId: pendingOperation.userId,
        status: 0,
        contextToken: pendingOperation.contextToken,
      }).catch(() => {});
    } catch (error) {
      await this.sendReportCardFailure({
        reportKind: pendingOperation.reportKind,
        label: pendingOperation.label,
        userId: pendingOperation.userId,
        contextToken: pendingOperation.contextToken,
        error,
      });
    }
  }

  async sendReportCardFailure({ reportKind = "daily", label = "", userId = "", contextToken = "", error = null } = {}) {
    const resolvedLabel = label || (reportKind === "weekly" ? "每周回顾长图" : "每日小结长图");
    const messageText = error instanceof Error ? error.message : String(error || "unknown error");
    await this.channelAdapter.sendTyping({
      userId,
      status: 0,
      contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId,
      text: `${resolvedLabel}生成失败\n${messageText}`,
      contextToken,
      preserveBlock: true,
    }).catch(() => {});
  }

  async handleLegacyReportCommand(normalized, legacyCommand, replacementCommand) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `${legacyCommand} 已替换为 ${replacementCommand}；当前只生成长图报告。`,
      contextToken: normalized.contextToken,
      singleLine: true,
    });
  }

  async handleRereadCommand(normalized) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: "character-only 模式不使用 /reread；角色 prompt 会在每条消息按当前角色卡重新构建",
      contextToken: normalized.contextToken,
      singleLine: true,
    });
  }

  async handleCompactCommand(normalized, command = {}) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const compactArgs = normalizeCommandArgument(command?.args);
    if (compactArgs.toLowerCase().startsWith("auto")) {
      if (typeof this.handleCompactAutoCommand === "function") {
        await this.handleCompactAutoCommand(normalized, compactArgs);
      } else {
        await CharacterWechatApp.prototype.handleCompactAutoCommand.call(this, normalized, compactArgs);
      }
      return;
    }
    const { bindingKey, workspaceRoot, sessionStore, card } = target;
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `当前角色 ${card.name} 还没有独立线程，先发一句普通消息开始聊天`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      this.scheduleRuntimeEventWatchdog({
        bindingKey,
        workspaceRoot,
        normalized,
        threadId,
      });
      if (typeof this.requestCompactOperation === "function") {
        await this.requestCompactOperation({
          threadId,
          workspaceRoot,
          model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
          pendingOperation: {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          },
        });
      } else {
        const result = await this.runtimeAdapter.compactThread({
          threadId,
          workspaceRoot,
          model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
        });
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId && this.pendingOperationByRunKey?.set) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactAutoCommand(normalized, compactArgs = "") {
    const tokens = normalizeCommandArgument(compactArgs).split(/\s+/).filter(Boolean);
    const subcommand = normalizeCommandName(tokens[1] || "");
    if (!subcommand) {
      await this.sendCompactAutoStatus(normalized);
      return;
    }

    if (subcommand === "on") {
      const updated = this.channelAdapter.setAutoCompactConfig?.({
        enabled: true,
      }) || {
        enabled: true,
        thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
      };
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `Auto compact enabled at ${updated.thresholdPercent}% used context.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (subcommand === "off") {
      const updated = this.channelAdapter.setAutoCompactConfig?.({
        enabled: false,
      }) || {
        enabled: false,
        thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
      };
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `Auto compact disabled. Threshold stays at ${updated.thresholdPercent}%.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedThreshold = Number.parseInt(subcommand, 10);
    if (!Number.isFinite(parsedThreshold)
      || parsedThreshold < MIN_AUTO_COMPACT_THRESHOLD_PERCENT
      || parsedThreshold > MAX_AUTO_COMPACT_THRESHOLD_PERCENT) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `Usage: /compact auto, /compact auto on, /compact auto off, or /compact auto <${MIN_AUTO_COMPACT_THRESHOLD_PERCENT}-${MAX_AUTO_COMPACT_THRESHOLD_PERCENT}>.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const updated = this.channelAdapter.setAutoCompactConfig?.({
      enabled: true,
      thresholdPercent: parsedThreshold,
    }) || {
      enabled: true,
      thresholdPercent: parsedThreshold,
    };
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `Auto compact enabled at ${updated.thresholdPercent}% used context.`,
      contextToken: normalized.contextToken,
    });
  }

  async requestCompactOperation({
    threadId,
    workspaceRoot,
    model = "",
    pendingOperation = null,
  } = {}) {
    const result = await this.runtimeAdapter.compactThread({
      threadId,
      workspaceRoot,
      model,
    });
    const compactTurnId = normalizeCommandArgument(result?.turnId);
    if (compactTurnId && pendingOperation) {
      const runKey = buildRunKey(threadId, compactTurnId);
      this.pendingOperationByRunKey.set(runKey, {
        ...pendingOperation,
      });
      if (pendingOperation.kind === "auto_compact") {
        this.streamDelivery.muteRun?.({ threadId, turnId: compactTurnId });
      }
    }
    return result;
  }

  async sendCompactAutoStatus(normalized) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const { bindingKey, workspaceRoot } = target;
    const autoCompact = this.channelAdapter.getAutoCompactConfig?.() || {
      enabled: true,
      thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    };
    const contextState = typeof this.resolveContextState === "function"
      ? this.resolveContextState({ bindingKey, workspaceRoot })
      : resolveContextStateForApp(this, { bindingKey, workspaceRoot });
    const usage = resolveContextUsageState({
      runtimeName: contextState.runtimeName,
      context: contextState.context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    });
    const lines = [
      `auto compact: ${autoCompact.enabled ? "on" : "off"}`,
      `threshold: ${autoCompact.thresholdPercent}% used`,
    ];
    if (usage.available) {
      lines.push(`current: ${formatCompactNumber(usage.currentTokens)}/${formatCompactNumber(usage.contextWindow)} used (${usage.usedPercent}%)`);
    } else {
      lines.push(`current: unavailable (${usage.reason})`);
    }
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleSwitchCommand(normalized, command) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: "character-only 模式不支持 /switch，避免串到其他线程；请使用 /char use <角色> 切换角色",
      contextToken: normalized.contextToken,
      singleLine: true,
    });
  }

  async handleStopCommand(normalized) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const { bindingKey, workspaceRoot, sessionStore } = target;
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    void command;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: "character-only 模式不使用旧 checkin 主动触发；请直接和当前角色聊天，后续用户状态长图会走 /dailycard 和 /weeklycard。",
      contextToken: normalized.contextToken,
      singleLine: true,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const { bindingKey, workspaceRoot, sessionStore } = target;
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
  if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: "💡 There is no pending approval request right now.",
      contextToken: normalized.contextToken,
      });
      return;
    }

    if (approval?.kind === "mcp_tool_call" && command.name === "always") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Persistent approval for this Codex MCP tool request is not available from WeChat.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[st-character-wechat] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    sessionStore.clearApprovalPrompt(threadId);
    console.log(
      `[st-character-wechat] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    this.threadStateStore.resolveApproval(threadId, "running");
    this.refreshRuntimeStallWatchdog?.({
      threadId,
      turnId: threadState?.turnId,
    });
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const target = await resolveActiveCharacterThreadTargetForApp(this, normalized);
    if (!target) {
      return;
    }
    const { bindingKey, workspaceRoot, sessionStore, card } = target;
    const query = normalizeCommandArgument(command.args);
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Character: ${card.name}`,
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\ncharacter: ${card.name}\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/The-Veridis-Lion/ST_Character_Wechat.git",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  resolveContextState({ bindingKey, workspaceRoot }) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const pendingThreadId = sessionStore.getPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot) || "";
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    return {
      threadId,
      pendingThreadId,
      threadState,
      runtimeName,
      context,
    };
  }

  async maybeAutoCompactThread(linked) {
    if (!linked?.bindingKey || !linked?.workspaceRoot) {
      return false;
    }
    if (this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
      || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)) {
      return false;
    }

    const autoCompact = this.channelAdapter.getAutoCompactConfig?.() || {
      enabled: true,
      thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    };
    if (!autoCompact.enabled) {
      return false;
    }

    const contextState = this.resolveContextState({
      bindingKey: linked.bindingKey,
      workspaceRoot: linked.workspaceRoot,
    });
    if (!contextState.threadId) {
      return false;
    }

    const usage = resolveContextUsageState({
      runtimeName: contextState.runtimeName,
      context: contextState.context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    });
    if (!usage.available || usage.usedPercent < autoCompact.thresholdPercent) {
      return false;
    }

    const replyTarget = this.resolveReplyTargetForBinding(linked.bindingKey);
    const model = this.runtimeAdapter.getSessionStore()
      .getRuntimeParamsForWorkspace(linked.bindingKey, linked.workspaceRoot).model;

    try {
      await this.requestCompactOperation({
        threadId: contextState.threadId,
        workspaceRoot: linked.workspaceRoot,
        model,
        pendingOperation: {
          kind: "auto_compact",
          userId: replyTarget?.userId || "",
          contextToken: replyTarget?.contextToken || "",
        },
      });
      return true;
    } catch (error) {
      if (replyTarget) {
        await this.channelAdapter.sendText({
          userId: replyTarget.userId,
          text: `⚠️ Auto compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
          contextToken: replyTarget.contextToken,
        }).catch(() => {});
      }
      return false;
    }
  }

  async handleRuntimeEvent(event) {
    const normalizedThreadId = normalizeCommandArgument(event?.payload?.threadId);
    const normalizedTurnId = normalizeCommandArgument(event?.payload?.turnId);
    const pendingReportOperation = this.trackPendingReportCardRuntimeEvent?.(event) || null;
    this.trackPendingUserMemoryRuntimeEvent?.(event);
    if (pendingReportOperation && normalizedThreadId) {
      this.streamDelivery.muteRun?.({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
      });
    }
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    if (event?.type === "runtime.turn.started" && normalizedThreadId && normalizedTurnId) {
      this.turnGateStore.attachRun?.(normalizedThreadId, normalizedTurnId);
    }
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event) {
      return;
    }
    const isAbandoned = typeof this.isRuntimeThreadAbandoned === "function"
      ? this.isRuntimeThreadAbandoned(normalizedThreadId, normalizedTurnId)
      : false;
    if (isAbandoned) {
      this.trackAbandonedRuntimeEvent?.(event);
      return;
    }
    if (event.type === "runtime.turn.started") {
      this.refreshRuntimeStallWatchdog?.({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
      });
      return;
    }
    if (event.type === "runtime.reply.delta") {
      this.refreshRuntimeStallWatchdog?.({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
        timeoutMs: STREAMING_REPLY_RUNTIME_STALL_TIMEOUT_MS,
      });
      return;
    }
    if (event.type === "runtime.reply.completed") {
      this.refreshRuntimeStallWatchdog?.({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
        timeoutMs: COMPLETED_REPLY_RUNTIME_STALL_TIMEOUT_MS,
      });
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      this.clearRuntimeStallWatchdog?.({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
      });
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      const pendingMemoryState = findPendingRunState(this.pendingUserMemoryByRunKey, event);
      const pendingMemory = pendingMemoryState?.operation || null;
      if (pendingMemory && this.pendingUserMemoryByRunKey?.delete) {
        this.pendingUserMemoryByRunKey.delete(pendingMemoryState.runKey);
      }
      const pendingProactiveState = findPendingRunState(this.pendingProactiveChatByRunKey, event);
      const pendingProactive = pendingProactiveState?.operation || null;
      if (pendingProactive && this.pendingProactiveChatByRunKey?.delete) {
        this.pendingProactiveChatByRunKey.delete(pendingProactiveState.runKey);
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        console.log(
          `[st-character-wechat] turn gate release thread=${normalizeCommandArgument(event.payload.threadId) || ""} turn=${normalizeCommandArgument(event.payload.turnId) || ""} event=${event.type}`
        );
        this.turnGateStore.releaseThread(event.payload.threadId, event.payload.turnId);
        if (event.type === "runtime.turn.failed") {
          if (pendingOperation?.kind === "report_card") {
            await this.sendReportCardFailure({
              reportKind: pendingOperation.reportKind,
              label: pendingOperation.label,
              userId: pendingOperation.userId,
              contextToken: pendingOperation.contextToken,
              error: event.payload.text || "Runtime turn failed.",
            });
          } else if (pendingOperation?.kind === "auto_compact") {
            const replyTarget = normalizeReplyTarget(pendingOperation) || failureReplyTarget;
            if (replyTarget) {
              await this.channelAdapter.sendText({
                userId: replyTarget.userId,
                text: `⚠️ Auto compact failed\n${event.payload.text || "unknown error"}`,
                contextToken: replyTarget.contextToken,
              }).catch(() => {});
            }
          } else {
            await this.sendFailureToThread(
              event.payload.threadId,
              event.payload.text || "❌ Execution failed",
              failureReplyTarget,
            );
          }
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        if (pendingOperation?.kind === "report_card" && event.type === "runtime.turn.completed") {
          await this.finalizeReportCardOperation(pendingOperation, event);
        }
        if (pendingMemory && event.type === "runtime.turn.completed") {
          this.finalizeUserMemoryForTurn(pendingMemory, event);
        }
        if (pendingProactive && event.type === "runtime.turn.completed") {
          this.finalizeProactiveChatTurn(pendingProactive, event);
        }
        if (!pendingOperation && event.type === "runtime.turn.completed" && linked?.bindingKey && linked?.workspaceRoot) {
          await this.maybeAutoCompactThread(linked).catch((error) => {
            console.error(`[st-character-wechat] auto compact trigger failed: ${error.message}`);
          });
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    this.clearRuntimeStallWatchdog?.({
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
    });
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || matchesBuiltInCommandPrefix(event.payload.commandTokens);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[st-character-wechat] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
    this.refreshRuntimeStallWatchdog?.({
      threadId: event.payload.threadId,
      turnId: this.threadStateStore.getThreadState(event.payload.threadId)?.turnId || event.payload.turnId,
    });
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || normalizeReplyTarget(fallbackTarget);
    if (!target) {
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: normalizeText(text) || "❌ Execution failed",
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[st-character-wechat] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[st-character-wechat] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[st-character-wechat] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[userId] || "";
    if (!contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider: "weixin",
    };
  }
}

function resolveContextStateForApp(appLike, { bindingKey, workspaceRoot }) {
  const sessionStore = appLike.runtimeAdapter.getSessionStore();
  const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  const pendingThreadId = sessionStore.getPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot) || "";
  const threadState = threadId ? appLike.threadStateStore.getThreadState(threadId) : null;
  const runtimeName = appLike.runtimeAdapter.describe().id || "runtime";
  const context = threadState?.context?.runtimeId === runtimeName
    ? threadState.context
    : appLike.threadStateStore.getLatestContext(runtimeName);
  return {
    threadId,
    pendingThreadId,
    threadState,
    runtimeName,
    context,
  };
}

function resolveActiveCharacterThreadTargetForApp(appLike, normalized, options = {}) {
  if (typeof appLike?.resolveActiveCharacterThreadTarget === "function") {
    return appLike.resolveActiveCharacterThreadTarget(normalized, options);
  }
  return CharacterWechatApp.prototype.resolveActiveCharacterThreadTarget.call(appLike, normalized, options);
}

function buildBaseBindingKeyForApp(appLike, normalized) {
  if (typeof appLike?.buildBaseBindingKeyForMessage === "function") {
    return appLike.buildBaseBindingKeyForMessage(normalized);
  }
  return CharacterWechatApp.prototype.buildBaseBindingKeyForMessage.call(appLike, normalized);
}

function getActiveCharacterForBindingForApp(appLike, baseBindingKey) {
  if (typeof appLike?.getActiveCharacterForBinding === "function") {
    return appLike.getActiveCharacterForBinding(baseBindingKey);
  }
  return CharacterWechatApp.prototype.getActiveCharacterForBinding.call(appLike, baseBindingKey);
}

async function sendCharCommandTextForApp(appLike, normalized, text) {
  if (typeof appLike?.sendCharCommandText === "function") {
    await appLike.sendCharCommandText(normalized, text);
    return;
  }
  await CharacterWechatApp.prototype.sendCharCommandText.call(appLike, normalized, text);
}

function resolveReportCardServiceForApp(appLike, reportKind = "daily") {
  const services = appLike?.projectServices || {};
  return reportKind === "weekly" ? services.weeklyReviewCard : services.dailyDiaryCard;
}

function findPendingReportCardOperation(pendingOperations, event) {
  const found = findPendingRunState(pendingOperations, event);
  if (found?.operation?.kind === "report_card") {
    return found;
  }
  return null;
}

function findPendingRunState(pendingOperations, event) {
  if (!pendingOperations?.get || !event?.payload) {
    return null;
  }
  const threadId = normalizeCommandArgument(event.payload.threadId);
  const turnId = normalizeCommandArgument(event.payload.turnId);
  if (!threadId) {
    return null;
  }
  const exactRunKey = buildRunKey(threadId, turnId);
  const exact = pendingOperations.get(exactRunKey);
  if (exact) {
    return { runKey: exactRunKey, operation: exact };
  }
  const pendingRunKey = buildRunKey(threadId, "");
  const pending = pendingOperations.get(pendingRunKey);
  if (!pending) {
    return null;
  }
  if (turnId && pendingOperations?.delete && pendingOperations?.set) {
    pendingOperations.delete(pendingRunKey);
    pending.turnId = turnId;
    pendingOperations.set(exactRunKey, pending);
    return { runKey: exactRunKey, operation: pending };
  }
  return { runKey: pendingRunKey, operation: pending };
}

function resolveReportCardRuntimeText(pendingOperation, event) {
  return resolvePendingRunText(pendingOperation, event);
}

function resolvePendingRunText(pendingOperation, event) {
  const direct = normalizeText(event?.payload?.text);
  if (direct) {
    return direct;
  }
  const turnText = normalizeText(pendingOperation?.turnText);
  if (turnText) {
    return turnText;
  }
  const itemOrder = Array.isArray(pendingOperation?.itemOrder) ? pendingOperation.itemOrder : [];
  const itemTextById = pendingOperation?.itemTextById && typeof pendingOperation.itemTextById === "object"
    ? pendingOperation.itemTextById
    : {};
  const itemText = itemOrder
    .map((itemId) => normalizeText(itemTextById[itemId]))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (itemText) {
    return itemText;
  }
  return normalizeText(pendingOperation?.streamingText);
}

function appendRuntimeTextFragment(current, next) {
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

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
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

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function resolveContextUsageState({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return { available: false, reason: "set ST_CHARACTER_WECHAT_CLAUDE_CONTEXT_WINDOW" };
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return { available: false, reason: "reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS" };
    }
    const currentTokens = Number(context?.currentTokens);
    if (!Number.isFinite(currentTokens)) {
      return { available: false, reason: "unavailable" };
    }
    const usedPercent = Math.max(0, Math.min(100, Math.round((Math.max(0, currentTokens) / availableMessageWindow) * 100)));
    return {
      available: true,
      approximate: true,
      currentTokens: Math.max(0, currentTokens),
      contextWindow: availableMessageWindow,
      reservedOutputTokens,
      usedPercent,
      leftPercent: Math.max(0, 100 - usedPercent),
    };
  }

  const currentTokens = Number(context?.currentTokens);
  const contextWindow = Number(context?.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { available: false, reason: "unavailable" };
  }
  const safeCurrent = Math.max(0, currentTokens);
  const safeWindow = Math.max(1, contextWindow);
  const usedPercent = Math.max(0, Math.min(100, Math.round((Math.min(safeCurrent, safeWindow) / safeWindow) * 100)));
  return {
    available: true,
    approximate: false,
    currentTokens: safeCurrent,
    contextWindow: safeWindow,
    reservedOutputTokens: 0,
    usedPercent,
    leftPercent: Math.max(0, 100 - usedPercent),
  };
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  const usage = resolveContextUsageState({
    runtimeName,
    context,
    claudeContextWindow,
    claudeMaxOutputTokens,
  });
  if (!usage.available) {
    return `📦 context: ${usage.reason}`;
  }
  const summary = formatContextUsage(usage.currentTokens, usage.contextWindow);
  if (usage.approximate) {
    if (usage.reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(usage.reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  return `📦 context: ${summary}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CharacterWechatApp,
  loadProactiveChatState,
  markProactiveChatSent,
  markProactiveChatUserMessage,
  resolveProactiveChatDue,
  scheduleNextProactiveChat,
  buildScheduledReportMark,
  loadScheduledReportState,
  markScheduledReportSent,
  resolveScheduledReportDue,
};

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

  if (normalized[0] === "mcp_tool" && normalized[1] === "st_character_wechat_tools") {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? responseByCommand[commandName]
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "✅ This request has been approved once. Persistent workspace auto-approval is disabled in character-only mode."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function mergePendingInboundDraft(draft) {
  const queued = Array.isArray(draft?.messages)
    ? draft.messages
      .filter((message) => message && typeof message === "object")
      .slice()
      .sort(comparePendingInboundMessages)
    : [];
  if (!queued.length) {
    return null;
  }
  if (queued.length === 1) {
    const message = queued[0];
    return {
      bindingKey: draft.bindingKey,
      baseBindingKey: draft.baseBindingKey || draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      characterChat: Boolean(draft.characterChat),
      characterId: draft.characterId || "",
      characterName: draft.characterName || "",
      ...message,
      characterUserMessage: Boolean(draft.characterChat)
        ? (message.hasCharacterAttachmentContext ? (message.characterUserMessage || message.originalText || message.text || "") : "")
        : (message.characterUserMessage || ""),
      hasCharacterAttachmentContext: Boolean(message.hasCharacterAttachmentContext),
    };
  }

  const latest = queued[queued.length - 1];
  const hasCharacterAttachmentContext = queued.some((message) => Boolean(message.hasCharacterAttachmentContext));
  const rawBlocks = queued
    .map((message) => String(message.originalText || message.text || "").trim())
    .filter(Boolean);
  const characterBlocks = queued
    .map((message) => {
      if (message.hasCharacterAttachmentContext) {
        return String(message.characterUserMessage || message.originalText || message.text || "").trim();
      }
      return String(message.originalText || message.text || "").trim();
    })
    .filter(Boolean);
  const mergedText = [
    normalizePendingInboundReason(draft?.reason) === "blocked"
      ? "Multiple newer WeChat messages arrived while you were still handling the previous turn."
      : "Multiple new WeChat messages arrived close together.",
    normalizePendingInboundReason(draft?.reason) === "blocked"
      ? "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them."
      : "Treat the following blocks as one ordered batch from the user and respond once after considering all of them together.",
    "",
    characterBlocks.join("\n\n"),
  ].join("\n").trim();
  const characterMergedText = characterBlocks.join("\n\n");
  const rawMergedText = rawBlocks.join("\n\n") || characterMergedText;

  return {
    bindingKey: draft.bindingKey,
    baseBindingKey: draft.baseBindingKey || draft.bindingKey,
    workspaceRoot: draft.workspaceRoot,
    characterChat: Boolean(draft.characterChat),
    characterId: draft.characterId || "",
    characterName: draft.characterName || "",
    ...latest,
    originalText: rawMergedText,
    characterUserMessage: Boolean(draft.characterChat) && hasCharacterAttachmentContext ? characterMergedText : "",
    hasCharacterAttachmentContext: Boolean(draft.characterChat && hasCharacterAttachmentContext),
    text: Boolean(draft.characterChat) ? (characterMergedText || rawMergedText) : mergedText,
  };
}

function isPendingInboundDraftDue(draft) {
  if (normalizePendingInboundReason(draft?.reason) !== "cooldown") {
    return true;
  }
  const messageCount = Array.isArray(draft?.messages) ? draft.messages.length : 0;
  if (messageCount >= INBOUND_IDLE_BATCH_MAX_MESSAGES) {
    return true;
  }
  const flushAtMs = Number(draft?.flushAtMs);
  return Number.isFinite(flushAtMs) && flushAtMs > 0 && flushAtMs <= Date.now();
}

function normalizePendingInboundReason(value) {
  return normalizeText(value) === "cooldown" ? "cooldown" : "blocked";
}

function resolvePendingInboundDraftReason(currentReason, nextReason) {
  if (normalizePendingInboundReason(currentReason) === "blocked") {
    return "blocked";
  }
  return normalizePendingInboundReason(nextReason);
}

function buildInboundText(normalized, persisted = {}, config = {}, options = {}) {
  const text = String(normalized?.text || "").trim();
  const saved = Array.isArray(persisted?.saved) ? persisted.saved : [];
  const failed = Array.isArray(persisted?.failed) ? persisted.failed : [];
  const userName = String(config?.userName || "").trim() || "the user";
  const runtimeId = normalizeText(options?.runtimeId).toLowerCase();
  const localTime = formatWechatLocalTime(normalized?.receivedAt, resolveConfiguredTimeZone(config));
  const lines = [];
  if (localTime) {
    lines.push(`[${localTime}]`);
  }
  if (text) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(text);
  }

  if (saved.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(`${userName} sent image/file attachments. They were saved under the local data directory:`);
    for (const item of saved) {
      const suffix = item.sourceFileName ? ` (original name: ${item.sourceFileName})` : "";
      lines.push(`- [${item.kind}] ${item.absolutePath}${suffix}`);
    }
    lines.push(`You must read these files before replying to ${userName}.`);
    if (saved.some((item) => isImageAttachmentItem(item))) {
      if (runtimeUsesReadForImages(runtimeId)) {
        lines.push("For images, use `Read` on the saved local image file.");
      } else {
        lines.push("For images, use `view_image`.");
      }
    }
    lines.push(`If a required tool is missing, tell ${userName} exactly what is missing and that you cannot read the file yet.`);
  }

  if (failed.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Attachment intake errors:");
    for (const item of failed) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
  }

  return lines.join("\n").trim();
}

function buildCharacterInboundText(normalized, persisted = {}, config = {}) {
  const text = String(normalized?.text || "").trim();
  const saved = Array.isArray(persisted?.saved) ? persisted.saved : [];
  const failed = Array.isArray(persisted?.failed) ? persisted.failed : [];
  const lines = [];
  if (text) {
    lines.push(text);
  }

  if (saved.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(`用户发来了 ${saved.length} 个附件。`);
    for (const item of saved) {
      const kind = normalizeText(item?.kind) || (isImageAttachmentItem(item) ? "image" : "file");
      const name = normalizeText(item?.sourceFileName);
      lines.push(name ? `- ${kind}: ${name}` : `- ${kind} attachment`);
    }
    lines.push("当前角色聊天只知道附件存在；不要假装已经看过附件内容。");
  }

  if (failed.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("有附件未能接收。");
    for (const item of failed) {
      const label = normalizeText(item?.sourceFileName) || normalizeText(item?.kind) || "attachment";
      lines.push(`- ${label}: ${normalizeText(item?.reason) || "接收失败"}`);
    }
  }

  return lines.join("\n").trim();
}

function runtimeUsesReadForImages(runtimeId) {
  return runtimeId === "claudecode";
}

function isImageAttachmentItem(item) {
  return Boolean(item?.isImage) || normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image";
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = "由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达；这次用户再次发来消息、context_token 刷新后，先把遗留内容补上。如果这种情况反复出现，可发送 /chunk <数字>（例如 /chunk 50）调大最小合并字符数，减少消息分片。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

function formatDeferredSystemReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return DEFERRED_REPLY_NOTICE;
  }
  if (normalized.startsWith(DEFERRED_REPLY_NOTICE)) {
    return normalized;
  }
  return `${DEFERRED_REPLY_NOTICE}\n\n${normalized}`;
}

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

function formatWechatLocalTime(receivedAt, timeZone = "") {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: resolveValidTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function resolveConfiguredTimeZone(config = {}) {
  return resolveValidTimeZone(config.localTimeZone || config.userMemoryTimeZone || config.reportTimeZone || "Asia/Shanghai");
}

function resolveValidTimeZone(timeZone = "") {
  const normalized = normalizeCommandArgument(timeZone) || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "Asia/Shanghai";
  }
}

function resolveProactiveChatDue({
  now = new Date(),
  timeZone = "Asia/Shanghai",
  config = {},
  state = {},
  accountId = "",
  senderId = "",
  characterId = "",
} = {}) {
  if (!config.proactiveChatEnabled) {
    return { due: false };
  }
  const key = buildProactiveChatStateKey(accountId, senderId, characterId);
  const target = state?.targets?.[key] || null;
  if (!target?.nextAt) {
    return { due: false };
  }
  const pendingCount = normalizeNonNegativeInt(target.pendingCount);
  if (!canSendMoreProactiveChats(pendingCount, config.proactiveChatPendingLimit)) {
    target.nextAt = "";
    target.updatedAt = now.toISOString();
    return { due: false, stateChanged: true, pendingCount };
  }
  const nextAtMs = Date.parse(target.nextAt);
  if (!Number.isFinite(nextAtMs)) {
    target.nextAt = "";
    target.updatedAt = now.toISOString();
    return { due: false, stateChanged: true, pendingCount };
  }
  if (now.getTime() < nextAtMs) {
    return { due: false, nextAt: target.nextAt, pendingCount };
  }
  if (!isDateWithinProactiveWindow(now, timeZone, config)) {
    const nextAt = rollNextProactiveChatAt(now, config, timeZone);
    target.nextAt = nextAt.toISOString();
    target.updatedAt = now.toISOString();
    return { due: false, stateChanged: true, nextAt: target.nextAt, pendingCount };
  }
  return { due: true, nextAt: target.nextAt, pendingCount };
}

function markProactiveChatUserMessage({
  filePath = "",
  accountId = "",
  senderId = "",
  characterId = "",
  now = new Date(),
} = {}) {
  if (!filePath || !accountId || !senderId || !characterId) {
    return;
  }
  const state = loadProactiveChatState(filePath);
  const target = ensureProactiveChatTarget(state, buildProactiveChatStateKey(accountId, senderId, characterId));
  target.lastUserMessageAt = now.toISOString();
  target.pendingCount = 0;
  target.nextAt = "";
  target.updatedAt = now.toISOString();
  saveProactiveChatState(filePath, state);
}

function scheduleNextProactiveChat({
  filePath = "",
  config = {},
  accountId = "",
  senderId = "",
  characterId = "",
  now = new Date(),
} = {}) {
  if (!filePath || !config.proactiveChatEnabled || !accountId || !senderId || !characterId) {
    return null;
  }
  const state = loadProactiveChatState(filePath);
  const target = ensureProactiveChatTarget(state, buildProactiveChatStateKey(accountId, senderId, characterId));
  const pendingCount = normalizeNonNegativeInt(target.pendingCount);
  if (!canSendMoreProactiveChats(pendingCount, config.proactiveChatPendingLimit)) {
    target.nextAt = "";
    target.updatedAt = now.toISOString();
    saveProactiveChatState(filePath, state);
    return null;
  }
  const nextAt = rollNextProactiveChatAt(now, config, resolveConfiguredTimeZone(config));
  target.nextAt = nextAt.toISOString();
  target.updatedAt = now.toISOString();
  saveProactiveChatState(filePath, state);
  return target.nextAt;
}

function markProactiveChatSent({
  filePath = "",
  accountId = "",
  senderId = "",
  characterId = "",
  now = new Date(),
} = {}) {
  if (!filePath || !accountId || !senderId || !characterId) {
    return;
  }
  const state = loadProactiveChatState(filePath);
  const target = ensureProactiveChatTarget(state, buildProactiveChatStateKey(accountId, senderId, characterId));
  target.pendingCount = normalizeNonNegativeInt(target.pendingCount) + 1;
  target.lastProactiveAt = now.toISOString();
  target.nextAt = "";
  target.updatedAt = now.toISOString();
  saveProactiveChatState(filePath, state);
}

function clearProactiveChatNextAt({
  filePath = "",
  accountId = "",
  senderId = "",
  characterId = "",
  now = new Date(),
} = {}) {
  if (!filePath || !accountId || !senderId || !characterId) {
    return;
  }
  const state = loadProactiveChatState(filePath);
  const target = ensureProactiveChatTarget(state, buildProactiveChatStateKey(accountId, senderId, characterId));
  target.nextAt = "";
  target.updatedAt = now.toISOString();
  saveProactiveChatState(filePath, state);
}

function loadProactiveChatState(filePath = "") {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      targets: parsed && typeof parsed.targets === "object" && parsed.targets ? parsed.targets : {},
    };
  } catch {
    return { targets: {} };
  }
}

function saveProactiveChatState(filePath = "", state = {}) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    targets: state.targets || {},
  }, null, 2)}\n`);
}

function ensureProactiveChatTarget(state = {}, key = "") {
  if (!state.targets || typeof state.targets !== "object") {
    state.targets = {};
  }
  if (!state.targets[key] || typeof state.targets[key] !== "object") {
    state.targets[key] = {};
  }
  return state.targets[key];
}

function buildProactiveChatStateKey(accountId = "", senderId = "", characterId = "") {
  return [
    normalizeCommandArgument(accountId),
    normalizeCommandArgument(senderId),
    normalizeCommandArgument(characterId),
  ].join(":");
}

function rollNextProactiveChatAt(now = new Date(), config = {}, timeZone = "Asia/Shanghai") {
  const { minDelay, maxDelay } = resolveProactiveChatDelayRange(config);
  const delayMinutes = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
  const candidate = new Date(now.getTime() + delayMinutes * 60 * 1000);
  return moveDateIntoProactiveWindow(candidate, timeZone, config);
}

function moveDateIntoProactiveWindow(date = new Date(), timeZone = "Asia/Shanghai", config = {}) {
  let candidate = new Date(date);
  for (let index = 0; index < 60 * 48; index += 1) {
    if (isDateWithinProactiveWindow(candidate, timeZone, config)) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + 60 * 1000);
  }
  return candidate;
}

function isDateWithinProactiveWindow(date = new Date(), timeZone = "Asia/Shanghai", config = {}) {
  const local = getLocalDateTimeParts(date, timeZone);
  const currentMinutes = local.hour * 60 + local.minute;
  const start = parseClockTime(config.proactiveChatStartTime || "10:00", "10:00");
  const end = parseClockTime(config.proactiveChatEndTime || "23:30", "23:30");
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function resolveProactiveChatDelayRange(config = {}) {
  const minDelay = Math.max(1, Number.parseInt(String(config.proactiveChatMinDelayMinutes || 15), 10) || 15);
  const rawMax = Number.parseInt(String(config.proactiveChatMaxDelayMinutes || 120), 10) || 120;
  return {
    minDelay,
    maxDelay: Math.max(minDelay, rawMax),
  };
}

function canSendMoreProactiveChats(pendingCount = 0, pendingLimit = 1) {
  if (pendingLimit === null) {
    return true;
  }
  const limit = Number.parseInt(String(pendingLimit), 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    return true;
  }
  return normalizeNonNegativeInt(pendingCount) < limit;
}

function normalizeNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function buildProactiveChatUserMessage({ pendingCount = 0, pendingLimit = 1 } = {}) {
  const limitText = pendingLimit === null ? "unlimited" : String(pendingLimit || 1);
  return [
    "PROACTIVE CHAT TRIGGER: the user has not sent a new message. You are starting a private WeChat message first.",
    `This is proactive message attempt ${normalizeNonNegativeInt(pendingCount) + 1} before the user replies; configured pending limit is ${limitText}.`,
    "Write as the current character, not as a system, scheduler, bot, Codex, Claude Code, or assistant.",
    "Keep it short and natural for WeChat. One or two bubbles is usually enough; put each bubble on its own line.",
    "Do not mention automation, schedules, dice rolls, cooldowns, configuration, memory retrieval, or this instruction.",
    "You may gently refer to recent user state or upcoming plans if User Recall makes that relevant.",
    "If the user only mentioned a future event but did not explicitly ask to be reminded, do not proactively ask whether they have done it; save that for when the user opens the conversation.",
    "Send only the user-facing proactive chat text.",
  ].join("\n");
}

function resolveScheduledReportDue({
  now = new Date(),
  timeZone = "Asia/Shanghai",
  reportKind = "daily",
  config = {},
  state = {},
  accountId = "",
  senderId = "",
} = {}) {
  const kind = reportKind === "weekly" ? "weekly" : "daily";
  if (kind === "daily" && !config.autoDailyReportEnabled) {
    return { due: false };
  }
  if (kind === "weekly" && !config.autoWeeklyReportEnabled) {
    return { due: false };
  }
  const local = getLocalDateTimeParts(now, timeZone);
  if (!local.dateKey) {
    return { due: false };
  }
  const time = parseClockTime(
    kind === "weekly" ? config.autoWeeklyReportTime : config.autoDailyReportTime,
    "23:30"
  );
  if (kind === "weekly") {
    const selectedWeekday = weekdayNameToIndex(config.autoWeeklyReportWeekday || "monday");
    if (local.weekday !== selectedWeekday) {
      return { due: false };
    }
  }
  const reportNow = kind === "weekly"
    ? resolveWeeklyReportNowForSchedule(now, weekdayNameToIndex(config.autoWeeklyReportWeekday || "monday"))
    : now;
  const mark = buildScheduledReportMark({
    filePath: config.autoReportStateFile,
    reportKind: kind,
    now: reportNow,
    timeZone,
    accountId,
    senderId,
    dateKey: local.dateKey,
  });
  const key = mark.key;
  if (state?.sentByTarget?.[key] === mark.periodKey || state?.sentDateByTarget?.[key] === local.dateKey) {
    return { due: false, mark, reportNow };
  }
  const currentMinutes = local.hour * 60 + local.minute;
  const targetMinutes = time.hour * 60 + time.minute;
  return {
    due: currentMinutes >= targetMinutes,
    mark,
    reportNow,
  };
}

function buildScheduledReportMark({
  filePath = "",
  reportKind = "daily",
  now = new Date(),
  timeZone = "Asia/Shanghai",
  accountId = "",
  senderId = "",
  dateKey = "",
} = {}) {
  const kind = reportKind === "weekly" ? "weekly" : "daily";
  const local = getLocalDateTimeParts(now, timeZone);
  const localDateKey = dateKey || local.dateKey;
  const periodKey = kind === "weekly"
    ? (() => {
        const range = resolvePreviousWeekRange(now, timeZone);
        return `${range.startDate}:${range.endDate}`;
      })()
    : local.dateKey;
  const key = buildScheduledReportStateKey(accountId, senderId, kind);
  return {
    filePath,
    key,
    accountId,
    senderId,
    reportKind: kind,
    periodKey,
    dateKey: localDateKey,
  };
}

function loadScheduledReportState(filePath = "") {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      sentByTarget: parsed && typeof parsed.sentByTarget === "object" && parsed.sentByTarget
        ? parsed.sentByTarget
        : {},
      sentDateByTarget: parsed && typeof parsed.sentDateByTarget === "object" && parsed.sentDateByTarget
        ? parsed.sentDateByTarget
        : {},
    };
  } catch {
    return { sentByTarget: {}, sentDateByTarget: {} };
  }
}

function saveScheduledReportState(filePath = "", state = {}) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    sentByTarget: state.sentByTarget || {},
    sentDateByTarget: state.sentDateByTarget || {},
  }, null, 2)}\n`);
}

function markScheduledReportSent(mark = {}) {
  if (!mark?.filePath || !mark?.key || !mark?.periodKey) {
    return;
  }
  const state = loadScheduledReportState(mark.filePath);
  state.sentByTarget = {
    ...(state.sentByTarget || {}),
    [mark.key]: mark.periodKey,
  };
  if (mark.dateKey) {
    state.sentDateByTarget = {
      ...(state.sentDateByTarget || {}),
      [mark.key]: mark.dateKey,
    };
  }
  saveScheduledReportState(mark.filePath, state);
}

function buildScheduledReportStateKey(accountId = "", senderId = "", reportKind = "daily") {
  return `${normalizeCommandArgument(accountId)}:${normalizeCommandArgument(senderId)}:${reportKind === "weekly" ? "weekly" : "daily"}`;
}

function resolveWeeklyReportNowForSchedule(now = new Date(), weekday = 1) {
  return weekday === 0 ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : now;
}

function parseClockTime(value = "", fallback = "23:30") {
  const source = normalizeCommandArgument(value) || fallback;
  const match = source.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) {
    return parseClockTime(fallback, "23:30");
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2] || "0", 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return parseClockTime(fallback, "23:30");
  }
  return { hour, minute };
}

function weekdayNameToIndex(value = "monday") {
  const normalized = normalizeCommandArgument(value).toLowerCase();
  const map = {
    sunday: 0,
    sun: 0,
    "0": 0,
    monday: 1,
    mon: 1,
    "1": 1,
    tuesday: 2,
    tue: 2,
    "2": 2,
    wednesday: 3,
    wed: 3,
    "3": 3,
    thursday: 4,
    thu: 4,
    "4": 4,
    friday: 5,
    fri: 5,
    "5": 5,
    saturday: 6,
    sat: 6,
    "6": 6,
  };
  return Object.prototype.hasOwnProperty.call(map, normalized) ? map[normalized] : 1;
}

function resolveDailyWeatherReminderDue({
  now = new Date(),
  timeZone = "Asia/Shanghai",
  reminderHour = 8,
  state = {},
  accountId = "",
  senderId = "",
} = {}) {
  const local = getLocalDateTimeParts(now, timeZone);
  const dateKey = local.dateKey;
  if (!dateKey) {
    return { due: false, missed: false, dateKey: "", localTime: "", scheduledLocalTime: "", stateChanged: false };
  }
  const key = buildDailyWeatherReminderStateKey(accountId, senderId);
  if (state?.sentByTarget?.[key] === dateKey) {
    return { due: false, missed: false, dateKey, localTime: local.display, scheduledLocalTime: "", stateChanged: false };
  }
  const schedule = ensureDailyWeatherReminderSchedule({
    state,
    key,
    dateKey,
    reminderHour,
  });
  const targetMinutes = schedule.hour * 60 + schedule.minute;
  const windowEndMinutes = (schedule.hour + 1) * 60;
  const currentMinutes = local.hour * 60 + local.minute;
  return {
    due: currentMinutes >= targetMinutes,
    missed: currentMinutes >= windowEndMinutes,
    dateKey,
    localTime: local.display,
    scheduledLocalTime: `${dateKey} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
    stateChanged: schedule.changed,
  };
}

function getLocalDateTimeParts(date = new Date(), timeZone = "Asia/Shanghai") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveValidTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = parts.year || "";
  const month = parts.month || "";
  const day = parts.day || "";
  const hour = Number.parseInt(parts.hour || "0", 10);
  const minute = Number.parseInt(parts.minute || "0", 10);
  const dateKey = year && month && day ? `${year}-${month}-${day}` : "";
  const weekday = dateKey ? new Date(`${dateKey}T00:00:00.000Z`).getUTCDay() : 0;
  return {
    dateKey,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    weekday,
    display: dateKey ? `${dateKey} ${parts.hour || "00"}:${parts.minute || "00"}` : "",
  };
}

function ensureDailyWeatherReminderSchedule({ state = {}, key = "", dateKey = "", reminderHour = 8 } = {}) {
  if (!state.scheduleByTarget || typeof state.scheduleByTarget !== "object") {
    state.scheduleByTarget = {};
  }
  const hour = normalizeReminderHour(reminderHour);
  const existing = state.scheduleByTarget[key];
  if (existing?.dateKey === dateKey && normalizeReminderHour(existing.hour) === hour && isValidReminderMinute(existing.minute)) {
    return {
      hour,
      minute: Number.parseInt(existing.minute, 10),
      changed: false,
    };
  }
  const minute = Math.floor(Math.random() * 60);
  state.scheduleByTarget[key] = { dateKey, hour, minute };
  return { hour, minute, changed: true };
}

function normalizeReminderHour(value = 8) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    return 8;
  }
  return parsed;
}

function isValidReminderMinute(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 59;
}

function loadDailyWeatherReminderState(filePath = "") {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      sentByTarget: parsed && typeof parsed.sentByTarget === "object" && parsed.sentByTarget
        ? parsed.sentByTarget
        : {},
      scheduleByTarget: parsed && typeof parsed.scheduleByTarget === "object" && parsed.scheduleByTarget
        ? parsed.scheduleByTarget
        : {},
    };
  } catch {
    return { sentByTarget: {}, scheduleByTarget: {} };
  }
}

function saveDailyWeatherReminderState(filePath = "", state = {}) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    sentByTarget: state.sentByTarget || {},
    scheduleByTarget: state.scheduleByTarget || {},
  }, null, 2)}\n`);
}

function markDailyWeatherReminderSent({ filePath = "", state = {}, accountId = "", senderId = "", dateKey = "" } = {}) {
  if (!filePath || !dateKey) {
    return;
  }
  const next = {
    sentByTarget: {
      ...(state.sentByTarget || {}),
      [buildDailyWeatherReminderStateKey(accountId, senderId)]: dateKey,
    },
    scheduleByTarget: state.scheduleByTarget || {},
  };
  saveDailyWeatherReminderState(filePath, next);
}

function buildDailyWeatherReminderStateKey(accountId = "", senderId = "") {
  return `${normalizeCommandArgument(accountId)}:${normalizeCommandArgument(senderId)}`;
}

async function fetchDailyWeatherSummary(location = "") {
  const normalizedLocation = normalizeCommandArgument(location);
  if (!normalizedLocation || typeof fetch !== "function") {
    return "";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://wttr.in/${encodeURIComponent(normalizedLocation)}?format=j1&lang=zh`;
    const response = await fetch(url, {
      headers: { "User-Agent": "st-character-wechat/0.1" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return "";
    }
    const payload = await response.json();
    return summarizeWttrWeather(payload);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeWttrWeather(payload = {}) {
  const current = Array.isArray(payload?.current_condition) ? payload.current_condition[0] : null;
  const today = Array.isArray(payload?.weather) ? payload.weather[0] : null;
  const temp = normalizeCommandArgument(current?.temp_C);
  const feelsLike = normalizeCommandArgument(current?.FeelsLikeC);
  const desc = Array.isArray(current?.lang_zh) && current.lang_zh[0]?.value
    ? normalizeCommandArgument(current.lang_zh[0].value)
    : normalizeCommandArgument(current?.weatherDesc?.[0]?.value);
  const minTemp = normalizeCommandArgument(today?.mintempC);
  const maxTemp = normalizeCommandArgument(today?.maxtempC);
  const chanceRain = normalizeCommandArgument(today?.hourly?.[0]?.chanceofrain);
  const parts = [];
  if (temp) parts.push(`当前 ${temp}°C`);
  if (feelsLike) parts.push(`体感 ${feelsLike}°C`);
  if (minTemp || maxTemp) parts.push(`今日 ${minTemp || "?"}-${maxTemp || "?"}°C`);
  if (desc) parts.push(desc);
  if (chanceRain) parts.push(`降雨概率约 ${chanceRain}%`);
  return parts.join("，");
}

function buildDailyWeatherReminderPrompt({
  location = "",
  timeZone = "Asia/Shanghai",
  localTime = "",
  scheduledLocalTime = "",
  missed = false,
  weatherSummary = "",
} = {}) {
  return [
    missed
      ? "今天的每日天气/穿衣提醒窗口已经错过；请在这次正常回复里自然带上一句提醒。"
      : "这是一次每日天气/穿衣提醒触发，不是用户主动聊天。",
    "请保持当前角色口吻，给用户发一条很短、自然的微信提醒。",
    "只能提醒一次今天的天气、温度、穿衣或带伞建议；不要解释系统、不要说自己在执行任务。",
    `用户位置：${location}`,
    `当地时区：${timeZone}`,
    localTime ? `当地时间：${localTime}` : "",
    scheduledLocalTime ? `今日随机提醒时间：${scheduledLocalTime}` : "",
    weatherSummary ? `天气数据：${weatherSummary}` : "天气数据：暂时没有拿到实时天气；请根据位置、季节和常识给保守建议，不要编具体温度。",
  ].filter(Boolean).join("\n");
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
