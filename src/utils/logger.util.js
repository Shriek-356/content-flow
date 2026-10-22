import { EventEmitter } from "events";

/**
 * Logger Utility — Singleton
 * Ghi log ra terminal và stream tới Dashboard thông qua Server-Sent Events (SSE).
 */
class Logger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this._history = [];
    this._maxHistory = 200;
  }

  log(message, level = "info") {
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8); // "HH:MM:SS"

    const icon = {
      info: "ℹ️",
      success: "✅",
      error: "❌",
      warn: "⚠️"
    }[level] || "ℹ️";

    console.log(`[${timeStr}] ${icon} ${message}`);

    const entry = {
      ts: now.toISOString(),
      time: timeStr,
      level,
      message: String(message)
    };

    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    this.emit("log", entry);
  }

  getHistory() {
    return this._history;
  }

  subscribe(callback) {
    this.on("log", callback);
  }

  unsubscribe(callback) {
    this.off("log", callback);
  }
}

export const logger = new Logger();
