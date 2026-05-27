import { randomBytes } from "node:crypto";
import {
  MAX_HISTORY_ITEMS,
  MAX_MESSAGES_PER_SESSION,
  RUNNING_STATS_INTERVAL_MS,
} from "../constants.js";
import type {
  BufferedMessage,
  EvenMessage,
  HistoryItem,
  PendingPermission,
  PendingQuestion,
  PersistedSession,
  SessionState,
  SseClient,
  TokenCounters,
} from "../types.js";

export interface SessionOwner {
  readonly verbose: boolean;
  persist(): void;
}

/**
 * Runtime session model shared by all API routes.
 *
 * Even Terminal treats sessions as both resumable history entries and live SSE
 * streams. This object owns the ring buffer used by `/api/messages` and replay
 * on `/api/events?needReplay=true`.
 */
export class Session {
  readonly id: string;
  title: string;
  timestamp: string;
  cwd: string;
  status: SessionState;
  history: HistoryItem[];
  readonly messages: BufferedMessage[] = [];
  readonly clients = new Set<SseClient>();
  nextId = 1;
  readonly queue: string[] = [];
  currentRunId: string | null = null;
  currentAssistantText = "";
  runningStartedAt = 0;
  textStarted = false;
  tokens: TokenCounters = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  pendingPermission: PendingPermission | null = null;
  pendingQuestion: PendingQuestion | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(data: Partial<PersistedSession>, private readonly owner: SessionOwner, fallbackCwd: string) {
    this.id = data.id || `hermes-${randomBytes(8).toString("hex")}`;
    this.title = data.title || "";
    this.timestamp = data.timestamp || new Date().toISOString();
    this.cwd = data.cwd || fallbackCwd;
    this.status = data.status || "idle";
    this.history = Array.isArray(data.history) ? data.history : [];
  }

  /** Persistable view used by `StateStore`. */
  toJSON(): PersistedSession {
    return {
      id: this.id,
      title: this.title,
      timestamp: this.timestamp,
      cwd: this.cwd,
      status: this.status === "busy" ? "idle" : this.status,
      history: this.history.slice(-MAX_HISTORY_ITEMS),
    };
  }

  /** Add a message to the ring buffer and broadcast it to connected SSE clients. */
  push(msg: EvenMessage): number {
    const id = this.nextId++;
    this.messages.push({ id, msg });
    if (this.messages.length > MAX_MESSAGES_PER_SESSION) {
      this.messages.shift();
    }
    const data = JSON.stringify(msg);
    for (const res of [...this.clients]) {
      try {
        res.write(`id: ${id}\ndata: ${data}\n\n`);
      } catch {
        this.clients.delete(res);
      }
    }
    if (this.owner.verbose) {
      console.log(`[SSE ${this.id}] ${data}`);
    }
    return id;
  }

  /** Start Even Terminal's standard 10s running statistics heartbeat. */
  startRunningStats(): void {
    this.stopRunningStats();
    this.statsTimer = setInterval(() => this.emitRunningStats(), RUNNING_STATS_INTERVAL_MS);
  }

  /** Stop the running statistics heartbeat when a turn finishes or aborts. */
  stopRunningStats(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /** Emit the upstream `running_stats` event shape observed in Even Terminal. */
  emitRunningStats(): void {
    if (this.status !== "busy" && this.status !== "awaiting") {
      this.stopRunningStats();
      return;
    }
    this.push({
      type: "running_stats",
      durationMs: this.runningStartedAt ? Date.now() - this.runningStartedAt : 0,
      inputTokens: this.tokens.inputTokens,
      outputTokens: this.tokens.outputTokens,
    });
  }

  /** Return messages newer than the caller's last seen SSE id. */
  messagesAfter(after: number): Array<{ id: number } & EvenMessage> {
    return this.messages
      .filter((entry) => entry.id > after)
      .map((entry) => ({ id: entry.id, ...entry.msg }));
  }

  /** Append compact user/assistant history for `/history` and title generation. */
  appendHistory(role: HistoryItem["role"], text: string): void {
    if (!text.trim()) {
      return;
    }
    this.history.push({ role, text });
    if (this.history.length > MAX_HISTORY_ITEMS) {
      this.history.splice(0, this.history.length - MAX_HISTORY_ITEMS);
    }
    if (!this.title && role === "user") {
      this.title = text.replace(/\s+/g, " ").trim().slice(0, 64);
    }
    this.timestamp = new Date().toISOString();
    this.owner.persist();
  }
}
