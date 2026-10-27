# Public MCP verification

Checked on 2026-10-27 using the real hub, official protocol SDKs, and the providers below. Each provider was registered once, discovered through the hub's MCP and A2A interfaces, then called directly from the returned connection definition. A2A discovery of an MCP target still leads to MCP execution against that target.

| Provider | Connection | Observed tools | Direct calls verified through each discovery interface |
| --- | --- | --- | --- |
| OpenAI Docs | `https://developers.openai.com/mcp` | 5 | `search_openai_docs`, `fetch_openai_doc` |
| Toss Payments Docs | `npx --yes @tosspayments/integration-guide-mcp@0.0.31` | 3 | `get-documents`, `document-by-id` |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | 3 | `microsoft_docs_search`, `microsoft_docs_fetch` |
| Cloudflare Docs | `https://docs.mcp.cloudflare.com/mcp` | 2 | `search_cloudflare_documentation`, `migrate_pages_to_workers_guide` |
| Context7 | `https://mcp.context7.com/mcp` | 2 | `resolve-library-id`, `query-docs` |
| DeepWiki | `https://mcp.deepwiki.com/mcp` | 3 | `read_wiki_structure`, `read_wiki_contents` |

All 24 required cases passed: six providers, two discovery interfaces, and two documentation calls. Metadata registration made zero `tools/call` requests. The verifier used no API keys, payment operations, or model API calls. Context7 anonymous calls succeeded in this environment; this does not guarantee anonymous access or quotas for other users or future runs. The script does not call DeepWiki's AI question tool.

The initial six-provider run attempted 24 calls. Its Microsoft fetch cases failed because the verifier selected a URL inside a search excerpt instead of the article's `results[].contentUrl`. After that parsing fix, a Microsoft-only run passed all four cases. The final matrix combines the unaffected initial cases and the corrected Microsoft run. Across these two recorded runs there were 28 tool attempts; this is not a claim of one pristine 24-call run. Both failure and success evidence are retained.

## Reproduce

```sh
npm ci
npm run test:public-mcp
npm run test:public-mcp -- --providers microsoft-learn,cloudflare-docs
npm run test:public-mcp -- --output /absolute/path/to/new-evidence-directory
```

An explicit output directory must not already exist. The default creates a new temporary directory. The script starts an isolated SQLite hub with temporary tokens, inspects live tool metadata, registers targets through the administrator API, and queries through both discovery interfaces. It never modifies a running registry or personal agent settings. Each failure is recorded while other providers continue, and any incomplete case makes the command exit with code 1.

Output includes a portable `registry.json`, `summary.json`, request trace `events.json`, and the temporary SQLite registry. Summaries contain tool arguments, response sizes, hashes, and selected document references. They do not retain complete third-party document bodies or credentials. DeepWiki's wiki contents response was approximately 1 MB of serialized JSON, illustrating why consumers need their own result-size and context handling.

## Import the observed registrations

```sh
npm run cli -- registry import examples/public-docs-registry.json --dry-run
npm run cli -- registry import examples/public-docs-registry.json
npm run cli -- target list --tag public-docs
```

The [snapshot](../examples/public-docs-registry.json) contains all six observed definitions and their input schemas. Toss's command runs in the consumer environment; the hub does not launch it. The package is pinned for reproducibility and is not a project dependency. Existing target IDs use the normal snapshot conflict policy.

Provider descriptions and input schemas are retained as received, including Toss's Korean text. Our project documentation and messages use English. These examples do not restrict registration: other MCP servers and A2A agents can be registered using the same generic definition schema.

## Observations and limits

- Toss's installed package exposes `get-documents` with a `version` argument. Its setup guide's tool table uses version-specific names. The snapshot follows the observed package schema. The npm package version is `0.0.31`; the protocol handshake advertises server version `1.0.0`.
- DeepWiki's handshake exposed `ask_wiki_question`, whereas its documentation lists `ask_question`. Neither was called. Only wiki structure and contents were read for the public `modelcontextprotocol/typescript-sdk` repository.
- Cloudflare's migration tool returns a guide; it does not perform a migration.
- This SDK-driven test proves live discovery and direct execution. Model-driven selection is tested separately in [multiple-target selection](selection-verification.md).
- Network access, provider availability, npm availability for Toss, and provider rate limits remain external requirements. Authentication flows, paid endpoints, every provider tool, arbitrary task completion, and every commercial agent are outside this test.
- Public MCP verification is opt-in and excluded from the default test suite and CI.

## Evidence

- [Consolidated observations](evidence/public-mcp-20261027.json)
- [Initial run, including failures](evidence/public-mcp-initial-20261027-summary.json) and [request trace](evidence/public-mcp-initial-20261027-events.json)
- [Corrected Microsoft run](evidence/public-mcp-microsoft-20261027-summary.json) and [request trace](evidence/public-mcp-microsoft-20261027-events.json)

## Official provider references

- [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp)
- [Toss Payments LLM integration guide](https://docs.tosspayments.com/guides/v2/get-started/llms-guide)
- [Microsoft Learn MCP overview](https://learn.microsoft.com/en-us/training/support/mcp)
- [Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
- [Context7 MCP client setup](https://context7.com/docs/resources/all-clients)
- [DeepWiki MCP](https://docs.devin.ai/work-with-devin/deepwiki-mcp)
