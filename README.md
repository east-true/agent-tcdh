# AgentTCDH

**Agent & Tool Capability Discovery Hub**

An open-source TypeScript registry for MCP servers and A2A agents, licensed under [Apache-2.0](LICENSE).

Register MCP servers and A2A agents in one place. Agents discover capabilities and connection details from the hub, then connect directly to the selected target.

```text
Administrator -- CLI / HTTP API --> Registry
Consumer ----- MCP / A2A / HTTP --> Discover capabilities and connections
Consumer ----- MCP / A2A -------> Execute directly on the target
```

The hub stores metadata. It does not execute tools, launch registered commands, relay agent tasks, or install discovered tools into a consumer's native tool list. Consumers provide protocol support, execution permissions, and target credentials.

## Features

- Register, retrieve, replace, disable, and delete remote MCP, local stdio MCP, and HTTP A2A targets.
- Import remote MCP tool lists and A2A Agent Cards from the CLI; refresh metadata with conflict protection.
- Inspect registered metadata with `target check` without executing target capabilities or changing registrations.
- Keyword search across ids, names, descriptions, tags, and capabilities; protocol/tag filters and pagination.
- SQLite persistence and transactional JSON snapshot import/export.
- Read-only `search_targets` and `get_target` tools over stdio or Streamable HTTP MCP.
- A2A 1.0/0.3 JSONRPC discovery with a public Agent Card.
- OpenAPI 3.1 generated from runtime schemas.
- Separate administrator/read Bearer tokens and conditional writes using ETag/If-Match.
- Account-free local demos, packaging checks, and opt-in public MCP verification.

Project documentation, comments, examples, and application messages use English. Intentional Unicode test fixtures and unmodified third-party metadata may contain other languages.

## Get started

Requires Node.js 24 or newer and npm. Linux, macOS, and Windows verification and shell-specific setup are documented in [platform compatibility](docs/platform-compatibility.md).

The implementation is currently on `feat/registry-discovery` during initial development:

```sh
git clone --branch feat/registry-discovery https://github.com/east-true/agent-tcdh.git
cd agent-tcdh
npm ci
npm run build
npm start
```

The default listener is `http://127.0.0.1:3000`. In another terminal:

```sh
npm run cli -- target add examples/mcp-remote.json
npm run cli -- target add examples/mcp-stdio.json
npm run cli -- target add examples/a2a.json
npm run cli -- target list
npm run cli -- target list --q "document search" --protocol mcp
npm run cli -- target get docs
```

Replace example addresses and filesystem paths before use. Registration stores metadata without connecting to the target. Use `npm run dev` for watch mode, `node dist/index.js` for the built CLI, or `npm link` to expose `agent-tcdh` locally.

## Run the complete local flow

```sh
npm run demo
npm run demo -- --discovery a2a
npm run demo -- --serve
```

The demo registers three local targets, discovers them through MCP or A2A, directly calls HTTP MCP, stdio MCP, and an A2A echo agent, verifies execution receipts and deletion visibility, then cleans up. `--serve` keeps the isolated servers available for manual connections. No model account or external service is used. See [the local demo guide](docs/local-demo.md).

## Real public MCP servers

OpenAI Docs, Toss Payments Docs, Microsoft Learn, Cloudflare Docs, Context7, and DeepWiki are verified using actual documentation calls. The [verification report](docs/public-mcp-verification.md) separates provider tool results from local fixtures.

Import the observed, portable registrations into your running hub:

```sh
npm run cli -- registry import examples/public-docs-registry.json
npm run cli -- target list --tag public-docs
```

Five targets use remote HTTP; the Toss target runs the pinned official npm package in the consuming environment. The registry does not start that process. These profiles are examples, not a provider allowlist.

Run the external verification explicitly:

```sh
npm run test:public-mcp
npm run test:public-mcp -- --providers microsoft-learn,cloudflare-docs
npm run test:public-mcp -- --output /absolute/path/to/new-evidence-directory
```

This performs documentation-only calls through both hub discovery interfaces, uses no API keys, and makes no model or payment API calls. Network access and npm are required. It does not run as part of the default offline-friendly test suite or CI. Provider availability and responses can change.

## Select multiple targets

Actual Codex runs selected the required 3 and 5 targets from 10 candidates, mixing MCP and A2A execution without calling unrelated providers. These use local protocol fixtures; the public-provider checks above use live documentation services. See [the selection verification report](docs/selection-verification.md) for evidence and limits.

```sh
npm run test:selection -- --count 3 --model gpt-6.1-sol
npm run test:selection -- --count 5 --model gpt-6.1-sol
```

This explicit real-agent check consumes model usage. Only the hub is configured in Codex; the agent selects and calls targets using returned metadata. The harness accepts counts 1..8; observed runs cover 3 and 5. The hub remains a registry, and selection/execution remain consumer responsibilities.

## Real model-backed targets

A separate opt-in check verified real Gemini and official TypeSafe Jev responses through local A2A and MCP test adapters, respectively. It performs at most one provider invocation per enabled target, using existing credentials and no retries. These adapters run outside the hub. See [the model-target report](docs/model-target-verification.md) for actual usage, responses, and protocol scope.

```sh
npm run test:model-targets
```

This consumes model usage and requires an already configured Gemini CLI and `TYPESAFE_API_KEY`. Jev calls go directly to TypeSafe; the verification does not use OpenCode's inference service.

## CLI

```text
agent-tcdh serve [--host HOST] [--port PORT] [--db FILE]
agent-tcdh target add <JSON_FILE> [--hub URL]
agent-tcdh target update <ID> <JSON_FILE> [--if-match ETAG] [--hub URL]
agent-tcdh target import <URL> --id ID --protocol mcp|a2a [--dry-run] [--hub URL]
agent-tcdh target refresh <ID> [--dry-run] [--hub URL]
agent-tcdh target check <ID> [--bearer-env VARIABLE] [--hub URL]
agent-tcdh target get <ID> [--with-version] [--hub URL]
agent-tcdh target list [--q QUERY] [--protocol mcp|a2a] [--tag TAG]
                     [--limit COUNT] [--offset OFFSET] [--include-disabled] [--hub URL]
agent-tcdh target remove <ID> [--if-match ETAG] [--hub URL]
agent-tcdh registry export <JSON_FILE> [--overwrite] [--hub URL]
agent-tcdh registry import <JSON_FILE> [--on-conflict error|skip|replace] [--dry-run] [--hub URL]
agent-tcdh mcp [--hub URL]
```

The default command is `serve`. Successful administrative commands print JSON; failures print diagnostics to stderr and exit with code 1. `target check` also prints failed/skipped reports as JSON and uses the exit codes below. Use `--help` for all options.

HTTP client commands and `mcp` accept `--token-env VARIABLE`, defaulting to `AGENT_TCDH_TOKEN`. An explicitly selected empty variable fails without falling back to another credential. `serve` uses server environment variables instead.

Updates replace the complete definition. Set `enabled: false` to disable a target. Default searches exclude disabled targets; direct lookup and `--include-disabled` still expose their metadata.

## Search and connection definitions

Search is case-insensitive keyword matching. Whitespace-separated terms must all match, possibly across different fields. Results are ranked; equal scores use stable id order. An empty query lists targets by id.

Parameters are `q`, `protocol`, `tag`, `includeDisabled`, `limit`, and `offset`. Defaults: enabled targets only, `limit: 20`, `offset: 0`. Maximum limit: 100; maximum offset: 1000000. Totals are calculated after all filters and before pagination.

```json
{"items": [], "total": 0, "limit": 20, "offset": 0}
```

Definitions contain `id`, `name`, `description`, `protocol`, `tags`, `capabilities`, `connection`, and optional `enabled` (default true). Capabilities have `name`, `description`, and optional `inputSchema`. Responses add `createdAt` and `updatedAt`.

| Protocol | Connection |
| --- | --- |
| Remote MCP | `transport: streamable-http` or `sse`, `url`, optional `auth` |
| Local MCP | `transport: stdio`, `command`, optional `args` and `envVars` |
| A2A | `transport: http`, `url`, optional `agentCardUrl`, `protocolBinding`, `protocolVersion`, `auth` |

Stdio commands and paths are interpreted in the consumer's environment. A2A bindings are `JSONRPC` or `HTTP+JSON`. Binding and version fields are independently optional for backward compatibility. API/MCP responses, SQLite, and snapshots preserve them without changing DB or snapshot formats. Consumers perform actual connections, version negotiation, and authentication, consulting the card for additional details.

Remote authentication metadata supports `none`, `bearer`, `api-key`, or `oauth2`, with optional `description` and environment variable names in `envVars`. Store references, not credential values.

## Import and refresh metadata

```sh
npm run cli -- target import https://mcp.example.com/mcp --id docs --protocol mcp
npm run cli -- target import https://mcp.example.com/sse --id legacy --protocol mcp --transport sse
npm run cli -- target import https://agent.example.com --id research --protocol a2a
npm run cli -- target import https://agent.example.com/custom-card --id custom --protocol a2a
npm run cli -- target import https://agent.example.com --id research --protocol a2a \
  --a2a-binding JSONRPC --a2a-version 1.0 --dry-run
```

MCP inspection initializes the server and reads tool pages without calling tools. A2A root URLs resolve to `/.well-known/agent-card.json`; explicit paths are used as supplied. Native `supportedInterfaces` is authoritative. Legacy `url`, `preferredTransport`, and `additionalInterfaces` are also supported. HTTP interfaces declaring unsupported bindings are rejected; gRPC-only cards do not fall back to legacy URLs. Undeclared bindings and versions are not inferred.

`--a2a-binding` accepts `JSONRPC` or `HTTP+JSON`; `--a2a-version` accepts two or three numeric components, such as `1.0` or `0.3.0`. Selection compares exact declared strings: `0.3` and `0.3.0` are distinct. A requested version is sent in `A2A-Version`. No matching interface means failure, not silent fallback. These options apply only to A2A import/refresh.

Use `--name`, `--description`, and `--tag` for display metadata. `--dry-run` prints a proposed definition without registering it. Anonymous and Bearer inspection are supported:

```sh
npm run cli -- target import https://mcp.example.com/mcp --id private-docs --protocol mcp \
  --bearer-env REMOTE_MCP_TOKEN
npm run cli -- target refresh docs --dry-run
npm run cli -- target refresh docs
npm run cli -- target refresh research --a2a-binding HTTP+JSON --a2a-version 1.0
```

Refresh preserves administrator labels, description, tags, enabled state, and authentication metadata while replacing capabilities and updating the A2A endpoint. Saved A2A binding/version selections remain pinned despite card reordering; missing selections fail without changing the registration. Explicit options can switch them. `--bearer-env` overrides the credential used for that inspection only.

Concurrent label changes are reread and preserved; changed connection details stop refresh. The final conditional write uses the latest ETag and fails with 412 if another write occurs afterward. No automatic retry is performed. Refresh requires a hub supporting target versions; `--dry-run` leaves the revision unchanged.

Inspection occurs in the CLI, not the hub. OAuth login and API-key header setup are not automated. Stdio definitions are managed as JSON without executing commands during import/refresh. Inspection limits: 10 seconds overall, 1 MiB per response, 200 capabilities, and 50 MCP pages. Cyclic cursors and redirects are rejected; use the final URL.

## Check registered metadata

```sh
npm run cli -- target check docs
npm run cli -- target check research --bearer-env RESEARCH_TOKEN
npm run cli -- target check docs --token-env AGENT_TCDH_READ_TOKEN
```

Checks run in the CLI using a read-only hub lookup. `targetVersion` identifies the registration inspected. Reports are not saved to the registry and do not automatically update targets.

| Status | Exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Metadata retrieved; compared registration fields match |
| `warning` | 0 | Metadata retrieved; capabilities or selected card endpoint differ |
| `failed` | 1 | Missing credentials, invalid metadata, connection failure, or timeout |
| `skipped` | 2 | Stdio, unsupported authentication, or ambiguous Bearer reference |

Argument errors and failed hub lookups use the normal stderr/exit-1 behavior. Automation should examine both exit code and `status`/`issues`.

`scope: mcp-tools-list` covers initialization and tool listing; `scope: a2a-agent-card` covers card retrieval. `executionVerified` is always false. No tools or A2A tasks are executed; a valid card does not prove its execution endpoint works.

`capabilities` includes registered/observed counts and added/removed/changed names, comparing descriptions and input schemas while ignoring JSON object key order. Manual metadata can legitimately differ. Run `target refresh` separately when appropriate.

A2A checks reuse saved binding/version selections. `CARD_ENDPOINT_DIFFERS` reports a selected URL different from the saved URL without declaring execution failure: multiple interfaces may share a binding/version. Missing `agentCardUrl` uses the same-origin standard card path; custom paths must be registered explicitly.

A single Bearer environment reference is selected automatically; absent or ambiguous references require `--bearer-env`. OAuth and API-key setup are skipped unless an already available Bearer token is explicitly selected. The saved authentication definition is unchanged. Metadata import limits also apply to checks.

## Conditional updates and deletion

```sh
npm run cli -- target get docs --with-version
npm run cli -- target update docs examples/mcp-remote.json --if-match '"previous-etag"'
npm run cli -- target remove docs --if-match '"previous-etag"'
```

`--with-version` returns `{"target": {...}, "etag": "\"revision\""}`. Use the actual ETag, including its quotes. Normal `target get` output is unchanged. Successful updates generate a new version; reread it before another conditional write. Changed or deleted targets return `412 PRECONDITION_FAILED` without overwriting current state. Identical contents/timestamps and delete-recreate cycles still receive distinct revisions.

HTTP `PUT` and `DELETE /api/targets/:id` accept `If-Match`. Strong tag lists are supported; weak tags never match. `If-Match: *` requires existence. Omitted headers retain unconditional writes. Bulk `replace` is unconditional and assigns new revisions.

## Backup and restore

```sh
npm run cli -- registry export backups/registry.json
npm run cli -- registry export backups/registry.json --overwrite
npm run cli -- registry import backups/registry.json --dry-run
npm run cli -- registry import backups/registry.json --on-conflict skip
npm run cli -- registry import backups/registry.json --on-conflict replace
```

Snapshots include all definitions, including disabled entries, rather than one search page. The format is `agent-tcdh`, version 1, with `exportedAt` and `targets`. Limits: 16 MiB and 10000 targets. Timestamps and ETags are not portable configuration and are assigned by the destination hub.

The default conflict policy is `error`, rolling back the entire import on existing ids. `skip` preserves existing definitions and timestamps; `replace` updates matching ids while preserving destination creation timestamps. Targets absent from the snapshot are retained. Invalid input and intermediate failures cause no partial changes. `--dry-run` reports expected counts without writing.

Exports are validated against the same import limits, written completely and synced before atomic installation, and do not overwrite existing files unless `--overwrite` is supplied. Temporary files are cleaned up on failure; previous backups remain intact.

## HTTP API

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/health` | Public basic health check |
| GET | `/openapi.json` | OpenAPI 3.1 specification |
| GET | `/.well-known/agent-card.json` | Public hub Agent Card |
| POST | `/mcp` | MCP discovery |
| POST | `/a2a` | A2A discovery |
| GET | `/api/registry/export` | Export all definitions (administrator) |
| POST | `/api/registry/import` | Import snapshot (administrator) |
| POST | `/api/targets` | Register target, returning 201 |
| GET | `/api/targets` | Search/filter/page targets |
| GET | `/api/targets/:id` | Retrieve target and connection metadata |
| PUT | `/api/targets/:id` | Replace complete definition |
| DELETE | `/api/targets/:id` | Delete, returning 204 |

General body limit: 1 MiB. Bulk import: 16 MiB, with `onConflict=error|skip|replace` and `dryRun=true|false`. Invalid input returns 400; duplicate ids 409; missing targets 404. PUT path/body ids must match. OpenAPI schemas include recursive input schemas, route roles (`x-required-role`), version headers, and conditional-write errors.

## MCP discovery

Connect a remote MCP client to `http://127.0.0.1:3000/mcp` and supply the optional hub Bearer token. The transport is stateless, reads current registry data per call, and needs neither session affinity nor persistent session ids. GET and DELETE return 405.

For stdio discovery, start the HTTP hub first and configure the consumer with:

```json
{"mcpServers":{"agent-tcdh":{"command":"node","args":["/absolute/path/agent-tcdh/dist/index.js","mcp","--hub","http://127.0.0.1:3000"]}}}
```

`search_targets` accepts keyword, protocol, tag, disabled-state, and page options. `get_target` retrieves current metadata by id. Additions, updates, and deletions become visible on the next lookup. The consumer decides how to connect and execute using the returned definition.

### Codex CLI

Configure only the hub in `~/.codex/config.toml`:

```toml
[mcp_servers.agent_tcdh]
url = "http://127.0.0.1:3000/mcp"
bearer_token_env_var = "AGENT_TCDH_READ_TOKEN"
```

Omit the token setting for an anonymous hub. Ask the agent to discover capabilities and connect directly using `connection`. See the [official MCP settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### OpenCode 1.x

Verified with OpenCode 1.18.31:

```json
{"mcp":{"agent_tcdh":{"type":"remote","url":"http://127.0.0.1:3000/mcp","oauth":false,"headers":{"Authorization":"Bearer {env:AGENT_TCDH_READ_TOKEN}"}}}}
```

Omit `headers` for an anonymous hub. Use `opencode mcp list` to inspect connections. OpenCode 2.x has a different format; use its [version-specific documentation](https://opencode.ai/v2/docs/mcp-servers).

Discovery does not dynamically mount target tools in a consumer's native tool registry. The observed Codex run used native MCP discovery followed by an agent-written HTTP client. Shell/network permissions and target credentials belong to the consuming environment. See [actual-agent verification](docs/agent-verification.md) and [A2A registration compatibility](docs/agent-compatibility.md).

## A2A discovery

The Agent Card is at `/.well-known/agent-card.json`; JSONRPC requests use `/a2a`. Send `A2A-Version: 1.0` for native cards and `SendMessage`. Omitted, `0.3`, or `0.3.0` selects the legacy card and `message/send`; other versions fail explicitly.

```sh
curl http://127.0.0.1:3000/a2a \
  -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
  --data-binary '{"jsonrpc":"2.0","id":"find-docs","method":"SendMessage","params":{"message":{"messageId":"query-1","role":"ROLE_USER","parts":[{"data":{"operation":"search_targets","arguments":{"q":"documentation","protocol":"mcp"}}}]}}}'
```

Add `Authorization: Bearer <token>` when configured. For a lookup, use `data: {"operation":"get_target","arguments":{"id":"docs"}}`. Structured search uses the same filters and pagination as MCP. A single text part becomes the literal keyword query; no language model interprets it. A single data part is also accepted; mixed parts and file input are rejected.

Native responses place SearchResult, Target, or an application `error` in `result.message.parts[0].data`. Setting `configuration.acceptedOutputModes` to `["text/plain"]` returns the same JSON as text. Invalid messages and unsupported operations return JSON-RPC errors.

Legacy messages use `kind: message`, `role: user`, and part `kind: text` or `data`; the response Message is directly under `result`. Versioned serialization uses the official SDK. See the [1.0 specification](https://a2a-protocol.org/v1.0.0/specification/) and [0.3 specification](https://a2a-protocol.org/v0.3.0/specification/).

The hub responds immediately from current registry data. It does not store task/conversation history or support streaming or push notifications. A supplied context id is preserved without merging prior turns. Consumers execute directly against discovered targets.

## Storage, authentication, and deployment

| Environment variable | Default | Purpose |
| --- | --- | --- |
| HOST | 127.0.0.1 | Listener address |
| PORT | 3000 | Listener port |
| AGENT_TCDH_DB_PATH | ~/.agent-tcdh/registry.sqlite | Persistent SQLite file |
| AGENT_TCDH_URL | http://127.0.0.1:3000 | CLI/stdio MCP hub URL |
| AGENT_TCDH_TOKEN | Unset | Administrator token; default CLI/stdio credential |
| AGENT_TCDH_READ_TOKEN | Unset | Read-only server token |
| AGENT_TCDH_ALLOWED_ORIGINS | Empty list | Allowed HTTP MCP/A2A Origin headers |
| AGENT_TCDH_PUBLIC_URL | Listener address | Public base URL advertised in A2A cards |

CLI options override corresponding environment variables. Storage directories are created automatically. DB schema version 2 is migrated transactionally while preserving definitions and timestamps; failures roll back. Revisions survive restart. DB schema 2 and snapshot format 1 are independent.

An administrator token protects every endpoint except health and the public Agent Card. The optional read token requires a distinct administrator token. Tokens must be printable ASCII without whitespace/control characters; invalid settings fail before storage creation. With neither token configured, requests are anonymous.

| Capability | Administrator | Read token |
| --- | --- | --- |
| Search, target lookup, OpenAPI, MCP/A2A discovery | Allowed | Allowed |
| Register, replace, delete | Allowed | 403 |
| Export, bulk import, import preview | Allowed | 403 |

Missing/invalid credentials return 401; forbidden mutations return 403. Authentication occurs before body parsing. Public cards contain hub capabilities and authentication requirements, without target lists or token values.

```sh
npm run cli -- target list --token-env AGENT_TCDH_READ_TOKEN
npm run cli -- target add examples/mcp-remote.json --token-env AGENT_TCDH_TOKEN
npm run cli -- mcp --token-env AGENT_TCDH_READ_TOKEN
```

Configure remote consumers with a read Bearer token. Stdio consumers may pass `--token-env` or receive a read token through their own `AGENT_TCDH_TOKEN`. Server-side authorization applies consistently across CLI/HTTP/MCP/A2A. Restart the server after token changes; for Compose, use `docker compose up -d --force-recreate`.

Requests without Origin headers are allowed. Requests with Origin must match `AGENT_TCDH_ALLOWED_ORIGINS`, otherwise 403. Values must be HTTP(S) origins without paths, trailing slashes, or wildcards. This is separate from CORS response configuration.

Set `AGENT_TCDH_PUBLIC_URL` to the externally reachable base URL behind HTTPS proxies, container port mappings, or public hosts. A stripped reverse-proxy prefix such as `https://hub.example.com/registry` is supported. Without configuration, cards use the actual listener address; wildcard listeners advertise loopback. Host and forwarding headers cannot change published addresses.

```sh
cp .env.example .env
docker compose up --build -d
docker compose logs -f hub
docker compose down
```

Compose defaults to loopback port 3000 and persists SQLite in the `registry-data` volume. Its `.env` supports `AGENT_TCDH_BIND_ADDRESS`, `AGENT_TCDH_PORT`, both tokens, allowed origins, and the public URL. Match the public URL to the consumer-facing port, such as `http://127.0.0.1:4000`. Local npm execution uses shell variables rather than loading `.env`. The container runs as a non-root user and checks `/health`; `docker compose down` preserves the named volume.

## Verification

```sh
npm run check
npm run test:package
docker build --tag agent-tcdh:ci .
npm run test:container -- --image agent-tcdh:ci
```

The default suite checks runtime contracts, SQLite persistence/migration, CLI, both MCP transports, A2A versions, direct connections, metadata inspection, snapshots/rollback, permissions, version conflicts, OpenAPI, and local demos. Integration tests use temporary loopback ports.

`test:package` packs the built artifact, checks included files/docs, installs production dependencies in an isolated directory, and verifies the installed binary, protocols, diagnostics, restart persistence, and local demo. With a populated npm cache, use `-- --offline`. Temporary processes/files are removed. Nothing is published to npm.

`test:container` uses a uniquely named container and volume to verify non-root execution, the image HEALTHCHECK, permissions/protocols, and restart persistence. It removes only its own container and volume, retaining the image. Docker daemon access is required.

The [CI workflow](.github/workflows/ci.yml) runs Node.js 24 regression/package verification on Linux x64, macOS Apple Silicon and Intel, and Windows x64, plus independent Linux Docker build/container checks on push, pull request, or manual dispatch. Action code is pinned to inspected commits; repository tokens have read permission only. Public MCP calls, actual models, and artifact publication are not automatic.

Actual-agent checks are explicit and may consume model usage:

```sh
npm run test:agents -- --agent codex --model gpt-6.1-sol
npm run test:agents -- --agent opencode --model opencode/YOUR_MODEL_ID
npm run test:agents -- --agent opencode --connection-only
```

These use temporary settings without changing personal configuration. The model must support tool calls and be available to the current account. Provider authentication, availability, and quota failures stop the run without switching models. See [the verification record](docs/agent-verification.md).

## Contributing and support

Bug reports, feature requests, documentation improvements, and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), use the [issue forms](https://github.com/east-true/agent-tcdh/issues/new/choose), and follow [SECURITY.md](SECURITY.md) for vulnerability reporting.

Source development and local package verification are available from this repository. The `private: true` field in `package.json` prevents accidental npm publication; it does not change the public repository or source license. See [npm's private-field documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#private).

## License

[Apache-2.0](LICENSE)
