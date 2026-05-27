import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  HERMES_BOOT_TIMEOUT_MS,
  HERMES_HEALTH_TIMEOUT_MS,
} from "../constants.js";
import { parseSse } from "../sse.js";
import type { BridgeOptions, HealthResult, ParsedSseEvent, StartRunParams } from "../types.js";
import { delay } from "../utils.js";
import type {
  HermesCapabilitiesResponse,
  HermesModelsResponse,
  HermesRunResponse,
} from "./types.js";

/** Thin typed wrapper around Hermes Agent's local API server. */
export class HermesClient {
  private child: ChildProcess | null = null;
  private bootPromise: Promise<void> | null = null;
  private readonly port: number;

  constructor(private readonly options: BridgeOptions) {
    const url = new URL(options.hermesUrl);
    this.port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  }

  private headers(extra: HeadersInit = {}): HeadersInit {
    const headers: Record<string, string> = { ...(extra as Record<string, string>) };
    if (this.options.hermesKey) {
      headers.Authorization = `Bearer ${this.options.hermesKey}`;
    }
    return headers;
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.options.hermesUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers || {}),
    });
  }

  /** Check whether the configured Hermes API is reachable. */
  async health(): Promise<HealthResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HERMES_HEALTH_TIMEOUT_MS);
      const response = await fetch(`${this.options.hermesUrl}/health`, {
        signal: controller.signal,
        headers: this.headers(),
      });
      clearTimeout(timer);
      if (!response.ok) {
        return { ok: false, status: response.status };
      }
      return { ok: true, body: await response.json().catch(() => ({})) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Ensure Hermes is reachable, optionally starting a separate API gateway. */
  async ensureReady(): Promise<void> {
    const health = await this.health();
    if (health.ok) {
      return;
    }
    if (!this.options.autoStartHermes) {
      throw new Error(`Hermes API server is not reachable at ${this.options.hermesUrl}. This bridge will not start or replace Hermes Gateway unless --auto-start-hermes is set.`);
    }
    if (this.bootPromise) {
      return this.bootPromise;
    }
    this.bootPromise = this.startLocalHermes();
    try {
      await this.bootPromise;
    } finally {
      this.bootPromise = null;
    }
  }

  /** Explicit opt-in fallback for users who want the bridge to spawn Hermes. */
  private async startLocalHermes(): Promise<void> {
    if (this.child) {
      return;
    }
    console.log(`[hermes] starting local API server via ${this.options.hermesCommand} gateway run`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(this.port),
      HERMES_ACCEPT_HOOKS: "1",
    };
    if (this.options.hermesKey) {
      env.API_SERVER_KEY = this.options.hermesKey;
    }
    const args = ["gateway", "run", "--accept-hooks"];
    if (this.options.replaceHermes) {
      args.push("--replace");
    }
    const output: string[] = [];
    const child = spawn(this.options.hermesCommand, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString());
      if (this.options.verbose) {
        process.stdout.write(`[hermes] ${chunk.toString()}`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      process.stderr.write(`[hermes] ${text}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (code !== 0 && code !== null) {
        console.error(`[hermes] exited with code ${code}`);
      } else if (signal) {
        console.error(`[hermes] exited from signal ${signal}`);
      }
    });

    const started = Date.now();
    while (Date.now() - started < HERMES_BOOT_TIMEOUT_MS) {
      await delay(500);
      const health = await this.health();
      if (health.ok) {
        console.log(`[hermes] API server ready at ${this.options.hermesUrl}`);
        return;
      }
      if (child.exitCode !== null) {
        break;
      }
    }
    const details = output.join("").trim();
    const hint = details.includes("Gateway already running")
      ? " Existing Hermes gateway is already running without a reachable API server; expose the API on that daemon, or intentionally opt in with --auto-start-hermes --replace-hermes."
      : "";
    throw new Error(`Timed out waiting for Hermes API server at ${this.options.hermesUrl}.${hint}${details ? ` Hermes output: ${details}` : ""}`);
  }

  /** Return Even `/api/info` fields derived from Hermes health/capabilities. */
  async getInfo(): Promise<Record<string, unknown>> {
    await this.ensureReady();
    const [health, models, capabilities, version] = await Promise.all([
      this.health(),
      this.fetch("/v1/models").then((r) => r.ok ? r.json() as Promise<HermesModelsResponse> : null).catch(() => null),
      this.fetch("/v1/capabilities").then((r) => r.ok ? r.json() as Promise<HermesCapabilitiesResponse> : null).catch(() => null),
      hermesVersion(this.options.hermesCommand),
    ]);
    const model = models?.data?.[0]?.id || capabilities?.model || "hermes-agent";
    return {
      account: {},
      model,
      version: version || "Hermes Agent",
      provider: this.options.wireProvider,
      hermes: {
        url: this.options.hermesUrl,
        health: health.ok ? "ok" : "unreachable",
        capabilities: capabilities?.features || null,
      },
    };
  }

  /** Start a Hermes run and return its run id. */
  async startRun(params: StartRunParams): Promise<string> {
    await this.ensureReady();
    const body: Record<string, unknown> = {
      input: params.text,
      session_id: params.sessionId,
      model: "hermes-agent",
    };
    if (params.instructions) {
      body.instructions = params.instructions;
    }
    const response = await this.fetch("/v1/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hermes-Session-Id": params.sessionId,
        "X-Hermes-Session-Key": `even-terminal:${params.sessionId}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Hermes /v1/runs failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json() as HermesRunResponse;
    if (!data.run_id) {
      throw new Error("Hermes /v1/runs response did not include run_id");
    }
    return data.run_id;
  }

  /** Stream Hermes lifecycle events for a run. */
  async streamRun(runId: string, onEvent: (event: ParsedSseEvent) => Promise<void>): Promise<void> {
    await this.ensureReady();
    const response = await this.fetch(`/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Hermes run events failed: ${response.status} ${await response.text()}`);
    }
    await parseSse(response.body, onEvent);
  }

  /** Resolve a Hermes approval request. */
  async approval(runId: string, choice: string): Promise<unknown> {
    await this.ensureReady();
    const response = await this.fetch(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice }),
    });
    if (!response.ok) {
      throw new Error(`Hermes approval failed: ${response.status} ${await response.text()}`);
    }
    return response.json().catch(() => ({}));
  }

  /** Ask Hermes to stop an active run. */
  async stop(runId: string): Promise<unknown> {
    await this.ensureReady();
    const response = await this.fetch(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Hermes stop failed: ${response.status} ${await response.text()}`);
    }
    return response.json().catch(() => ({}));
  }

  close(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}

function hermesVersion(command: string): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(command, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolvePromise("");
        return;
      }
      resolvePromise(stdout.trim().split("\n")[0] || "");
    });
  });
}
