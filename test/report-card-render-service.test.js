const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { CardRenderService } = require("../src/services/card-render-service");
const { DailyDiaryCardService } = require("../src/services/daily-diary-card-service");
const { WeeklyReviewCardService } = require("../src/services/weekly-review-card-service");

test("daily and weekly HTML templates render to PNG files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-card-render-"));
  const config = {
    stateDir: dir,
    reportCardOutputDir: dir,
    reportCardWidth: 720,
    reportCardDeviceScaleFactor: 1,
    reportTimeZone: "Asia/Shanghai",
    playwrightBrowserChannel: process.env.ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_CHANNEL || "msedge",
  };
  const renderer = new CardRenderService({ config });
  const daily = new DailyDiaryCardService({ config, renderer });
  const weekly = new WeeklyReviewCardService({ config, renderer });

  const dailyResult = await daily.renderFromRuntimeText({
    text: JSON.stringify({
      date: "2026-05-18",
      summary: "用户今天在收敛角色卡微信项目，重点推进日报和周报长图。",
      moodLabel: "专注",
      moodEmoji: "🎯",
      moodDetail: "目标明确，持续处理模板和验证。",
      stateOverview: [
        { label: "心情", value: "专注", detail: "表达明确，目标收束。", tone: "mood" },
        { label: "压力", value: "中等", detail: "在意发布质量。", tone: "stress" },
        { label: "进度", value: "接近完成", detail: "进入验证阶段。", tone: "progress" },
      ],
      topics: ["长图模板", "Playwright 截图", "GitHub 发布边界"],
      keyFacts: ["只从本地目录导入角色卡", "运行时只返回结构化 JSON"],
      chatExcerpts: ["先不要乱改，先做 Git 安全检查。"],
      supplemental: ["颜色通过 CSS variables 管理。"],
      energyTrend: [
        { label: "早间", value: 42 },
        { label: "午后", value: 68 },
        { label: "晚间", value: 74 },
      ],
      timeDistribution: [
        { label: "上午", value: 30, detail: "安全检查与阅读代码" },
        { label: "下午", value: 48, detail: "实现报告卡" },
        { label: "夜间", value: 22, detail: "验证与整理文档" },
      ],
      tags: ["专注", "收尾", "本地部署"],
    }),
    now: new Date("2026-05-18T12:00:00.000Z"),
  });

  const weeklyResult = await weekly.renderFromRuntimeText({
    text: JSON.stringify({
      startDate: "2026-05-11",
      endDate: "2026-05-17",
      summary: "用户这一周持续把项目从旧叙事收敛到本地角色卡微信聊天。",
      statusTags: ["稳定推进", "重视隐私"],
      weekMatters: ["完成角色卡导入边界", "补齐命令说明", "开始长图报告能力"],
      dailyRecords: [
        {
          date: "2026-05-11",
          weekday: "周一",
          title: "角色边界",
          summary: "确认不继承旧助手人格。",
          items: [
            { text: "确认角色聊天边界", progressPercent: 35 },
            { text: "整理导入规则", progressPercent: 60 },
          ],
          sleepScore: 3,
          stressScore: 4,
          progress: "推进",
          completionPercent: 60,
        },
        {
          date: "2026-05-12",
          weekday: "周二",
          title: "世界书过滤",
          summary: "继续过滤变量和状态栏内容。",
          items: [
            { text: "过滤变量和状态栏内容", progressPercent: 45 },
            { text: "补充安全测试", progressPercent: 55 },
          ],
          sleepScore: 2,
          stressScore: 5,
          progress: "推进",
          completionPercent: 55,
        },
        {
          date: "2026-05-17",
          weekday: "周日",
          title: "报告卡",
          summary: "进入每日和每周长图阶段。",
          items: [
            { text: "开始日报长图", progressPercent: 25 },
            { text: "周报结构确认", progressPercent: 40 },
          ],
          sleepScore: 4,
          stressScore: 3,
          progress: "开始",
          completionPercent: 40,
        },
      ],
      metrics: [
        { label: "睡眠", value: "未充分提及", detail: "缺少连续记录。", tone: "sleep" },
        { label: "压力", value: "中等", detail: "主要来自发布质量要求。", tone: "stress" },
        { label: "进度", value: "明显推进", detail: "功能边界更清楚。", tone: "progress" },
      ],
      weeklyTrend: [
        { label: "周一", value: 40 },
        { label: "周二", value: 48 },
        { label: "周三", value: 54 },
        { label: "周四", value: 51 },
        { label: "周五", value: 63 },
        { label: "周六", value: 66 },
        { label: "周日", value: 71 },
      ],
      closing: "这一周的重点是把产品边界变得清楚，下一步继续验证图卡输出。",
    }),
    now: new Date("2026-05-18T12:00:00.000Z"),
  });

  assertPng(dailyResult.filePath);
  assertPng(weeklyResult.filePath);
  assert.ok(dailyResult.height > 900);
  assert.ok(weeklyResult.height > 900);
});

function assertPng(filePath) {
  assert.ok(fs.existsSync(filePath), `${filePath} should exist`);
  const stat = fs.statSync(filePath);
  assert.ok(stat.size > 1000, `${filePath} should not be empty`);
  const signature = fs.readFileSync(filePath).subarray(0, 8);
  assert.deepEqual([...signature], [137, 80, 78, 71, 13, 10, 26, 10]);
}
