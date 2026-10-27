# Contributing to AgentTCDH

Bug reports, documentation improvements, examples, and pull requests are welcome. Use English for project discussions, documentation, comments, and test names. Preserve original provider metadata and intentional Unicode fixtures.

## Development setup

Use Node.js 24 and npm:

```sh
git clone https://github.com/east-true/agent-tcdh.git
cd agent-tcdh
npm ci
npm run check
npm run demo
```

Create your working branch from `main` and target `main` in your pull request. Keep your branch up to date with `main`, pass all required CI checks, and resolve review conversations before merging. Use a lowercase branch name such as `fix/windows-paths` or `feat/search-filter`. Keep each pull request focused on one change and explain the problem, resulting behavior, and validation.

## Project boundaries

The hub registers and discovers capabilities and connection details. Consumers select targets and execute directly through MCP or A2A. Keep target execution, model planning, credentials, and permissions in the consuming environment. Example provider profiles do not form a registration allowlist.

Use the shared runtime schemas for contract changes and keep OpenAPI, CLI behavior, snapshots, and MCP/A2A discovery consistent. Preserve existing registrations and SQLite data when changing storage. Update the relevant examples and documentation when behavior changes.

## Validation

For runtime changes, run `npm run check`. For package contents, CLI startup, or examples, also run `npm run test:package`. The normal checks use local fixtures; CI verifies Linux, macOS Apple Silicon/Intel, Windows, and a separate Linux container. See [platform compatibility](docs/platform-compatibility.md).

Keep public-provider and actual model calls opt-in. `test:public-mcp`, `test:agents`, `test:selection`, and `test:model-targets` can require external services, credentials, or model usage. Do not add them to the default suite or CI. Describe exactly which clients, protocols, and provider calls you actually verified.

Do not commit credentials, private registry exports, databases, or personal agent configuration. Reports should use redacted configuration and minimal reproducible examples.

## Issues and pull requests

Use the bug and feature forms when opening an issue. Include the source commit, Node version, operating system, expected behavior, actual behavior, and reproduction steps where relevant. Search existing issues first. Use a lowercase title such as `fix: handle Windows command paths` or `feat: add a discovery filter`.

Pull requests should describe the final change for a reviewer who has not seen the issue discussion. Include relevant test results and any compatibility limits. An issue is helpful for substantial design changes; a small fix can be submitted directly.

Report vulnerabilities using [the security policy](SECURITY.md).

## License

Contributions are submitted under the project's existing [Apache-2.0 license](LICENSE). Third-party service metadata and documentation retain their original provenance; do not claim ownership of provider content or copy complete documentation into verification evidence.
