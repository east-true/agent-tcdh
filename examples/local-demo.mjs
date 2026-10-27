import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentCard, Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createApp } from "../dist/app.js";
import { HubClient } from "../dist/client.js";
import { inspectRemote, remoteImportSchema } from "../dist/remote-import.js";
import { createDemoTargets } from "./demo-targets.mjs";

/** Prepare an isolated hub and three connection types for tests and demonstrations. */
export async function createLocalDemo() {
  // 1. Create an in-memory hub without using personal settings or existing databases.
  const targets = await createDemoTargets();
  const hub = createApp({ logger: false, dbPath: ":memory:" });
  /** Close both HTTP servers owned by this example. */
  async function close() {
    const results = await Promise.allSettled([hub.close(), targets.app.close()]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), "Unable to clean up demo servers.");
    }
  }
  try {
    const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
    const admin = new HubClient(hubUrl);

    // 2. Import HTTP metadata and register stdio commands without executing them.
    const remoteMcp = await inspectRemote(remoteImportSchema.parse({ id: "demo-mcp", protocol: "mcp", url: targets.url + "/mcp", tags: ["demo"] }));
    const agent = await inspectRemote(remoteImportSchema.parse({ id: "demo-agent", protocol: "a2a", url: targets.url,
      a2aBinding: "JSONRPC", a2aVersion: "1.0", tags: ["demo"] }));
    const localMcp = { ...remoteMcp, id: "demo-stdio", name: "Demo stdio MCP", connection: {
      transport: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./demo-targets.mjs", import.meta.url)), "--stdio"],
    } };
    for (const definition of [remoteMcp, localMcp, agent]) {
      await admin.create(definition);
    }
    assert.equal(targets.executions.length, 0, "Targets must not execute during registration.");
    return { hubUrl, admin, targets, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Send a discovery command as an A2A message and decode its structured result. */
async function a2aQuery(client, operation, args) {
  const response = await client.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation, arguments: args } }],
  } }));
  return Message.toJSON(response).parts[0].data;
}

/** Connect a discovery client over MCP or A2A using only the hub URL. */
async function connectDiscovery(hubUrl, mode) {
  if (mode === "a2a") {
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] }).createFromUrl(hubUrl);
    return {
      search: () => a2aQuery(client, "search_targets", { tag: "demo" }),
      get: (id) => a2aQuery(client, "get_target", { id }),
      close: async () => undefined,
    };
  }
  const client = new Client({ name: "demo-consumer", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(hubUrl + "/mcp")));
  } catch (error) {
    await client.close();
    throw error;
  }
  /** Decode a text MCP tool response into hub JSON. */
  async function query(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  }
  return { search: () => query("search_targets", { tag: "demo" }), get: (id) => query("get_target", { id }), close: () => client.close() };
}

/** Connect directly using discovered metadata and execute the target's echo capability. */
async function executeTarget(target, text) {
  // 1. Select the registered A2A URL, binding, and version from the published card.
  const connection = target.connection;
  if (target.protocol === "a2a") {
    const response = await fetch(connection.agentCardUrl, { headers: { "A2A-Version": connection.protocolVersion }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const card = AgentCard.fromJSON(await response.json());
    const selected = card.supportedInterfaces.filter((entry) => entry.url === connection.url
      && entry.protocolBinding === connection.protocolBinding && entry.protocolVersion === connection.protocolVersion);
    assert.ok(selected.length, "The registered A2A interface is missing from the card.");
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] })
      .createFromAgentCard({ ...card, supportedInterfaces: selected });
    const message = await client.sendMessage(SendMessageRequest.fromJSON({ message: {
      messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }],
    } }));
    return Message.toJSON(message).parts[0].data;
  }

  // 2. Connect to the MCP URL or start the discovered local command in the consuming process.
  const client = new Client({ name: "demo-direct-consumer", version: "1.0.0" });
  const transport = connection.transport === "stdio"
    ? new StdioClientTransport({ command: connection.command, args: connection.args, stderr: "pipe" })
    : new StreamableHTTPClientTransport(new URL(connection.url));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "echo", arguments: { text } });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}

/** Reproduce registration, both discovery protocols, three direct calls, and deletion visibility. */
export async function runLocalDemo(mode = "mcp") {
  assert.ok(["mcp", "a2a"].includes(mode), "Discovery mode must be mcp or a2a.");
  const demo = await createLocalDemo();
  let discovery;
  try {
    // 1. Give the consumer only the hub URL, without target addresses.
    discovery = await connectDiscovery(demo.hubUrl, mode);
    const found = await discovery.search();
    assert.equal(found.total, 3);
    const definitions = [];
    for (const candidate of found.items) {
      definitions.push(await discovery.get(candidate.id));
    }
    assert.equal(demo.targets.executions.length, 0, "Targets must not execute during discovery.");

    // 2. Call three targets directly and verify actual execution receipts.
    const executions = [];
    for (const definition of definitions) {
      const text = "AgentTCDH demo " + randomUUID();
      const result = await executeTarget(definition, text);
      assert.equal(result.text, text);
      assert.match(result.receipt, /^[0-9a-f-]{36}$/u);
      executions.push({ id: definition.id, protocol: definition.protocol, transport: definition.connection.transport, ...result });
    }
    assert.equal(demo.targets.executions.length, 2);
    for (const observation of demo.targets.executions) {
      assert.ok(executions.some((item) => item.receipt === observation.receipt));
    }

    // 3. Delete a target as administrator and query through the same discovery connection.
    await demo.admin.remove("demo-mcp");
    const remaining = await discovery.search();
    assert.deepEqual(remaining.items.map((item) => item.id).sort(), ["demo-agent", "demo-stdio"]);
    return { discovery: mode, targetsFound: found.total, executions,
      executionsDuringRegistrationAndDiscovery: 0, removedTarget: "demo-mcp", remainingTargets: remaining.items.map((item) => item.id) };
  } finally {
    try {
      await discovery?.close();
    } finally {
      await demo.close();
    }
  }
}

/** Wait for console signals or an owning parent's IPC shutdown request. */
function waitForStop() {
  return new Promise((resolve) => {
    /** Handle either shutdown signal exactly once. */
    function stop() {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("message", onMessage);
      if (process.connected) {
        process.disconnect();
      }
      resolve();
    }
    /** Accept shutdown only from an already connected parent IPC channel. */
    function onMessage(message) {
      if (message === "shutdown") {
        stop();
      }
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.send) {
      process.on("message", onMessage);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({ options: { discovery: { type: "string" }, serve: { type: "boolean" } } });
  if (values.serve && values.discovery !== undefined) {
    throw new Error("--serve cannot be combined with --discovery.");
  }
  if (values.serve) {
    const demo = await createLocalDemo();
    try {
      const stopped = waitForStop();
      console.log(JSON.stringify({ mode: "serve", hubUrl: demo.hubUrl, mcpDiscoveryUrl: demo.hubUrl + "/mcp",
        agentCardUrl: demo.hubUrl + "/.well-known/agent-card.json", auth: "none", targets: ["demo-agent", "demo-mcp", "demo-stdio"] }));
      await stopped;
    } finally {
      await demo.close();
    }
  } else {
    console.log(JSON.stringify(await runLocalDemo(values.discovery ?? "mcp"), null, 2));
  }
}
