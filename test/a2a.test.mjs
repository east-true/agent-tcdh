// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { inspectRemote, remoteImportSchema, refreshDefinition } from "../dist/remote-import.js";
import { HubClient } from "../dist/client.js";
import { TargetStore } from "../dist/targets/store.js";
import { targetDefinitionSchema } from "../dist/targets/schema.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";
import { cardSource, mcpSource } from "./import-helpers.mjs";

const execute = promisify(execFile);

/** Apply defaults and inspect only A2A metadata. */
async function inspect(url, extra = {}) {
  return inspectRemote(remoteImportSchema.parse({ id: "agent", protocol: "a2a", url, ...extra }));
}

/** Run an isolated CLI without inheriting a personal hub token. */
async function cli(args) {
  return execute(process.execPath, [resolve("dist/index.js"), ...args], {
    env: { ...process.env, AGENT_TCDH_TOKEN: "" }, timeout: 15_000,
  });
}

/** Decode the hub JSON payload in an MCP response. */
function payload(result) {
  return JSON.parse(result.content.find((part) => part.type === "text").text);
}

test("native cards preserve the selected interface binding and version", async (t) => {
  const source = await cardSource(t, async () => ({
    name: "Modern", description: "인터페이스별 판본", protocolVersion: "0.3.0",
    supportedInterfaces: [
      { protocolBinding: "GRPC", protocolVersion: "1.0", url: "https://agent.example.com/grpc" },
      { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://agent.example.com/rpc" },
      { protocolBinding: "HTTP+JSON", protocolVersion: "0.3.0", url: "https://agent.example.com/rest" },
    ], skills: [],
  }));
  const target = await inspect(source.url);
  assert.equal(target.connection.url, "https://agent.example.com/rpc");
  assert.equal(target.connection.protocolBinding, "JSONRPC");
  assert.equal(target.connection.protocolVersion, "1.0");
});

test("legacy cards preserve preferred transports, alternative interfaces, and unknown values", async (t) => {
  let card = {
    name: "Legacy", description: "이전 카드", protocolVersion: "0.3.0",
    preferredTransport: "HTTP+JSON", url: "https://agent.example.com/rest",
    additionalInterfaces: [{ transport: "JSONRPC", url: "https://agent.example.com/rpc" }], skills: [],
  };
  const source = await cardSource(t, async () => card);
  const preferred = await inspect(source.url);
  assert.equal(preferred.connection.protocolBinding, "HTTP+JSON");
  assert.equal(preferred.connection.protocolVersion, "0.3.0");
  const alternate = await inspect(source.url, { a2aBinding: "JSONRPC" });
  assert.equal(alternate.connection.url, "https://agent.example.com/rpc");
  card = { ...card, preferredTransport: "GRPC" };
  assert.equal((await inspect(source.url)).connection.url, "https://agent.example.com/rpc");

  card = { name: "Old", description: "접속 주소만 알려진 카드", url: "https://agent.example.com", skills: [] };
  const unknown = await inspect(source.url);
  assert.equal(Object.hasOwn(unknown.connection, "protocolBinding"), false);
  assert.equal(Object.hasOwn(unknown.connection, "protocolVersion"), false);
  card = { ...card, protocolVersion: "0.3.0", supportedInterfaces: [{ protocolBinding: "JSONRPC", url: card.url }] };
  const missingInterfaceVersion = await inspect(source.url);
  assert.equal(missingInterfaceVersion.connection.protocolBinding, "JSONRPC");
  assert.equal(Object.hasOwn(missingInterfaceVersion.connection, "protocolVersion"), false);
});

test("binding and version selection matches exact declarations and sends the version header", async (t) => {
  const versions = [];
  const source = await cardSource(t, async (request) => {
    versions.push(request.headers["a2a-version"]);
    return { name: "Multiple", description: "여러 인터페이스", supportedInterfaces: [
      { protocolBinding: "JSONRPC", protocolVersion: "0.3", url: "https://agent.example.com/old" },
      { protocolBinding: "HTTP+JSON", protocolVersion: "1.0", url: "https://agent.example.com/rest" },
      { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://agent.example.com/new" },
    ], skills: [] };
  });
  const selected = await inspect(source.url, { a2aBinding: "JSONRPC", a2aVersion: "1.0" });
  assert.equal(selected.connection.url, "https://agent.example.com/new");
  assert.equal(versions.at(-1), "1.0");
  await assert.rejects(inspect(source.url, { a2aBinding: "HTTP+JSON", a2aVersion: "0.3" }), /matching A2A binding and version/);
  await assert.rejects(inspect(source.url, { a2aVersion: "0.3.0" }), /matching A2A binding and version/);
});

test("unsupported native interfaces do not fall back to legacy URLs or infer transports", async (t) => {
  const base = { name: "Unsupported", description: "지원 선언 확인", url: "https://agent.example.com/fallback", skills: [] };
  let card;
  const source = await cardSource(t, async () => card);
  for (const extra of [
    { supportedInterfaces: [{ protocolBinding: "GRPC", protocolVersion: "1.0", url: base.url }] },
    { supportedInterfaces: [] },
    { preferredTransport: "GRPC" },
    { supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "ftp://agent.example.com" }] },
  ]) {
    card = { ...base, ...extra };
    await assert.rejects(inspect(source.url), /no supported HTTP endpoint/);
  }
});

test("HTTP and stdio MCP return identical A2A binding and version metadata", async (t) => {
  const app = await fixture(t);
  const input = definition("contract", { protocol: "a2a", connection: {
    transport: "http", url: "https://agent.example.com/rest", protocolBinding: "HTTP+JSON", protocolVersion: "1.0",
  } });
  const created = await register(app, input);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().connection, input.connection);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const transports = [
    new StreamableHTTPClientTransport(new URL(hub + "/mcp")),
    new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js"), "mcp", "--hub", hub],
      env: { AGENT_TCDH_TOKEN: "" }, stderr: "pipe" }),
  ];
  for (const transport of transports) {
    const client = new Client({ name: "a2a-contract-test", version: "1.0.0" });
    t.after(async () => {
      await client.close();
    });
    await client.connect(transport);
    assert.deepEqual(payload(await client.callTool({ name: "get_target", arguments: { id: input.id } })).connection, input.connection);
    const list = payload(await client.callTool({ name: "search_targets", arguments: { protocol: "a2a" } }));
    assert.deepEqual(list.items[0].connection, input.connection);
  }
});

test("SQLite restarts and snapshot imports preserve new metadata and legacy definitions", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "registry.sqlite");
  const enriched = targetDefinitionSchema.parse(definition("enriched", { protocol: "a2a", connection: {
    transport: "http", url: "https://agent.example.com/rpc", protocolBinding: "JSONRPC", protocolVersion: "0.3.0",
  } }));
  const legacy = targetDefinitionSchema.parse(definition("legacy", { protocol: "a2a", connection: {
    transport: "http", url: "https://legacy.example.com",
  } }));
  const initial = new TargetStore(path);
  initial.create(enriched);
  initial.create(legacy);
  initial.close();
  const reopened = new TargetStore(path);
  const destination = new TargetStore(":memory:");
  try {
    assert.deepEqual(reopened.get("enriched").connection, enriched.connection);
    assert.deepEqual(reopened.get("legacy").connection, legacy.connection);
    destination.importSnapshot(reopened.exportSnapshot(), { onConflict: "error", dryRun: false });
    assert.deepEqual(destination.get("enriched").connection, enriched.connection);
    assert.deepEqual(destination.get("legacy").connection, legacy.connection);
  } finally {
    destination.close();
    reopened.close();
  }
});

test("CLI imports preserve selection across refresh and apply only explicit changes", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  let interfaces = [
    { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://agent.example.com/rpc" },
    { protocolBinding: "HTTP+JSON", protocolVersion: "0.3.0", url: "https://agent.example.com/rest" },
  ];
  const source = await cardSource(t, async () => ({ name: "Remote", description: "선택 유지", supportedInterfaces: interfaces, skills: [] }));
  const imported = JSON.parse((await cli([
    "target", "import", source.url, "--protocol", "a2a", "--id", "cli-agent",
    "--a2a-binding", "HTTP+JSON", "--a2a-version", "0.3.0", "--hub", hub,
  ])).stdout);
  assert.equal(imported.connection.protocolBinding, "HTTP+JSON");
  interfaces[1] = { ...interfaces[1], url: "https://agent.example.com/rest-v2" };
  const refreshed = JSON.parse((await cli(["target", "refresh", "cli-agent", "--hub", hub])).stdout);
  assert.equal(refreshed.connection.url, "https://agent.example.com/rest-v2");
  assert.equal(refreshed.connection.protocolVersion, "0.3.0");
  const client = new HubClient(hub);
  const before = await client.getVersioned("cli-agent");
  interfaces = [interfaces[0]];
  await assert.rejects(cli(["target", "refresh", "cli-agent", "--hub", hub]), /matching A2A binding and version/);
  assert.deepEqual(await client.getVersioned("cli-agent"), before);
  const changed = JSON.parse((await cli([
    "target", "refresh", "cli-agent", "--a2a-binding", "JSONRPC", "--a2a-version", "1.0", "--hub", hub,
  ])).stdout);
  assert.equal(changed.connection.protocolBinding, "JSONRPC");
  assert.equal(changed.connection.protocolVersion, "1.0");
  assert.equal(changed.createdAt, imported.createdAt);
});

test("MCP targets reject A2A selection and invalid binding or version fields", async (t) => {
  const source = await mcpSource(t);
  const app = await fixture(t);
  await register(app, definition("mcp", { connection: { transport: "streamable-http", url: source.url + "/mcp" } }));
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await assert.rejects(cli([
    "target", "import", source.url + "/mcp", "--id", "invalid", "--protocol", "mcp", "--a2a-version", "1.0", "--hub", hub,
  ]), /only available for A2A targets/);
  await assert.rejects(cli(["target", "refresh", "mcp", "--a2a-binding", "JSONRPC", "--hub", hub]), /only available for A2A targets/);
  assert.equal(source.state.listCalls, 0);
  for (const extra of [
    { protocolBinding: "GRPC" }, { protocolBinding: "jsonrpc" },
    { protocolVersion: "" }, { protocolVersion: " 1.0" }, { protocolVersion: "invalid" },
  ]) {
    const response = await register(app, definition("invalid", { protocol: "a2a", connection: {
      transport: "http", url: "https://agent.example.com", ...extra,
    } }));
    assert.equal(response.statusCode, 400, JSON.stringify(extra));
  }
});

test("concurrent administrator changes to the binding prevent refresh overwrites", async (t) => {
  const source = await cardSource(t, async () => ({ name: "Agent", description: "충돌 검사", supportedInterfaces: [
    { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://agent.example.com/rpc" },
  ], skills: [] }));
  const original = { ...definition("race", { protocol: "a2a", connection: {
    transport: "http", url: "https://agent.example.com/rpc", agentCardUrl: source.url + "/custom-card",
    protocolBinding: "JSONRPC", protocolVersion: "1.0",
  } }), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  let reads = 0;
  await assert.rejects(refreshDefinition({ getVersioned: async () => ({
    target: ++reads === 1 ? original : { ...original, connection: { ...original.connection, protocolBinding: "HTTP+JSON" } },
    etag: '"version"',
  }) }, "race"), /Connection details changed/);
});

test("OpenAPI describes optional A2A bindings and versions using the runtime contract", async (t) => {
  const app = await fixture(t);
  const spec = (await app.inject("/openapi.json")).json();
  const validator = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  validator.addSchema(spec, "urn:agent-tcdh:a2a");
  const valid = validator.compile({ $ref: "urn:agent-tcdh:a2a#/components/schemas/TargetDefinition" });
  const input = definition("contract", { protocol: "a2a", connection: {
    transport: "http", url: "https://agent.example.com", protocolBinding: "HTTP+JSON", protocolVersion: "1.0",
  } });
  assert.ok(valid(input), JSON.stringify(valid.errors));
  assert.equal(valid({ ...input, connection: { ...input.connection, protocolBinding: "GRPC" } }), false);
  assert.equal(valid({ ...input, connection: { ...input.connection, protocolVersion: "bad" } }), false);
  assert.ok(valid({ ...input, connection: { transport: "http", url: input.connection.url } }));
});
