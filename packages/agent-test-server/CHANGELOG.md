# Changelog

Notable changes to `@rwoll/agent-test-server`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
