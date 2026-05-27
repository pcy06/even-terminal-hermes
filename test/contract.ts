import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVEN_STANDARD_ENDPOINTS, EVEN_STANDARD_MESSAGE_TYPES } from "../src/even-contract.js";
import { createEvenHermesBridge } from "../src/index.js";

const TOKEN = "test-token";
const UPSTREAM_VERSION = "0.7.9";
const LOCAL_UPSTREAM_TARBALL = `evenrealities-even-terminal-${UPSTREAM_VERSION}.tgz`;

interface FakeRun {
  input: unknown;
  instructions: unknown;
  approvalResolved: boolean;
  approvalResponse: Record<string, unknown> | null;
}

interface JsonResponse<T = unknown> {
  response: Response;
  body: T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
  });
  res.end(bytes);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

async function startFakeHermes(): Promise<{
  url: string;
  runs: Map<string, FakeRun>;
  close: () => Promise<void>;
}> {
  const runs = new Map<string, FakeRun>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://fake-hermes");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", platform: "hermes-agent" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, { object: "list", data: [{ id: "hermes-agent" }] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/capabilities") {
      sendJson(res, 200, {
        object: "hermes.api_server.capabilities",
        model: "hermes-agent",
        features: { run_submission: true, run_events_sse: true, run_approval_response: true },
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = await readJson(req);
      const runId = `run_${runs.size + 1}`;
      runs.set(runId, {
        input: body.input,
        instructions: body.instructions,
        approvalResolved: false,
        approvalResponse: null,
      });
      sendJson(res, 202, { run_id: runId, status: "started" });
      return;
    }
    const approvalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/approval$/);
    if (req.method === "POST" && approvalMatch?.[1]) {
      const run = runs.get(approvalMatch[1]);
      if (!run) {
        sendJson(res, 404, { error: { code: "run_not_found" } });
        return;
      }
      run.approvalResolved = true;
      run.approvalResponse = await readJson(req);
      sendJson(res, 200, {
        object: "hermes.run.approval_response",
        run_id: approvalMatch[1],
        choice: run.approvalResponse.choice,
        resolved: 1,
      });
      return;
    }
    const stopMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch?.[1]) {
      sendJson(res, 200, { run_id: stopMatch[1], status: "stopping" });
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch?.[1]) {
      const runId = eventsMatch[1];
      const run = runs.get(runId);
      if (!run) {
        sendJson(res, 404, { error: { code: "run_not_found" } });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const write = (event: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify({ run_id: runId, ...event })}\n\n`);
      };
      write({ event: "message.delta", delta: "Hello" });
      write({ event: "reasoning.available", text: "Hello from Hermes" });
      write({ event: "notification", title: "Notice", message: "Visible notice" });
      write({ event: "task.progress", completed: 1, total: 2, current: "Checking contract" });
      write({ event: "question.request", id: "tone", question: "Which tone?", options: ["brief", "detailed"] });
      write({ event: "tool.started", tool: "terminal", preview: "pwd" });
      write({ event: "tool.completed", tool: "terminal", preview: "pwd" });
      write({ event: "approval.request", tool: "terminal", command: "echo yes" });
      const started = Date.now();
      while (!run.approvalResolved && Date.now() - started < 5_000) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      write({ event: "approval.responded", choice: run.approvalResponse?.choice || "deny" });
      write({
        event: "run.completed",
        output: "Hello from Hermes",
        usage: { input_tokens: 3, output_tokens: 4 },
      });
      res.end(": stream closed\n\n");
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    runs,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function requestJson<T = Record<string, unknown>>(base: string, path: string, options: RequestInit = {}): Promise<JsonResponse<T>> {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return { response, body: (text ? JSON.parse(text) : null) as T };
}

async function waitFor<T>(predicate: () => Promise<T | false | null | undefined>, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function upstreamTarball(): { path: string; cleanup: () => void } {
  if (existsSync(LOCAL_UPSTREAM_TARBALL)) {
    return { path: LOCAL_UPSTREAM_TARBALL, cleanup: () => undefined };
  }
  const dir = mkdtempSync(join(tmpdir(), "even-terminal-upstream-"));
  const filename = execFileSync(
    "npm",
    ["pack", `@evenrealities/even-terminal@${UPSTREAM_VERSION}`, "--silent", "--pack-destination", dir],
    { encoding: "utf8" },
  ).trim().split("\n").at(-1);
  if (!filename) {
    throw new Error("Unable to download @evenrealities/even-terminal tarball");
  }
  return {
    path: join(dir, filename),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function upstreamFile(tarball: string, path: string): string {
  return execFileSync("tar", ["-xOf", tarball, path], { encoding: "utf8" });
}

function assertUpstreamContractSnapshot(): void {
  const tarball = upstreamTarball();
  try {
    const routes = [
      upstreamFile(tarball.path, "package/dist/routes/core.js"),
      upstreamFile(tarball.path, "package/dist/routes/events.js"),
    ].join("\n");
    const upstreamEndpoints = new Set<string>();
    for (const match of routes.matchAll(/router\.(get|post)\("([^"]+)"/g)) {
      const method = match[1]?.toUpperCase();
      const route = match[2];
      assert.ok(method);
      assert.ok(route);
      upstreamEndpoints.add(`${method} /api${route}`);
    }
    assert.deepEqual(new Set(EVEN_STANDARD_ENDPOINTS), upstreamEndpoints);

    const providers = [
      upstreamFile(tarball.path, "package/dist/claude/session.js"),
      upstreamFile(tarball.path, "package/dist/codex/session.js"),
    ].join("\n");
    const upstreamMessages = new Set<string>();
    for (const match of providers.matchAll(/send\(\{\s*type:\s*"([^"]+)"/gs)) {
      const messageType = match[1];
      assert.ok(messageType);
      upstreamMessages.add(messageType);
    }
    assert.deepEqual(new Set(EVEN_STANDARD_MESSAGE_TYPES), upstreamMessages);
  } finally {
    tarball.cleanup();
  }
}

async function main(): Promise<void> {
  assertUpstreamContractSnapshot();

  assert.throws(
    () => createEvenHermesBridge({ autoStartHermes: false, replaceHermes: true }),
    /--replace-hermes requires --auto-start-hermes/,
  );

  const fakeHermes = await startFakeHermes();
  const stateDir = mkdtempSync(join(tmpdir(), "even-hermes-terminal-"));
  const bridge = createEvenHermesBridge({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    hermesUrl: fakeHermes.url,
    autoStartHermes: false,
    instructions: "Answer briefly in plain text.",
    stateDir,
    wireProvider: "codex",
  });
  await bridge.listen();
  const bridgeAddress = bridge.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${bridgeAddress.port}`;

  try {
    const unauthorized = await fetch(`${base}/api/info`);
    assert.equal(unauthorized.status, 401);

    const info = await requestJson<{ model: string }>(base, "/api/info");
    assert.equal(info.response.status, 200);
    assert.equal(info.body.model, "hermes-agent");

    const prompt = await requestJson<{ sessionId: string }>(base, "/api/prompt", {
      method: "POST",
      body: JSON.stringify({ text: "Say hello" }),
    });
    assert.equal(prompt.response.status, 202);
    assert.ok(prompt.body.sessionId);

    const sessionId = prompt.body.sessionId;
    await waitFor(async () => {
      const messages = await requestJson<{ messages: Array<{ type: string }> }>(base, `/api/messages?sessionId=${encodeURIComponent(sessionId)}&after=0`);
      return messages.body.messages.some((msg) => msg.type === "permission_request") && messages.body;
    });

    const question = await requestJson(base, "/api/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answers: { tone: "brief" } }),
    });
    assert.equal(question.response.status, 200);

    const approval = await requestJson(base, "/api/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, decision: "allowAlways" }),
    });
    assert.equal(approval.response.status, 200);
    const firstRun = [...fakeHermes.runs.values()][0];
    if (!firstRun) {
      throw new Error("Expected fake Hermes to receive a run");
    }
    assert.equal(firstRun.instructions, "Answer briefly in plain text.");
    assert.equal(firstRun.approvalResponse?.choice, "session");

    const completed = await waitFor(async () => {
      const messages = await requestJson<{ messages: Array<Record<string, unknown>> }>(base, `/api/messages?sessionId=${encodeURIComponent(sessionId)}&after=0`);
      return messages.body.messages.find((msg) => msg.type === "result") && messages.body;
    });
    const result = completed.messages.find((msg) => msg.type === "result");
    if (!result) {
      throw new Error("Expected bridge to emit a result message");
    }
    assert.equal(result.success, true);
    assert.equal(result.text, "Hello from Hermes");
    assert.equal(completed.messages.some((msg) => msg.title === "Reasoning"), false);
    assert.equal(
      completed.messages.some((msg) => msg.type === "notification" && msg.message === "Hello from Hermes"),
      false,
    );
    assert.equal(completed.messages.some((msg) => msg.type === "notification"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "task_progress"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "user_question"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "question_answer"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "text_delta"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "tool_start"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "tool_end"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "permission_result"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "status" && msg.state === "text_start"), true);
    assert.equal(completed.messages.some((msg) => msg.type === "status" && msg.state === "text_end"), true);
    assert.equal(result.inputTokens, 3);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.reasoningTokens, 0);
    assert.equal(result.totalTokens, 7);

    const history = await requestJson<{ history: Array<{ role: string; text: string }> }>(base, `/api/sessions/${encodeURIComponent(sessionId)}/history`);
    assert.deepEqual(history.body.history.slice(-2), [
      { role: "user", text: "Say hello" },
      { role: "assistant", text: "Hello from Hermes" },
    ]);

    const status = await requestJson<{ state: string }>(base, `/api/status?sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(status.body.state, "idle");

    const metrics = await requestJson<{ evenTerminal: { endpoints: string[]; messageTypes: string[] } }>(base, "/api/metrics");
    assert.ok(metrics.body.evenTerminal.endpoints.includes("GET /api/events"));
    assert.ok(metrics.body.evenTerminal.messageTypes.includes("result"));

    console.log("contract ok");
  } finally {
    await bridge.close();
    await fakeHermes.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
