# Even Hermes Terminal

TypeScript bridge that exposes the `@evenrealities/even-terminal` HTTP/SSE
contract and forwards agent work to a local Hermes Agent API server.

The bridge is intentionally non-invasive by default: it does not start, stop,
replace, or rewrite an existing Hermes Gateway daemon. It only connects to the
Hermes API URL you configure.

## Status

This is a local-network bridge for pairing the Even App with a Hermes Agent API
server. The code is structured for public review, typed, and covered by a
contract test against the official `@evenrealities/even-terminal` package, but
it should not be exposed directly to the public internet. Put it behind a VPN,
Zero Trust tunnel, or authenticated HTTPS reverse proxy if remote access is
needed.

## Quick Start

```bash
npm install
npm run build
BRIDGE_TOKEN=mytoken123 HERMES_API_KEY="$API_SERVER_KEY" \
  npm start -- --host 0.0.0.0 --port 3456 --hermes-url http://127.0.0.1:8642
```

The server prints a pairing URL for the Even App:

```text
http://<lan-ip>:3456?token=<token>&defaultProvider=codex&name=Hermes+Agent
```

For glasses-friendly output, pass an instruction file:

```bash
npm start -- \
  --token mytoken123 \
  --hermes-url http://127.0.0.1:8642 \
  --instructions-file ./even-glasses-instructions.txt
```

## Hermes Safety Model

Default behavior is read/connect only:

```bash
npm start -- --hermes-url http://127.0.0.1:8642
```

If the configured Hermes API is unreachable, startup fails with a clear error.
The bridge will not mutate a Slack-backed or otherwise preconfigured Hermes
daemon.

Optional auto-start exists for users who explicitly want a separate local API
gateway:

```bash
npm start -- --auto-start-hermes
```

`--replace-hermes` is rejected unless `--auto-start-hermes` is also set:

```bash
npm start -- --auto-start-hermes --replace-hermes
```

Use replacement only when you intentionally want Hermes itself to replace an
already-running gateway.

## Configuration

CLI flags and matching environment variables:

| Flag | Environment | Default |
| --- | --- | --- |
| `--port` | `PORT` | `3456` |
| `--host` | `HOST` | `0.0.0.0` |
| `--token` | `BRIDGE_TOKEN` | generated |
| `--name` | `EVEN_TERMINAL_NAME` | `Hermes Agent` |
| `--cwd` | `PROJECT_DIR` | current directory |
| `--state-dir` | `EVEN_HERMES_STATE_DIR` | `<cwd>/.even-hermes-terminal` |
| `--hermes-url` | `HERMES_API_BASE_URL` or `API_SERVER_BASE_URL` | `http://127.0.0.1:8642` |
| `--hermes-key` | `HERMES_API_KEY` or `API_SERVER_KEY` | empty |
| `--hermes-command` | `HERMES_COMMAND` | `hermes` |
| `--instructions` | `EVEN_HERMES_INSTRUCTIONS` | empty |
| `--instructions-file` | `EVEN_HERMES_INSTRUCTIONS_FILE` | empty |
| `--wire-provider` | `EVEN_WIRE_PROVIDER` | `codex` |
| `--verbose` | `VERBOSE=1` | off |

## Even Terminal Contract

The implemented contract is tracked in `src/even-contract.ts` and verified by
`test/contract.ts` against `@evenrealities/even-terminal` 0.7.9. The test uses
a local tarball when present, otherwise it downloads the npm tarball with
`npm pack`.

Implemented endpoints:

```text
GET  /api/events
GET  /api/sessions
GET  /api/info
GET  /api/update-check
POST /api/prompt
POST /api/permission-response
POST /api/question-response
POST /api/interrupt
GET  /api/status
GET  /api/messages
GET  /api/debug/thread/:id
GET  /api/debug/status/:id
GET  /api/sessions/:id/history
GET  /api/metrics
```

Implemented SSE message types:

```text
status
user_prompt
text_delta
tool_start
tool_end
permission_request
permission_result
user_question
question_answer
running_stats
task_progress
notification
result
error
```

`GET /api/events` also honors the standard SSE `Last-Event-ID` header. When the
Even App reconnects after seeing a message such as `tool_start`, the bridge
replays only buffered messages with larger ids so long-running tool calls do not
leave the glasses stuck on the last event seen before a transient disconnect.

Hermes `reasoning.available` events are not mapped to Even `notification`
messages. In Hermes `/v1/runs`, this event currently comes from the tool
progress path and can contain `assistant_message.content`, not true reasoning.
Even Terminal also has no separate `reasoning` SSE message type, so mapping the
payload to `notification` makes the Even App render a fake `Reasoning: ...`
block that duplicates the final assistant output.

Hermes `/v1/runs` does not reconstruct short-term context from `session_id`
alone. The bridge therefore sends the prior Even session transcript as
`conversation_history` on each run. The `session_id` and
`X-Hermes-Session-Key` are still sent for Hermes run labeling, approval scope,
and long-term memory scoping.

## Known Limits

`POST /api/question-response` is implemented for Even compatibility and records
the selected answer in local session history. Hermes currently exposes approval
resolution over HTTP, but not a matching question-answer endpoint in the checked
API surface.

`GET /api/sessions` returns bridge-local session metadata, not Slack history or
the Hermes Gateway daemon's unrelated runtime state.

Direct internet exposure is out of scope for this bridge. The bearer token
protects Even endpoints, but there is no built-in TLS termination, rate limit,
IP allowlist, account model, or audit log.

## Architecture

The bridge is split into focused TypeScript modules:

```text
src/cli.ts                 CLI entrypoint
src/config.ts              env/flag parsing and safety validation
src/bridge.ts              HTTP route orchestration
src/even-contract.ts       upstream contract checklist
src/types.ts               documented wire/runtime types
src/http.ts                CORS, auth token, JSON helpers
src/sse.ts                 SSE parser and Even App client attachment
src/hermes/client.ts       typed Hermes API client
src/hermes/mapping.ts      Hermes event to Even message mapping
src/session/session.ts     session ring buffer, history, live stats
src/session/state-store.ts persistent session metadata
```

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check
```

`npm test` starts an in-process fake Hermes API server, exercises prompt,
permission, question, tool, notification, progress, result, history, metrics,
and verifies that `reasoning.available` is not surfaced as a notification.

## License

MIT
