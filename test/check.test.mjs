// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import Fastify from "fastify";
import { checkTarget } from "../dist/targets/check.js";
import { targetDefinitionSchema } from "../dist/targets/schema.js";
import { inspectRemote, remoteImportSchema } from "../dist/remote-import.js";
import { definition, fixture, register } from "./helpers.mjs";
import { cardSource, mcpSource } from "./import-helpers.mjs";

const execute = promisify(execFile);

/** Build a stored target response from a file-style definition. */
function target(input) {
  return { ...targetDefinitionSchema.parse(input), createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" };
}

/** Prepare a comparison baseline from actual remote metadata. */
async function imported(input, environment = {}) {
  return target(await inspectRemote(remoteImportSchema.parse(input), environment));
}

/** Capture CLI exit codes and JSON output on success or failure. */
async function cli(args, environment = {}) {
  try {
    const result = await execute(process.execPath, [resolve("dist/index.js"), ...args], {
      env: { ...process.env, AGENT_TCDH_TOKEN: "", ...environment }, timeout: 15_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("MCP and SSE checks read tool metadata without execution or baseline mutations", async (t) => {
  const source = await mcpSource(t, { token: "peer-secret" });
  for (const transport of ["streamable-http", "sse"]) {
    const baseline = await imported({ id: "peer", protocol: "mcp", transport,
      url: source.url + (transport === "sse" ? "/sse" : "/mcp"), bearerEnv: "PEER_TOKEN" }, { PEER_TOKEN: "peer-secret" });
    const before = structuredClone(baseline);
    const report = await checkTarget(baseline, {}, { PEER_TOKEN: "peer-secret" });
    assert.equal(report.status, "passed");
    assert.equal(report.scope, "mcp-tools-list");
    assert.equal(report.executionVerified, false);
    assert.deepEqual(report.capabilities, { registered: 1, observed: 1, added: [], removed: [], changed: [] });
    assert.deepEqual(baseline, before);
    assert.equal(JSON.stringify(report).includes("peer-secret"), false);
    assert.equal(source.state.calls, 0);
  }
});

test("capability changes distinguish additions, removals, and content changes while ignoring object key order", async (t) => {
  const source = await mcpSource(t, { pages: [{ tools: [
    { name: "same", description: "동일", inputSchema: { type: "object", properties: { q: { type: "string" }, n: { type: "number" } } } },
    { name: "changed", description: "처음", inputSchema: { type: "object" } },
    { name: "removed", inputSchema: { type: "object" } },
  ] }] });
  const baseline = await imported({ id: "peer", protocol: "mcp", url: source.url + "/mcp" });
  source.state.pages = [{ tools: [
    { name: "same", description: "동일", inputSchema: { properties: { n: { type: "number" }, q: { type: "string" } }, type: "object" } },
    { name: "changed", description: "나중", inputSchema: { type: "object", required: ["query"] } },
    { name: "added", inputSchema: { type: "object" } },
  ] }];
  const report = await checkTarget(baseline);
  assert.equal(report.status, "warning");
  assert.deepEqual(report.capabilities, { registered: 3, observed: 3, added: ["added"], removed: ["removed"], changed: ["changed"] });
  assert.equal(report.issues[0].code, "CAPABILITIES_CHANGED");
});

test("A2A checks the saved version's card and distinguishes endpoint differences from execution failure", async (t) => {
  const versions = [];
  const source = await cardSource(t, async (request) => {
    versions.push(request.headers["a2a-version"]);
    return { name: "Agent", description: "카드 점검", supportedInterfaces: [
      { url: "https://agent.example.com/first", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: "https://agent.example.com/second", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: "https://agent.example.com/old", protocolBinding: "HTTP+JSON", protocolVersion: "0.3.0" },
    ], skills: [{ id: "review", description: "검토" }] };
  });
  const baseline = target(definition("agent", { protocol: "a2a", capabilities: [{ name: "review", description: "검토" }],
    connection: { transport: "http", url: "https://agent.example.com/second", agentCardUrl: source.url + "/custom-card",
      protocolBinding: "JSONRPC", protocolVersion: "1.0" } }));
  const report = await checkTarget(baseline);
  assert.equal(report.status, "warning");
  assert.equal(report.scope, "a2a-agent-card");
  assert.equal(report.executionVerified, false);
  assert.equal(report.connection.selectedUrl, "https://agent.example.com/first");
  assert.equal(report.connection.matches, false);
  assert.equal(report.issues[0].code, "CARD_ENDPOINT_DIFFERS");
  assert.deepEqual(versions, ["1.0"]);
  const missing = await checkTarget({ ...baseline, connection: { ...baseline.connection, protocolVersion: "2.0" } });
  assert.equal(missing.status, "failed");
  assert.match(missing.issues[0].message, /binding and version/);
});

test("missing card URLs use the same-origin standard path without sending messages", async (t) => {
  let endpoint;
  const requests = [];
  const source = await cardSource(t, async () => ({ name: "Legacy", description: "이전 카드",
    url: endpoint, preferredTransport: "JSONRPC", protocolVersion: "0.3.0", skills: [] }));
  endpoint = source.url + "/execution-path";
  source.app.server.on("request", (request) => {
    requests.push({ method: request.method, url: request.url });
  });
  const report = await checkTarget(target(definition("agent", { protocol: "a2a", capabilities: [],
    connection: { transport: "http", url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "0.3.0" } })));
  assert.equal(report.status, "passed");
  assert.equal(report.connection.matches, true);
  assert.deepEqual(requests, [{ method: "GET", url: "/.well-known/agent-card.json" }]);
});

test("unsupported authentication and ambiguous, missing, or invalid credentials are reported before requests", async (t) => {
  const source = await mcpSource(t);
  const baseline = target(definition("auth", { connection: { transport: "streamable-http", url: source.url + "/mcp" } }));
  for (const type of ["oauth2", "api-key"]) {
    const report = await checkTarget({ ...baseline, connection: { ...baseline.connection, auth: { type, envVars: [] } } });
    assert.equal(report.status, "skipped");
    assert.equal(report.issues[0].code, "AUTH_NOT_SUPPORTED");
  }
  for (const envVars of [[], ["FIRST", "SECOND"]]) {
    const report = await checkTarget({ ...baseline, connection: { ...baseline.connection, auth: { type: "bearer", envVars } } });
    assert.equal(report.status, "skipped");
    assert.equal(report.issues[0].code, "BEARER_ENV_REQUIRED");
  }
  const missing = await checkTarget(baseline, { bearerEnv: "MISSING_TOKEN" }, {});
  assert.equal(missing.status, "failed");
  assert.equal(missing.issues[0].code, "AUTH_ENV_MISSING");
  const invalid = await checkTarget(baseline, { bearerEnv: "TOKEN" }, { TOKEN: "private-secret\ninvalid" });
  assert.equal(invalid.issues[0].code, "AUTH_TOKEN_INVALID");
  assert.equal(JSON.stringify(invalid).includes("private-secret"), false);
  assert.equal(source.state.headers.length, 0);
});

test("stdio checks explicitly skip command execution", async () => {
  const report = await checkTarget(target(definition("local", { connection: {
    transport: "stdio", command: "this-command-must-not-run", args: ["--never"],
  } })));
  assert.equal(report.status, "skipped");
  assert.equal(report.scope, "none");
  assert.equal(report.executionVerified, false);
  assert.equal(report.issues[0].code, "STDIO_NOT_CHECKED");
});

test("explicit Bearer overrides apply only to inspection and remote token rejection is distinguished", async (t) => {
  const source = await mcpSource(t, { token: "override-secret" });
  const baseline = target(definition("oauth", { capabilities: [{ name: "search_docs", description: "공식 문서 검색", inputSchema: { type: "object" } }],
    connection: { transport: "streamable-http", url: source.url + "/mcp", auth: { type: "oauth2", envVars: ["ORIGINAL"] } } }));
  const report = await checkTarget(baseline, { bearerEnv: "ACCESS_TOKEN" }, { ACCESS_TOKEN: "override-secret" });
  assert.equal(report.status, "passed");
  assert.equal(baseline.connection.auth.type, "oauth2");
  assert.ok(source.state.headers.every((value) => value === "Bearer override-secret"));
  const rejected = await checkTarget(baseline, { bearerEnv: "ACCESS_TOKEN" }, { ACCESS_TOKEN: "wrong-token" });
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.issues[0].code, "METADATA_FETCH_FAILED");
  assert.equal(source.state.calls, 0);
});

test("reflected tokens, invalid cards, redirects, and timeouts produce bounded diagnostics", async (t) => {
  const secret = "never-print-this-token";
  const app = Fastify({ logger: false });
  app.post("/mcp", async (_request, reply) => {
    return reply.code(500).send({ error: secret });
  });
  const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });
  const reflected = await checkTarget(target(definition("reflected", { connection: {
    transport: "streamable-http", url: endpoint + "/mcp", auth: { type: "bearer", envVars: ["TOKEN"] },
  } })), {}, { TOKEN: secret });
  assert.equal(reflected.status, "failed");
  assert.equal(JSON.stringify(reflected).includes(secret), false);
  const invalid = await cardSource(t, async () => ({ name: "Invalid", description: secret }));
  const definitionFor = (url) => target(definition("invalid", { protocol: "a2a", connection: { transport: "http", url, agentCardUrl: url } }));
  const bad = await checkTarget(definitionFor(invalid.url + "/custom-card"));
  assert.equal(bad.issues[0].code, "INVALID_METADATA");
  assert.equal(JSON.stringify(bad).includes(secret), false);
  const redirected = await cardSource(t, async (_request, reply) => {
    return reply.redirect(invalid.url + "/custom-card");
  });
  assert.match((await checkTarget(definitionFor(redirected.url + "/custom-card"))).issues[0].message, /final metadata/);
  const slow = await cardSource(t, async () => {
    await setTimeout(250);
    return {};
  });
  const timeout = await checkTarget(definitionFor(slow.url + "/custom-card"), {}, {}, 40);
  assert.equal(timeout.issues[0].code, "TIMEOUT");
});

test("CLI checks use read tokens and report JSON, exit status, and baseline versions without writes", async (t) => {
  const source = await mcpSource(t, { token: "peer-secret" });
  const baseline = await imported({ id: "checked", protocol: "mcp", url: source.url + "/mcp", bearerEnv: "PEER_TOKEN" }, { PEER_TOKEN: "peer-secret" });
  const app = await fixture(t, { token: "admin", readToken: "reader" });
  const { createdAt, updatedAt, ...input } = baseline;
  const added = await register(app, input, { authorization: "Bearer admin" });
  const before = added.json();
  const etag = added.headers.etag;
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const requests = [];
  app.server.on("request", (request) => {
    requests.push(request.method + " " + request.url);
  });
  const args = ["target", "check", "checked", "--hub", url, "--token-env", "HUB_READER"];
  const environment = { HUB_READER: "reader", PEER_TOKEN: "peer-secret" };
  const passed = await cli(args, environment);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, "passed");
  assert.equal(JSON.parse(passed.stdout).targetVersion, etag);
  source.state.pages = [{ tools: [] }];
  const warning = await cli(args, environment);
  assert.equal(warning.code, 0);
  assert.equal(JSON.parse(warning.stdout).status, "warning");
  const failed = await cli(args, { HUB_READER: "reader", PEER_TOKEN: "" });
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.stdout).issues[0].code, "AUTH_ENV_MISSING");
  assert.ok(requests.every((request) => request === "GET /api/targets/checked"));
  const current = await app.inject({ url: "/api/targets/checked", headers: { authorization: "Bearer reader" } });
  assert.equal(current.headers.etag, etag);
  assert.deepEqual(current.json(), before);
  assert.equal(source.state.calls, 0);
});

test("CLI stdio skips return 2 and invalid check options fail before hub requests", async (t) => {
  const app = await fixture(t);
  await register(app, definition("local", { connection: { transport: "stdio", command: "never-execute" } }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const skipped = await cli(["target", "check", "local", "--hub", url]);
  assert.equal(skipped.code, 2);
  assert.equal(JSON.parse(skipped.stdout).issues[0].code, "STDIO_NOT_CHECKED");
  for (const extra of [["--dry-run"], ["--a2a-version", "1.0"], ["--bearer-env", "BAD-NAME"]]) {
    const invalid = await cli(["target", "check", "local", "--hub", "http://127.0.0.1:1", ...extra]);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stderr.includes("fetch failed"), false);
  }
});
