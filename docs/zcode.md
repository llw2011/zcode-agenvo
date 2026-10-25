# Use the ZCode Connector

[简体中文](zcode.zh-CN.md) · [README](../README.md)

The ZCode Connector attaches the local ZCode CLI (`zcode app-server --stdio`, ZCode Protocol v4) to your relay so assistants can drive native sessions: create work contexts, submit input, read output and answer permission requests. Native sessions keep running when the Connector closes or reconnects.

## Requirements

- ZCode CLI installed locally (desktop bundle or standalone). The Connector resolves it from `ZCODE_BIN`, the default desktop install path, or `PATH`.
- Node.js 24.13+.

## Configure

Register one instance per workspace directory:

```sh
agenvo-zcode instance add --id laptop-zcode --cwd /path/to/project \
  [--api-key-file /path/to/key] [--default-model providerId/modelId]
```

- `--api-key-file`（mode 0600) supplies the coding-plan API key when the runtime asks the host for provider credentials.
- `--default-model` routes sends when a session's own model belongs to a plan-gated provider whose per-turn credentials only a desktop host can mint. Use a personal provider model that your CLI can call directly.

Then pair and run as with any Connector (`agenvo-zcode connect https://RELAY`, `agenvo-zcode run`).

## Methods

| Method | Params | Notes |
|---|---|---|
| `version.get` | `{}` | CLI version and wire revision |
| `session.list` | `{}` | Sessions with live phase (running / waiting_input / completedSuccess…) |
| `session.create` | `{text, mode?, planEnabled?}` | Creates the session and submits the first input (startNow) |
| `session.send` | `{sessionId, text, mode?}` | Follow-up input; the CLI may queue it while a turn runs |
| `session.read` | `{sessionId, limit?, beforeRowId?}` | Bounded, cursor-paged rows; tool rows are slimmed |
| `session.stop` | `{sessionId}` | Interrupt the current turn |
| `session.delete` | `{sessionId}` | Delete the session and its history (stop first) |
| `session.rename` | `{sessionId, title}` | Rename |
| `session.compact` | `{sessionId}` | Native compact to reclaim context |
| `interaction.list` | `{sessionId}` | Pending permission requests and questions with option ids |
| `interaction.resolve` | `{sessionId, interactionId, optionId?/freeText?/action?}` | Answer and unblock |

ACK `accepted` means dispatched, not completed. Watch `runtime.changed` events or poll `session.list`, then read output with `session.read`.

## Ownership and visibility

The CLI allows one runtime per session. Sessions created by this Connector, or closed in the desktop app, are fully operable (they are resumed from the shared session store). Do not send into a session that is currently live in the desktop app: two runtimes over one session corrupt the projection. Sessions written by this Connector become visible in the desktop app after its list re-subscribes (restart or workspace switch).

## Headless client tokens

`apps/zcode/issue-token.mjs` walks the full OAuth flow without a browser and prints `client_id` + access/refresh tokens for agents that cannot open one:

```sh
AGENVO_ADMIN_SECRET=… AGENVO_BASE_URL=https://relay.example.com node issue-token.mjs "my-agent"
```

Refresh tokens rotate on every use; persist the new value each refresh, or the grant is revoked.

## Diagnostics

`agenvo-zcode doctor` checks the CLI version and relay reachability. Connector stderr surfaces native diagnostics (model errors, crashes) as JSON lines.
