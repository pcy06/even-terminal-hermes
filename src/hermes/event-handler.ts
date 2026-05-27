import {
  approvalDetail,
  describeApproval,
  extractQuestionAnswers,
  hermesChoiceToEvenDecision,
  hermesEventType,
  mapHermesNotification,
  mapHermesTaskProgress,
  mapHermesUserQuestion,
} from "./mapping.js";
import type { HermesEvent } from "./types.js";
import type { EvenProvider } from "../types.js";
import type { Session } from "../session/session.js";
import { approximateTokens } from "../utils.js";

export interface HermesEventHandlerOptions {
  provider: EvenProvider;
  verbose: boolean;
  finishSession(session: Session, success: boolean, text: string, usage: unknown): void;
}

/**
 * Owns the Hermes -> Even Terminal event translation table.
 *
 * Keeping this out of the HTTP bridge makes it easier to audit the upstream
 * message contract separately from route handling and process lifecycle code.
 */
export class HermesEventHandler {
  constructor(private readonly options: HermesEventHandlerOptions) {}

  /** Translate one Hermes event into zero or more Even Terminal messages. */
  async handle(session: Session, event: HermesEvent): Promise<void> {
    const type = hermesEventType(event);
    if (type === "message.delta") {
      this.handleTextDelta(session, event);
      return;
    }
    if (type === "reasoning.started" || type === "reasoning.start" || type === "think_start") {
      session.push({ type: "status", state: "think_start", sessionId: session.id, provider: this.options.provider });
      return;
    }
    if (type === "reasoning.completed" || type === "reasoning.end" || type === "think_end") {
      session.push({ type: "status", state: "think_end", sessionId: session.id, provider: this.options.provider });
      return;
    }
    if (type === "tool.started") {
      session.push({
        type: "tool_start",
        name: String(event.tool || event.toolName || "tool"),
        toolId: String(event.tool_call_id || event.toolCallId || event.tool || event.timestamp || ""),
      });
      return;
    }
    if (type === "tool.completed") {
      session.push({
        type: "tool_end",
        name: String(event.tool || event.toolName || "tool"),
        toolId: String(event.tool_call_id || event.toolCallId || event.tool || event.timestamp || ""),
        summary: String(event.preview || event.summary || event.tool || "Tool completed"),
        detail: event,
      });
      return;
    }
    if (type === "reasoning.available") {
      // Do not route this through Even's `notification` type. The current
      // Hermes /v1/runs API uses tool_progress_callback for this event, and
      // the payload can be copied from assistant_message.content rather than
      // from a true reasoning channel. Mapping it to a notification makes the
      // Even App render a fake "Reasoning" block that duplicates the final
      // assistant output.
      const maybeMessage = mapHermesNotification(event);
      if (maybeMessage) {
        session.push(maybeMessage);
      }
      return;
    }
    if (type === "notification" || type === "notice" || type === "system.notification") {
      const maybeMessage = mapHermesNotification(event);
      if (maybeMessage) {
        session.push(maybeMessage);
      }
      return;
    }
    if (type === "task.progress" || type === "progress" || type === "todo.progress") {
      session.push(mapHermesTaskProgress(event));
      return;
    }
    if (type === "question.request" || type === "user_question" || type === "input.request") {
      this.handleQuestionRequest(session, event);
      return;
    }
    if (type === "question.answered") {
      session.status = "busy";
      session.pendingQuestion = null;
      session.push({ type: "question_answer", answers: extractQuestionAnswers(event) });
      session.push({ type: "status", state: "busy", sessionId: session.id, provider: this.options.provider });
      return;
    }
    if (type === "approval.request") {
      this.handleApprovalRequest(session, event);
      return;
    }
    if (type === "approval.responded") {
      this.handleApprovalResponded(session, event);
      return;
    }
    if (type === "run.completed") {
      this.options.finishSession(session, true, String(event.output || session.currentAssistantText || ""), event.usage || {});
      return;
    }
    if (type === "run.failed") {
      this.options.finishSession(session, false, String(event.error || "Hermes run failed"), {});
      return;
    }
    if (type === "run.cancelled") {
      this.options.finishSession(session, false, "Interrupted by user", {});
      return;
    }
    if (type === "run.stopping") {
      session.push({ type: "status", state: "busy", sessionId: session.id, provider: this.options.provider });
      return;
    }
    if (this.options.verbose) {
      console.log(`[hermes-event] ${JSON.stringify(event)}`);
    }
  }

  private handleTextDelta(session: Session, event: HermesEvent): void {
    const text = String(event.delta ?? event.text ?? "");
    if (!text) {
      return;
    }
    if (!session.textStarted) {
      session.textStarted = true;
      session.push({ type: "status", state: "text_start", sessionId: session.id, provider: this.options.provider });
    }
    session.currentAssistantText += text;
    session.tokens.outputTokens += approximateTokens(text);
    session.tokens.totalTokens = session.tokens.inputTokens + session.tokens.outputTokens + session.tokens.reasoningTokens;
    session.push({ type: "text_delta", text });
  }

  private handleQuestionRequest(session: Session, event: HermesEvent): void {
    session.status = "awaiting";
    const { questions, toolUseId } = mapHermesUserQuestion(event);
    session.pendingQuestion = {
      runId: String(event.run_id || session.currentRunId || ""),
      toolUseId,
      questions,
    };
    session.push({ type: "status", state: "awaiting", sessionId: session.id, provider: this.options.provider });
    session.push({ type: "user_question", questions, toolUseId });
  }

  private handleApprovalRequest(session: Session, event: HermesEvent): void {
    session.status = "awaiting";
    const description = describeApproval(event);
    session.pendingPermission = {
      runId: String(event.run_id || session.currentRunId || ""),
      toolName: String(event.tool || event.tool_name || event.command || "Hermes"),
      description,
    };
    session.push({ type: "status", state: "awaiting", sessionId: session.id, provider: this.options.provider });
    session.push({
      type: "permission_request",
      toolName: session.pendingPermission.toolName,
      description,
      detail: approvalDetail(event),
      toolUseId: String(event.approval_id || event.run_id || session.currentRunId || ""),
      options: [
        { text: "Yes, just this once", key: "allow" },
        { text: "Yes, for this session", key: "allowAlways" },
        { text: "No", key: "deny" },
      ],
      suggestions: event,
    });
  }

  private handleApprovalResponded(session: Session, event: HermesEvent): void {
    session.status = "busy";
    if (session.pendingPermission) {
      session.push({
        type: "permission_result",
        toolName: session.pendingPermission.toolName,
        summary: session.pendingPermission.description,
        decision: hermesChoiceToEvenDecision(event.choice),
      });
    }
    session.pendingPermission = null;
    session.push({ type: "status", state: "busy", sessionId: session.id, provider: this.options.provider });
  }
}
