# @agenvo/zcode

[简体中文](README.zh-CN.md)

Attach to the ZCode CLI's `app-server` (stdio, ZCode Protocol v4) and expose its sessions to remote assistants: create sessions, submit input, read output, answer permission requests. Closing the Connector leaves native sessions running.

Requires Node.js 24.13+ and a local ZCode CLI install. This Connector is experimental and follows the upstream ZCode Protocol; verify behavior against your CLI version before relying on it.

- Locate the CLI automatically (desktop bundle path, `ZCODE_BIN`, or `PATH`).
- One instance per workspace directory; sessions from other clients appear after `session/resume`.
- Sends carry an explicit model selection when the instance sets `--default-model providerId/modelId`; plan-gated providers are routed to that default because their per-turn credentials are only mintable by a desktop host.

[Configure and use the ZCode Connector](https://github.com/Xuanwo/agenvo/blob/main/docs/zcode.md)

`issue-token.mjs` (in this directory) mints OAuth credentials for headless MCP clients against any relay, using the relay administrator key.

## License

Apache-2.0. ZCode is a product of Z.ai; this Connector depends on its CLI only through the public app-server protocol and contains no Z.ai code.
