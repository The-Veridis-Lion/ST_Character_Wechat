const path = require("path");

const { CardRenderService } = require("./card-render-service");
const {
  formatDateInTimeZone,
  formatDateTimeInTimeZone,
  normalizeMetricItems,
  normalizeString,
  normalizeStringArray,
  normalizeTrendPoints,
  parseReportJson,
  sanitizeReportPayload,
} = require("./report-card-data");

class DailyDiaryCardService {
  constructor({ config = {}, renderer = null } = {}) {
    this.config = config;
    this.renderer = renderer || new CardRenderService({ config });
  }

  buildRuntimePrompt({ now = new Date(), userName = "", timeZone = "", memoryContext = null } = {}) {
    const resolvedTimeZone = resolveReportTimeZone(this.config, timeZone);
    const date = formatDateInTimeZone(now, resolvedTimeZone);
    const generatedAt = formatDateTimeInTimeZone(now, resolvedTimeZone);
    const displayName = normalizeString(userName || this.config.userName || "User", "User");
    return [
      "你是本地微信聊天项目的每日小结 JSON 结构化器。",
      "根据当前线程中可见的历史对话，只总结用户自己的状态、事项、情绪、压力、睡眠、进度和收获。",
      "如果下面提供了 USER MEMORY RECORDS，只使用这些本地记录作为报告依据；忽略线程里不属于这些记录的旧聊天。",
      "不要总结角色状态、角色心理、角色关系进度、角色数值、变量、状态栏或 MVU。不要执行任何变量或世界书机制。",
      "心情字段请单独输出 moodLabel、moodEmoji、moodDetail。moodEmoji 只输出一个最贴切的 emoji；建议从 😌 平稳、😊 开心、🎯 专注、😮‍💨 疲惫、😟 焦虑、😔 低落、💗 满足、✨ 期待 中选择。",
      "chatExcerpts 输出 1-4 条用户自己的原话或轻微清理后的聊天摘录；stateOverview 优先包含心情、压力、睡眠、进度、收获。",
      "只输出一个 JSON object，不要输出 Markdown，不要输出代码块，不要解释。",
      `用户名：${displayName}`,
      `日期：${date}`,
      `生成时间：${generatedAt}`,
      memoryContext ? `USER MEMORY RECORDS:\n${JSON.stringify(memoryContext, null, 2)}` : "",
      "JSON schema:",
      JSON.stringify({
        date,
        title: "每日小结",
        summary: "用 2-4 句概括用户今天的状态。",
        moodLabel: "平稳",
        moodEmoji: "😌",
        moodDetail: "用 1 句说明今天的情绪基调。",
        stateOverview: [
          { label: "心情", value: "平稳", detail: "依据用户表达归纳", tone: "mood" },
          { label: "压力", value: "中等", detail: "只写用户压力", tone: "stress" },
          { label: "睡眠", value: "未提及", detail: "只写用户睡眠", tone: "sleep" },
          { label: "进度", value: "有推进", detail: "只写用户事项进度", tone: "progress" },
          { label: "收获", value: "一点确认", detail: "只写用户收获", tone: "gain" },
        ],
        topics: ["主要话题"],
        keyFacts: ["关键信息摘要"],
        chatExcerpts: ["用户自己的聊天摘录，必要时可轻微清理口语"],
        supplemental: ["补充信息"],
        energyTrend: [
          { label: "早间", value: 0, detail: "0-100，无法判断则 0" },
          { label: "午后", value: 0, detail: "0-100，无法判断则 0" },
          { label: "晚间", value: 0, detail: "0-100，无法判断则 0" },
        ],
        timeDistribution: [
          { label: "上午", value: 0, detail: "该时段用户状态" },
          { label: "下午", value: 0, detail: "该时段用户状态" },
          { label: "夜间", value: 0, detail: "该时段用户状态" },
        ],
        tags: ["用户状态标签"],
      }, null, 2),
    ].join("\n");
  }

  async renderFromRuntimeText({ text = "", outputFile = "", now = new Date(), context = {} } = {}) {
    const parsed = parseReportJson(text);
    const data = buildDailyDiaryCardData(parsed, {
      ...context,
      now,
      config: this.config,
    });
    const rendered = await this.renderer.renderPng({
      templateName: "daily-diary.html",
      data,
      outputFile: outputFile || buildReportOutputFile({
        outputDir: this.config.reportCardOutputDir,
        stateDir: this.config.stateDir,
        kind: "daily-diary",
        dateText: data.date,
      }),
      width: this.config.reportCardWidth,
      deviceScaleFactor: this.config.reportCardDeviceScaleFactor,
    });
    return { ...rendered, data };
  }
}

function buildDailyDiaryCardData(rawPayload = {}, { now = new Date(), config = {}, timeZone = "", userName = "" } = {}) {
  const payload = sanitizeReportPayload(rawPayload);
  const resolvedTimeZone = resolveReportTimeZone(config, timeZone);
  const date = normalizeString(payload.date) || formatDateInTimeZone(now, resolvedTimeZone);
  const generatedAt = normalizeString(payload.generatedAt) || formatDateTimeInTimeZone(now, resolvedTimeZone);
  const title = normalizeString(payload.title, "每日小结");
  const summary = normalizeString(
    payload.summary || payload.diarySummary || payload.todaySummary,
    "今天的可总结信息还不多，先保留为一张轻量记录。"
  );
  const overviewSource = payload.stateOverview || payload.statusOverview || payload.overview || payload.metrics;
  const rawMoodItem = findMoodOverviewItem(overviewSource);
  const stateOverview = normalizeMetricItems(
    overviewSource,
    [
      { label: "心情", value: "未记录", detail: "今天还没有足够表达可归纳。", tone: "mood" },
      { label: "压力", value: "未记录", detail: "暂时没有明确压力线索。", tone: "stress" },
      { label: "睡眠", value: "未记录", detail: "暂时没有睡眠相关信息。", tone: "sleep" },
      { label: "进度", value: "未记录", detail: "暂时没有事项推进信息。", tone: "progress" },
      { label: "收获", value: "未记录", detail: "暂时没有明确收获。", tone: "gain" },
    ]
  ).slice(0, 6);
  const normalizedMoodItem = stateOverview.find((item) => item.tone === "mood") || {};
  const moodLabel = normalizeString(
    payload.moodLabel || payload.mood || payload.emotion || rawMoodItem?.value || rawMoodItem?.status || rawMoodItem?.level || normalizedMoodItem.value,
    normalizedMoodItem.value || "未记录"
  );
  const moodDetail = normalizeString(
    payload.moodDetail || payload.moodSummary || rawMoodItem?.detail || rawMoodItem?.note || rawMoodItem?.summary || normalizedMoodItem.detail,
    normalizedMoodItem.detail || "依据用户表达归纳。"
  );
  const moodEmoji = normalizeString(payload.moodEmoji || payload.emoji || payload.moodIcon || rawMoodItem?.emoji || rawMoodItem?.icon);
  const topics = normalizeStringArray(payload.topics || payload.mainTopics, ["暂无主要话题"]);
  const keyFacts = normalizeStringArray(payload.keyFacts || payload.keyInfo || payload.facts, ["暂无关键信息"]);
  const chatExcerpts = normalizeStringArray(
    payload.chatExcerpts || payload.representativeQuotes || payload.quotes || payload.sentences,
    ["暂无可摘录语句"]
  ).slice(0, 5);
  const supplemental = normalizeStringArray(payload.supplemental || payload.extra || payload.notes, ["暂无补充信息"]);
  const energyTrend = normalizeTrendPoints(payload.energyTrend || payload.energy || payload.trend, []);
  const timeDistribution = normalizeTrendPoints(payload.timeDistribution || payload.distribution || payload.periods, []);
  const tags = normalizeStringArray(payload.tags || payload.stateTags, ["用户状态"]);

  return sanitizeReportPayload({
    kind: "daily-diary",
    title,
    date,
    generatedAt,
    userName: normalizeString(userName || config.userName || "User", "User"),
    summary,
    moodLabel,
    moodEmoji,
    moodDetail,
    stateOverview,
    topics,
    keyFacts,
    chatExcerpts,
    representativeQuotes: chatExcerpts,
    supplemental,
    energyTrend,
    timeDistribution,
    tags,
  });
}

function findMoodOverviewItem(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const marker = normalizeString(item.tone || item.kind || item.type || item.label || item.name || item.metric || item.title);
    return /mood|心情|情绪|情緒/u.test(marker);
  }) || null;
}

function buildReportOutputFile({ outputDir = "", stateDir = "", kind = "report", dateText = "" } = {}) {
  const baseDir = outputDir || path.join(stateDir || process.cwd(), "report-cards");
  const safeDate = normalizeString(dateText).replace(/[^0-9a-z-]/giu, "-") || "undated";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(baseDir, `${kind}-${safeDate}-${stamp}.png`);
}

function resolveReportTimeZone(config = {}, timeZone = "") {
  return normalizeString(timeZone || config.reportTimeZone, "Asia/Shanghai");
}

module.exports = {
  DailyDiaryCardService,
  buildDailyDiaryCardData,
  buildReportOutputFile,
  resolveReportTimeZone,
};
