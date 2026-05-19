const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("codex characterChat turns do not inject shared opening instructions", async () => {
  const indexPath = path.resolve(__dirname, "../src/adapters/runtime/codex/index.js");
  const rpcClientPath = path.resolve(__dirname, "../src/adapters/runtime/codex/rpc-client.js");
  const mcpConfigPath = path.resolve(__dirname, "../src/adapters/runtime/codex/mcp-config.js");
  const originalIndex = require.cache[indexPath];
  const originalRpc = require.cache[rpcClientPath];
  const originalMcp = require.cache[mcpConfigPath];
  let client = null;

  class MockCodexRpcClient {
    constructor() {
      client = this;
      this.isReady = false;
      this.sentMessages = [];
    }

    async connect() {}

    async initialize() {
      this.isReady = true;
    }

    isTransportReady() {
      return true;
    }

    async listModels() {
      return { result: { data: [] } };
    }

    onMessage() {
      return () => {};
    }

    async startThread() {
      return { result: { thread: { id: "codex-thread-1" } } };
    }

    async sendUserMessage(payload) {
      this.sentMessages.push(payload);
      return { result: { turn: { id: "turn-1" } } };
    }

    async close() {}
  }

  delete require.cache[indexPath];
  require.cache[rpcClientPath] = {
    id: rpcClientPath,
    filename: rpcClientPath,
    loaded: true,
    exports: {
      CodexRpcClient: MockCodexRpcClient,
    },
  };
  require.cache[mcpConfigPath] = {
    id: mcpConfigPath,
    filename: mcpConfigPath,
    loaded: true,
    exports: {
      resolveCodexProjectToolMcpServerConfig() {
        return null;
      },
    },
  };

  try {
    const { createCodexRuntimeAdapter } = require(indexPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-codex-character-"));
    const adapter = createCodexRuntimeAdapter({
      sessionsFile: path.join(dir, "sessions.json"),
      codexEndpoint: "ws://127.0.0.1:8765",
      stateDir: dir,
      userName: "User",
    });

    await adapter.sendTextTurn({
      bindingKey: "binding-1:character:ciel",
      workspaceRoot: dir,
      text: "CHARACTER PROMPT ONLY",
      metadata: { characterChat: true },
    });

    assert.equal(client.sentMessages.length, 1);
    assert.equal(client.sentMessages[0].text, "CHARACTER PROMPT ONLY");
  } finally {
    delete require.cache[indexPath];
    if (originalIndex) {
      require.cache[indexPath] = originalIndex;
    }
    if (originalRpc) {
      require.cache[rpcClientPath] = originalRpc;
    } else {
      delete require.cache[rpcClientPath];
    }
    if (originalMcp) {
      require.cache[mcpConfigPath] = originalMcp;
    } else {
      delete require.cache[mcpConfigPath];
    }
  }
});

test("claudecode characterChat turns do not inject shared opening instructions", async () => {
  const indexPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/index.js");
  const processClientPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/process-client.js");
  const projectSettingsPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/project-settings.js");
  const ipcServerPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/ipc-server.js");
  const originalIndex = require.cache[indexPath];
  const originalProcessClient = require.cache[processClientPath];
  const originalProjectSettings = require.cache[projectSettingsPath];
  const originalIpcServer = require.cache[ipcServerPath];
  let client = null;

  class MockClaudeCodeProcessClient {
    constructor() {
      client = this;
      this.alive = false;
      this.sessionId = "";
      this.pendingTurnId = "turn-1";
      this.sentMessages = [];
    }

    onMessage() {}

    async connect(threadId = "") {
      this.alive = true;
      this.sessionId = threadId || "claude-thread-1";
    }

    async sendUserMessage(payload) {
      this.sentMessages.push(payload);
    }

    async waitForSessionId() {
      return this.sessionId;
    }

    async close() {
      this.alive = false;
    }
  }

  class MockClaudeCodeIpcServer {
    on() {}

    start() {}

    async close() {}
  }

  delete require.cache[indexPath];
  require.cache[processClientPath] = {
    id: processClientPath,
    filename: processClientPath,
    loaded: true,
    exports: {
      ClaudeCodeProcessClient: MockClaudeCodeProcessClient,
    },
  };
  require.cache[projectSettingsPath] = {
    id: projectSettingsPath,
    filename: projectSettingsPath,
    loaded: true,
    exports: {
      ensureClaudeProjectMcpConfig() {
        return {
          configPath: path.join(os.tmpdir(), "mock-claude-mcp.json"),
          serverName: "st_character_wechat_tools",
        };
      },
    },
  };
  require.cache[ipcServerPath] = {
    id: ipcServerPath,
    filename: ipcServerPath,
    loaded: true,
    exports: {
      ClaudeCodeIpcServer: MockClaudeCodeIpcServer,
    },
  };

  try {
    const { createClaudeCodeRuntimeAdapter } = require(indexPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-character-wechat-claude-character-"));
    const adapter = createClaudeCodeRuntimeAdapter({
      sessionsFile: path.join(dir, "sessions.json"),
      stateDir: dir,
      claudeCommand: "claude",
      userName: "User",
    });

    await adapter.sendTextTurn({
      bindingKey: "binding-1:character:ciel",
      workspaceRoot: dir,
      text: "CHARACTER PROMPT ONLY",
      metadata: { characterChat: true },
    });

    assert.equal(client.sentMessages.length, 1);
    assert.equal(client.sentMessages[0].text, "CHARACTER PROMPT ONLY");
  } finally {
    delete require.cache[indexPath];
    if (originalIndex) {
      require.cache[indexPath] = originalIndex;
    }
    if (originalProcessClient) {
      require.cache[processClientPath] = originalProcessClient;
    } else {
      delete require.cache[processClientPath];
    }
    if (originalProjectSettings) {
      require.cache[projectSettingsPath] = originalProjectSettings;
    } else {
      delete require.cache[projectSettingsPath];
    }
    if (originalIpcServer) {
      require.cache[ipcServerPath] = originalIpcServer;
    } else {
      delete require.cache[ipcServerPath];
    }
  }
});
