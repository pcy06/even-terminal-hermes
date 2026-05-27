import type { IncomingMessage, ServerResponse } from "node:http";
import { SSE_HEARTBEAT_MS } from "./constants.js";
import { corsHeaders, jsonResponse } from "./http.js";
import type { ParsedSseEvent } from "./types.js";
import type { Session } from "./session/session.js";

/** Parse Server-Sent Events from Hermes' `/v1/runs/:id/events` stream. */
export async function parseSse(body: AsyncIterable<Uint8Array>, onEvent: (event: ParsedSseEvent) => Promise<void> | void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = "";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const event: ParsedSseEvent = { event: eventName || "message", data: raw, json: null };
    eventName = "";
    try {
      event.json = JSON.parse(raw) as unknown;
    } catch {
      event.json = null;
    }
    await onEvent(event);
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const idx = buffer.search(/\r?\n/);
      if (idx === -1) {
        break;
      }
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(buffer[idx] === "\r" ? idx + 2 : idx + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        await dispatch();
      } else if (line.startsWith(":")) {
        continue;
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (buffer.trim() || dataLines.length > 0) {
    if (buffer.startsWith("data:")) {
      dataLines.push(buffer.slice(5).trimStart());
    }
    await dispatch();
  }
}

/** Attach one Even App SSE client and optionally replay the session ring buffer. */
export function attachEvenSseClient(req: IncomingMessage, res: ServerResponse, session: Session, needReplay: boolean): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
  });
  res.write(":ok\n\n");

  if (needReplay) {
    for (const entry of session.messages) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
    }
  }

  session.clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      session.clients.delete(res);
    }
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    session.clients.delete(res);
  });
}

/** Send the standard missing-session-id error used by Even Terminal. */
export function missingSessionId(res: ServerResponse): void {
  jsonResponse(res, 400, { error: "Missing 'sessionId' query parameter" });
}
