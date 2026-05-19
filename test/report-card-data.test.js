const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDailyDiaryCardData } = require("../src/services/daily-diary-card-service");
const { buildWeeklyReviewCardData, resolvePreviousWeekRange } = require("../src/services/weekly-review-card-service");
const { parseReportJson } = require("../src/services/report-card-data");

test("daily report data removes character state and variable-like content", () => {
  const data = buildDailyDiaryCardData({
    date: "2026-05-18",
    summary: "用户今天压力有点高。\n角色状态：好感度上升。",
    moodLabel: "专注",
    moodEmoji: "🎯",
    moodDetail: "用户在收尾阶段保持专注。",
    characterState: "MVU status_bar 变量更新",
    stateOverview: [
      { label: "心情", value: "有点紧", detail: "用户提到赶进度", tone: "mood" },
      { label: "角色状态", value: "好感度 20", detail: "MVU" },
    ],
    keyFacts: [
      "用户想把报告卡做完",
      "状态栏：角色很开心",
    ],
    chatExcerpts: ["我今天要把这个收尾。"],
  }, {
    now: new Date("2026-05-18T12:00:00.000Z"),
    config: { userName: "User", reportTimeZone: "Asia/Shanghai" },
  });

  const serialized = JSON.stringify(data);
  assert.match(serialized, /用户今天压力有点高/);
  assert.equal(data.moodLabel, "专注");
  assert.equal(data.moodEmoji, "🎯");
  assert.doesNotMatch(serialized, /MVU|status_bar|变量|角色状态|好感度/u);
});

test("weekly report data removes character state and variable-like content", () => {
  const data = buildWeeklyReviewCardData({
    startDate: "2026-05-11",
    endDate: "2026-05-17",
    summary: "用户这一周推进了本地角色卡微信项目。\nMVU：不要出现。",
    roleState: "characterState 好感度",
    dailyRecords: [
      {
        date: "2026-05-12",
        weekday: "周二",
        title: "测试",
        summary: "用户补了渲染测试。\n状态栏：角色状态变化",
        items: [{ text: "补渲染测试", progressPercent: 55 }],
        sleepScore: 3,
        stressScore: 5,
        progress: "有推进",
      },
    ],
    metrics: [
      { label: "进度", value: "稳定", detail: "用户持续推进", tone: "progress" },
    ],
  }, {
    now: new Date("2026-05-18T12:00:00.000Z"),
    config: { userName: "User", reportTimeZone: "Asia/Shanghai" },
  });

  const serialized = JSON.stringify(data);
  assert.match(serialized, /用户这一周推进/);
  assert.match(serialized, /用户补了渲染测试/);
  assert.equal(data.dailyRecords[0].items[0].progressPercent, 55);
  assert.equal(data.dailyRecords[0].sleepScore, 3);
  assert.equal(data.dailyRecords[0].stressScore, 5);
  assert.doesNotMatch(serialized, /MVU|状态栏|角色状态|characterState|好感度/u);
});

test("report JSON parser accepts fenced JSON objects", () => {
  const parsed = parseReportJson("```json\n{\"summary\":\"ok\"}\n```");
  assert.deepEqual(parsed, { summary: "ok" });
});

test("weekly range resolves to the previous Monday through Sunday", () => {
  const range = resolvePreviousWeekRange(new Date("2026-05-18T12:00:00.000Z"), "Asia/Shanghai");
  assert.deepEqual(range, {
    startDate: "2026-05-11",
    endDate: "2026-05-17",
  });
});
