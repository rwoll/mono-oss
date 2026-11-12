# Changelog

Notable changes to `@rwoll/agent-test-server`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `start --no-auth` and `startServer({ noAuth: true })`: an opt-in mode that accepts LLM and
  MCP requests without a session API key, for clients that can't be given one, such as a
  signed-out VS Code in a disposable container, which sends an empty bearer token. Requests
  with no key, an empty key, or an unknown key go to the default session; a request with
  another session's key still goes to that session. It only listens on loopback (`127.0.0.1`,
  `::1`, or `localhost`) and refuses to start otherwise. The admin API still needs the admin
  token.
- In no-auth mode, responses carry `x-agent-test-server-no-auth: 1`, `start` and `status`
  report `noAuth: true`, `start` prints a warning, and the request log marks requests that
  came without their session's key with `unauthenticated: true`.

### Changed

- In no-auth mode, `config vscode` writes `chatLanguageModels.json` without `apiKey`. VS Code
  reads that key only from its secret storage, so the one in the file was never sent.

## [0.1.0] - 2026-11-10

### Added

- A fake LLM server for the OpenAI Chat Completions, OpenAI Responses (with
  `previous_response_id`), and Anthropic Messages APIs, streaming and not. Rules
  script text, reasoning, and tool calls once for every API, and fail on cue: HTTP
  errors in each API's shape, delays, dropped streams, and hangs.
- A request log with cursors and waits, holds, and a manual mode for answering
  requests by hand.
- Fake MCP servers over Streamable HTTP with declared tools, for 2026 and 2025-era
  clients.
- Isolated sessions, each with its own API key, rules, log, and MCP servers.
- `chatLanguageModels.json` and `mcp.json` for VS Code's Custom Endpoint provider.
- A TypeScript SDK, Playwright Test fixtures, and the `agent-test-server` CLI.

[0.1.0]: https://github.com/rwoll/mono-oss/releases/tag/agent-test-server@0.1.0
