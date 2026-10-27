import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

assert.ok(process.argv[2] && process.argv[3], "Specify the project root and external package installation path.");
const projectRoot = resolve(process.argv[2]);
const packageRoot = resolve(process.argv[3]);
const { createA2AServer } = await import(pathToFileURL(join(packageRoot, "node_modules/@a2a-wrapper/core/dist/index.js")));
const { Message } = await import(pathToFileURL(join(packageRoot, "node_modules/@a2a-js/sdk/dist/index.js")));
const { AgentEvent } = await import(pathToFileURL(join(packageRoot, "node_modules/@a2a-js/sdk/dist/server/index.js")));
const { createApp } = await import(pathToFileURL(join(projectRoot, "dist/app.js")));
const { inspectRemote } = await import(pathToFileURL(join(projectRoot, "dist/remote-import.js")));
const { targetDefinitionSchema } = await import(pathToFileURL(join(projectRoot, "dist/targets/schema.js")));
const output = process.argv[4] ?? join(tmpdir(), "a2a-registration-" + randomUUID() + ".json");

const receipt = randomUUID();
let executions = 0;
const results = [];
const configuration = {
  agentCard: { name: "Adapter compatibility probe", description: "Stub executor for external A2A adapter registration compatibility",
    skills: [{ id: "probe", name: "Probe", description: "Fixed test response", tags: ["test"] }] },
  server: { hostname: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 },
};
const executor = {
  /** Prepare protocol inspection without connecting real products or models. */
  async initialize() {
  },
  /** Issue a verification message for a protocol request. */
  async execute(context, bus) {
    executions++;
    bus.publish(AgentEvent.message(Message.fromJSON({
      messageId: randomUUID(), contextId: context.contextId, role: "ROLE_AGENT", parts: [{ text: receipt }],
    })));
    bus.finished();
  },
  /** Explicitly reject cancellation outside the inspection scope. */
  async cancelTask() {
    throw new Error("Cancellation is outside this verification scope.");
  },
  /** Indicate that the stub executor has no additional shutdown resources. */
  async shutdown() {
  },
};

const wrapper = await createA2AServer(configuration, () => executor);
if (!wrapper.server.listening) {
  await once(wrapper.server, "listening");
}
const root = "http://127.0.0.1:" + wrapper.server.address().port;
const hub = createApp({ logger: false });
try {
  // 1. Parse the published adapter core's actual Agent Card with the current importer.
  const defaultDefinition = await inspectRemote({ protocol: "a2a", id: "default-probe", url: root });
  assert.equal(defaultDefinition.connection.protocolVersion, "0.3.0");
  assert.equal(Object.hasOwn(defaultDefinition.connection, "protocolBinding"), false);
  const definition = await inspectRemote({ protocol: "a2a", id: "adapter-probe", url: root, a2aBinding: "JSONRPC" });
  assert.equal(definition.connection.url, root + "/a2a/jsonrpc");
  assert.equal(definition.connection.protocolBinding, "JSONRPC");
  assert.equal(definition.connection.protocolVersion, "0.3.0");
  assert.equal(executions, 0);
  const added = await hub.inject({ method: "POST", url: "/api/targets", payload: definition });
  assert.equal(added.statusCode, 201, added.body);
  const found = await hub.inject({ method: "GET", url: "/api/targets?q=probe&protocol=a2a" });
  assert.equal(found.json().items[0].id, "adapter-probe");
  assert.equal(found.json().items[0].connection.protocolBinding, "JSONRPC");
  assert.equal(found.json().items[0].connection.protocolVersion, "0.3.0");
  results.push({ check: "published-core-legacy-card-import-register-search", passed: true,
    executionsDuringRegistration: executions, undeclaredDefaultBindingOmitted: true,
    selectedBinding: definition.connection.protocolBinding, protocolVersion: definition.connection.protocolVersion });

  // 2. Send A2A messages directly to the discovered endpoint and verify the stub response.
  const response = await fetch(found.json().items[0].connection.url, {
    method: "POST", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "message/send", params: {
      message: { kind: "message", messageId: randomUUID(), role: "user", parts: [{ kind: "text", text: "probe" }] },
    } }),
  });
  const message = await response.json();
  assert.equal(response.status, 200, JSON.stringify(message));
  assert.ok(JSON.stringify(message.result).includes(receipt), JSON.stringify(message));
  assert.equal(executions, 1);
  results.push({ check: "discovered-endpoint-direct-a2a-legacy-message", passed: true, realBackend: false });

  // 3. Verify import and registration of the same core's native 1.0 card.
  const nativeResponse = await fetch(root + "/.well-known/agent-card.json", { headers: { "A2A-Version": "1.0" } });
  const nativeCard = await nativeResponse.json();
  assert.ok(nativeCard.supportedInterfaces.some((item) => item.protocolVersion === "1.0"));
  const nativeDefinition = await inspectRemote({
    protocol: "a2a", id: "native-probe", url: root, a2aBinding: "JSONRPC", a2aVersion: "1.0",
  });
  assert.equal(nativeDefinition.connection.url, root + "/a2a/jsonrpc");
  assert.equal(nativeDefinition.connection.protocolBinding, "JSONRPC");
  assert.equal(nativeDefinition.connection.protocolVersion, "1.0");
  const nativeAdded = await hub.inject({ method: "POST", url: "/api/targets", payload: nativeDefinition });
  assert.equal(nativeAdded.statusCode, 201, nativeAdded.body);
  results.push({ check: "published-core-native-card-import-register", passed: true,
    preservedBinding: Object.hasOwn(nativeDefinition.connection, "protocolBinding"),
    preservedProtocolVersion: Object.hasOwn(nativeDefinition.connection, "protocolVersion") });

  // 4. Reject non-A2A session APIs, CLI, and gRPC as supported A2A registrations.
  wrapper.app.get("/plain-session-api", (_request, reply) => reply.json({ session_id: "not-an-agent-card" }));
  await assert.rejects(inspectRemote({ protocol: "a2a", id: "invalid", url: root + "/plain-session-api" }));
  assert.equal(targetDefinitionSchema.safeParse({ ...definition, connection: { transport: "cli", command: "aider" } }).success, false);
  assert.equal(targetDefinitionSchema.safeParse({ ...definition, connection: { transport: "grpc", url: "grpc://localhost:1" } }).success, false);
  results.push({ check: "non-a2a-api-cli-grpc-not-treated-as-supported-registration", passed: true });
  await writeFile(output, JSON.stringify({
    coreVersion: "2.1.1", a2aSdkVersion: "1.3.0", productBackendExecuted: false, results,
  }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, results }, null, 2));
} finally {
  await hub.close();
  await wrapper.shutdown();
}
