// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { inspectRemote, refreshDefinition, remoteImportSchema } from "../dist/remote-import.js";
import { HubClient } from "../dist/client.js";
import { mcpSource, cardSource } from "./import-helpers.mjs";
import { definition, fixture, register } from "./helpers.mjs";

const execute = promisify(execFile);

/** Apply defaults before inspecting a remote target. */
async function inspect(input, environment = {}, timeout = 10_000) {
  return inspectRemote(remoteImportSchema.parse(input), environment, timeout);
}

/** Run the administrative CLI in an independent process. */
async function cli(args, environment = {}) {
  return execute(process.execPath, [resolve("dist/index.js"), ...args], {
    env: { ...process.env, AGENT_TCDH_TOKEN: "", ...environment }, timeout: 15_000,
  });
}

test("MCP pagination collects metadata without tool calls and retains credential references only", async (t) => {
  const source = await mcpSource(t, {
    token: "remote-secret",
    pages: [
      { tools: [{ name: "first", description: "첫 기능", inputSchema: { type: "object" } }], nextCursor: "1" },
      { tools: [{ name: "second", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
    ],
  });
  const target = await inspect({
    id: "remote", protocol: "mcp", url: source.url + "/mcp",
    bearerEnv: "REMOTE_TOKEN", tags: ["docs"],
  }, { REMOTE_TOKEN: "remote-secret" });
  assert.equal(target.name, "Remote MCP");
  assert.deepEqual(target.capabilities.map((capability) => capability.name), ["first", "second"]);
  assert.deepEqual(target.capabilities[1].inputSchema.properties, { q: { type: "string" } });
  assert.deepEqual(target.connection.auth, { type: "bearer", envVars: ["REMOTE_TOKEN"] });
  assert.ok(source.state.headers.every((value) => value === "Bearer remote-secret"));
  assert.equal(source.state.calls, 0);
  assert.equal(JSON.stringify(target).includes("remote-secret"), false);
});

test("legacy SSE MCP metadata is collected and connections are closed", async (t) => {
  const source = await mcpSource(t);
  const target = await inspect({
    id: "legacy", protocol: "mcp", url: source.url + "/sse", transport: "sse",
  });
  assert.equal(target.connection.transport, "sse");
  assert.equal(target.capabilities[0].name, "search_docs");
  assert.equal(source.state.calls, 0);
});

test("repeated MCP cursors and oversized capability lists fail without partial registration", async (t) => {
  const cyclic = await mcpSource(t, {
    pages: [{ tools: [], nextCursor: "1" }, { tools: [], nextCursor: "1" }],
  });
  await assert.rejects(inspect({
    id: "cycle", protocol: "mcp", url: cyclic.url + "/mcp",
  }), /cursor is repeated/);
  const large = await mcpSource(t, {
    pages: [{ tools: Array.from({ length: 201 }, (_, index) => ({
      name: "tool_" + index, inputSchema: { type: "object" },
    })) }],
  });
  await assert.rejects(inspect({
    id: "large", protocol: "mcp", url: large.url + "/mcp",
  }), /at most 200/);
});

test("native A2A cards expose HTTP interfaces and skills and resolve standard discovery paths", async (t) => {
  let endpoint;
  const source = await cardSource(t, async () => ({
    name: "Research Agent", description: "자료 조사",
    version: "1.0.0",
    supportedInterfaces: [
      { protocolBinding: "GRPC", protocolVersion: "1.0", url: "grpc.example.com:443" },
      { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: endpoint },
    ],
    skills: [{ id: "research", name: "Research", description: "공식 출처 조사", tags: ["research"] }],
  }));
  endpoint = source.url + "/agent";
  const target = await inspect({ id: "agent", protocol: "a2a", url: source.url });
  assert.equal(target.connection.url, endpoint);
  assert.equal(target.connection.agentCardUrl, source.url + "/.well-known/agent-card.json");
  assert.deepEqual(target.capabilities, [{ name: "research", description: "공식 출처 조사" }]);
});

test("legacy A2A URLs and custom card paths are supported", async (t) => {
  const source = await cardSource(t, async () => ({
    name: "Legacy Agent", description: "이전 형식 카드",
    url: "https://agent.example.com", skills: [],
  }));
  const target = await inspect({
    id: "legacy-agent", protocol: "a2a", url: source.url + "/custom-card", name: "Custom",
  });
  assert.equal(target.name, "Custom");
  assert.equal(target.connection.url, "https://agent.example.com");
});

test("missing credentials, invalid cards, and unsupported interfaces fail explicitly", async (t) => {
  await assert.rejects(inspect({
    id: "auth", protocol: "mcp", url: "http://127.0.0.1:1/mcp", bearerEnv: "MISSING",
  }), /environment variable is missing/);
  const source = await cardSource(t, async () => ({
    name: "GRPC", description: "HTTP 없음",
    supportedInterfaces: [{ protocolBinding: "GRPC", url: "grpc.example.com:443" }], skills: [],
  }));
  await assert.rejects(inspect({
    id: "grpc", protocol: "a2a", url: source.url,
  }), /no supported HTTP endpoint/);
  const invalid = await cardSource(t, async () => ({ name: "Invalid" }));
  await assert.rejects(inspect({ id: "invalid", protocol: "a2a", url: invalid.url }));
});

test("invalid token values are not reflected in error messages", async () => {
  const secret = "hidden-secret\ninvalid";
  await assert.rejects(inspect({
    id: "invalid-token", protocol: "mcp", url: "http://127.0.0.1:1/mcp", bearerEnv: "REMOTE_TOKEN",
  }, { REMOTE_TOKEN: secret }), (error) => {
    assert.match(error.message, /Bearer tokens/);
    assert.equal(error.message.includes("hidden-secret"), false);
    return true;
  });
});

test("metadata requests reject redirects and enforce response size and overall timeout limits", async (t) => {
  let followed = 0;
  const destination = await cardSource(t, async () => {
    followed++;
    return { name: "Unused" };
  });
  const redirect = await cardSource(t, async (_request, reply) => {
    return reply.redirect(destination.url + "/custom-card");
  });
  await assert.rejects(inspect({
    id: "redirect", protocol: "a2a", url: redirect.url,
  }), /final metadata URL/);
  assert.equal(followed, 0);
  const large = await cardSource(t, async () => ({ data: "x".repeat(1_048_576) }));
  await assert.rejects(inspect({ id: "large", protocol: "a2a", url: large.url }), /1 MiB/);
  const slow = await cardSource(t, async () => {
    await setTimeout(250);
    return {};
  });
  await assert.rejects(inspect({ id: "slow", protocol: "a2a", url: slow.url }, {}, 40), /timeout|aborted/i);
});

test("CLI import previews, registration, and refresh preserve existing data on failure", async (t) => {
  const hubApp = await fixture(t, { token: "hub-secret" });
  const hub = await hubApp.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { token: "peer-secret" });
  const environment = { AGENT_TCDH_TOKEN: "hub-secret", PEER_TOKEN: "peer-secret" };
  const args = [
    "target", "import", source.url + "/mcp", "--id", "auto", "--protocol", "mcp",
    "--bearer-env", "PEER_TOKEN", "--name", "Custom title", "--tag", "custom", "--hub", hub,
  ];
  const preview = JSON.parse((await cli([...args, "--dry-run"], environment)).stdout);
  assert.equal(preview.id, "auto");
  const client = new HubClient(hub, "hub-secret");
  assert.equal((await client.search({ q: "", limit: 20, offset: 0, includeDisabled: true })).total, 0);
  const saved = JSON.parse((await cli(args, environment)).stdout);
  assert.equal(saved.name, "Custom title");
  await client.update("auto", {
    ...preview, description: "직접 작성한 설명", enabled: false,
  });
  source.state.pages = [{
    tools: [{ name: "new_tool", description: "새로운 기능", inputSchema: { type: "object" } }],
  }];
  const refreshPreview = JSON.parse((await cli([
    "target", "refresh", "auto", "--dry-run", "--hub", hub,
  ], environment)).stdout);
  assert.equal(refreshPreview.capabilities[0].name, "new_tool");
  assert.equal((await client.get("auto")).capabilities[0].name, "search_docs");
  const refreshed = JSON.parse((await cli(["target", "refresh", "auto", "--hub", hub], environment)).stdout);
  assert.equal(refreshed.name, "Custom title");
  assert.equal(refreshed.description, "직접 작성한 설명");
  assert.deepEqual(refreshed.tags, ["custom"]);
  assert.equal(refreshed.enabled, false);
  assert.equal(refreshed.createdAt, saved.createdAt);
  assert.deepEqual(refreshed.capabilities.map((item) => item.name), ["new_tool"]);
  source.state.fail = true;
  await assert.rejects(cli(["target", "refresh", "auto", "--hub", hub], environment));
  assert.deepEqual(await client.get("auto"), refreshed);
  assert.equal(source.state.calls, 0);
});

test("refresh preserves concurrent label changes and rejects changed connections", async (t) => {
  const source = await mcpSource(t);
  const original = {
    ...definition("concurrent", { connection: { transport: "streamable-http", url: source.url + "/mcp" } }),
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let reads = 0;
  const preserved = await refreshDefinition({
    getVersioned: async () => ({
      target: ++reads === 1 ? original : { ...original, name: "Changed while fetching", tags: ["new"] },
      etag: '"test-version"',
    }),
  }, "concurrent");
  assert.equal(preserved.target.name, "Changed while fetching");
  assert.deepEqual(preserved.target.tags, ["new"]);
  assert.equal(preserved.etag, '"test-version"');
  reads = 0;
  await assert.rejects(refreshDefinition({
    getVersioned: async () => ({
      target: ++reads === 1 ? original : {
        ...original, connection: { transport: "streamable-http", url: "https://changed.example.com/mcp" },
      },
      etag: '"test-version"',
    }),
  }, "concurrent"), /Connection details changed/);
});

test("stdio refresh does not execute the registered command", async (t) => {
  const app = await fixture(t);
  await register(app, definition("local", { connection: { transport: "stdio", command: "/never-execute" } }));
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await assert.rejects(cli(["target", "refresh", "local", "--hub", hub]), /not supported for stdio/);
});
