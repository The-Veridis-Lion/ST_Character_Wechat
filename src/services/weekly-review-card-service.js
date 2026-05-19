const { CardRenderService } = require("./card-render-service");
const { buildReportOutputFile, resolveReportTimeZone } = require("./daily-diary-card-service");
const {
  clampPercentage,
  formatDateInTimeZone,
  formatDateTimeInTimeZone,
  normalizeMetricItems,
  normalizeString,
  normalizeStringArray,
  normalizeTrendPoints,
  parseReportJson,
  sanitizeReportPayload,
} = require("./report-card-data");

class WeeklyReviewCardService {
  constructor({ config = {}, renderer = null } = {}) {
    this.config = config;
    this.renderer = renderer || new CardRenderService({ config });
  }

  buildRuntimePrompt({ now = new Date(), userName = "", timeZone = "", memoryContext = null } = {}) {
    const resolvedTimeZone = resolveReportTimeZone(this.config, timeZone);
    const { startDate, endDate } = resolvePreviousWeekRange(now, resolvedTimeZone);
    const generatedAt = formatDateTimeInTimeZone(now, resolvedTimeZone);
    const displayName = normalizeString(userName || this.config.userName || "User", "User");
    return [
      "你是本地微信聊天项目的每周回顾 JSON 结构化器。",
      "根据当前线程中可见的上一周历史对话，只总结用户自己的心情、状态、事项、睡眠、压力、进度和收获。",
      "如果下面提供了 USER MEMORY RECORDS，只使用这些本地记录作为报告依据；忽略线程里不属于这些记录的旧聊天。",
      "不要总结角色状态、角色心理、角色关系进度、角色数值、变量、状态栏或 MVU。不要执行任何变量或世界书机制。",
      "每日记录里的完成度、睡眠分、压力分必须按实际聊天判断：progressPercent/completionPercent 为 0-100；sleepScore 为 0-5；stressScore 为 0-8。无法判断则填 0。",
      "dailyRecords 尽量输出周一到周日 7 条；每一天的 items 输出 1-2 条用户事项，每条包含 text 和 progressPercent。",
      "statusTags 输出 4-8 个短标签；summary 控制在 1-2 句，适合放进长图顶部描述。",
      "只输出一个 JSON object，不要输出 Markdown，不要输出代码块，不要解释。",
      `用户名：${displayName}`,
      `日期范围：${startDate} 至 ${endDate}`,
      `生成时间：${generatedAt}`,
      memoryContext ? `USER MEMORY RECORDS:\n${JSON.stringify(memoryContext, null, 2)}` : "",
      "JSON schema:",
      JSON.stringify({
        title: "每周回顾",
        startDate,
        endDate,
        summary: "用 3-5 句概括用户上一周的状态。",
        statusTags: ["心情标签", "状态标签"],
        weekMatters: ["一周事项"],
        dailyRecords: [
          {
            date: startDate,
            weekday: "周一",
            title: "当天主题",
            summary: "只写用户当天记录",
            items: [
              { text: "事件 / 任务内容", progressPercent: 25 },
              { text: "事件 / 任务内容", progressPercent: 50 },
            ],
            mood: "平稳",
            sleep: "未提及",
            sleepScore: 0,
            stress: "未提及",
            stressScore: 0,
            progress: "未提及",
            completionPercent: 0,
          },
        ],
        metrics: [
          { label: "睡眠", value: "未提及", detail: "只写用户睡眠", tone: "sleep" },
          { label: "压力", value: "中等", detail: "只写用户压力", tone: "stress" },
          { label: "进度", value: "有推进", detail: "只写用户事项进度", tone: "progress" },
          { label: "收获", value: "一点确认", detail: "只写用户收获", tone: "gain" },
        ],
        weeklyTrend: [
          { label: "周一", value: 0, detail: "0-100，无法判断则 0" },
          { label: "周二", value: 0, detail: "0-100，无法判断则 0" },
          { label: "周三", value: 0, detail: "0-100，无法判断则 0" },
          { label: "周四", value: 0, detail: "0-100，无法判断则 0" },
          { label: "周五", value: 0, detail: "0-100，无法判断则 0" },
          { label: "周六", value: 0, detail: "0-100，无法判断则 0" },
          { label: "周日", value: 0, detail: "0-100，无法判断则 0" },
        ],
        closing: "一周总结，只写用户状态。",
      }, null, 2),
    ].join("\n");
  }

  async renderFromRuntimeText({ text = "", outputFile = "", now = new Date(), context = {} } = {}) {
    const parsed = parseReportJson(text);
    const data = buildWeeklyReviewCardData(parsed, {
      ...context,
      now,
      config: this.config,
    });
    const rendered = await this.renderer.renderPng({
      templateName: "weekly-review.html",
      data,
      outputFile: outputFile || buildReportOutputFile({
        outputDir: this.config.reportCardOutputDir,
        stateDir: this.config.stateDir,
        kind: "weekly-review",
        dateText: `${data.startDate}-${data.endDate}`,
      }),
      width: this.config.reportCardWidth,
      deviceScaleFactor: this.config.reportCardDeviceScaleFactor,
    });
    return { ...rendered, data };
  }
}

function buildWeeklyReviewCardData(rawPayload = {}, { now = new Date(), config = {}, timeZone = "", userName = "" } = {}) {
  const payload = sanitizeReportPayload(rawPayload);
  const resolvedTimeZone = resolveReportTimeZone(config, timeZone);
  const range = resolvePreviousWeekRange(now, resolvedTimeZone);
  const startDate = normalizeString(payload.startDate || payload.from || payload.rangeStart, range.startDate);
  const endDate = normalizeString(payload.endDate || payload.to || payload.rangeEnd, range.endDate);
  const generatedAt = normalizeString(payload.generatedAt) || formatDateTimeInTimeZone(now, resolvedTimeZone);
  const summary = normalizeString(
    payload.summary || payload.weekSummary || payload.review,
    "这一周的可总结信息还不多，先保留为一张轻量回顾。"
  );
  const statusTags = normalizeStringArray(payload.statusTags || payload.tags || payload.moodTags, ["用户状态"]);
  const weekMatters = normalizeStringArray(payload.weekMatters || payload.matters || payload.events, ["暂无一周事项"]);
  const metrics = normalizeMetricItems(
    payload.metrics || payload.sleepStressProgress || payload.overview,
    [
      { label: "睡眠", value: "未记录", detail: "暂时没有睡眠相关信息。", tone: "sleep" },
      { label: "压力", value: "未记录", detail: "暂时没有明确压力线索。", tone: "stress" },
      { label: "进度", value: "未记录", detail: "暂时没有事项推进信息。", tone: "progress" },
      { label: "收获", value: "未记录", detail: "暂时没有明确收获。", tone: "gain" },
    ]
  ).slice(0, 6);
  const dailyRecords = normalizeDailyRecords(payload.dailyRecords || payload.days || payload.records);
  const weeklyTrend = normalizeTrendPoints(payload.weeklyTrend || payload.trend || payload.energyTrend, []);
  const closing = normalizeString(payload.closing || payload.conclusion, "继续保留能量，给下一周留出可执行的节奏。");

  return sanitizeReportPayload({
    kind: "weekly-review",
    title: normalizeString(payload.title, "每周回顾"),
    startDate,
    endDate,
    dateRange: normalizeString(payload.dateRange, `${startDate} 至 ${endDate}`),
    generatedAt,
    userName: normalizeString(userName || config.userName || "User", "User"),
    summary,
    statusTags,
    weekMatters,
    dailyRecords,
    metrics,
    weeklyTrend,
    closing,
  });
}

function normalizeDailyRecords(value) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const date = normalizeString(item.date || item.day);
      const weekday = normalizeString(item.weekday || item.label);
      const title = normalizeString(item.title || item.topic, weekday || date || "每日记录");
      const summary = normalizeString(item.summary || item.text || item.note, "暂无记录");
      const mood = normalizeString(item.mood || item.emotion);
      const sleep = normalizeString(item.sleep);
      const stress = normalizeString(item.stress || item.pressure);
      const progress = normalizeString(item.progress);
      const completionPercent = clampPercentage(item.completionPercent ?? item.progressPercent ?? item.percent ?? item.progressValue);
      const sleepScore = clampScale(item.sleepScore ?? item.sleepLevel ?? item.sleepValue, 5);
      const stressScore = clampScale(item.stressScore ?? item.pressureScore ?? item.stressLevel ?? item.pressureLevel, 8);
      const items = normalizeDailyItems(item.items || item.tasks || item.events, { title, summary, completionPercent });
      return {
        date,
        weekday,
        title,
        summary,
        items,
        mood,
        sleep,
        sleepScore,
        stress,
        stressScore,
        progress,
        completionPercent,
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : [
    {
      date: "",
      weekday: "",
      title: "暂无每日记录",
      summary: "上一周还没有足够的用户记录可展开。",
      items: [],
      mood: "",
      sleep: "",
      sleepScore: 0,
      stress: "",
      stressScore: 0,
      progress: "",
      completionPercent: 0,
    },
  ];
}

function normalizeDailyItems(value, { title = "", summary = "", completionPercent = 0 } = {}) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source
    .map((item) => {
      if (typeof item === "string") {
        return { text: normalizeString(item), progressPercent: completionPercent };
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const text = normalizeString(item.text || item.title || item.summary || item.task || item.event || item.content);
      const progressPercent = clampPercentage(item.progressPercent ?? item.completionPercent ?? item.percent ?? completionPercent);
      return text ? { text, progressPercent } : null;
    })
    .filter(Boolean)
    .slice(0, 2);
  if (normalized.length) {
    return normalized;
  }
  return [title, summary]
    .filter(Boolean)
    .slice(0, 2)
    .map((text, index) => ({
      text,
      progressPercent: completionPercent || (index === 0 ? 25 : 50),
    }));
}

function clampScale(value, max) {
  const numeric = Number.parseFloat(String(value ?? "").replace("%", ""));
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(max, Math.round(numeric)));
}

function resolvePreviousWeekRange(now = new Date(), timeZone = "Asia/Shanghai") {
  const currentDateText = formatDateInTimeZone(now, timeZone);
  const localMidnight = new Date(`${currentDateText}T00:00:00.000Z`);
  const day = localMidnight.getUTCDay() || 7;
  const currentWeekMonday = new Date(localMidnight);
  currentWeekMonday.setUTCDate(localMidnight.getUTCDate() - day + 1);
  const previousWeekMonday = new Date(currentWeekMonday);
  previousWeekMonday.setUTCDate(currentWeekMonday.getUTCDate() - 7);
  const previousWeekSunday = new Date(previousWeekMonday);
  previousWeekSunday.setUTCDate(previousWeekMonday.getUTCDate() + 6);
  return {
    startDate: previousWeekMonday.toISOString().slice(0, 10),
    endDate: previousWeekSunday.toISOString().slice(0, 10),
  };
}

module.exports = {
  WeeklyReviewCardService,
  buildWeeklyReviewCardData,
  normalizeDailyRecords,
  resolvePreviousWeekRange,
};
