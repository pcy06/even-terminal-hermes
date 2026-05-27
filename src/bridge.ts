import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION } from "./constants.js";
import { normalizeOptions, parseArgs } from "./config.js";
import { EVEN_STANDARD_ENDPOINTS, EVEN_STANDARD_MESSAGE_TYPES } from "./even-contract.js";
import { HermesClient } from "./hermes/client.js";
import {
  decisionToHermesChoice,
  extractQuestionAnswers,
  hermesChoiceToEvenDecision,
} from "./hermes/mapping.js";
import { HermesEventHandler } from "./hermes/event-handler.js";
import type { HermesEvent } from "./hermes/types.js";
import { corsHeaders, errorMessage, jsonResponse, readJson, requestToken } from "./http.js";
import { getLanAddress } from "./network.js";
import { Session } from "./session/session.js";
import { StateStore } from "./session/state-store.js";
import { attachEvenSseClient, missingSessionId } from "./sse.js";
import type {
  BridgeOptions,
  EvenMessage,
  HistoryItem,
  PersistedSession,
  SessionListItem,
  TokenCounters,
} from "./types.js";
import { currentUpdateInfo } from "./update.js";
import { approximateTokens, tokenCount } from "./utils.js";

/** Create a fully configured bridge from partial options, useful for tests. */
export function createEvenHermesBridge(rawOptions: Partial<BridgeOptions> = {}): EvenHermesBridge {
  const base = parseArgs([]);
  const options = normalizeOptions({ ...base, ...rawOptions });
  return new EvenHermesBridge(options);
}

/**
 * Production HTTP/SSE bridge that exposes the Even Terminal contract while
 * delegating actual agent execution to Hermes Agent's local API server.
 */
export class EvenHermesBridge {
  readonly server: Server;
  private readonly hermes: HermesClient;
  private readonly hermesEvents: HermesEventHandler;
  private readonly store: StateStore;
  private readonly sessions = new Map<string, Session>();

  constructor(readonly options: BridgeOptions) {
    this.hermes = new HermesClient(options);
    this.hermesEvents = new HermesEventHandler({
      provider: options.wireProvider,
      verbose: options.verbose,
      finishSession: (session, success, text, usage) => this.finishSession(session, success, text, usage),
    });
    this.store = new StateStore(options.stateDir);
    for (const data of this.store.load()) {
      const session = new Session(data, this, options.cwd);
      session.status = "idle";
      this.sessions.set(session.id, session);
    }
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        jsonResponse(res, 500, { error: errorMessage(error) });
      });
    });
  }

  get verbose(): boolean {
    return this.options.verbose;
  }

  /** Persist all resumable session metadata. */
  persist(): void {
    this.store.save(this.sessions.values());
  }

  /** Start listening and resolve once Node has bound the socket. */
  listen(): Promise<AddressInfo | string | null> {
    return new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolvePromise(this.server.address());
      });
    });
  }

  /** Close HTTP server and any bridge-owned Hermes child process. */
  close(): Promise<void> {
    this.hermes.close();
    return new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  private getOrCreateSession(id?: string, cwd?: string): Session {
    if (id && this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      if (!existing) {
        throw new Error(`Session disappeared while resolving ${id}`);
      }
      if (cwd) {
        existing.cwd = cwd;
      }
      return existing;
    }
    const data: Partial<PersistedSession> = {};
    if (id) {
      data.id = id;
    }
    if (cwd) {
      data.cwd = cwd;
    }
    const session = new Session(data, this, this.options.cwd);
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  private auth(req: IncomingMessage, url: URL): boolean {
    return requestToken(req, url) === this.options.token;
  }

  /** Top-level request handler, including CORS preflight and auth. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      jsonResponse(res, 200, this.rootInfo());
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }
    if (!this.auth(req, url)) {
      jsonResponse(res, 401, { error: "Unauthorized" });
      return;
    }
    await this.routeApi(req, res, url);
  }

  /** Basic machine-readable discovery endpoint at `/`. */
  private rootInfo(): Record<string, unknown> {
    return {
      name: "even-hermes-terminal",
      version: VERSION,
      provider: this.options.wireProvider,
      api: "/api",
      hermesUrl: this.options.hermesUrl,
      endpoints: EVEN_STANDARD_ENDPOINTS,
      messageTypes: EVEN_STANDARD_MESSAGE_TYPES,
    };
  }

  /** Explicit Even Terminal route table. Unknown methods/paths return 404. */
  private async routeApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/info") {
      jsonResponse(res, 200, await this.hermes.getInfo());
      return;
    }
    if (req.method === "GET" && path === "/api/update-check") {
      jsonResponse(res, 200, currentUpdateInfo());
      return;
    }
    if (req.method === "GET" && path === "/api/sessions") {
      this.handleSessions(res, url);
      return;
    }
    if (req.method === "POST" && path === "/api/prompt") {
      await this.handlePrompt(req, res);
      return;
    }
    if (req.method === "POST" && path === "/api/permission-response") {
      await this.handlePermissionResponse(req, res);
      return;
    }
    if (req.method === "POST" && path === "/api/question-response") {
      await this.handleQuestionResponse(req, res);
      return;
    }
    if (req.method === "POST" && path === "/api/interrupt") {
      await this.handleInterrupt(req, res);
      return;
    }
    if (req.method === "GET" && path === "/api/status") {
      this.handleStatus(res, url);
      return;
    }
    if (req.method === "GET" && path === "/api/messages") {
      this.handleMessages(res, url);
      return;
    }
    if (req.method === "GET" && path === "/api/events") {
      this.handleEvents(req, res, url);
      return;
    }
    const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (req.method === "GET" && historyMatch?.[1]) {
      this.handleHistory(res, historyMatch[1], url);
      return;
    }
    const debugThreadMatch = path.match(/^\/api\/debug\/thread\/([^/]+)$/);
    if (req.method === "GET" && debugThreadMatch?.[1]) {
      this.handleDebugThread(res, debugThreadMatch[1]);
      return;
    }
    const debugStatusMatch = path.match(/^\/api\/debug\/status\/([^/]+)$/);
    if (req.method === "GET" && debugStatusMatch?.[1]) {
      this.handleDebugStatus(res, debugStatusMatch[1]);
      return;
    }
    if (req.method === "GET" && path === "/api/metrics") {
      this.handleMetrics(res);
      return;
    }
    jsonResponse(res, 404, { error: "Not found" });
  }

  private handleSessions(res: ServerResponse, url: URL): void {
    const limit = Number(url.searchParams.get("limit") || 10);
    const sessions: SessionListItem[] = [...this.sessions.values()]
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        title: session.title || "Hermes session",
        timestamp: session.timestamp,
        cwd: session.cwd || "",
        provider: this.options.wireProvider,
        status: session.status,
      }));
    jsonResponse(res, 200, { sessions });
  }

  /** Accept Even App prompts, create/resume a bridge session, and queue if busy. */
  private async handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      jsonResponse(res, 400, { error: "Missing 'text' field" });
      return;
    }
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : this.options.cwd;
    const session = this.getOrCreateSession(
      typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined,
      cwd,
    );
    if (session.status === "busy" || session.status === "awaiting") {
      session.queue.push(text);
    } else {
      this.startPrompt(session, text).catch((error: unknown) => this.finishWithError(session, error));
    }
    jsonResponse(res, 202, {
      ok: true,
      sessionId: session.id,
      provider: this.options.wireProvider,
    });
  }

  /** Start a Hermes run and stream its lifecycle into Even messages. */
  private async startPrompt(session: Session, text: string): Promise<void> {
    session.status = "busy";
    session.currentAssistantText = "";
    session.runningStartedAt = Date.now();
    session.textStarted = false;
    session.pendingQuestion = null;
    session.tokens = {
      inputTokens: approximateTokens(text),
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: approximateTokens(text),
    };
    session.startRunningStats();
    session.push({ type: "user_prompt", text });
    session.appendHistory("user", text);
    session.push({ type: "status", state: "busy", sessionId: session.id, provider: this.options.wireProvider });

    const runId = await this.hermes.startRun({
      sessionId: session.id,
      text,
      instructions: this.options.instructions,
    });
    session.currentRunId = runId;
    this.persist();
    await this.hermes.streamRun(runId, async (event) => {
      await this.hermesEvents.handle(session, (event.json || { event: event.event, data: event.data }) as HermesEvent);
    });
    if (session.currentRunId === runId) {
      this.finishSession(session, false, session.currentAssistantText || "Hermes stream ended before the run completed", {});
    }
  }

  /** Emit a final result, persist history, and dispatch one queued prompt. */
  private finishSession(session: Session, success: boolean, text: string, usage: unknown): void {
    const finalText = text || session.currentAssistantText || "";
    if (finalText) {
      session.appendHistory("assistant", finalText);
    }
    session.stopRunningStats();
    if (session.textStarted) {
      session.push({ type: "status", state: "text_end", sessionId: session.id, provider: this.options.wireProvider });
      session.textStarted = false;
    }
    session.status = "idle";
    session.currentRunId = null;
    session.pendingPermission = null;
    session.pendingQuestion = null;
    const durationMs = session.runningStartedAt ? Date.now() - session.runningStartedAt : 0;
    const tokens: TokenCounters = {
      inputTokens: tokenCount(usage, "input_tokens", "inputTokens", "prompt_tokens"),
      outputTokens: tokenCount(usage, "output_tokens", "outputTokens", "completion_tokens"),
      reasoningTokens: tokenCount(usage, "reasoning_tokens", "reasoningTokens", "output_tokens_details.reasoning_tokens"),
      totalTokens: tokenCount(usage, "total_tokens", "totalTokens"),
    };
    tokens.totalTokens ||= tokens.inputTokens + tokens.outputTokens;
    session.tokens = tokens;
    session.push({
      type: "result",
      success,
      text: finalText,
      sessionId: session.id,
      costUsd: 0,
      turns: 1,
      durationMs,
      ...tokens,
      provider: this.options.wireProvider,
    });
    session.push({ type: "status", state: "idle", sessionId: session.id, provider: this.options.wireProvider });
    session.runningStartedAt = 0;
    this.persist();
    this.dispatchNext(session);
  }

  private finishWithError(session: Session, error: unknown): void {
    const message = errorMessage(error);
    session.push({ type: "error", message });
    this.finishSession(session, false, message, {});
  }

  private dispatchNext(session: Session): void {
    if (session.status !== "idle" || session.queue.length === 0) {
      return;
    }
    const next = session.queue.shift();
    if (next) {
      this.startPrompt(session, next).catch((error: unknown) => this.finishWithError(session, error));
    }
  }

  private async handlePermissionResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const session = this.sessions.get(String(body.sessionId));
    if (!session) {
      jsonResponse(res, 404, { error: "Session not found" });
      return;
    }
    const runId = session.pendingPermission?.runId || session.currentRunId;
    if (!runId) {
      jsonResponse(res, 409, { error: "Session has no active Hermes run" });
      return;
    }
    const choice = decisionToHermesChoice(String(body.decision || "deny"));
    const result = await this.hermes.approval(runId, choice);
    session.push({
      type: "permission_result",
      toolName: session.pendingPermission?.toolName || "Hermes",
      summary: session.pendingPermission?.description || "Permission response",
      decision: hermesChoiceToEvenDecision(choice),
    });
    session.pendingPermission = null;
    session.status = "busy";
    session.push({ type: "status", state: "busy", sessionId: session.id, provider: this.options.wireProvider });
    jsonResponse(res, 200, { ok: true, hermes: result });
  }

  private async handleQuestionResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const session = this.sessions.get(String(body.sessionId));
    if (!session) {
      jsonResponse(res, 404, { error: "Session not found" });
      return;
    }
    session.pendingQuestion = null;
    session.status = session.currentRunId ? "busy" : session.status;
    session.push({ type: "question_answer", answers: extractQuestionAnswers(body) });
    if (session.currentRunId) {
      session.push({ type: "status", state: "busy", sessionId: session.id, provider: this.options.wireProvider });
    }
    jsonResponse(res, 200, { ok: true });
  }

  private async handleInterrupt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body.sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const session = this.sessions.get(String(body.sessionId));
    if (!session) {
      jsonResponse(res, 404, { error: "Session not found" });
      return;
    }
    if (session.currentRunId) {
      await this.hermes.stop(session.currentRunId);
    }
    jsonResponse(res, 200, { ok: true });
  }

  private handleStatus(res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: "Session not found" });
      return;
    }
    jsonResponse(res, 200, { state: session.status, sessionId, provider: this.options.wireProvider });
  }

  private handleMessages(res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!sessionId) {
      jsonResponse(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const after = Number(url.searchParams.get("after") || 0);
    const session = this.sessions.get(sessionId);
    if (!session) {
      jsonResponse(res, 200, { messages: [], state: "idle", sessionId, provider: this.options.wireProvider });
      return;
    }
    jsonResponse(res, 200, {
      messages: session.messagesAfter(after),
      state: session.status,
      sessionId,
      provider: this.options.wireProvider,
    });
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!sessionId) {
      missingSessionId(res);
      return;
    }
    const session = this.getOrCreateSession(sessionId);
    attachEvenSseClient(req, res, session, url.searchParams.get("needReplay") === "true");
  }

  private handleHistory(res: ServerResponse, id: string, url: URL): void {
    const session = this.sessions.get(decodeURIComponent(id));
    const limit = Math.min(Number(url.searchParams.get("limit") || 10), 10);
    const history: HistoryItem[] = session ? session.history.slice(-limit) : [];
    jsonResponse(res, 200, { history });
  }

  private handleDebugThread(res: ServerResponse, id: string): void {
    const session = this.sessions.get(decodeURIComponent(id));
    jsonResponse(res, session ? 200 : 404, session ? {
      sessionId: session.id,
      title: session.title,
      status: session.status,
      cwd: session.cwd,
      history: session.history,
      messages: session.messages.map((entry) => ({ id: entry.id, ...entry.msg })),
    } : { error: "Session not found" });
  }

  private handleDebugStatus(res: ServerResponse, id: string): void {
    const session = this.sessions.get(decodeURIComponent(id));
    jsonResponse(res, 200, {
      sessionId: id,
      provider: this.options.wireProvider,
      status: session?.status || "idle",
      runId: session?.currentRunId || null,
      queuedPrompts: session?.queue.length || 0,
    });
  }

  private handleMetrics(res: ServerResponse): void {
    jsonResponse(res, 200, {
      hermes: {
        sessions: [...this.sessions.values()].map((session) => ({
          sessionId: session.id,
          status: session.status,
          runId: session.currentRunId,
          queuedPrompts: session.queue.length,
        })),
      },
      evenTerminal: {
        endpoints: EVEN_STANDARD_ENDPOINTS,
        messageTypes: EVEN_STANDARD_MESSAGE_TYPES,
      },
    });
  }

  /** Print the exact pairing URL the Even App expects. */
  printBanner(address: AddressInfo | string | null): void {
    const lan = getLanAddress();
    const localPort = typeof address === "object" && address ? address.port : this.options.port;
    const host = lan || "localhost";
    const params = new URLSearchParams({
      token: this.options.token,
      defaultProvider: String(this.options.wireProvider),
    });
    if (this.options.name) {
      params.set("name", this.options.name);
    }
    const pairUrl = `http://${host}:${localPort}?${params.toString()}`;
    console.log("");
    console.log(`Even Hermes Terminal v${VERSION}`);
    console.log(`Local:  http://localhost:${localPort}`);
    if (lan) {
      console.log(`LAN:    http://${lan}:${localPort}`);
    }
    console.log(`Hermes: ${this.options.hermesUrl}`);
    console.log(`Token:  ${this.options.token}`);
    console.log(`CWD:    ${this.options.cwd}`);
    console.log("");
    console.log(pairUrl);
    console.log("");
  }
}
