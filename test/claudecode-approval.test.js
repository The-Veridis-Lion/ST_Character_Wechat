const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { CharacterWechatApp } = require("../src/core/app");
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

function activeCharacterContext() {
  return {
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
  };
}

test("claudecode approval events extract command tokens from exec_command input", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-1",
    toolName: "exec_command",
    input: {
      cmd: "st-character-wechat reminder write --delay 30m --text 'Reminder text'",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["st-character-wechat", "reminder", "write"]);
});

test("claudecode approval events prefer prefix_rule when present", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-2",
    toolName: "exec_command",
    input: {
      cmd: "npm run timeline:build -- --locale en",
      prefix_rule: ["npm", "run", "timeline:build"],
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["npm", "run", "timeline:build"]);
});

test("claudecode approval events canonicalize diary commands for stable always matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-diary",
    toolName: "exec_command",
    input: {
      cmd: "/Users/tingyiwen/Dev/st-character-wechat/bin/st-character-wechat diary write --date 2026-04-17 --title '4.17' --text 'hello'",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["st-character-wechat", "diary", "write"]);
});

test("claudecode approval events canonicalize view_image tool approvals", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-img",
    toolName: "view_image",
    input: {
      path: "/tmp/example.png",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["view_image"]);
});

test("claudecode approval events canonicalize MCP tool approvals for stable always matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-mcp-timeline",
    toolName: "mcp__st_character_wechat_tools__st_character_wechat_timeline_write",
    input: {
      date: "2026-04-21",
      events: [],
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["mcp_tool", "st_character_wechat_tools", "st_character_wechat_timeline_write"]);
  assert.match(event.payload.command, /^st_character_wechat_timeline_write\b/);
});

test("claudecode approval events canonicalize Read image approvals for stable matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-read-image",
    toolName: "Read",
    input: {
      file_path: "/Users/tingyiwen/.st-character-wechat/inbox/2026-04-17/attachment-5.jpg",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["read_image"]);
  assert.equal(event.payload.filePath, "/Users/tingyiwen/.st-character-wechat/inbox/2026-04-17/attachment-5.jpg");
});

test("claudecode approval events keep non-image Read approvals as file reads", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-read-text",
    toolName: "Read",
    input: {
      file_path: "/Users/tingyiwen/.st-character-wechat/inbox/2026-04-17/note.txt",
    },
  });

  assert.deepEqual(event.payload.commandTokens, []);
  assert.equal(event.payload.filePath, "/Users/tingyiwen/.st-character-wechat/inbox/2026-04-17/note.txt");
});

test("claudecode approval events capture Write file paths for state-dir auto approve", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-write",
    toolName: "Write",
    input: {
      file_path: "/Users/tingyiwen/.st-character-wechat/notes/today.md",
      content: "hello",
    },
  });

  assert.equal(event.payload.filePath, "/Users/tingyiwen/.st-character-wechat/notes/today.md");
  assert.deepEqual(event.payload.filePaths, ["/Users/tingyiwen/.st-character-wechat/notes/today.md"]);
});

test("claudecode assistant events map usage into context snapshots", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent(
    {
      type: "context.updated",
      sessionId: "thread-1",
    },
    {
      message: {
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 12150,
          cache_read_input_tokens: 13535,
          output_tokens: 1509,
        },
      },
    },
  );

  assert.equal(event.type, "runtime.context.updated");
  assert.equal(event.payload.runtimeId, "claudecode");
  assert.equal(event.payload.threadId, "thread-1");
  assert.equal(event.payload.currentTokens, 27201);
});

test("handleRuntimeEvent prompts for project shell commands instead of auto-approving them", async () => {
  const prompts = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
        };
      },
      async respondApproval(payload) {
        throw new Error(`should not auto-approve ${JSON.stringify(payload)}`);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-3",
      commandTokens: ["st-character-wechat", "timeline", "write", "--date", "2026-04-17"],
    },
  });

  assert.equal(prompts.length, 1);
});

test("handleCharResetCommand asks runtime to start a fresh draft before clearing the saved thread", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
    runtimeAdapter: {
      startFreshThreadDraft: async ({ bindingKey, workspaceRoot }) => {
        calls.push(["fresh", bindingKey, workspaceRoot]);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clear", bindingKey, workspaceRoot]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CharacterWechatApp.prototype.handleCharResetCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    ["fresh", "binding-1:character:ciel-abc", "/workspace"],
    ["clear", "binding-1:character:ciel-abc", "/workspace"],
    ["send", "已重置 Ciel 的独立聊天线程"],
  ]);
});

test("handleCompactCommand invokes runtime compaction for the current thread", async () => {
  const calls = [];
  const appLike = {
    pendingOperationByRunKey: new Map(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
    streamDelivery: {
      queueReplyTargetForThread(threadId, payload) {
        calls.push(["queue", threadId, payload.userId, payload.contextToken, payload.provider]);
      },
    },
    scheduleRuntimeEventWatchdog(payload) {
      calls.push(["watchdog", payload.threadId, payload.workspaceRoot]);
    },
    runtimeAdapter: {
      async compactThread(payload) {
        calls.push(["compact", payload.threadId, payload.workspaceRoot, payload.model]);
        return { threadId: payload.threadId, turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["thread", bindingKey, workspaceRoot]);
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-sonnet" };
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CharacterWechatApp.prototype.handleCompactCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  });

  assert.deepEqual(calls, [
    ["thread", "binding-1:character:ciel-abc", "/workspace"],
    ["queue", "thread-1", "user-1", "ctx-1", "weixin"],
    ["watchdog", "thread-1", "/workspace"],
    ["compact", "thread-1", "/workspace", "claude-sonnet"],
    ["send", "🗜️ Compact request sent\nthread: thread-1"],
  ]);
  assert.equal(appLike.pendingOperationByRunKey.get("thread-1:turn-1")?.kind, "compact");
});

test("handleCompactCommand reports when there is no active thread", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleCompactCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    "当前角色 Ciel 还没有独立线程，先发一句普通消息开始聊天",
  ]);
});

test("handleStopCommand passes workspaceRoot through to runtime cancellation", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
    threadStateStore: {
      getThreadState(threadId) {
        calls.push(["state", threadId]);
        return {
          threadId,
          turnId: "turn-1",
          status: "running",
        };
      },
    },
    runtimeAdapter: {
      async cancelTurn(payload) {
        calls.push(["cancel", payload.threadId, payload.turnId, payload.workspaceRoot]);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["thread", bindingKey, workspaceRoot]);
            return "thread-1";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStopCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    ["thread", "binding-1:character:ciel-abc", "/workspace"],
    ["state", "thread-1"],
    ["cancel", "thread-1", "turn-1", "/workspace"],
    ["send", "⏹️ Stop request sent\nthread: thread-1"],
  ]);
});

test("handleStopCommand allows stopping while waiting for approval", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    characterStateStore: {
      getActiveCharacterId() {
        return "ciel-abc";
      },
    },
    characterLibrary: {
      getCharacter() {
        return { id: "ciel-abc", name: "Ciel" };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "waiting_approval",
        };
      },
    },
    runtimeAdapter: {
      async cancelTurn(payload) {
        calls.push(payload);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["thread", bindingKey, workspaceRoot]);
            return "thread-1";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStopCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls[0], ["thread", "binding-1:character:ciel-abc", "/workspace"]);
  assert.equal(calls[1].workspaceRoot, "/workspace");
  assert.equal(calls[2], "⏹️ Stop request sent\nthread: thread-1");
});

test("handleRuntimeEvent reports compact completion back to WeChat", async () => {
  const sent = [];
  const appLike = {
    pendingOperationByRunKey: new Map([
      ["thread-1:turn-1", {
        kind: "compact",
        userId: "user-1",
        contextToken: "ctx-1",
      }],
    ]),
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    hasPendingInboundMessage() {
      return false;
    },
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });

  assert.deepEqual(sent, ["✅ Compact finished\nthread: thread-1"]);
  assert.equal(appLike.pendingOperationByRunKey.size, 0);
});

test("handleRuntimeEvent keeps auto compact completion silent", async () => {
  const sent = [];
  const appLike = {
    pendingOperationByRunKey: new Map([
      ["thread-1:turn-2", {
        kind: "auto_compact",
        userId: "user-1",
        contextToken: "ctx-1",
      }],
    ]),
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    hasPendingInboundMessage() {
      return false;
    },
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-2",
    },
  });

  assert.deepEqual(sent, []);
  assert.equal(appLike.pendingOperationByRunKey.size, 0);
});

test("handleRuntimeEvent auto-approves built-in view_image approvals without prompting", async () => {
  const responses = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for view_image");
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-img-2",
      commandTokens: ["view_image"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-img-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves project-native MCP tool approvals without prompting", async () => {
  const responses = [];
  const appLike = {
    config: { stateDir: path.join(os.tmpdir(), "st-character-wechat-approval-test") },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for project-native MCP tools");
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-project-tool",
      commandTokens: ["mcp_tool", "st_character_wechat_tools", "st_character_wechat_timeline_write"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-project-tool", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves inbox image reads for claudecode without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "st-character-wechat-approval-test");
  const appLike = {
    config: { stateDir },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for inbox image read");
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-read-img-2",
      filePath: path.join(stateDir, "inbox", "2026-04-17", "attachment.jpg"),
      commandTokens: ["read_image"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-read-img-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves any state-dir file operation without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "st-character-wechat-approval-test");
  const appLike = {
    config: { stateDir },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for state-dir file operation");
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-write-2",
      filePath: path.join(stateDir, "notes", "today.md"),
      filePaths: [path.join(stateDir, "notes", "today.md")],
      commandTokens: [],
      reason: "Tool: Write",
      command: "Write\nfile_path: \"/tmp/st-character-wechat-approval-test/notes/today.md\"",
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-write-2", decision: "accept" }]);
});

test("handleRuntimeEvent still prompts for non-inbox image reads", async () => {
  const responses = [];
  const prompts = [];
  const stateDir = path.join(os.tmpdir(), "st-character-wechat-approval-test");
  const appLike = {
    config: { stateDir },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-read-img-3",
      filePath: "/Users/tingyiwen/Desktop/photo.jpg",
      commandTokens: ["read_image"],
      reason: "Tool: Read",
      command: "Read\nfile_path: \"/Users/tingyiwen/Desktop/photo.jpg\"",
    },
  });

  assert.deepEqual(responses, []);
  assert.equal(prompts.length, 1);
});

test("handleRuntimeEvent prompts for formerly allowlisted shell prefixes in character-only mode", async () => {
  const responses = [];
  const prompts = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-4",
      commandTokens: ["npm", "run", "timeline:build", "--", "--locale", "en"],
    },
  });

  assert.deepEqual(responses, []);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].approval.requestId, "req-4");
});

test("handleRuntimeEvent prompts for non-project MCP tools even if a legacy allowlist exists", async () => {
  const responses = [];
  const prompts = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await CharacterWechatApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-mcp-allow",
      commandTokens: ["mcp_tool", "external_tools", "external_action"],
    },
  });

  assert.deepEqual(responses, []);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].approval.requestId, "req-mcp-allow");
});

test("handleSwitchCommand is disabled in character-only mode", async () => {
  const calls = [];
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
            calls.push(["set", bindingKey, workspaceRoot, threadId]);
          },
          setPendingThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
            calls.push(["pending", bindingKey, workspaceRoot, threadId]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CharacterWechatApp.prototype.handleSwitchCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "target-thread",
  });

  assert.deepEqual(calls, [
    ["send", "character-only 模式不支持 /switch，避免串到其他线程；请使用 /char use <角色> 切换角色"],
  ]);
});

test("session store does not reuse legacy thread ids across runtimes", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `st-character-wechat-session-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRoot: {
          "/workspace": "codex-thread",
        },
      },
    },
  }, null, 2));

  const claudecodeStore = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(claudecodeStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
});

test("codex session store reads runtime-scoped thread ids", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `st-character-wechat-codex-runtime-scoped-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "/workspace": "codex-thread",
          },
        },
      },
    },
  }, null, 2));

  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "codex-thread");
  assert.deepEqual(codexStore.listWorkspaceRoots("binding-1"), ["/workspace"]);
  assert.deepEqual(codexStore.findBindingForThreadId("codex-thread"), {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });
});

test("codex session store does not reuse legacy thread ids without runtime-scoped binding", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `st-character-wechat-codex-thread-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRoot: {
          "/workspace": "legacy-codex-thread",
        },
      },
    },
  }, null, 2));

  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
  assert.deepEqual(codexStore.listWorkspaceRoots("binding-1"), []);
  assert.equal(codexStore.findBindingForThreadId("legacy-codex-thread"), null);
});

test("claudecode session store keeps pending thread targets runtime-scoped", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `st-character-wechat-pending-thread-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const claudecodeStore = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  claudecodeStore.setPendingThreadIdForWorkspace("binding-1", "/workspace", "claude-target");
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(claudecodeStore.getPendingThreadIdForWorkspace("binding-1", "/workspace"), "claude-target");
  assert.equal(codexStore.getPendingThreadIdForWorkspace("binding-1", "/workspace"), "");
});

test("handleStatusCommand asks to configure claudecode context window before showing context", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeModel: "claude-sonnet",
    },
    ...activeCharacterContext(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return {
          runtimeId: "claudecode",
          currentTokens: 18000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: set ST_CHARACTER_WECHAT_CLAUDE_CONTEXT_WINDOW/);
});

test("handleStatusCommand shows approximate context details for claudecode when configured", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 130000,
      claudeMaxOutputTokens: 64000,
    },
    ...activeCharacterContext(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "kimi-for-coding" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          status: "idle",
          context: {
            runtimeId: "claudecode",
            currentTokens: 18000,
          },
        };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: approx 18k\/66k \| 73% left \| reserve 64k/);
});

test("handleStatusCommand asks to reduce claudecode max output tokens when reserve exceeds window", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 130000,
      claudeMaxOutputTokens: 140000,
    },
    ...activeCharacterContext(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "kimi-for-coding" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          status: "idle",
          context: {
            runtimeId: "claudecode",
            currentTokens: 18000,
          },
        };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS/);
});

test("handleStatusCommand shows codex context details", async () => {
  const sent = [];
  const appLike = {
    config: {},
    ...activeCharacterContext(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return {
          runtimeId: "codex",
          currentTokens: 1234,
          contextWindow: 200000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: 1.2k\/200k \| 99% left/);
});

test("handleStatusCommand shows codex context as unavailable when no context data is available", async () => {
  const sent = [];
  const appLike = {
    config: {},
    ...activeCharacterContext(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CharacterWechatApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: unavailable/);
});
