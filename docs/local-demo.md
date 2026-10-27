# Local registration, discovery, and direct execution

Requires Node.js 24+ and project dependencies. No external service or model account is needed. These are deterministic consumers using the official MCP/A2A SDKs, not a test of a commercial agent's model behavior. See [actual-agent verification](agent-verification.md) for that scope.

## Run once

```sh
npm ci
npm run demo
npm run demo -- --discovery a2a
```

The default discovers through MCP; the second mode discovers through A2A. Both:

1. Start an in-memory hub and independent echo targets on allocated loopback ports.
2. Import HTTP MCP tools and an A2A card. Register stdio command metadata without starting the command.
3. Connect the consumer using only the hub URL, search the `demo` tag, and retrieve current target definitions.
4. Connect directly to HTTP MCP and A2A targets. Launch the discovered stdio command in the consuming process.
5. Verify fresh execution receipts and zero remote executions during registration/discovery.
6. Delete `demo-mcp` as administrator and confirm the deletion through the same discovery connection.
7. Clean up hub/target servers and the consumer's stdio process.

```text
Consumer -- MCP or A2A --> Hub discovery
Consumer -- MCP HTTP ---> Remote echo tool
Consumer -- MCP stdio --> Local echo process
Consumer -- A2A 1.0 -----> Echo agent
```

The result contains `discovery`, three `executions` with input `text` and fresh `receipt` values, `executionsDuringRegistrationAndDiscovery: 0`, and remaining `demo-agent`/`demo-stdio` targets. Ports and receipts change on every run.

Echo targets do not use external files, networks, or models. The example A2A target supports only 1.0 JSONRPC `SendMessage`. This example does not mount tools into native agent tool lists or implement a general protocol/authentication/task adapter.

## Keep the servers running

```sh
npm run demo -- --serve
```

The readiness JSON contains `hubUrl`, `mcpDiscoveryUrl`, and `agentCardUrl`. A2A 1.0 consumers send `A2A-Version: 1.0`. In another terminal, replace HUB_URL with the actual output:

```sh
node dist/index.js target list --hub HUB_URL
node dist/index.js target check demo-mcp --hub HUB_URL
node dist/index.js target check demo-agent --hub HUB_URL
node dist/index.js target remove demo-mcp --hub HUB_URL
```

The demo is anonymous and loopback-only. It neither reads nor modifies existing HOST/PORT, hub URL/token/database/public URL settings, or personal agent configuration. All registrations are in memory and disappear on exit. Press Ctrl+C to close both servers. Stdio paths and commands refer to this machine.

Configure your actual agent with only `mcpDiscoveryUrl`, or provide the A2A card. See [MCP connection setup](../README.md#mcp-discovery). A sample request:

> Search the hub for demo targets and retrieve their connection details. Connect directly to the HTTP MCP and A2A targets and execute echo. If local process execution is available, call the stdio target too. Show the actual returned execution receipts.

Network and process permissions must be supplied by the consuming environment. Discovery itself does not grant them.

## Run an installed artifact

The source command `npm run demo` builds TypeScript first. An installed tarball already includes the build and can run the example without development dependencies:

```sh
node /actual/installation/agent-tcdh/examples/local-demo.mjs --discovery a2a
```

`npm run test:package` verifies this installation mode too.
