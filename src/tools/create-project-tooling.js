const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { CardRenderService } = require("../services/card-render-service");
const { ChannelFileService } = require("../services/channel-file-service");
const { DailyDiaryCardService } = require("../services/daily-diary-card-service");
const { DiaryService } = require("../services/diary-service");
const { ReminderService } = require("../services/reminder-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineService } = require("../services/timeline-service");
const { UserMemoryService } = require("../services/user-memory-service");
const { WeeklyReviewCardService } = require("../services/weekly-review-card-service");
const { WhereaboutsService } = require("../services/whereabouts-service");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");

function createProjectTooling(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const channelAdapter = options.channelAdapter || createWeixinChannelAdapter(config);
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const cardRenderer = options.cardRenderer || new CardRenderService({ config });
  const services = {
    cardRenderer,
    dailyDiaryCard: new DailyDiaryCardService({ config, renderer: cardRenderer }),
    diary: new DiaryService({ config }),
    reminder: new ReminderService({ config, sessionStore }),
    system: new SystemMessageService({ config, sessionStore }),
    channelFile: new ChannelFileService({ config, channelAdapter, sessionStore }),
    timeline: new TimelineService({ config, timelineIntegration, sessionStore }),
    userMemory: new UserMemoryService({ config }),
    weeklyReviewCard: new WeeklyReviewCardService({ config, renderer: cardRenderer }),
    whereabouts: new WhereaboutsService({
      config: {
        storeFile: config.locationStoreFile,
        host: config.locationHost,
        port: config.locationPort,
        token: config.locationToken,
        historyLimit: config.locationHistoryLimit,
        movementEventLimit: config.locationMovementEventLimit,
        batteryHistoryLimit: config.locationBatteryHistoryLimit,
        knownPlaces: config.locationKnownPlaces,
        knownPlaceRadiusMeters: config.locationKnownPlaceRadiusMeters,
        stayMergeRadiusMeters: config.locationStayMergeRadiusMeters,
        stayBreakConfirmRadiusMeters: config.locationStayBreakConfirmRadiusMeters,
        stayBreakConfirmSamples: config.locationStayBreakConfirmSamples,
        majorMoveThresholdMeters: config.locationMajorMoveThresholdMeters,
      },
    }),
  };
  const toolHost = new ProjectToolHost({
    services,
    runtimeContextStore,
  });
  return {
    services,
    toolHost,
    runtimeContextStore,
  };
}

module.exports = { createProjectTooling };
