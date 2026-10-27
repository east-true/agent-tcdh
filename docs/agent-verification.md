# Actual-agent verification

Observed on 2026-10-27 with installed CLIs, separately from the original 75 integration checks. This is a historical record, not a compatibility claim for every agent, transport, or A2A version.

| Client | Observed result |
| --- | --- |
| Codex CLI 0.164.0, gpt-6.1-sol | Native hub MCP discovery followed by direct MCP and A2A calls succeeded |
| OpenCode 1.18.31 | Real MCP initialization/tool listing succeeded; model-driven full flow remains unverified |
| Claude Code 2.1.310 | Installation confirmed; no usable authenticated account, so model checks were excluded |

## Verified flow

```text
Agent -- native MCP --> Hub search_targets / get_target
Agent -- direct HTTP --> MCP tool or A2A target
```

A temporary hub registered authenticated MCP and A2A targets. The agent received only the hub MCP configuration, without advance target URLs or ids. Target credentials were resolved from environment references returned by the hub; the administrator token was not provided to the agent.

The agent searched a run-specific tag, called get_target for both entries, and directly invoked the targets. The MCP fixture supported initialize/tools/call; the A2A fixture supported card lookup and synchronous 0.3.0 JSONRPC message/send. This did not test the complete A2A task lifecycle or other versions.

Targets checked a challenge and generated random receipts during actual execution. Receipts were absent from metadata and prompts. The verifier compared issued receipts with the final answer.

| Codex observation | Result |
| --- | --- |
| Hub search_targets | 1 call |
| Hub get_target | 2 calls |
| Successful MCP execution | 1 |
| Successful A2A execution | 1 |
| Receipt/final-answer comparison | Both matched |
| Additional per-target MCP configuration | None |

Codex used native MCP discovery, then wrote Python HTTP clients for direct execution. It corrected one malformed A2A request before succeeding. The agent authored protocol requests; the hub did not execute targets or dynamically install target tools into Codex's native tool list.

OpenCode completed initialization and tools/list through opencode mcp list. Although beam-free appeared in its model list, execution failed with ProviderModelNotFoundError. The suggested mimo-v2.5-free then failed with Model is unavailable. No full-flow success is claimed, and no paid provider was substituted.

## Reproduce

Requires Node.js 24+, project dependencies, the relevant CLI, account access, and an available model supporting tools. Model runs consume actual usage; select an available OpenCode model explicitly.

```sh
npm ci
npm run test:agents -- --agent codex --model gpt-6.1-sol
npm run test:agents -- --agent opencode --model opencode/YOUR_MODEL_ID
npm run test:agents -- --agent opencode --connection-only
```

The verifier creates a read-token-protected hub and independent protocol targets. Codex receives invocation-level configuration overrides; OpenCode receives temporary settings/data/cache locations. Personal settings are not edited. Shell/network execution and direct target connection belong to the agent.

Runs are bounded to 180 seconds. Provider availability, authentication, or quota failures stop the CLI without model fallback. Failures and successes use the same evidence format. The verifier cleans up temporary servers and the owned CLI process group.

Use `--output /absolute/path/to/new-directory` to choose a fresh evidence directory. Existing directories are not overwritten. Output includes:

- summary.json: CLI/model versions, mode, counts, and receipt comparisons.
- events.json: observed hub/target paths, protocol methods, and discovery tool names.
- stdout.jsonl and stderr.log: captured output with temporary verification tokens redacted.

Zero execution counts and false receipt checks are expected in connection-only mode, not proof of full execution.

## Limits and additional checks

The actual Codex run demonstrates hub-only configuration followed by direct target calls. The consuming environment still needs shell/network permissions and credentials.

This model-driven record does not establish dynamic native-tool mounting for all commercial agents, complete OpenCode/Claude flows, an OpenCode A2A server, external A2A adapters, production OAuth, long-running tasks/cancellation/streaming, other A2A versions, or agent-driven local stdio execution.

Later [local SDK demos](local-demo.md) verify stdio/HTTP MCP and A2A direct execution without a model. [Public MCP verification](public-mcp-verification.md) exercises actual OpenAI and Toss Payments documentation services, also without model calls. Neither expands the historical commercial-agent claims above.

Official references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [OpenCode 1.x MCP](https://docs.opencode.ai/docs/mcp-servers/), [OpenCode server API](https://docs.opencode.ai/docs/server/), [OpenCode ACP](https://docs.opencode.ai/docs/acp/), and [A2A 0.3.0](https://a2a-protocol.org/v0.3.0/specification/). OpenCode HTTP APIs and ACP are distinct from A2A.

## Multiple-target selection

Additional actual Codex runs selected and executed three and five targets from ten candidates, mixing MCP and A2A and avoiding unrelated providers. See [the selection report](selection-verification.md) for independent target receipts, request traces, reproduction commands, and the distinction between local fixtures and live public MCP checks.

## Real model-backed targets

Gemini CLI and the official TypeSafe Jev API each returned one real response through independent local protocol adapters. See [the model-target report](model-target-verification.md). These are target-provider checks with an SDK consumer, separate from the Codex consumer selection runs above.
