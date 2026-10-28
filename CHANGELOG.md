# Changelog

## 0.1.1 — 2026-10-28

- Prepare a new package version after the previous npm package was withdrawn during account migration. Previously published version numbers cannot be reused.
- Point repository metadata, documentation, release links, and trusted publisher instructions to `jiind/agent-tcdh`.
- Advertise version `0.1.1` in MCP clients/server metadata, the A2A Agent Card, and OpenAPI.
- Document GitHub tarball installation while npm publication is pending.

Runtime behavior, SQLite schema version 2, and snapshot format version 1 are unchanged. See the [release notes](docs/releases/v0.1.1.md).

## 0.1.0 — 2026-10-27

Initial public release of AgentTCDH, a shared capability and connection registry for MCP servers and A2A agents.

- Manage MCP HTTP/stdio and A2A registrations with SQLite persistence, HTTP APIs, and a CLI.
- Discover targets through MCP tools, A2A 1.0/0.3 JSONRPC, or HTTP; execute directly from the consumer.
- Search capabilities, filter and paginate results, import/refresh remote metadata, and inspect drift.
- Use separate administrator/read tokens, conditional updates, and portable JSON snapshots.
- Run an isolated local demo and installable-package checks on Linux, macOS ARM64/x64, and Windows x64.
- Include public documentation-provider examples, opt-in agent verification, and a non-root Docker deployment.

The hub returns connection metadata. Consumers supply protocol clients, credentials, selection, and execution permissions. Automatic native tool mounting, target proxying, hosted identity management, and model planning are outside this release.

See the [release notes](docs/releases/v0.1.0.md) and [verification reports](docs/platform-compatibility.md) for installation and tested scope.
