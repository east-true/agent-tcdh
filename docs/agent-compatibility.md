# Agent A2A connectivity and registration research

Observed on 2026-10-27. Support here means another agent can delegate work to the product through A2A, independently of whether that product can consume MCP tools. Findings are historical observations, not a claim that unconfirmed alternatives cannot exist.

AgentTCDH registers and discovers MCP/A2A metadata through HTTP, MCP tools, and A2A 1.0/0.3 JSONRPC messages. It does not turn arbitrary SDK, REST, CLI, or ACP interfaces into A2A servers. Target-side adapters are deployed separately. See [hub A2A discovery](../README.md#a2a-discovery).

## Product findings

| Product | External control surface | A2A finding | Registration approach |
| --- | --- | --- | --- |
| GitHub Copilot SDK | SDK sessions; Copilot CLI ACP | External A2A adapter exists; not a claim of universal native support | Deploy a2a-copilot or another verified adapter and register its card/endpoint |
| Devin Cloud | Organization/session REST API | Native A2A and a ready dedicated adapter were not confirmed | Implement and verify session/message/status/result mappings in a target-side adapter |
| OpenHands Agent Server | Conversation REST API and SDK | Official A2A server PR was unmerged | Use a verified external adapter; the PR branch is an experimental candidate |
| Aider CLI | --message, --message-file, Python calls | An external adapter candidate exists but is not verified as ready to run | Adapt and verify against supported scripting arguments before deployment |
| Grok Build | Headless CLI and ACP | Native A2A and a verified dedicated adapter were not confirmed | Add a target-side CLI/ACP-to-A2A adapter |
| Grok Bot | Webhook-triggered routines | External webhook/A2A bridge exists; actual Bot execution unverified | Configure its webhook/callback and register the bridge's card/endpoint |

No actual product accounts or model backends were exercised in this research.

### GitHub Copilot

The public a2a-copilot package wraps the Copilot SDK. Its executor uses CopilotClient from @github/copilot-sdk and the server passes CopilotExecutor into a shared A2A factory. Inspected package definitions identified a2a-copilot 1.8.2 and core 2.1.1. [Server source](https://github.com/shashikanth-gs/a2a-wrapper/blob/main/a2a-copilot/src/server/index.ts), [executor source](https://github.com/shashikanth-gs/a2a-wrapper/blob/main/a2a-copilot/src/copilot/executor.ts).

This establishes an adapter path, not A2A access to every GitHub web cloud-agent or running IDE session. Copilot CLI's [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) is a different protocol.

### Devin Cloud

Official documentation describes REST session creation, follow-up messages, status inspection, and result-file retrieval. A2A integration needs conversation/task/session id mapping plus completion, failure, cancellation, and artifact semantics. This is an implementation proposal, not a completed dedicated Devin integration. [API overview](https://docs.devin.ai/api-reference/overview), [common flows](https://docs.devin.ai/api-reference/common-flows).

Labeling the existing REST endpoint protocol a2a does not make it callable by an A2A client.

### OpenHands

[Official PR #4590](https://github.com/OpenHands/software-agent-sdk/pull/4590) was open with merged false at head e4fd0134731639482d6502afde3a82f0586fcb23. It proposes an Agent Card and JSONRPC message/send, message/stream, tasks/get, and tasks/cancel mappings onto conversations. This is evidence of a proposed implementation, not a shipped native feature. Author-reported tests were not rerun here.

### Aider

Fang's README and [adapter](https://github.com/kariemSeiam/fangai/blob/main/packages/adapters/aider/src/index.ts) describe an A2A wrapper but assume aider --json. The inspected [official argument definitions](https://github.com/Aider-AI/aider/blob/main/aider/args.py) had --message and --message-file, not --json. Therefore the example was not classified as ready to run.

Verify or adjust process arguments and output parsing against [official scripting](https://aider.chat/docs/scripting.html). A one-shot CLI/Python adapter is feasible, without implying verified conversation resumption, cancellation, or streaming.

### Grok Build and Grok Bot

Grok Build documents grok -p and grok agent stdio. The latter is ACP; an A2A card/task API was not established. A CLI/ACP adapter is a design path, not a verified ready integration. [Official headless/ACP guide](https://docs.x.ai/build/cli/headless-scripting).

Grok Bot is separate. Its [official changelog](https://x.ai/changelog/bot) describes webhook routines. [Rladmsrl/a2a-bridge](https://github.com/Rladmsrl/a2a-bridge/blob/main/a2a_bridge/app.py) maps A2A requests to webhooks and callbacks to task states/results. Card declarations, 0.3/1.0 interfaces, methods, and callbacks were inspected; no Bot account was exercised. Do not merge Grok chat, model API, Build, and Bot into one support claim.

## Register different implementations

Expose an A2A endpoint on the target side and register the same standard connection contract:

```text
Native A2A ---------------------> Register card and endpoint
SDK / custom REST --> Adapter --> Register card and endpoint
CLI / ACP ----------> Adapter --> Register card and endpoint

Consumer --> Hub: discover capability and connection
Consumer --> Discovered A2A endpoint: delegate directly
```

| Original interface | Target-side responsibility | Hub metadata |
| --- | --- | --- |
| Native A2A | Operate the standard endpoint | Card URL, execution URL, capabilities, authentication requirements |
| SDK | Initialize SDK, manage sessions, map results | Adapter's standard metadata and addresses |
| REST | Map conversations, tasks, states, files, and errors | Adapter's standard metadata and addresses |
| CLI | Manage installation, working directory, I/O, process termination | Adapter's standard metadata and addresses |
| ACP | Handle initialization, sessions, messages, permissions | Adapter's standard metadata and addresses |
| Unknown external control | Establish a callable interface first | Do not claim executable support yet |

Adapters run in the target environment, which owns CLI paths, working directories, SDK credentials, and lifecycle. The consumer retrieves an HTTP A2A address from the hub. No product-specific executor or allowlist belongs in the registry.

```sh
npm run cli -- target import https://copilot-agent.example.com --id copilot-reviewer --protocol a2a
```

Replace the address with a real endpoint. If Bearer authentication is configured, pass --bearer-env VARIABLE referencing an existing credential; this option does not provision authentication. Registering CLI/ACP directly without an adapter would require explicit new protocol schemas and consumer support. Do not disguise them as MCP stdio or A2A HTTP. This investigation did not add protocol kinds.

## Executed adapter-core checks

A temporary installation of @a2a-wrapper/core 2.1.1 with @a2a-js/sdk 1.3.0 ran a real protocol server using a stub executor. No actual Copilot, Devin, Aider, or Grok backend was called. Four checks passed:

1. Import/register/search the published core's default card; zero task executions during registration.
2. Directly call the discovered A2A message/send endpoint and verify the stub result.
3. Import/register its native 1.0 supportedInterfaces card.
4. Reject automatic import of a non-card session API and unsupported CLI/gRPC connection schemas.

Manual JSON registration does not connect to the endpoint and cannot prove that an arbitrary HTTP URL labeled A2A implements the protocol.

Evidence: [initial results](evidence/a2a-registration-20261027.json), [inspected source/PR metadata](evidence/agent-sources-20261027.json), and the [reproduction script](evidence/a2a-registration-probe.mjs).

```sh
npm run build
npm install --ignore-scripts --no-audit --no-fund --omit=optional \
  --prefix /tmp/tcdh-adapter-probe @a2a-wrapper/core@2.1.1 @a2a-js/sdk@1.3.0
node docs/evidence/a2a-registration-probe.mjs "$PWD" /tmp/tcdh-adapter-probe
```

## Registration contract follow-up

Initial imports did not preserve protocolBinding or protocolVersion. False values in the initial evidence remain historical results. Both optional fields were subsequently implemented across imports, API/MCP responses, persistence, and snapshots. CLI binding/version selectors pin refresh behavior and stop if a matching interface disappears; missing declarations are not inferred. [Follow-up results](evidence/a2a-registration-contract-20261027.json) record preserved fields as true.

The inspected core's default 0.3 card omitted preferredTransport but declared JSONRPC in additionalInterfaces. Selecting its default URL leaves the binding unknown; explicit --a2a-binding JSONRPC preserves both binding and version. Native cards preserve per-interface declarations.

Keep these concerns distinct: connection contract (transport/binding/version/card/authentication), actual behavioral support (messages, resumption, tasks, cancellation, streaming, files), and verification level/time (registered metadata, connected endpoint, actual execution). Binding/version preservation and selection are implemented. Persisted behavioral/verification fields and automatic validation policies remain proposals; execution relaying is not proposed.
