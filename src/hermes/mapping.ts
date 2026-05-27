import type {
  EvenMessage,
  PermissionResultEvent,
  TaskProgressEvent,
  UserQuestion,
} from "../types.js";
import { preview } from "../utils.js";
import type { HermesEvent } from "./types.js";

/** Return the canonical Hermes event name from either supported field. */
export function hermesEventType(event: HermesEvent): string {
  return String(event.event || event.type || "message");
}

/** Build a user-facing approval description from Hermes' best available data. */
export function describeApproval(event: HermesEvent): string {
  return preview(
    event.description ||
    event.preview ||
    event.command ||
    event.tool ||
    event.message ||
    "Hermes is requesting permission",
  );
}

/** Build the detail field shown under an Even permission request. */
export function approvalDetail(event: HermesEvent): string {
  if (event.command) {
    return preview(event.command);
  }
  if (event.preview) {
    return preview(event.preview);
  }
  if (event.path) {
    return preview(event.path);
  }
  return preview(JSON.stringify(event));
}

/** Convert Even's permission decisions to Hermes API approval choices. */
export function decisionToHermesChoice(decision: string): string {
  switch (decision) {
    case "allow":
    case "once":
    case "approve":
      return "once";
    case "allowAlways":
    case "session":
      return "session";
    case "always":
      return "always";
    case "deny":
    default:
      return "deny";
  }
}

/** Normalize Hermes approval choices back to Even's display decisions. */
export function hermesChoiceToEvenDecision(choice: unknown): PermissionResultEvent["decision"] {
  if (choice === "deny") {
    return "denied";
  }
  if (choice === "always") {
    return "always";
  }
  return "allowed";
}

/** Convert generic Hermes notification-like events when they are safe to show. */
export function mapHermesNotification(event: HermesEvent): EvenMessage | null {
  if (hermesEventType(event) === "reasoning.available") {
    // Important contract mismatch:
    // - Hermes /v1/runs currently emits `reasoning.available.text` from the
    //   tool-progress path, where the text may be assistant_message.content.
    // - Even Terminal has no distinct `reasoning` SSE message type; if we map
    //   this to `notification`, the Even App renders a visible "Reasoning"
    //   block even when the payload is actually the final answer.
    // Keep the event out of notifications until Hermes exposes true reasoning
    // via a dedicated stream such as `reasoning.delta`.
    return null;
  }
  return {
    type: "notification",
    title: String(event.title || "Hermes"),
    message: String(event.message || event.preview || event.text || "Hermes event"),
  };
}

/** Convert Hermes progress-like events to Even's `task_progress` message. */
export function mapHermesTaskProgress(event: HermesEvent): TaskProgressEvent {
  const completed = numericField(event, "completed", "done", "current_index");
  const total = numericField(event, "total", "count", "max");
  const percent = numericField(event, "percent", "percentage");
  const current = event.current ?? event.item ?? event.subject ?? event.message;
  return {
    type: "task_progress",
    ...(completed === undefined ? {} : { completed }),
    ...(current === undefined ? {} : { current: String(current) }),
    ...(event.title === undefined ? {} : { title: String(event.title) }),
    ...(event.message === undefined ? {} : { message: String(event.message) }),
    ...(total === undefined ? {} : { total }),
    ...(percent === undefined ? {} : { percent }),
  };
}

/** Normalize Hermes user-input requests to the Even question schema. */
export function mapHermesUserQuestion(event: HermesEvent): { questions: UserQuestion[]; toolUseId: string } {
  const rawQuestions = Array.isArray(event.questions) ? event.questions : [event];
  const questions = rawQuestions.map((raw, index) => normalizeQuestion(raw, index));
  return {
    questions,
    toolUseId: String(event.toolUseId || event.tool_use_id || event.request_id || event.id || event.run_id || ""),
  };
}

/** Preserve structured answers when Even posts `/api/question-response`. */
export function extractQuestionAnswers(body: Record<string, unknown>): Record<string, unknown> {
  if (body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)) {
    return body.answers as Record<string, unknown>;
  }
  if ("answer" in body) {
    return { answer: body.answer };
  }
  return { answer: "skip" };
}

function normalizeQuestion(raw: unknown, index: number): UserQuestion {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const id = stringField(source, "id", "name", "key");
  const header = stringField(source, "header", "title", "label");
  const question = stringField(source, "question", "prompt", "message", "text") || "Please provide input";
  const type = stringField(source, "type", "kind");
  const rawOptions = Array.isArray(source.options) ? source.options : [];
  const options = rawOptions.map((option) => normalizeQuestionOption(option));
  return {
    ...(id ? { id } : { id: `q${index + 1}` }),
    ...(header ? { header, label: header } : {}),
    question,
    ...(type ? { type } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}

function normalizeQuestionOption(raw: unknown): NonNullable<UserQuestion["options"]>[number] {
  if (typeof raw === "string") {
    return { label: raw, value: raw };
  }
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const label = stringField(source, "label", "text", "name") || "Option";
  const value = stringField(source, "value", "key", "id");
  const description = stringField(source, "description", "detail");
  const optionPreview = stringField(source, "preview", "summary");
  return {
    label,
    ...(value ? { value } : {}),
    ...(description ? { description } : {}),
    ...(optionPreview ? { preview: optionPreview } : {}),
  };
}

function numericField(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}
