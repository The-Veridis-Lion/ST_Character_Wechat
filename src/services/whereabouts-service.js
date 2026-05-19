const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

class WhereaboutsService {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.server = null;
  }

  async startServer({ onAccepted } = {}) {
    if (this.server) {
      return this.server;
    }
    const host = this.config.host || "0.0.0.0";
    const port = Number.parseInt(String(this.config.port || "4318"), 10) || 4318;
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (this.config.token) {
          const token = req.headers.authorization?.replace(/^Bearer\s+/iu, "") || req.headers["x-location-token"];
          if (token !== this.config.token) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
        }
        const payload = await readJsonBody(req);
        const result = this.appendPoint(payload);
        if (typeof onAccepted === "function") {
          await onAccepted(result);
        }
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { error: error?.message || String(error) });
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    return this.server;
  }

  async closeServer() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  appendPoint(args = {}) {
    const point = {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      ...args,
    };
    const store = this.loadStore();
    store.points.push(point);
    const limit = Number.parseInt(String(this.config.historyLimit || "1000"), 10) || 1000;
    store.points = store.points.slice(-limit);
    this.saveStore(store);
    return {
      point,
      currentStay: this.formatPointAsStay(point),
      movementEvent: null,
    };
  }

  getSnapshot({ stayLimit = 5, moveLimit = 5 } = {}) {
    return {
      currentStay: this.getCurrentStayForOutput(),
      recentStays: this.getRecentStaysForOutput({ limit: stayLimit }).recentStays,
      recentMovementEvents: this.getRecentMovesForOutput({ limit: moveLimit }).recentMovementEvents,
    };
  }

  getCurrentStayForOutput() {
    const point = this.latestPoint();
    return point ? this.formatPointAsStay(point) : null;
  }

  getRecentStaysForOutput({ limit = 5 } = {}) {
    const points = this.loadStore().points.slice(-normalizeLimit(limit)).reverse();
    return {
      currentStay: this.getCurrentStayForOutput(),
      recentStays: points.map((point) => this.formatPointAsStay(point)),
      limit: normalizeLimit(limit),
    };
  }

  getRecentMovesForOutput({ limit = 5 } = {}) {
    return {
      currentStay: this.getCurrentStayForOutput(),
      recentMovementEvents: [],
      limit: normalizeLimit(limit),
    };
  }

  getSummary({ range = "day" } = {}) {
    const pointCount = this.loadStore().points.length;
    return {
      range,
      stayCount: pointCount ? 1 : 0,
      moveCount: 0,
      mobilityState: { state: pointCount ? "staying" : "unknown" },
      knownPlaces: [],
      batteryTrend: { sampleCount: 0, deltaPercent: 0 },
    };
  }

  latestPoint() {
    const points = this.loadStore().points;
    return points[points.length - 1] || null;
  }

  formatPointAsStay(point) {
    const address = point.address || point.place || point.placeTag || [
      point.latitude ?? point.lat,
      point.longitude ?? point.lng,
    ].filter((value) => value !== undefined && value !== "").join(", ");
    return {
      address: address || "Unknown location",
      enteredAt: point.receivedAt || point.timestamp || "",
      enteredAtLocal: point.localTime || point.receivedAt || point.timestamp || "",
      point,
    };
  }

  loadStore() {
    const filePath = this.config.storeFile;
    if (!filePath) {
      return { points: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return { points: Array.isArray(parsed.points) ? parsed.points : [] };
    } catch {
      return { points: [] };
    }
  }

  saveStore(store) {
    const filePath = this.config.storeFile;
    if (!filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  }
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

module.exports = { WhereaboutsService };
