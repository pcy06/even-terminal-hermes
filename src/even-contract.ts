/**
 * Authoritative checklist of Even Terminal API endpoints implemented here.
 *
 * Keeping the list in code gives tests and future maintainers one place to
 * compare against `@evenrealities/even-terminal` when the upstream contract
 * changes.
 */
export const EVEN_STANDARD_ENDPOINTS = [
  "GET /api/events",
  "GET /api/sessions",
  "GET /api/info",
  "GET /api/update-check",
  "POST /api/prompt",
  "POST /api/permission-response",
  "POST /api/question-response",
  "POST /api/interrupt",
  "GET /api/status",
  "GET /api/messages",
  "GET /api/debug/thread/:id",
  "GET /api/debug/status/:id",
  "GET /api/sessions/:id/history",
  "GET /api/metrics",
] as const;

/** Standard SSE message names observed in Even Terminal 0.7.9. */
export const EVEN_STANDARD_MESSAGE_TYPES = [
  "status",
  "user_prompt",
  "text_delta",
  "tool_start",
  "tool_end",
  "permission_request",
  "permission_result",
  "user_question",
  "question_answer",
  "running_stats",
  "task_progress",
  "notification",
  "result",
  "error",
] as const;
