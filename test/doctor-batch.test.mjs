import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { diagnose } from "../dist/onboarding/doctor.js";
import { diagnoseBatch, batchDiagnosisOptionsSchema } from "../dist/onboarding/doctor-batch.js";
import { fixture, register, definition, temporaryDirectory } from "./helpers.mjs";
import { mcpSource, cardSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");
const capabilities = [{ name: "probe", description: "Batch metadata", inputSchema: { type: "object" } }];

/** Run diagnostics without inheriting personal setup or contributor credentials. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  return execute(process.execPath, [entry, ...args], { env: { ...env, ...environment }, timeout: 30_000 });
}

/** Require a diagnostic failure and preserve its structured report for assertions. */
async function failure(args, environment = {}) {
  try {
    await cli(args, environment);
  } catch (error) {
    return error;
  }
  assert.fail("Diagnostics must fail.");
}

/** Register controlled MCP metadata without contacting its source during setup. */
async function remote(app, source, id, overrides = {}, headers = {}) {
  const response = await register(app, definition(id, { capabilities,
    connection: { transport: "streamable-http", url: source.url + "/mcp" }, ...overrides }), headers);
  assert.equal(response.statusCode, 201);
  return response.json();
}

test("batch doctor isolates target failures and distinguishes MCP, A2A, and stdio metadata without execution", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools: capabilities }] });
  await remote(app, source, "healthy");
  await remote(app, source, "drift", { capabilities: [] });
  await remote(app, source, "missing", { connection: { transport: "streamable-http", url: source.url + "/mcp",
    auth: { type: "bearer", envVars: ["ABSENT_PROVIDER"] } } });
  await register(app, definition("local", { connection: { transport: "stdio", command: process.execPath } }));
  let cardRequests = 0;
  const peer = await cardSource(t, async () => {
    cardRequests++;
    return { name: "Peer", description: "A metadata-only peer", url: "https://peer.example/a2a", skills: [] };
  });
  await register(app, definition("peer", { protocol: "a2a", capabilities: [],
    connection: { transport: "http", url: "https://peer.example/a2a", agentCardUrl: peer.url + "/custom-card" } }));
  const client = new HubClient(hub);
  const before = await client.getVersioned("healthy");
  const report = await diagnose({ hub, batch: batchDiagnosisOptionsSchema.parse({}) }, {});
  assert.equal(report.status, "failed");
  assert.equal(report.batch.complete, true);
  assert.deepEqual(report.batch.summary, { passed: 3, warning: 1, failed: 1 });
  assert.equal(report.batch.targets.find((target) => target.id === "healthy").metadata.scope, "mcp-tools-list");
  assert.equal(report.batch.targets.find((target) => target.id === "peer").metadata.scope, "a2a-agent-card");
  assert.equal(report.batch.targets.find((target) => target.id === "local").metadata.status, "skipped");
  assert.ok(report.batch.targets.every((target) => target.executionVerified === false && target.targetVersion));
  assert.equal(report.executionVerified, false);
  assert.equal(source.state.calls, 0);
  assert.equal(source.state.listCalls, 2);
  assert.equal(cardRequests, 1);
  assert.deepEqual(await client.getVersioned("healthy"), before);
});

test("batch filters preserve disabled exclusions and allow explicit disabled target inspection", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const [id, enabled, tags] of [["chosen", true, ["team"]], ["disabled", false, ["team"]], ["other", true, ["other"]]]) {
    await register(app, definition(id, { name: id, enabled, tags, connection: { transport: "stdio", command: process.execPath } }));
  }
  const args = ["doctor", "--all", "--protocol", "mcp", "--tag", "team", "--hub", hub];
  const selected = JSON.parse((await cli(args)).stdout);
  assert.deepEqual(selected.batch.targets.map((target) => target.id), ["chosen"]);
  const disabled = JSON.parse((await cli([...args, "--include-disabled", "--q", "disabled"])).stdout);
  assert.deepEqual(disabled.batch.targets.map((target) => target.id), ["disabled"]);
  const empty = JSON.parse((await cli([...args, "--protocol", "a2a"])).stdout);
  assert.equal(empty.status, "warning");
  assert.equal(empty.batch.matched, 0);
  assert.equal(empty.batch.complete, true);
});

test("batch selection enforces its cap before inspection and collects every read-only discovery page", async (t) => {
  const app = await fixture(t, { token: "batch-admin", readToken: "batch-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const targets = Array.from({ length: 105 }, (_, index) => definition("local-" + String(index).padStart(3, "0"), {
    connection: { transport: "stdio", command: process.execPath },
  }));
  const added = await app.inject({ method: "POST", url: "/api/registry/import", headers: { Authorization: "Bearer batch-admin" },
    payload: { format: "agent-tcdh", version: 1, exportedAt: new Date().toISOString(), targets } });
  assert.equal(added.statusCode, 200);
  const client = new HubClient(hub, "batch-reader");
  let lookups = 0;
  const getVersioned = client.getVersioned.bind(client);
  client.getVersioned = async (id) => {
    lookups++;
    return getVersioned(id);
  };
  const blocked = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({}));
  assert.equal(blocked.complete, false);
  assert.equal(blocked.matched, 105);
  assert.equal(blocked.selectionIssue.code, "SELECTION_LIMIT_EXCEEDED");
  assert.equal(lookups, 0);
  const inspected = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({ limit: 105, concurrency: 8 }));
  assert.equal(inspected.complete, true);
  assert.equal(inspected.targets.length, 105);
  assert.equal(new Set(inspected.targets.map((target) => target.id)).size, 105);
  assert.equal(inspected.summary.passed, 105);
  assert.equal(lookups, 105);
});

test("bounded metadata concurrency preserves discovery order despite out-of-order completion", async (t) => {
  let active = 0;
  let peak = 0;
  let lists = 0;
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools: capabilities }], onList: async () => {
    active++;
    peak = Math.max(peak, active);
    const ordinal = lists++;
    await setTimeout(ordinal === 0 ? 100 : 20);
    active--;
  } });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const id of ["one", "two", "three", "four", "five"]) {
    await remote(app, source, id);
  }
  const client = new HubClient(hub);
  const expected = (await client.search({ limit: 100 })).items.map((target) => target.id);
  const report = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({ concurrency: 2 }));
  assert.equal(report.status, "passed");
  assert.equal(peak, 2);
  assert.deepEqual(report.targets.map((target) => target.id), expected);
  assert.equal(source.state.calls, 0);
});

test("discovery inconsistencies stop the entire batch before any target lookups", async (t) => {
  const app = await fixture(t);
  await register(app, definition("template"));
  const template = (await app.inject("/api/targets/template")).json();
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...template, id: "n" + i }));
  let lookups = 0;
  const client = { search: async ({ offset }) => ({ items: offset ? [{ ...template, id: "n100" }] : hundred,
    total: offset ? 102 : 101, limit: 100, offset }), getVersioned: async () => { lookups++; } };
  const changed = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({ limit: 200 }));
  assert.equal(changed.selectionIssue.code, "SELECTION_CHANGED");
  assert.equal(lookups, 0);
  client.search = async () => ({ items: [template, template], total: 2, limit: 100, offset: 0 });
  const duplicate = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({}));
  assert.equal(duplicate.selectionIssue.code, "SELECTION_CHANGED");
  client.search = async () => { throw new Error("private-hub-error-body"); };
  const unavailable = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({}));
  assert.equal(unavailable.selectionIssue.code, "DISCOVERY_FAILED");
  assert.equal(JSON.stringify(unavailable).includes("private-hub-error-body"), false);
  assert.equal(lookups, 0);
});

test("one removed target fails independently while other current versions are inspected", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("removed", { connection: { transport: "stdio", command: process.execPath } }));
  await register(app, definition("retained", { connection: { transport: "stdio", command: "missing-initial-command" } }));
  const client = new HubClient(hub);
  const original = client.getVersioned.bind(client);
  const oldVersion = (await original("retained")).etag;
  client.getVersioned = async (id) => {
    if (id === "removed") {
      await client.remove(id);
    } else {
      await client.update(id, definition(id, { tags: ["changed"], connection: { transport: "stdio", command: process.execPath } }));
    }
    return original(id);
  };
  const report = await diagnoseBatch(client, batchDiagnosisOptionsSchema.parse({ tag: "docs" }));
  assert.deepEqual(report.summary, { passed: 1, warning: 0, failed: 1 });
  assert.equal(report.complete, true);
  assert.equal(report.targets.find((target) => target.id === "retained").metadata.scope, "none");
  const retained = report.targets.find((target) => target.id === "retained");
  assert.notEqual(retained.targetVersion, oldVersion);
  assert.equal(retained.targetVersion, (await original("retained")).etag);
  assert.equal(retained.status, "passed");
});

test("batch authentication keeps hub and provider tokens separate and skips unsupported authentication", async (t) => {
  const source = await mcpSource(t, { forceCloseConnections: true, token: "provider-private-value", pages: [{ tools: capabilities }] });
  const app = await fixture(t, { token: "admin-private-value", readToken: "reader-private-value" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await remote(app, source, "secured", { connection: { transport: "streamable-http", url: source.url + "/mcp",
    auth: { type: "bearer", envVars: ["PROVIDER"] } } }, { Authorization: "Bearer admin-private-value" });
  await remote(app, source, "oauth", { connection: { transport: "streamable-http", url: source.url + "/mcp",
    auth: { type: "oauth2" } } }, { Authorization: "Bearer admin-private-value" });
  const report = await diagnose({ hub, tokenEnv: "READER", batch: batchDiagnosisOptionsSchema.parse({}) }, {
    READER: "reader-private-value", PROVIDER: "provider-private-value",
  });
  assert.equal(report.status, "passed");
  assert.equal(report.batch.targets.find((target) => target.id === "oauth").metadata.status, "skipped");
  assert.ok(source.state.headers.every((header) => header === "Bearer provider-private-value"));
  for (const secret of ["provider-private-value", "reader-private-value", "admin-private-value"]) {
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
  const denied = await diagnose({ hub, tokenEnv: "READER", batch: batchDiagnosisOptionsSchema.parse({}) }, {});
  assert.equal(denied.status, "failed");
  assert.equal(denied.batch, undefined);
  assert.ok(denied.checks.some((check) => check.id === "targets" && check.status === "skipped"));
  assert.equal(source.state.listCalls, 1);
});

test("doctor without batch selection avoids provider calls and batch stdio never launches commands", async (t) => {
  const source = await mcpSource(t, { forceCloseConnections: true, pages: [{ tools: capabilities }] });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await remote(app, source, "remote");
  const marker = join(await temporaryDirectory(t), "must-not-run");
  await register(app, definition("local", { connection: { transport: "stdio", command: process.execPath,
    args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')"], envVars: ["LOCAL_VAR"] } }));
  assert.equal(JSON.parse((await cli(["doctor", "--hub", hub])).stdout).status, "passed");
  assert.equal(source.state.listCalls, 0);
  const missing = JSON.parse((await failure(["doctor", "--all", "--hub", hub])).stdout);
  assert.equal(missing.status, "failed");
  const present = JSON.parse((await cli(["doctor", "--all", "--hub", hub], { LOCAL_VAR: "private-local-value" })).stdout);
  assert.equal(present.status, "passed");
  assert.equal(JSON.stringify(present).includes("private-local-value"), false);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("batch CLI rejects incompatible selectors and invalid resource limits before contacting a hub", async () => {
  for (const args of [["--target", "docs", "--all"], ["--tag", "team"], ["--concurrency", "2"],
    ["--all", "--limit", "0"], ["--all", "--limit", "1001"], ["--all", "--concurrency", "9"], ["--all", "--concurrency", "1.5"]]) {
    const error = await failure(["doctor", ...args, "--hub", "http://127.0.0.1:1"]);
    assert.equal(error.stdout, "");
    assert.doesNotMatch(error.stderr, /fetch failed/);
  }
});
