import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { diffSnapshots, compareRegistry } from "../dist/registry/diff.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");

/** Wrap portable definitions without treating export dates as target data. */
function snapshot(targets) {
  return { format: "agent-tcdh", version: 1, exportedAt: "2026-10-29T00:00:00.000Z", targets };
}

/** Run comparison commands without inheriting personal setup or contributor credentials. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  return execute(process.execPath, [entry, ...args], { env: { ...env, ...environment }, timeout: 25_000 });
}

/** Capture a rejected import preview without treating unexpected success as a valid failure. */
async function failure(args, environment = {}) {
  try {
    await cli(args, environment);
  } catch (error) {
    return error;
  }
  assert.fail("This comparison command must fail.");
}

test("registry comparisons distinguish additions, changes, equality, and retained registrations with exact import policy counts", () => {
  const current = snapshot([definition("same"), definition("changed"), definition("retained", { enabled: false })]);
  const incoming = snapshot([definition("same"), definition("changed", { protocol: "a2a", name: "Agent", tags: [], capabilities: [], enabled: false,
    connection: { transport: "http", url: "https://peer.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" } }), definition("added")]);
  const report = diffSnapshots(incoming, current);
  assert.deepEqual(report.counts, { incoming: 3, current: 3, added: 1, changed: 1, unchanged: 1, retained: 1 });
  assert.equal(report.conflicts, 2);
  assert.equal(report.importReady, false);
  assert.equal(report.expectedImport, null);
  assert.deepEqual(report.entries.map((item) => item.id), ["added", "changed", "retained", "same"]);
  assert.deepEqual(report.entries[1].fields, ["name", "protocol", "tags", "capabilities", "connection", "enabled"]);
  assert.deepEqual(diffSnapshots(incoming, current, { onConflict: "skip" }).expectedImport, { inserted: 1, replaced: 0, skipped: 2 });
  assert.deepEqual(diffSnapshots(incoming, current, { onConflict: "replace" }).expectedImport, { inserted: 1, replaced: 2, skipped: 0 });
  assert.equal(report.applied, false);
  assert.equal(report.executionVerified, false);
});

test("comparison ignores JSON object key order while details remain explicit and array ordering is visible", () => {
  const original = definition("docs", { tags: ["first", "second"], connection: { transport: "streamable-http", url: "https://example.test/mcp?token=private-registered-value" },
    capabilities: [{ name: "probe", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } }] });
  const reordered = { ...original, capabilities: [{ name: "probe", inputSchema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" } }] };
  const report = diffSnapshots({ ...snapshot([original]), exportedAt: "2020-01-01T00:00:00.000Z" }, snapshot([reordered]));
  assert.equal(report.counts.unchanged, 1);
  assert.equal("current" in report.entries[0], false);
  assert.equal("incoming" in report.entries[0], false);
  assert.equal(JSON.stringify(report).includes("private-registered-value"), false);
  const detailed = diffSnapshots(snapshot([original]), snapshot([reordered]), { details: true });
  assert.equal(detailed.entries[0].current.connection.url, original.connection.url);
  assert.equal(detailed.entries[0].incoming.id, "docs");
  const changed = diffSnapshots(snapshot([{ ...original, tags: ["second", "first"] }]), snapshot([original]));
  assert.deepEqual(changed.entries[0].fields, ["tags"]);
});

test("read-only comparison paginates disabled registrations without administrator export or target execution", async (t) => {
  const app = await fixture(t, { token: "diff-admin", readToken: "diff-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const marker = join(await temporaryDirectory(t), "must-not-run");
  const targets = Array.from({ length: 105 }, (_, index) => definition("item-" + String(index).padStart(3, "0"), { enabled: index % 2 === 0,
    connection: { transport: "stdio", command: process.execPath, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')"] } }));
  const admin = new HubClient(hub, "diff-admin");
  await admin.importRegistry(snapshot(targets), { onConflict: "error", dryRun: false });
  const reader = new HubClient(hub, "diff-reader");
  await assert.rejects(reader.exportRegistry(), /403/);
  const before = await reader.getVersioned("item-001");
  const search = reader.search.bind(reader);
  const offsets = [];
  reader.search = async (options) => {
    assert.equal(options.includeDisabled, true);
    offsets.push(options.offset);
    return search(options);
  };
  const report = await compareRegistry(reader, snapshot([targets[1], definition("fresh")]), { onConflict: "skip" });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(report.counts.current, 105);
  assert.equal(report.counts.unchanged, 1);
  assert.equal(report.counts.retained, 104);
  assert.deepEqual(report.expectedImport, { inserted: 1, replaced: 0, skipped: 1 });
  assert.deepEqual(await reader.getVersioned("item-001"), before);
  assert.equal((await search({ includeDisabled: true })).total, 105);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("comparison rejects invalid source snapshots before reading and fails incomplete, changing, or oversized discovery", async (t) => {
  let reads = 0;
  const client = { search: async () => {
    reads++;
    throw new Error("No read expected.");
  } };
  await assert.rejects(compareRegistry(client, { ...snapshot([]), version: 2 }));
  await assert.rejects(compareRegistry(client, snapshot([definition("duplicate"), definition("duplicate")])));
  await assert.rejects(compareRegistry(client, snapshot([]), { onConflict: "invalid" }));
  assert.equal(reads, 0);
  const app = await fixture(t);
  await register(app, definition("template"));
  const template = (await app.inject("/api/targets/template")).json();
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...template, id: "n" + i }));
  client.search = async ({ offset }) => ({ items: offset ? [] : hundred, total: offset ? 100 : 101, limit: 100, offset });
  await assert.rejects(compareRegistry(client, snapshot([])), /pages changed/);
  client.search = async () => ({ items: [template, template], total: 2, limit: 100, offset: 0 });
  await assert.rejects(compareRegistry(client, snapshot([])), /pages changed/);
  client.search = async () => ({ items: [], total: 10_001, limit: 100, offset: 0 });
  await assert.rejects(compareRegistry(client, snapshot([])), /10000/);
  client.search = async ({ offset }) => ({ items: Array.from({ length: Math.min(100, 2200 - offset) }, (_, i) => ({ ...template, id: "large-" + (offset + i), description: "x".repeat(8000) })),
    total: 2200, limit: 100, offset });
  await assert.rejects(compareRegistry(client, snapshot([])), /16 MiB/);
});

test("snapshot diff CLI reads current metadata with configured read credentials and leaves the source unchanged", async (t) => {
  const app = await fixture(t, { token: "cli-diff-admin", readToken: "cli-diff-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs", { enabled: false }), { Authorization: "Bearer cli-diff-admin" });
  const directory = await temporaryDirectory(t);
  const source = join(directory, "registry.json");
  const original = JSON.stringify(snapshot([definition("docs", { name: "Updated" }), definition("fresh")]));
  await writeFile(source, original);
  const setup = join(directory, "reader.json");
  await cli(["init", "--yes", "--remote", "--hub", hub, "--read-token-env", "READER", "--config", setup]);
  const report = JSON.parse((await cli(["registry", "diff", source, "--config", setup], { READER: "cli-diff-reader" })).stdout);
  assert.equal(report.counts.changed, 1);
  assert.equal(report.importReady, false);
  assert.equal(report.conflicts, 1);
  const detailed = JSON.parse((await cli(["registry", "diff", source, "--config", setup, "--on-conflict", "replace", "--details"], { READER: "cli-diff-reader" })).stdout);
  assert.equal(detailed.importReady, true);
  assert.equal(detailed.entries[0].current.enabled, false);
  assert.equal(await readFile(source, "utf8"), original);
  assert.equal(JSON.stringify(report).includes("cli-diff-reader"), false);
  assert.equal((await new HubClient(hub, "cli-diff-reader").search({ includeDisabled: true })).total, 1);
});

test("config and preset comparisons are opt-in read-only previews and refuse apply combinations", async (t) => {
  const app = await fixture(t, { token: "preview-admin", readToken: "preview-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const directory = await temporaryDirectory(t);
  const source = join(directory, "client.json");
  await writeFile(source, JSON.stringify({ mcpServers: { local: { command: process.execPath } } }));
  await cli(["registry", "import-config", source, "--hub", hub, "--apply"], { AGENT_TCDH_TOKEN: "preview-admin" });
  const args = ["registry", "import-config", source, "--hub", hub, "--compare"];
  const blocked = JSON.parse((await failure(args, { AGENT_TCDH_TOKEN: "preview-reader" })).stdout);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.hubConflictsChecked, true);
  assert.equal(blocked.applied, false);
  assert.equal(blocked.comparison.counts.unchanged, 1);
  const skipped = JSON.parse((await cli([...args, "--on-conflict", "skip"], { AGENT_TCDH_TOKEN: "preview-reader" })).stdout);
  assert.equal(skipped.ready, true);
  assert.equal(skipped.comparison.expectedImport.skipped, 1);
  const preset = JSON.parse((await cli(["preset", "import", "public-docs", "--select", "openai-docs", "--hub", hub, "--compare"], { AGENT_TCDH_TOKEN: "preview-reader" })).stdout);
  assert.equal(preset.comparison.counts.added, 1);
  assert.equal(preset.comparison.counts.retained, 1);
  assert.equal(preset.applied, false);
  assert.equal(preset.comparison.sourceExportedAt, preset.metadataAsOf);
  const shown = JSON.parse((await cli(["preset", "show", "public-docs", "--select", "openai-docs", "--hub", hub, "--compare", "--details"], { AGENT_TCDH_TOKEN: "preview-reader" })).stdout);
  assert.equal(shown.comparison.entries.find((item) => item.id === "openai-docs").incoming.protocol, "mcp");
  assert.match((await failure([...args, "--apply"], { AGENT_TCDH_TOKEN: "preview-admin" })).stderr, /either/);
  assert.match((await failure(["preset", "import", "public-docs", "--compare", "--apply", "--hub", hub], { AGENT_TCDH_TOKEN: "preview-admin" })).stderr, /either/);
  assert.match((await failure(["registry", "import-config", source, "--details"])).stderr, /requires --compare/);
  assert.equal((await new HubClient(hub, "preview-reader").search({ includeDisabled: true })).total, 1);
  const offline = JSON.parse((await cli(["registry", "import-config", source, "--hub", "http://127.0.0.1:1"])).stdout);
  assert.equal(offline.comparison, undefined);
  assert.equal(offline.hubConflictsChecked, false);
});

test("snapshot parsing failures omit source values and invalid UTF-8 is rejected before hub comparison", async (t) => {
  const file = join(await temporaryDirectory(t), "invalid.json");
  await writeFile(file, '{"private-source-value');
  const invalid = await failure(["registry", "diff", file, "--hub", "http://127.0.0.1:1"]);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /valid UTF-8 JSON/);
  assert.equal(invalid.stderr.includes("private-source-value"), false);
  await writeFile(file, Buffer.from([0xff, 0xfe, 0x7b]));
  assert.match((await failure(["registry", "diff", file, "--hub", "http://127.0.0.1:1"])).stderr, /valid UTF-8 JSON/);
});
