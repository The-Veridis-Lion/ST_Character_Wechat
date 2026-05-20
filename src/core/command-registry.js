const COMMAND_GROUPS = [
  {
    id: "lifecycle",
    label: "Lifecycle & Diagnostics",
    actions: [
      {
        action: "app.login",
        summary: "Start WeChat QR login and save the account",
        terminal: ["login"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.accounts",
        summary: "List locally saved accounts",
        terminal: ["accounts"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.start",
        summary: "Start the current channel/runtime main loop",
        terminal: ["start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_start",
        summary: "Start the shared app-server and shared WeChat bridge",
        terminal: ["shared start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_open",
        summary: "Attach to the shared thread currently bound in WeChat",
        terminal: ["shared open"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_status",
        summary: "Show the shared app-server and bridge status",
        terminal: ["shared status"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.doctor",
        summary: "Print current config, boundaries, and thread state",
        terminal: ["doctor"],
        weixin: [],
        status: "active",
      },
      {
        action: "system.send",
        summary: "Write an invisible trigger message into the internal system queue",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "system.checkin_poller",
        summary: "Disabled in character-only mode",
        terminal: [],
        weixin: [],
        status: "disabled",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace & Thread",
    actions: [
      {
        action: "workspace.bind",
        summary: "Bind the current chat to a workspace directory",
        terminal: [],
        weixin: ["/bind"],
        status: "active",
      },
      {
        action: "workspace.status",
        summary: "Show the current workspace, thread, model, and context usage",
        terminal: [],
        weixin: ["/status"],
        status: "active",
      },
      {
        action: "character.manage",
        summary: "Scan local SillyTavern character cards and switch the active WeChat character",
        terminal: [],
        weixin: ["/char list", "/char use <name|number>", "/char current", "/char reload", "/char reset"],
        status: "active",
      },
      {
        action: "report.daily_card",
        summary: "Generate a daily summary long PNG from runtime JSON",
        terminal: [],
        weixin: ["/dailycard"],
        status: "active",
      },
      {
        action: "report.weekly_card",
        summary: "Generate a weekly review long PNG from runtime JSON",
        terminal: [],
        weixin: ["/weeklycard"],
        status: "active",
      },
      {
        action: "thread.reread",
        summary: "Disabled in character-only mode; character prompts are rebuilt per message",
        terminal: [],
        weixin: ["/reread"],
        weixinHelp: false,
        status: "active",
      },
      {
        action: "thread.compact",
        summary: "Compact the active character thread context",
        terminal: [],
        weixin: ["/compact"],
        weixinHelp: false,
        status: "active",
      },
      {
        action: "thread.auto_compact",
        summary: "View or change automatic compact for the active character thread",
        terminal: [],
        weixin: ["/compact auto", "/compact auto on", "/compact auto off", "/compact auto <percent>"],
        weixinHelp: false,
        status: "active",
      },
      {
        action: "thread.switch",
        summary: "Disabled in character-only mode; use /char use instead",
        terminal: [],
        weixin: ["/switch"],
        weixinHelp: false,
        status: "active",
      },
      {
        action: "thread.stop",
        summary: "Stop the active character turn",
        terminal: [],
        weixin: ["/stop"],
        status: "active",
      },
      {
        action: "system.checkin_range",
        summary: "Disabled in character-only mode",
        terminal: [],
        weixin: [],
        status: "disabled",
      },
      {
        action: "channel.chunk_min",
        summary: "Adjust the minimum short-chunk merge size for WeChat replies",
        terminal: [],
        weixin: ["/chunk <number>"],
        status: "active",
      },
    ],
  },
  {
    id: "approval",
    label: "Approvals & Control",
    actions: [
      {
        action: "approval.accept_once",
        summary: "Allow the current approval request once",
        terminal: [],
        weixin: ["/yes"],
        status: "active",
      },
      {
        action: "approval.accept_character_once",
        summary: "Allow the current approval request once; persistent workspace approvals are disabled",
        terminal: [],
        weixin: ["/always"],
        status: "active",
      },
      {
        action: "approval.reject_once",
        summary: "Deny the current approval request",
        terminal: [],
        weixin: ["/no"],
        status: "active",
      },
    ],
  },
  {
    id: "capabilities",
    label: "Capabilities",
    actions: [
      {
        action: "model.inspect",
        summary: "Inspect the current model",
        terminal: [],
        weixin: ["/model"],
        status: "active",
      },
      {
        action: "model.select",
        summary: "Switch to a specific model",
        terminal: [],
        weixin: ["/model <id>"],
        status: "active",
      },
      {
        action: "channel.send_file",
        summary: "Send a local file back to the current chat as an attachment",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.write",
        summary: "Write the current context into timeline",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.build",
        summary: "Build the static timeline site",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.serve",
        summary: "Start the static timeline site server",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.dev",
        summary: "Start the hot-reload timeline dev server",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.screenshot",
        summary: "Capture a timeline screenshot",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "reminder.create",
        summary: "Create a reminder and hand it to the scheduler",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "diary.append",
        summary: "Append a diary entry",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "app.star",
        summary: "Star the project on GitHub",
        terminal: [],
        weixin: ["/star"],
        status: "active",
      },
      {
        action: "app.help",
        summary: "Show currently available commands for this channel",
        terminal: ["help"],
        weixin: ["/help"],
        status: "active",
      },
    ],
  },
];

function listCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    actions: group.actions.map((action) => ({ ...action })),
  }));
}

function buildTerminalHelpText() {
  const lines = [
    "Usage: st-character-wechat <command>",
    "",
    "Current terminal commands:",
    "  st-character-wechat start        start the WeChat bridge and runtime loop",
    "  st-character-wechat login        start WeChat QR login",
    "  st-character-wechat accounts     list locally saved accounts",
    "  st-character-wechat doctor       print current config and thread state",
    "  npm run shared:start   start the shared app-server and WeChat bridge",
    "  npm run shared:open    attach to the shared thread currently bound in WeChat",
    "  npm run shared:status  show shared bridge status",
  ];

  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => action.status === "active" && action.terminal.length);
    if (!activeActions.length) {
      continue;
    }
    lines.push(`- ${group.label}`);
    for (const action of activeActions) {
      lines.push(`  ${formatTerminalExamples(action)}  ${action.summary}`);
    }
  }

  lines.push("");
  lines.push("ST Character WeChat capability operations are exposed to models as project tools, not terminal subcommands.");
  return lines.join("\n");
}

function buildWeixinHelpText() {
  const lines = ["💡 Available commands:"];
  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => (
      action.status === "active"
      && action.weixin.length
      && action.weixinHelp !== false
    ));
    if (!activeActions.length) {
      continue;
    }
    lines.push("");
    lines.push(`${groupEmoji(group.id)} 【${group.label}】`);
    for (const action of activeActions) {
      lines.push(`  ${actionEmoji(action)} ${action.weixin.join(", ")} — ${action.summary}`);
    }
  }
  return lines.join("\n");
}

function groupEmoji(groupId) {
  switch (groupId) {
    case "lifecycle": return "🔄";
    case "workspace": return "📁";
    case "approval": return "🔐";
    case "capabilities": return "⚡️";
    default: return "•";
  }
}

function actionEmoji(action) {
  switch (action.action) {
    case "workspace.bind": return "📍";
    case "workspace.status": return "📊";
    case "thread.reread": return "🔄";
    case "thread.compact": return "🗜️";
    case "thread.auto_compact": return "🧠";
    case "thread.switch": return "🔀";
    case "thread.stop": return "⏹️";
    case "report.daily_card": return "📝";
    case "report.weekly_card": return "📆";
    case "approval.accept_once": return "✅";
    case "approval.accept_character_once": return "💡";
    case "approval.reject_once": return "❌";
    case "model.inspect":
    case "model.select": return "🤖";
    case "app.help": return "❓";
    case "app.star": return "⭐️";
    default: return "•";
  }
}

module.exports = {
  buildTerminalHelpText,
  buildWeixinHelpText,
  listCommandGroups,
};

function formatTerminalExamples(action) {
  const terminal = Array.isArray(action?.terminal) ? action.terminal : [];
  if (!terminal.length) {
    return "";
  }
  return terminal.map((commandText) => toTerminalCommandExample(commandText)).join(", ");
}

function toTerminalCommandExample(commandText) {
  const normalized = typeof commandText === "string" ? commandText.trim() : "";
  switch (normalized) {
    case "login":
    case "accounts":
    case "start":
    case "doctor":
    case "help":
      return `st-character-wechat ${normalized}`;
    case "shared start":
    case "shared open":
    case "shared status":
      return `npm run ${normalized.replace(" ", ":")}`;
    default:
      return normalized;
  }
}
