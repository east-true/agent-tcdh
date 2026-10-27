# Real Gemini and TypeSafe Jev target calls

On 2026-10-27, a consumer discovered two targets through the actual hub MCP interface, then called the target connections directly. Both test adapters invoked real model providers successfully.

| Target | Target protocol | Underlying provider | Observed response |
| --- | --- | --- | --- |
| Gemini CLI adapter | A2A 0.3 JSONRPC | Gemini CLI 0.64.0, `gemini-3.5-flash-lite` | Returned the fresh challenge supplied in the task |
| TypeSafe Jev adapter | Streamable HTTP MCP | Official `https://api.typesafe.ai/v1/systemone`, `jev-latest` resolved to `jev-1.14.0` | Returned a typed Choice selecting `a2a` for delegation to a specialist agent |

Gemini statistics report one API request, zero API errors, zero tool calls, 6,483 input tokens, 41 candidate tokens, and 197 thinking tokens. Jev reports 373 input tokens and 43 output tokens. Each adapter invoked its provider once, with no automatic retries or model switching. The Jev call used the existing `TYPESAFE_API_KEY` directly against TypeSafe; it did not use OpenCode or its free inference endpoint.

## What this proves

The local adapters provide the protocol boundaries. The Gemini adapter accepts an A2A Message and launches one bounded, tool-free Gemini CLI request. The Jev adapter accepts an MCP `choose_protocol` call and makes one typed request to the official TypeSafe API. The consumer searches the hub, retrieves each definition, fetches the Gemini Agent Card, and connects directly using the declared transport. The hub never receives provider credentials or executes either model.

The endpoints in this test are adapters created by the verification harness. This is not evidence that Gemini CLI or the TypeSafe inference API directly exposes a native A2A/MCP service. Jev supplies typed judgments; application code controls its surrounding workflow. The hub stores the same generic connection definitions used for other targets and contains no provider-specific execution code.

This test used an SDK consumer with a fixed two-target verification workflow. Actual model-driven selection of a variable number of targets is independently demonstrated by the Codex [three- and five-target runs](selection-verification.md). Real external documentation MCP calls are recorded in [public MCP verification](public-mcp-verification.md).

## Reproduce

Requires Node.js 24, an existing configured Gemini CLI, and `TYPESAFE_API_KEY` for the official Jev API. This is an explicit model-usage test; TypeSafe usage is metered under the existing account. No billing setup, purchase, payment operation, account switch, or quota increase is performed. Gemini's published free tier does not independently establish the current account's billing status.

```sh
npm run test:model-targets
npm run test:model-targets -- --only jev --jev-model jev-latest
npm run test:model-targets -- --only gemini --gemini-model gemini-3.5-flash-lite
npm run test:model-targets -- --discovery a2a \
  --output /absolute/path/to/new-evidence-directory
```

The observed run used the default MCP discovery option. The A2A discovery option is implemented but was not used for another live model run, avoiding unnecessary duplicate inference. The public MCP suite separately verifies the hub's A2A discovery interface.

The harness creates new temporary listeners and settings. It disables Gemini tools, extensions, retries, and additional session turns, provides a 600-second CLI deadline, and closes stdin. An explicit output directory must be new. The Jev model list is checked before inference, and the requested alias must be advertised to the account. Errors are saved and not retried. Personal agent settings remain unchanged. Default tests and CI do not invoke this command.

## Evidence

- [Run summary and actual responses](evidence/model-targets-20261027.json)
- [Hub, target, and TypeSafe request trace](evidence/model-targets-20261027-events.json)
- [Connection and account model-list preflight](evidence/model-targets-preflight-20261027.json)
- [Jev request](evidence/model-targets-jev-20261027-request.json) and [response](evidence/model-targets-jev-20261027-response.json)
- [Verification harness](../scripts/verify-model-targets.mjs)

## Official references

- [TypeSafe System One API](https://docs.typesafe.ai/api/system-one)
- [TypeSafe account model list](https://docs.typesafe.ai/api/list-models)
- [Jev Choice questions](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe model and usage pricing](https://docs.typesafe.ai/models)
- [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite)
