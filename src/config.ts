import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_HERMES_URL,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_WIRE_PROVIDER,
} from "./constants.js";
import type { BridgeOptions } from "./types.js";

/** Human-readable CLI help kept close to parser flags so they stay in sync. */
export function usage(): string {
  return `even-hermes-terminal [options]

Even Terminal compatible server backed by local Hermes Agent.

Options:
  -p, --port <n>              Server port (default: 3456)
  --host <addr>               Bind address (default: 0.0.0.0)
  -t, --token <str>           Even App auth token (default: generated)
  -n, --name <str>            Display name in pairing URL
  -d, --cwd <path>            Project directory for bridge state
  --state-dir <path>          Persistent bridge state directory
  --hermes-url <url>          Hermes API base URL (default: http://127.0.0.1:8642)
  --hermes-key <str>          Hermes API bearer token, if configured
  --hermes-command <cmd>      Local Hermes command for auto-start (default: hermes)
  --auto-start-hermes         Start a separate local Hermes gateway if API is unreachable
  --no-auto-start-hermes      Require an already-running Hermes API server (default)
  --replace-hermes            Pass --replace when auto-starting Hermes gateway
  --instructions <text>       Per-bridge instructions sent with each Hermes run
  --instructions-file <path>  Read per-bridge instructions from a text file
  --wire-provider <name>      Provider value sent to Even App (default: codex)
  --verbose                   Print Hermes and SSE details
  -h, --help                  Show help
`;
}

/** Parse env and CLI flags into one immutable runtime configuration object. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeOptions {
  const options: BridgeOptions = {
    port: Number(env.PORT || DEFAULT_PORT),
    host: env.HOST || DEFAULT_HOST,
    token: env.BRIDGE_TOKEN || randomBytes(16).toString("hex"),
    name: env.EVEN_TERMINAL_NAME || "Hermes Agent",
    cwd: resolve(env.PROJECT_DIR || process.cwd()),
    stateDir: env.EVEN_HERMES_STATE_DIR || "",
    hermesUrl: env.HERMES_API_BASE_URL || env.API_SERVER_BASE_URL || DEFAULT_HERMES_URL,
    hermesKey: env.HERMES_API_KEY || env.API_SERVER_KEY || "",
    hermesCommand: env.HERMES_COMMAND || "hermes",
    autoStartHermes: env.HERMES_AUTO_START === "1",
    replaceHermes: env.HERMES_REPLACE === "1",
    instructions: env.EVEN_HERMES_INSTRUCTIONS || env.HERMES_BRIDGE_INSTRUCTIONS || "",
    instructionsFile: env.EVEN_HERMES_INSTRUCTIONS_FILE || "",
    wireProvider: env.EVEN_WIRE_PROVIDER || DEFAULT_WIRE_PROVIDER,
    verbose: env.VERBOSE === "1",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--port" || arg === "-p") {
      options.port = Number(next());
    } else if (arg === "--host") {
      options.host = next();
    } else if (arg === "--token" || arg === "-t") {
      options.token = next();
    } else if (arg === "--name" || arg === "-n") {
      options.name = next();
    } else if (arg === "--cwd" || arg === "-d") {
      options.cwd = resolve(next());
    } else if (arg === "--state-dir") {
      options.stateDir = resolve(next());
    } else if (arg === "--hermes-url") {
      options.hermesUrl = next();
    } else if (arg === "--hermes-key") {
      options.hermesKey = next();
    } else if (arg === "--hermes-command") {
      options.hermesCommand = next();
    } else if (arg === "--no-auto-start-hermes") {
      options.autoStartHermes = false;
    } else if (arg === "--auto-start-hermes") {
      options.autoStartHermes = true;
    } else if (arg === "--replace-hermes") {
      options.replaceHermes = true;
    } else if (arg === "--instructions") {
      options.instructions = next();
    } else if (arg === "--instructions-file") {
      options.instructionsFile = resolve(next());
    } else if (arg === "--wire-provider") {
      options.wireProvider = next();
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return normalizeOptions(options);
}

/** Apply derived defaults, read instruction files, and enforce safety guards. */
export function normalizeOptions(raw: BridgeOptions): BridgeOptions {
  const options = { ...raw };
  options.cwd = resolve(options.cwd || process.cwd());
  options.stateDir = resolve(options.stateDir || join(options.cwd, ".even-hermes-terminal"));
  options.hermesUrl = String(options.hermesUrl || DEFAULT_HERMES_URL).replace(/\/+$/, "");
  if (options.instructionsFile) {
    options.instructions = readFileSync(resolve(options.instructionsFile), "utf8").trim();
  }
  validateOptions(options);
  return options;
}

/** Refuse ambiguous or destructive combinations before the server starts. */
export function validateOptions(options: BridgeOptions): void {
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (options.replaceHermes && !options.autoStartHermes) {
    throw new Error("--replace-hermes requires --auto-start-hermes");
  }
}
