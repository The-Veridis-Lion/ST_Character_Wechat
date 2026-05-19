const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WEEKDAY_INDEX = {
  "一": 1,
  "二": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "日": 7,
  "天": 7,
};

const SEMANTIC_INDEX_SCHEMA_VERSION = 1;
const SEMANTIC_EMBEDDING_BATCH_SIZE = 32;
const SEMANTIC_RECALL_MODES = {
  EXPLICIT: "explicit_recall",
  PASSIVE: "passive_context",
};

class UserMemoryService {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.baseDir = config.userMemoryDir || path.join(config.stateDir || process.cwd(), "user-memory");
    this.timeZone = config.userMemoryTimeZone || config.reportTimeZone || "Asia/Shanghai";
    this.semanticEnabled = Boolean(config.userMemorySemanticEnabled);
    this.semanticBaseUrl = normalizeText(config.userMemorySemanticBaseUrl);
    this.semanticApiKey = normalizeText(config.userMemorySemanticApiKey);
    this.embeddingModel = normalizeText(config.userMemoryEmbeddingModel);
    this.rerankEnabled = Boolean(config.userMemoryRerankEnabled);
    this.rerankModel = normalizeText(config.userMemoryRerankModel);
    this.semanticIndexFile = config.userMemorySemanticIndexFile || path.join(this.baseDir, "semantic-index.json");
    this.semanticCandidateLimit = normalizePositiveInt(config.userMemorySemanticCandidateLimit) || 30;
    this.semanticTopK = normalizePositiveInt(config.userMemorySemanticTopK) || 8;
    this.semanticPassiveMinScore = normalizeOptionalNumber(config.userMemorySemanticPassiveMinScore, 0.32);
    this.semanticExplicitMinScore = normalizeOptionalNumber(config.userMemorySemanticExplicitMinScore, 0.12);
    this.rerankMinScore = normalizeOptionalNumber(config.userMemoryRerankMinScore, 0.05);
    this.semanticCooldownHours = normalizeOptionalNumber(config.userMemorySemanticCooldownHours, 24);
    this.semanticIndexQueue = Promise.resolve();
  }

  appendTurn({
    accountId = "",
    senderId = "",
    characterId = "",
    characterName = "",
    userText = "",
    assistantText = "",
    receivedAt = "",
    completedAt = "",
  } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    const normalizedCharacterId = normalizeText(characterId);
    const normalizedUserText = normalizeText(userText);
    if (!normalizedSenderId || !normalizedCharacterId || !normalizedUserText) {
      return null;
    }

    const receivedDate = parseDate(receivedAt) || new Date();
    const completedDate = parseDate(completedAt) || new Date();
    const sourceDate = formatDateInTimeZone(receivedDate, this.timeZone);
    const turn = buildTurnMemory({
      accountId,
      senderId: normalizedSenderId,
      characterId: normalizedCharacterId,
      characterName,
      userText: normalizedUserText,
      assistantText,
      receivedAt: receivedDate.toISOString(),
      completedAt: completedDate.toISOString(),
      sourceDate,
      timeZone: this.timeZone,
    });

    const sourceRecord = this.loadDayRecord({
      senderId: normalizedSenderId,
      characterId: normalizedCharacterId,
      date: sourceDate,
      accountId,
      characterName,
    });
    upsertById(sourceRecord.turns, turn);
    for (const signal of turn.stateSignals) {
      upsertById(sourceRecord.stateSignals, signal);
    }
    for (const event of turn.plannedEvents) {
      upsertById(sourceRecord.plannedEvents, { ...event, storedForDate: sourceDate, sourceOnly: event.date !== sourceDate });
    }
    this.saveDayRecord(sourceRecord);

    const targetDates = [...new Set(turn.plannedEvents.map((event) => event.date).filter((date) => date && date !== sourceDate))];
    for (const targetDate of targetDates) {
      const targetRecord = this.loadDayRecord({
        senderId: normalizedSenderId,
        characterId: normalizedCharacterId,
        date: targetDate,
        accountId,
        characterName,
      });
      for (const event of turn.plannedEvents.filter((candidate) => candidate.date === targetDate)) {
        upsertById(targetRecord.plannedEvents, { ...event, storedForDate: targetDate, sourceOnly: false });
      }
      this.saveDayRecord(targetRecord);
    }

    this.queueSemanticIndexUpdate({
      senderId: normalizedSenderId,
      characterId: normalizedCharacterId,
      chunks: buildSemanticChunksFromTurn({
        senderId: normalizedSenderId,
        characterId: normalizedCharacterId,
        turn,
      }),
    });

    return {
      sourceDate,
      turn,
      plannedEventDates: targetDates,
    };
  }

  async buildRecallContextAsync(options = {}) {
    const baseContext = this.buildRecallContext(options);
    const query = normalizeText(options.query);
    if (!query || !this.isSemanticConfigured()) {
      return baseContext;
    }
    try {
      const semanticContext = await this.buildSemanticRecallContext({
        senderId: options.senderId,
        characterId: options.characterId,
        query,
        now: options.now,
      });
      return {
        ...baseContext,
        semanticMatches: semanticContext.matches,
        text: combineRecallText(baseContext.text, semanticContext.text),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      console.error(`[st-character-wechat] semantic user memory recall failed: ${message}`);
      return baseContext;
    }
  }

  buildRecallContext({
    accountId = "",
    senderId = "",
    characterId = "",
    characterName = "",
    now = new Date(),
    recentDays = undefined,
    upcomingDays = undefined,
  } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    const normalizedCharacterId = normalizeText(characterId);
    if (!normalizedSenderId || !normalizedCharacterId) {
      return { text: "", records: [], upcomingEvents: [] };
    }

    const safeNow = parseDate(now) || new Date();
    const recentDayCount = normalizePositiveInt(recentDays) || this.config.userMemoryRecentDays || 7;
    const upcomingDayCount = normalizePositiveInt(upcomingDays) || this.config.userMemoryUpcomingDays || 21;
    const today = formatDateInTimeZone(safeNow, this.timeZone);
    const recentDates = buildDateRange(addDays(today, -(recentDayCount - 1)), today);
    const upcomingDates = buildDateRange(today, addDays(today, upcomingDayCount));
    const allDates = [...new Set([...recentDates, ...upcomingDates])];
    const records = allDates
      .map((date) => this.readDayRecord({ senderId: normalizedSenderId, characterId: normalizedCharacterId, date }))
      .filter(Boolean);
    const recentRecords = records.filter((record) => recentDates.includes(record.date));
    const upcomingEvents = records
      .flatMap((record) => Array.isArray(record.plannedEvents) ? record.plannedEvents : [])
      .filter((event) => event.date && upcomingDates.includes(event.date) && !event.sourceOnly)
      .sort(comparePlannedEvents)
      .slice(0, 12);
    const todayRecord = records.find((record) => record.date === today) || null;

    return {
      accountId: normalizeText(accountId),
      senderId: normalizedSenderId,
      characterId: normalizedCharacterId,
      characterName: normalizeText(characterName),
      today,
      recentDates,
      upcomingDates,
      recentRecords,
      todayRecord,
      upcomingEvents,
      text: formatRecallText({ today, todayRecord, recentRecords, upcomingEvents }),
    };
  }

  buildReportContext({
    senderId = "",
    characterId = "",
    reportKind = "daily",
    now = new Date(),
  } = {}) {
    const safeNow = parseDate(now) || new Date();
    const today = formatDateInTimeZone(safeNow, this.timeZone);
    const dates = reportKind === "weekly"
      ? buildPreviousWeekDates(safeNow, this.timeZone)
      : [today];
    const records = dates
      .map((date) => this.readDayRecord({ senderId, characterId, date }))
      .filter(Boolean);
    return {
      kind: reportKind === "weekly" ? "weekly" : "daily",
      timeZone: this.timeZone,
      date: today,
      dates,
      records: records.map(compactRecordForReport),
    };
  }

  readDayRecord({ senderId = "", characterId = "", date = "" } = {}) {
    const filePath = this.resolveDayFile({ senderId, characterId, date });
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeDayRecord(parsed);
    } catch {
      return null;
    }
  }

  loadDayRecord({ senderId = "", characterId = "", date = "", accountId = "", characterName = "" } = {}) {
    const existing = this.readDayRecord({ senderId, characterId, date });
    if (existing) {
      existing.accountId = existing.accountId || normalizeText(accountId);
      existing.characterName = existing.characterName || normalizeText(characterName);
      return existing;
    }
    return normalizeDayRecord({
      schemaVersion: 1,
      date,
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      characterId: normalizeText(characterId),
      characterName: normalizeText(characterName),
      turns: [],
      stateSignals: [],
      plannedEvents: [],
      updatedAt: new Date().toISOString(),
    });
  }

  saveDayRecord(record) {
    const normalized = normalizeDayRecord(record);
    normalized.updatedAt = new Date().toISOString();
    const filePath = this.resolveDayFile({
      senderId: normalized.senderId,
      characterId: normalized.characterId,
      date: normalized.date,
    });
    if (!filePath) {
      throw new Error("Cannot resolve user memory day file.");
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return filePath;
  }

  resolveDayFile({ senderId = "", characterId = "", date = "" } = {}) {
    const normalizedDate = normalizeDateText(date);
    if (!normalizeText(senderId) || !normalizeText(characterId) || !normalizedDate) {
      return "";
    }
    return path.join(
      this.baseDir,
      "senders",
      stableKey(senderId),
      "characters",
      stableKey(characterId),
      `${normalizedDate}.json`
    );
  }

  isSemanticConfigured() {
    return Boolean(this.semanticEnabled && this.semanticBaseUrl && this.semanticApiKey && this.embeddingModel);
  }

  queueSemanticIndexUpdate({ senderId = "", characterId = "", chunks = [] } = {}) {
    if (!this.isSemanticConfigured() || !chunks.length) {
      return;
    }
    this.semanticIndexQueue = this.semanticIndexQueue
      .catch(() => {})
      .then(() => this.upsertSemanticChunks({ senderId, characterId, chunks }));
    this.semanticIndexQueue.catch((error) => {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      console.error(`[st-character-wechat] semantic user memory index failed: ${message}`);
    });
  }

  async buildSemanticRecallContext({ senderId = "", characterId = "", query = "", now = new Date() } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    const normalizedCharacterId = normalizeText(characterId);
    const normalizedQuery = normalizeText(query);
    if (!normalizedSenderId || !normalizedCharacterId || !normalizedQuery) {
      return { text: "", matches: [] };
    }
    await this.semanticIndexQueue.catch(() => {});
    const index = await this.ensureSemanticIndexForScope({
      senderId: normalizedSenderId,
      characterId: normalizedCharacterId,
    });
    const senderKey = stableKey(normalizedSenderId);
    const characterKey = stableKey(normalizedCharacterId);
    const items = index.items.filter((item) => (
      item.senderKey === senderKey
      && item.characterKey === characterKey
      && Array.isArray(item.embedding)
      && item.embedding.length
      && normalizeText(item.text)
    ));
    if (!items.length) {
      return { text: "", matches: [] };
    }
    const recallMode = resolveSemanticRecallMode(normalizedQuery);
    const minScore = recallMode === SEMANTIC_RECALL_MODES.EXPLICIT
      ? this.semanticExplicitMinScore
      : this.semanticPassiveMinScore;
    const safeNow = parseDate(now) || new Date();
    const [queryEmbedding] = await this.fetchEmbeddings([normalizedQuery]);
    const candidates = items
      .map((item) => ({
        ...item,
        rawScore: cosineSimilarity(queryEmbedding, item.embedding),
      }))
      .filter((item) => Number.isFinite(item.rawScore) && item.rawScore >= minScore)
      .map((item) => ({
        ...item,
        recallMode,
        score: item.rawScore * semanticRecallPenalty(item, { now: safeNow, mode: recallMode, cooldownHours: this.semanticCooldownHours }),
      }))
      .filter((item) => Number.isFinite(item.score) && item.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, this.semanticCandidateLimit);
    if (!candidates.length) {
      return { text: "", matches: [] };
    }
    const matches = await this.maybeRerankSemanticMatches({ query: normalizedQuery, candidates, minScore });
    const finalMatches = matches
      .filter((item) => Number.isFinite(item.score) && item.score >= minScore)
      .slice(0, this.semanticTopK);
    this.recordSemanticRecall(finalMatches, safeNow);
    return {
      matches: finalMatches,
      recallMode,
      text: formatSemanticRecallText(finalMatches),
    };
  }

  async ensureSemanticIndexForScope({ senderId = "", characterId = "" } = {}) {
    const records = this.listDayRecords({ senderId, characterId });
    const chunks = records.flatMap((record) => buildSemanticChunksFromRecord({
      senderId,
      characterId,
      record,
    }));
    return this.upsertSemanticChunks({ senderId, characterId, chunks });
  }

  async upsertSemanticChunks({ chunks = [] } = {}) {
    const cleanChunks = dedupeSemanticChunks(chunks);
    const index = this.readSemanticIndex();
    const existingIds = new Set(index.items.map((item) => item.id));
    const missing = cleanChunks.filter((chunk) => !existingIds.has(chunk.id));
    if (!missing.length) {
      return index;
    }
    for (let indexOffset = 0; indexOffset < missing.length; indexOffset += SEMANTIC_EMBEDDING_BATCH_SIZE) {
      const batch = missing.slice(indexOffset, indexOffset + SEMANTIC_EMBEDDING_BATCH_SIZE);
      const embeddings = await this.fetchEmbeddings(batch.map((chunk) => chunk.text));
      for (let offset = 0; offset < batch.length; offset += 1) {
        const embedding = normalizeEmbedding(embeddings[offset]);
        if (!embedding.length) {
          continue;
        }
        index.items.push({
          ...batch[offset],
          embedding,
        });
      }
    }
    index.updatedAt = new Date().toISOString();
    this.saveSemanticIndex(index);
    return index;
  }

  readSemanticIndex() {
    const empty = {
      schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      embeddingModel: this.embeddingModel,
      updatedAt: "",
      items: [],
    };
    if (!this.semanticIndexFile || !fs.existsSync(this.semanticIndexFile)) {
      return empty;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.semanticIndexFile, "utf8"));
      if (
        Number(parsed?.schemaVersion) !== SEMANTIC_INDEX_SCHEMA_VERSION
        || normalizeText(parsed?.embeddingModel) !== this.embeddingModel
      ) {
        return empty;
      }
      return {
        ...empty,
        updatedAt: normalizeText(parsed.updatedAt),
        items: Array.isArray(parsed.items) ? parsed.items.filter(isValidSemanticIndexItem) : [],
      };
    } catch {
      return empty;
    }
  }

  saveSemanticIndex(index) {
    if (!this.semanticIndexFile) {
      return "";
    }
    fs.mkdirSync(path.dirname(this.semanticIndexFile), { recursive: true });
    fs.writeFileSync(this.semanticIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return this.semanticIndexFile;
  }

  listDayRecords({ senderId = "", characterId = "" } = {}) {
    const senderKey = stableKey(senderId);
    const characterKey = stableKey(characterId);
    const dir = path.join(this.baseDir, "senders", senderKey, "characters", characterKey);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir)
      .filter((fileName) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(fileName))
      .sort((left, right) => left.localeCompare(right))
      .map((fileName) => {
        try {
          return normalizeDayRecord(JSON.parse(fs.readFileSync(path.join(dir, fileName), "utf8")));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async fetchEmbeddings(texts) {
    const input = texts.map((text) => normalizeText(text)).filter(Boolean);
    if (!input.length) {
      return [];
    }
    const response = await fetch(buildSemanticApiUrl(this.semanticBaseUrl, "embeddings"), {
      method: "POST",
      headers: buildJsonAuthHeaders(this.semanticApiKey),
      body: JSON.stringify({
        model: this.embeddingModel,
        input,
      }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`embedding API ${response.status} ${response.statusText}: ${responseText.slice(0, 200)}`);
    }
    const payload = JSON.parse(responseText);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.map((item) => normalizeEmbedding(item?.embedding));
  }

  async maybeRerankSemanticMatches({ query = "", candidates = [], minScore = 0 } = {}) {
    const topK = this.semanticTopK;
    const vectorMatches = candidates.slice(0, topK);
    if (!this.rerankEnabled || !this.rerankModel || !candidates.length || candidates.length <= topK) {
      return vectorMatches;
    }
    try {
      const response = await fetch(buildSemanticApiUrl(this.semanticBaseUrl, "rerank"), {
        method: "POST",
        headers: buildJsonAuthHeaders(this.semanticApiKey),
        body: JSON.stringify({
          model: this.rerankModel,
          query: normalizeText(query),
          documents: candidates.map((candidate) => candidate.text),
          top_n: topK,
        }),
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`rerank API ${response.status} ${response.statusText}: ${responseText.slice(0, 200)}`);
      }
      const reranked = extractRerankMatches(JSON.parse(responseText), candidates);
      const filtered = reranked.filter((item) => {
        if (item.hasRerankScore && Number.isFinite(item.rerankScore)) {
          return item.rerankScore >= this.rerankMinScore;
        }
        return Number.isFinite(item.score) && item.score >= minScore;
      });
      if (reranked.length) {
        return filtered.slice(0, topK);
      }
      return vectorMatches;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      console.error(`[st-character-wechat] semantic user memory rerank failed, falling back to embedding scores: ${message}`);
      return vectorMatches;
    }
  }

  recordSemanticRecall(matches, now = new Date()) {
    const recalledIds = new Set((Array.isArray(matches) ? matches : [])
      .map((item) => normalizeText(item?.id))
      .filter(Boolean));
    if (!recalledIds.size) {
      return;
    }
    const index = this.readSemanticIndex();
    let changed = false;
    for (const item of index.items) {
      if (!recalledIds.has(item.id)) {
        continue;
      }
      item.lastRecalledAt = now.toISOString();
      item.recallCount = Math.max(0, Number.parseInt(String(item.recallCount || "0"), 10) || 0) + 1;
      changed = true;
    }
    if (changed) {
      index.updatedAt = new Date().toISOString();
      this.saveSemanticIndex(index);
    }
  }
}

function buildSemanticChunksFromRecord({ senderId = "", characterId = "", record = null } = {}) {
  const normalized = normalizeDayRecord(record);
  const chunks = [];
  for (const turn of normalized.turns) {
    chunks.push(...buildSemanticChunksFromTurn({
      senderId,
      characterId,
      turn: { ...turn, sourceDate: turn.sourceDate || normalized.date },
    }));
  }
  for (const signal of normalized.stateSignals) {
    const text = normalizeText(signal.text);
    if (!text) {
      continue;
    }
    chunks.push(buildSemanticChunk({
      senderId,
      characterId,
      id: `signal:${signal.id || stableKey([normalized.date, signal.kind, text].join("|"))}`,
      date: signal.date || normalized.date,
      kind: "state",
      text: `${signal.date || normalized.date} ${signal.kind || "state"}: ${text}`,
    }));
  }
  for (const event of normalized.plannedEvents) {
    if (event.sourceOnly) {
      continue;
    }
    const label = normalizeText(event.label || event.text);
    if (!label || !event.date) {
      continue;
    }
    chunks.push(buildSemanticChunk({
      senderId,
      characterId,
      id: `event:${event.id || stableKey([event.date, event.time, label].join("|"))}:${event.storedForDate || event.date}`,
      date: event.date,
      kind: "plan",
      text: `${event.date}${event.time ? ` ${event.time}` : ""} planned item: ${label}`,
    }));
  }
  return chunks.filter(Boolean);
}

function buildSemanticChunksFromTurn({ senderId = "", characterId = "", turn = null } = {}) {
  if (!turn || typeof turn !== "object") {
    return [];
  }
  const chunks = [];
  const date = normalizeDateText(turn.sourceDate) || normalizeText(turn.receivedAt).slice(0, 10);
  const userText = truncateText(turn.userText, 700);
  const assistantText = truncateText(turn.assistantText, 700);
  const turnText = [userText ? `User: ${userText}` : "", assistantText ? `Character: ${assistantText}` : ""]
    .filter(Boolean)
    .join("\n");
  if (turnText) {
    chunks.push(buildSemanticChunk({
      senderId,
      characterId,
      id: `turn:${turn.id || stableKey([date, turnText].join("|"))}`,
      date,
      kind: "turn",
      text: `${date} chat memory:\n${turnText}`,
    }));
  }
  for (const signal of Array.isArray(turn.stateSignals) ? turn.stateSignals : []) {
    const text = normalizeText(signal.text);
    if (!text) {
      continue;
    }
    chunks.push(buildSemanticChunk({
      senderId,
      characterId,
      id: `signal:${signal.id || stableKey([date, signal.kind, text].join("|"))}`,
      date: signal.date || date,
      kind: "state",
      text: `${signal.date || date} ${signal.kind || "state"}: ${text}`,
    }));
  }
  for (const event of Array.isArray(turn.plannedEvents) ? turn.plannedEvents : []) {
    const label = normalizeText(event.label || event.text);
    if (!label || !event.date) {
      continue;
    }
    chunks.push(buildSemanticChunk({
      senderId,
      characterId,
      id: `event:${event.id || stableKey([event.date, event.time, label].join("|"))}:${event.date}`,
      date: event.date,
      kind: "plan",
      text: `${event.date}${event.time ? ` ${event.time}` : ""} planned item: ${label}`,
    }));
  }
  return chunks.filter(Boolean);
}

function buildSemanticChunk({ senderId = "", characterId = "", id = "", date = "", kind = "", text = "" } = {}) {
  const normalizedText = truncateText(text, 1200);
  const normalizedId = normalizeText(id);
  if (!normalizedId || !normalizedText) {
    return null;
  }
  return {
    id: stableKey([stableKey(senderId), stableKey(characterId), normalizedId].join("|")),
    sourceId: normalizedId,
    senderKey: stableKey(senderId),
    characterKey: stableKey(characterId),
    date: normalizeDateText(date),
    kind: normalizeText(kind) || "memory",
    text: normalizedText,
  };
}

function dedupeSemanticChunks(chunks) {
  const seen = new Set();
  const output = [];
  for (const chunk of chunks) {
    if (!chunk?.id || !normalizeText(chunk.text) || seen.has(chunk.id)) {
      continue;
    }
    seen.add(chunk.id);
    output.push(chunk);
  }
  return output;
}

function resolveSemanticRecallMode(query) {
  const text = normalizeText(query);
  return /之前|以前|上次|曾经|曾經|过去|過去|历史|歷史|回忆|回憶|记忆|記憶|还记得|還記得|记得我|記得我|我说过|我說過|提过|提過|聊过|聊過|是不是说过|是不是說過|有没有说过|有沒有說過|remember|before|last time|previous/iu.test(text)
    ? SEMANTIC_RECALL_MODES.EXPLICIT
    : SEMANTIC_RECALL_MODES.PASSIVE;
}

function semanticRecallPenalty(item, { now = new Date(), mode = SEMANTIC_RECALL_MODES.PASSIVE, cooldownHours = 24 } = {}) {
  if (mode === SEMANTIC_RECALL_MODES.EXPLICIT) {
    return 1;
  }
  const count = Math.max(0, Number.parseInt(String(item?.recallCount || "0"), 10) || 0);
  let penalty = 1 / (1 + Math.min(count, 8) * 0.08);
  const lastRecalledAt = parseDate(item?.lastRecalledAt);
  const cooldownMs = Math.max(0, Number(cooldownHours) || 0) * 60 * 60 * 1000;
  if (lastRecalledAt && cooldownMs > 0) {
    const ageMs = (parseDate(now) || new Date()).getTime() - lastRecalledAt.getTime();
    if (ageMs >= 0 && ageMs < cooldownMs) {
      penalty *= 0.55 + (ageMs / cooldownMs) * 0.35;
    }
  }
  return Math.max(0.05, Math.min(1, penalty));
}

function isValidSemanticIndexItem(item) {
  return Boolean(
    item
    && typeof item === "object"
    && normalizeText(item.id)
    && normalizeText(item.senderKey)
    && normalizeText(item.characterKey)
    && normalizeText(item.text)
    && Array.isArray(item.embedding)
    && item.embedding.length
  );
}

function buildJsonAuthHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildSemanticApiUrl(baseUrl, endpoint) {
  const cleanEndpoint = normalizeText(endpoint).replace(/^\/+/u, "");
  let normalized = normalizeText(baseUrl).replace(/\/+$/u, "");
  normalized = normalized.replace(/\/chat\/completions$/iu, "");
  normalized = normalized.replace(/\/(?:embeddings|rerank)$/iu, "");
  normalized = normalized.replace(/\/models$/iu, "");
  if (new RegExp(`/${cleanEndpoint}$`, "iu").test(normalized)) {
    return normalized;
  }
  return `${normalized}/${cleanEndpoint}`;
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function cosineSimilarity(left, right) {
  const a = normalizeEmbedding(left);
  const b = normalizeEmbedding(right);
  const length = Math.min(a.length, b.length);
  if (!length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    leftNorm += a[index] * a[index];
    rightNorm += b[index] * b[index];
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function extractRerankMatches(payload, candidates) {
  const source = Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload) ? payload
        : [];
  return source
    .map((item, fallbackIndex) => {
      const index = Number.isInteger(item?.index) ? item.index
        : Number.isInteger(item?.document?.index) ? item.document.index
          : fallbackIndex;
      const candidate = candidates[index];
      if (!candidate) {
        return null;
      }
      const rerankScore = Number(item?.relevance_score ?? item?.score ?? item?.rerank_score);
      return {
        ...candidate,
        hasRerankScore: Number.isFinite(rerankScore),
        rerankScore: Number.isFinite(rerankScore) ? rerankScore : candidate.score,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.rerankScore ?? right.score) - (left.rerankScore ?? left.score));
}

function formatSemanticRecallText(matches) {
  const cleanMatches = (Array.isArray(matches) ? matches : [])
    .filter((item) => normalizeText(item?.text))
    .slice(0, 8);
  if (!cleanMatches.length) {
    return "";
  }
  const lines = ["Local User Memory - Longer-term memory, retrieved only when semantically relevant:"];
  for (const item of cleanMatches) {
    const label = [item.date, item.kind].filter(Boolean).join(" ");
    lines.push(`- ${label ? `${label}: ` : ""}${truncateText(item.text, 260)}`);
  }
  lines.push("These entries were selected from the local memory index and may include older events or plans outside the normal upcoming window. Use them only when relevant to the user's current message.");
  return lines.join("\n");
}

function combineRecallText(primary, secondary) {
  const parts = [normalizeText(primary), normalizeText(secondary)].filter(Boolean);
  return parts.join("\n\n");
}

function buildTurnMemory({
  accountId = "",
  senderId = "",
  characterId = "",
  characterName = "",
  userText = "",
  assistantText = "",
  receivedAt = "",
  completedAt = "",
  sourceDate = "",
  timeZone = "Asia/Shanghai",
} = {}) {
  const normalizedUserText = normalizeText(userText);
  const id = stableKey([senderId, characterId, receivedAt, normalizedUserText].join("|"));
  const stateSignals = extractStateSignals({
    text: normalizedUserText,
    sourceDate,
    receivedAt,
  });
  const plannedEvents = extractPlannedEvents({
    text: normalizedUserText,
    receivedAt,
    sourceDate,
    timeZone,
    senderId,
    characterId,
  });
  return {
    id,
    accountId: normalizeText(accountId),
    senderId: normalizeText(senderId),
    characterId: normalizeText(characterId),
    characterName: normalizeText(characterName),
    sourceDate,
    receivedAt: normalizeText(receivedAt),
    completedAt: normalizeText(completedAt),
    userText: normalizedUserText,
    assistantText: normalizeText(assistantText).slice(0, 1600),
    stateSignals,
    plannedEvents,
  };
}

function extractStateSignals({ text = "", sourceDate = "", receivedAt = "" } = {}) {
  const sentences = splitSentences(text);
  const signals = [];
  const rules = [
    { kind: "mood", re: /开心|高兴|难过|低落|沮丧|烦躁|平静|期待|紧张|焦虑|崩溃|委屈|生气|舒服|安心/u },
    { kind: "stress", re: /压力|压迫|来不及|赶|deadline|ddl|焦虑|紧张|忙|爆炸|崩|撑不住/u },
    { kind: "sleep", re: /睡|失眠|熬夜|早起|晚睡|困|梦|午睡|睡眠/u },
    { kind: "progress", re: /完成|搞定|推进|进度|卡住|拖延|计划|安排|要做|待办|todo|开始|收尾/u },
    { kind: "energy", re: /累|疲惫|精神|有劲|没劲|能量|状态|恢复|透支/u },
  ];

  for (const sentence of sentences) {
    for (const rule of rules) {
      if (!rule.re.test(sentence)) {
        continue;
      }
      const id = stableKey([sourceDate, receivedAt, rule.kind, sentence].join("|"));
      signals.push({
        id,
        kind: rule.kind,
        date: sourceDate,
        text: sentence,
        sourceReceivedAt: normalizeText(receivedAt),
      });
    }
  }
  return signals.slice(0, 24);
}

function extractPlannedEvents({
  text = "",
  receivedAt = "",
  sourceDate = "",
  timeZone = "Asia/Shanghai",
  senderId = "",
  characterId = "",
} = {}) {
  const events = [];
  for (const sentence of splitSentences(text)) {
    const dateMention = findDateMention(sentence, sourceDate, timeZone);
    if (!dateMention) {
      continue;
    }
    if (!isLikelyPlannedEvent(sentence)) {
      continue;
    }
    const time = extractTimeMention(sentence);
    const label = buildEventLabel(sentence, dateMention.raw, time.raw);
    const id = stableKey([senderId, characterId, dateMention.date, time.value, sentence].join("|"));
    events.push({
      id,
      date: dateMention.date,
      time: time.value,
      label,
      text: sentence,
      sourceDate,
      sourceReceivedAt: normalizeText(receivedAt),
      dateMention: dateMention.raw,
      timeMention: time.raw,
      status: "planned",
    });
  }
  return events.slice(0, 12);
}

function findDateMention(sentence, sourceDate, timeZone) {
  const text = normalizeText(sentence);
  const absolute = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
  if (absolute) {
    return {
      raw: absolute[0],
      date: normalizeDateParts(Number(absolute[1]), Number(absolute[2]), Number(absolute[3])),
    };
  }

  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u);
  if (monthDay) {
    const base = parseDate(`${sourceDate}T00:00:00.000Z`) || new Date();
    let year = base.getUTCFullYear();
    let date = normalizeDateParts(year, Number(monthDay[1]), Number(monthDay[2]));
    if (date && date < sourceDate) {
      year += 1;
      date = normalizeDateParts(year, Number(monthDay[1]), Number(monthDay[2]));
    }
    return { raw: monthDay[0], date };
  }

  const relativeRules = [
    { re: /大后天/u, offset: 3 },
    { re: /后天/u, offset: 2 },
    { re: /明天/u, offset: 1 },
    { re: /今天/u, offset: 0 },
  ];
  for (const rule of relativeRules) {
    const match = text.match(rule.re);
    if (match) {
      return { raw: match[0], date: addDays(sourceDate, rule.offset) };
    }
  }

  const week = text.match(/((?:下|上|本|这|這)?周)([一二三四五六日天])/u);
  if (week) {
    const prefix = week[1];
    const weekday = WEEKDAY_INDEX[week[2]];
    const baseDate = sourceDate || formatDateInTimeZone(new Date(), timeZone);
    const base = parseDate(`${baseDate}T00:00:00.000Z`) || new Date();
    const currentDay = base.getUTCDay() || 7;
    const monday = new Date(base);
    monday.setUTCDate(base.getUTCDate() - currentDay + 1);
    const offsetWeeks = prefix.startsWith("下") ? 1 : (prefix.startsWith("上") ? -1 : 0);
    monday.setUTCDate(monday.getUTCDate() + offsetWeeks * 7 + weekday - 1);
    return { raw: week[0], date: monday.toISOString().slice(0, 10) };
  }

  return null;
}

function extractTimeMention(sentence) {
  const text = normalizeText(sentence);
  const match = text.match(/(凌晨|早上|上午|中午|下午|晚上|夜里|今晚|明早)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?)?\s*(半|分)?/u);
  if (!match) {
    return { raw: "", value: "" };
  }
  let hour = Number(match[2]);
  let minute = Number(match[3] || 0);
  if (match[4] === "半" && !match[3]) {
    minute = 30;
  }
  const period = match[1] || "";
  if ((/下午|晚上|夜里|今晚/u.test(period)) && hour < 12) {
    hour += 12;
  }
  if ((/中午/u.test(period)) && hour < 11) {
    hour += 12;
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return { raw: match[0], value: "" };
  }
  return {
    raw: match[0].trim(),
    value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function isLikelyPlannedEvent(sentence) {
  return /要|需要|得|该|准备|计划|安排|预约|开会|会议|面试|考试|复诊|体检|上课|交|提交|提醒|记得|deadline|ddl|todo/u.test(sentence);
}

function buildEventLabel(sentence, dateRaw = "", timeRaw = "") {
  let label = normalizeText(sentence)
    .replace(dateRaw, "")
    .replace(timeRaw, "")
    .replace(/^(我|俺|咱|我们)?\s*(要|需要|得|该|准备|计划|安排|预约|记得|提醒我)?\s*/u, "")
    .trim();
  label = label || normalizeText(sentence);
  return label.slice(0, 120);
}

function formatRecallText({ today, todayRecord, recentRecords, upcomingEvents }) {
  const lines = [];
  const todaySignals = Array.isArray(todayRecord?.stateSignals) ? todayRecord.stateSignals.slice(-6) : [];
  const recentSignals = recentRecords
    .flatMap((record) => Array.isArray(record.stateSignals) ? record.stateSignals.map((signal) => ({ ...signal, date: record.date })) : [])
    .slice(-12);

  if (upcomingEvents.length) {
    lines.push("Local User Memory - Upcoming plans:");
    for (const event of upcomingEvents.slice(0, 8)) {
      lines.push(`- ${event.date}${event.time ? ` ${event.time}` : ""}: ${event.label || event.text}`);
    }
  }
  if (todaySignals.length) {
    lines.push(`Local User Memory - Recent status signals, today (${today}):`);
    for (const signal of todaySignals) {
      lines.push(`- ${signal.kind}: ${signal.text}`);
    }
  }
  if (recentSignals.length) {
    lines.push("Local User Memory - Recent status signals:");
    for (const signal of recentSignals.slice(-8)) {
      lines.push(`- ${signal.date} ${signal.kind}: ${signal.text}`);
    }
  }
  if (!lines.length) {
    return "";
  }
  lines.push("Use this only as quiet continuity memory. Do not mention it unless relevant to the user's message.");
  return lines.join("\n");
}

function compactRecordForReport(record) {
  return {
    date: record.date,
    turns: (Array.isArray(record.turns) ? record.turns : []).map((turn) => ({
      receivedAt: turn.receivedAt,
      userText: turn.userText,
      assistantText: turn.assistantText,
    })).slice(-20),
    stateSignals: (Array.isArray(record.stateSignals) ? record.stateSignals : []).slice(-30),
    plannedEvents: (Array.isArray(record.plannedEvents) ? record.plannedEvents : []).filter((event) => !event.sourceOnly).slice(-20),
  };
}

function normalizeDayRecord(value) {
  const record = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: Number(record.schemaVersion) || 1,
    date: normalizeDateText(record.date),
    accountId: normalizeText(record.accountId),
    senderId: normalizeText(record.senderId),
    characterId: normalizeText(record.characterId),
    characterName: normalizeText(record.characterName),
    turns: Array.isArray(record.turns) ? record.turns.filter((item) => item && typeof item === "object") : [],
    stateSignals: Array.isArray(record.stateSignals) ? record.stateSignals.filter((item) => item && typeof item === "object") : [],
    plannedEvents: Array.isArray(record.plannedEvents) ? record.plannedEvents.filter((item) => item && typeof item === "object") : [],
    updatedAt: normalizeText(record.updatedAt),
  };
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/[\n。！？!?；;，,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function comparePlannedEvents(left, right) {
  const leftKey = `${left.date || ""} ${left.time || ""}`;
  const rightKey = `${right.date || ""} ${right.time || ""}`;
  return leftKey.localeCompare(rightKey);
}

function upsertById(items, item) {
  if (!Array.isArray(items) || !item?.id) {
    return;
  }
  const index = items.findIndex((candidate) => candidate?.id === item.id);
  if (index >= 0) {
    items[index] = { ...items[index], ...item };
    return;
  }
  items.push(item);
}

function buildPreviousWeekDates(now, timeZone) {
  const today = formatDateInTimeZone(now, timeZone);
  const base = parseDate(`${today}T00:00:00.000Z`) || new Date();
  const currentDay = base.getUTCDay() || 7;
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() - currentDay + 1 - 7);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function buildDateRange(startDate, endDate) {
  const start = parseDate(`${normalizeDateText(startDate)}T00:00:00.000Z`);
  const end = parseDate(`${normalizeDateText(endDate)}T00:00:00.000Z`);
  if (!start || !end || start > end) {
    return [];
  }
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function addDays(dateText, days) {
  const base = parseDate(`${normalizeDateText(dateText)}T00:00:00.000Z`);
  if (!base) {
    return "";
  }
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString().slice(0, 10);
}

function formatDateInTimeZone(date, timeZone = "Asia/Shanghai") {
  const safeDate = parseDate(date) || new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safeDate);
}

function normalizeDateParts(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return "";
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDateText(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : "";
}

function normalizePositiveInt(value) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeOptionalNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stableKey(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncateText(value, maxLength) {
  const text = normalizeText(value).replace(/\s+/gu, " ");
  const limit = normalizePositiveInt(maxLength) || 400;
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

module.exports = {
  UserMemoryService,
  buildSemanticApiUrl,
  buildPreviousWeekDates,
  buildTurnMemory,
  cosineSimilarity,
  extractPlannedEvents,
  extractStateSignals,
  formatDateInTimeZone,
};
