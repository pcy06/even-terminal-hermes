import type { ServerResponse } from "node:http";

/**
 * Even Terminal currently exposes two provider labels to the mobile app.
 *
 * Hermes is not one of the upstream labels, so this bridge defaults to
 * `codex` to reuse the app's richer agent UI while preserving the same wire
 * shapes as the official package.
 */
export type EvenProvider = "claude" | "codex" | (string & {});

/** Runtime state values used by `/api/status` and `status` SSE messages. */
export type SessionState = "idle" | "busy" | "awaiting";

/** Fine-grained UI phase states emitted by the official Codex provider. */
export type StatusState = SessionState | "think_start" | "think_end" | "text_start" | "text_end";

/** Minimal history item returned by `/api/sessions/:id/history`. */
export interface HistoryItem {
  role: "user" | "assistant" | (string & {});
  text: string;
}

/** Session list item returned by `GET /api/sessions`. */
export interface SessionListItem {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: EvenProvider;
  status: SessionState | null;
}

/**
 * `status` events tell the app whether to show busy/idle affordances.
 * The official package also uses `think_*` and `text_*` states for Codex.
 */
export interface StatusEvent {
  type: "status";
  state: StatusState;
  sessionId: string;
  provider: EvenProvider;
}

/** Echo of the user's prompt once a run starts. */
export interface UserPromptEvent {
  type: "user_prompt";
  text: string;
}

/** Incremental assistant text. The app concatenates these until `result`. */
export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

/** Tool lifecycle start event. */
export interface ToolStartEvent {
  type: "tool_start";
  name: string;
  toolId: string;
}

/** Tool lifecycle completion event with optional structured detail. */
export interface ToolEndEvent {
  type: "tool_end";
  name: string;
  toolId: string;
  summary: string;
  detail?: unknown;
}

/** User-facing permission option expected by the Even app. */
export interface PermissionOption {
  text: string;
  key: "allow" | "allowAlways" | "deny" | (string & {});
}

/** Permission prompt shown when Hermes asks before running a risky action. */
export interface PermissionRequestEvent {
  type: "permission_request";
  toolName: string;
  description: string;
  detail: string;
  toolUseId: string;
  options: PermissionOption[];
  suggestions: unknown;
}

/** Permission result notification after the user or bridge resolves a prompt. */
export interface PermissionResultEvent {
  type: "permission_result";
  toolName: string;
  summary: string;
  decision: "allowed" | "always" | "denied";
}

/** Question field descriptor used by the official Codex provider. */
export interface UserQuestion {
  id?: string;
  header?: string;
  label?: string;
  question: string;
  type?: string;
  options?: Array<{
    label: string;
    value?: string;
    description?: string;
    preview?: string;
  }>;
}

/** Request for user input beyond a yes/no permission. */
export interface UserQuestionEvent {
  type: "user_question";
  questions: UserQuestion[];
  toolUseId: string;
}

/** Echo of user-provided answers. */
export interface QuestionAnswerEvent {
  type: "question_answer";
  answers: Record<string, unknown>;
}

/** Periodic running statistics while a turn is busy. */
export interface RunningStatsEvent {
  type: "running_stats";
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Generic notification event. Kept for compatibility, but not used for Hermes reasoning. */
export interface NotificationEvent {
  type: "notification";
  title: string;
  message: string;
}

/** Progress update for long-running background tasks. */
export interface TaskProgressEvent {
  type: "task_progress";
  completed?: number;
  current?: string;
  title?: string;
  message?: string;
  total?: number;
  percent?: number;
}

/** Final turn event. Token fields are explicit to avoid app-side fallback guesses. */
export interface ResultEvent {
  type: "result";
  success: boolean;
  text: string;
  sessionId: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  provider: EvenProvider;
}

/** Error event for failed bridge/Hermes operations. */
export interface ErrorEvent {
  type: "error";
  message: string;
}

/** Complete Even Terminal SSE message union observed in the npm package. */
export type EvenMessage =
  | StatusEvent
  | UserPromptEvent
  | TextDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | PermissionRequestEvent
  | PermissionResultEvent
  | UserQuestionEvent
  | QuestionAnswerEvent
  | RunningStatsEvent
  | NotificationEvent
  | TaskProgressEvent
  | ResultEvent
  | ErrorEvent;

/** Ring-buffer entry with the SSE id assigned by the bridge. */
export interface BufferedMessage {
  id: number;
  msg: EvenMessage;
}

/** Connected SSE client response. */
export type SseClient = ServerResponse;

/** Persisted session shape on disk. */
export interface PersistedSession {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  status: SessionState;
  history: HistoryItem[];
}

/** Runtime token counters for the active turn. */
export interface TokenCounters {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Pending permission state tied to the active Hermes run. */
export interface PendingPermission {
  runId: string | null;
  toolName: string;
  description: string;
}

/** Pending user-input request mirrored back through `/api/question-response`. */
export interface PendingQuestion {
  runId: string | null;
  toolUseId: string;
  questions: UserQuestion[];
}

/** Runtime bridge options after env/CLI parsing. */
export interface BridgeOptions {
  port: number;
  host: string;
  token: string;
  name: string;
  cwd: string;
  stateDir: string;
  hermesUrl: string;
  hermesKey: string;
  hermesCommand: string;
  autoStartHermes: boolean;
  replaceHermes: boolean;
  instructions: string;
  instructionsFile: string;
  wireProvider: EvenProvider;
  verbose: boolean;
  help?: boolean;
}

/** Hermes health-check result. */
export type HealthResult =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; error?: string };

/** Parsed server-sent event from Hermes. */
export interface ParsedSseEvent {
  event: string;
  data: string;
  json: unknown | null;
}

/** Minimal run-start parameters for Hermes `/v1/runs`. */
export interface StartRunParams {
  sessionId: string;
  text: string;
  instructions: string;
}
