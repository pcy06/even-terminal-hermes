import type { IncomingMessage, ServerResponse } from "node:http";

/** CORS contract copied from the Even Terminal package. */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
  };
}

/** JSON response helper that keeps route handlers small and consistent. */
export function jsonResponse(res: ServerResponse, statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(bytes);
}

/** Parse a small JSON request body. Empty bodies are treated as `{}`. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/** Extract an auth bearer or query token exactly like Even Terminal. */
export function requestToken(req: IncomingMessage, url: URL): string {
  const header = req.headers.authorization || "";
  const queryToken = url.searchParams.get("token") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : queryToken;
}

/** Safely coerce unknown errors to messages for JSON responses and logs. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
