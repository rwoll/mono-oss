---
name: agent-test-server
description: "Run a fake LLM and MCP server with the `agent-test-server` CLI (`@rwoll/agent-test-server`) to test clients such as VS Code's BYOK models and MCP support: script replies, tool calls, reasoning, and failures in the OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs, play the model by hand, add fake MCP tools, and check exactly what the client sent. Use it when testing, reproducing, or demoing anything that talks to a model or MCP server, without real keys or nondeterministic models."
---

# Fake LLM and MCP server for testing

`agent-test-server` speaks the OpenAI Chat Completions, OpenAI Responses, and
Anthropic Messages APIs, streaming and not, and serves MCP over Streamable HTTP.
You decide every reply, and it logs every request, so you can check what the
client sent. Every command prints JSON. It needs Node.js 24.

**Setup.** Once per session, run `node scripts/install-tools.ts agent-test-server --check`
from this skill's folder. It says when `agent-test-server` is missing or older than
its newest release. Then ask the user, and run
`node scripts/install-tools.ts agent-test-server` from this skill's folder. It
installs `@rwoll/agent-test-server` globally from its newest GitHub release, after
checking the download against GitHub's digest; its other dependencies come from
npm's registry, only once they're 7 days old. If it fails, show the user its
message, and stop. Don't run the CLI with npx.

## Start it and point the client at it

```sh
agent-test-server start            # background; prints url, adminToken, session.apiKey, session.llmBaseUrl
agent-test-server models my-model --protocol responses --vision
agent-test-server config vscode --write <user-data-dir>/User/chatLanguageModels.json
```

`config vscode` writes a provider group for VS Code's built-in **Custom Endpoint**
provider (`customendpoint`), with each model's `apiType` set to
`chat-completions`, `responses`, or `messages`. `--protocol` points every model at one
API. The file lives next to `settings.json` in the profile's folder. For other
clients, use `session.llmBaseUrl` (ends in `/v1`) and `session.apiKey` from `status`.
With the Copilot SDK, pass them as `provider: { type: 'openai', wireApi: 'responses'
or 'completions', baseUrl: llmBaseUrl, apiKey }`, or `{ type: 'anthropic', baseUrl, apiKey }`
with the base URL without `/v1`.

When the client runs in a container or VM, start with `--host 0.0.0.0 --public-url
http://<address the client can reach>:<port> --port <port>`.

Stop it with `agent-test-server stop` when you're done.

## Script the model

Rules match in order; the first that matches answers. Replies are encoded for
whichever API the request used.

```sh
agent-test-server reply "Hi! How can I help?" --when-user hello
agent-test-server reply --when-user weather --reasoning "They want weather." --tool-call get_forecast --args '{"city":"Paris"}'
agent-test-server reply "Sunny, 22°C." --when-tool-result get_forecast --stream 4:50
agent-test-server reply "Fallback answer." --fallback
```

- `--tool-call` takes a tool name or the end of one: `get_forecast` matches the
  `mcp_weather_get_forecast` the client offered.
- `--when-user` matches only when the request ends with a user message, so a rule
  for the prompt doesn't fire again after the tool result.
- `--once` and `--times <n>` limit a rule; `--nth <n>` matches the session's nth request.
- Unmatched requests get a reply that says no rule matched. `unmatched error` makes
  them fail instead.
- Built-in models need no rules: `echo`, `fail-429`, `fail-500`, `hang`, `slow`.

For many rules, write a scenario file (`agent-test-server schema` prints its JSON
Schema) and run `agent-test-server load scenario.json`.

## Faults

```sh
agent-test-server fail --status 429 --retry-after 2 --once
agent-test-server fail --status 529 --message "Overloaded"      # overloaded_error on the Messages API
agent-test-server reply "a long answer" --stream 2:100 --disconnect-after 5
agent-test-server reply "never sent" --hang
agent-test-server reply "late" --delay 5000
```

Errors use each API's error shape. Real clients often retry 429 and 5xx: use
`--once` to see the retry succeed, or no limit to see the client give up.

## Check what the client sent

Mark before the action, then wait for the request it causes:

```sh
agent-test-server requests mark
# ... do the thing in the client ...
agent-test-server requests wait --has-tool run_in_terminal --timeout 60
agent-test-server requests show r3          # headers, raw body, normalized messages and tools, response
```

`wait` returns the first matching request after the last one `wait` returned or
`mark`, so requests that arrive before you start waiting still count. It exits 3
on timeout. `requests` lists short summaries; add `--full` for everything.
Filters: `--kind llm|mcp`, `--status`, `--protocol`, `--model`, `--has-tool`,
`--user <text>`, `--mcp-server`, `--tool`, `--method`.

The log records client behavior too: a request the client cancelled mid-stream is
`aborted`, with a note saying after how many SSE events.

## Play the model by hand

To decide each reply as it comes, for exploratory testing:

```sh
agent-test-server unmatched manual
agent-test-server requests wait --pending --timeout 120
agent-test-server respond r4 "Here's what I found."
agent-test-server respond r5 --tool-call read_file --args '{"path":"README.md"}'
agent-test-server respond r6 --fail 500
```

`reply ... --hold` holds requests that match a rule until `respond <id>` releases
them with the rule's reply, which lets you look at the client's loading state.

## Fake MCP servers

```sh
agent-test-server mcp add weather            # prints its URL: <base>/mcp/weather
agent-test-server mcp tool weather get_forecast --description "Forecast for a city" \
  --schema '{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}' --text "Sunny"
agent-test-server mcp tool weather book_trip --manual     # each call waits for respond
agent-test-server config vscode --write-mcp <user-data-dir>/User/mcp.json
agent-test-server requests wait --kind mcp --tool get_forecast
agent-test-server respond r9 "Booked" --error             # answers a manual tool call
```

Tool results: `--text`, or `--result '{"content":[...],"structuredContent":{...}}'`,
and `--error` for `isError`. The log also records `initialize` and `tools/list`.

## Sessions for isolation

Every session has its own API key, models, rules, log, and MCP servers, under
`<url>/s/<id>/`. Create one per test or task so parallel work never collides:

```sh
agent-test-server session create --id qa-1
AGENT_TEST_SERVER_SESSION=qa-1 agent-test-server reply "hi"
```

`reset` clears the current session; `reset --all` clears every session.

## From code

The package's SDK drives the same server from tests, and `@rwoll/agent-test-server/playwright`
gives each Playwright test a fresh session:

```ts
import { startServer } from '@rwoll/agent-test-server'

await using server = await startServer()
const session = await server.createSession()
await session.when({ lastUserMessage: 'weather' }).reply(r => r.toolCall('get_forecast', { city: 'Paris' }))
const request = await session.waitForRequest({ hasTool: 'get_forecast' })
```
