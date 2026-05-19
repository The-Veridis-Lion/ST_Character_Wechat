class WhereaboutsToolHost {
  constructor({ service }) {
    this.service = service;
  }

  listTools() {
    return [
      {
        name: "whereabouts_current_stay",
        description: "Show the current local location stay from ST Character WeChat local storage. Input: {}",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "whereabouts_snapshot",
        description: "Show recent local location stays and moves from ST Character WeChat local storage. Input: { stayLimit?: integer, moveLimit?: integer }",
        inputSchema: {
          type: "object",
          properties: {
            stayLimit: { type: "integer" },
            moveLimit: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "whereabouts_summary",
        description: "Summarize local location movement for a range. Input: { range?: string }",
        inputSchema: {
          type: "object",
          properties: {
            range: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async invokeTool(toolName, args = {}) {
    if (!this.service) {
      throw new Error("whereabouts service is not configured");
    }
    switch (toolName) {
      case "whereabouts_current_stay": {
        const currentStay = this.service.getCurrentStayForOutput(args);
        return {
          text: currentStay ? `Current stay: ${currentStay.address || "unknown"}` : "Current stay: unknown",
          data: { currentStay },
        };
      }
      case "whereabouts_snapshot": {
        const data = this.service.getSnapshot(args);
        return {
          text: `Whereabouts snapshot: ${(data.recentStays || []).length} stays, ${(data.recentMovementEvents || []).length} moves.`,
          data,
        };
      }
      case "whereabouts_summary": {
        const data = this.service.getSummary(args);
        return {
          text: `Whereabouts summary: ${data.mobilityState?.state || "unknown"}.`,
          data,
        };
      }
      default:
        throw new Error(`Unknown whereabouts tool: ${toolName}`);
    }
  }
}

module.exports = { WhereaboutsToolHost };
