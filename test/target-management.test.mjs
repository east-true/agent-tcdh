import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { HubClient } from "../dist/client.js";
import { editTarget, previewRemoval } from "../dist/targets/edit.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";
import { cardSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");

/** Run management commands without using personal setup or inherited hub credentials. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  return execute(process.execPath, [entry, ...args], { env: { ...env, ...environment }, timeout: 20_000 });
}

/** Capture the expected failure output without accepting an unexpected successful mutation. */
async function failure(args, environment = {}) {
  try {
    await cli(args, environment);
  } catch (error) {
    return error;
  }
  assert.fail("The management command must fail.");
}

test("metadata edits preserve full MCP HTTP, stdio, and A2A protocol contracts", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new HubClient(hub);
  const connections = [
    { transport: "sse", url: "https://docs.example/sse", auth: { type: "oauth2", description: "Consumer login", envVars: ["PROVIDER_REF"] } },
    { transport: "stdio", command: process.execPath, args: ["--version"], envVars: ["LOCAL_REF"] },
    { transport: "http", url: "https://peer.example/a2a", agentCardUrl: "https://peer.example/custom-card", protocolBinding: "JSONRPC", protocolVersion: "1.0",
      auth: { type: "bearer", envVars: ["PEER_REF"] } },
  ];
  for (const [index, connection] of connections.entries()) {
    const id = "target-" + index;
    await register(app, definition(id, { protocol: connection.transport === "http" ? "a2a" : "mcp", connection, tags: ["docs", "keep"] }));
    const before = await client.getVersioned(id);
    const result = await editTarget(client, id, { name: "Shared docs", description: "Updated administrator description",
      addTags: [" team ", "team", "docs"], removeTags: ["keep"] });
    assert.equal(result.applied, true);
    assert.equal(result.baseVersion, before.etag);
    assert.deepEqual(result.changes.map((change) => change.field), ["name", "description", "tags"]);
    const after = await client.getVersioned(id);
    assert.deepEqual(after.target.tags, ["docs", "team"]);
    assert.equal(after.target.name, "Shared docs");
    assert.deepEqual(after.target.connection, before.target.connection);
    assert.deepEqual(after.target.capabilities, before.target.capabilities);
    assert.equal(after.target.protocol, before.target.protocol);
    assert.equal(after.target.createdAt, before.target.createdAt);
    assert.notEqual(after.etag, before.etag);
  }
});

test("CLI edit previews use configured read credentials while application requires administrator access", async (t) => {
  const app = await fixture(t, { token: "management-admin", readToken: "management-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"), { Authorization: "Bearer management-admin" });
  const setup = join(await temporaryDirectory(t), "read-setup.json");
  await cli(["init", "--yes", "--remote", "--hub", hub, "--read-token-env", "READER", "--config", setup]);
  const client = new HubClient(hub, "management-reader");
  const original = await client.getVersioned("docs");
  const args = ["target", "edit", "docs", "--name", "New name", "--add-tag", "team", "--config", setup];
  const preview = JSON.parse((await cli([...args, "--dry-run"], { READER: "management-reader" })).stdout);
  assert.equal(preview.applied, false);
  assert.equal(preview.hasChanges, true);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(await client.getVersioned("docs"), original);
  assert.match((await failure(args, { READER: "management-reader" })).stderr, /administrator credential/);
  const applied = JSON.parse((await cli([...args, "--token-env", "ADMIN"], { ADMIN: "management-admin" })).stdout);
  assert.equal(applied.applied, true);
  assert.equal((await client.get("docs")).name, "New name");
  assert.equal(JSON.stringify(applied).includes("management-admin"), false);
  assert.equal(JSON.stringify(preview).includes("management-reader"), false);
});

test("enable and disable affect current discovery while idempotent operations preserve the version", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"));
  const client = new HubClient(hub);
  const before = await client.getVersioned("docs");
  const noop = JSON.parse((await cli(["target", "enable", "docs", "--hub", hub])).stdout);
  assert.equal(noop.hasChanges, false);
  assert.equal(noop.applied, false);
  assert.deepEqual(await client.getVersioned("docs"), before);
  const preview = JSON.parse((await cli(["target", "disable", "docs", "--dry-run", "--hub", hub])).stdout);
  assert.equal(preview.target.enabled, false);
  assert.equal((await client.search({})).total, 1);
  const disabled = JSON.parse((await cli(["target", "disable", "docs", "--hub", hub])).stdout);
  assert.equal(disabled.applied, true);
  assert.deepEqual(disabled.changes, [{ field: "enabled", before: true, after: false }]);
  assert.equal((await client.search({})).total, 0);
  assert.equal((await client.search({ includeDisabled: true })).total, 1);
  assert.equal((await client.get("docs")).enabled, false);
  await cli(["target", "enable", "docs", "--hub", hub]);
  assert.equal((await client.search({})).total, 1);
});

test("automatic conditional writes reject a concurrent edit without losing any intervening changes", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"));
  const client = new HubClient(hub);
  const before = await client.getVersioned("docs");
  const update = client.update.bind(client);
  let attempts = 0;
  client.update = async (id, target, condition) => {
    attempts++;
    assert.equal(condition, before.etag);
    await update(id, definition("docs", { description: "Concurrent administrator change" }));
    return update(id, target, condition);
  };
  await assert.rejects(editTarget(client, "docs", { name: "Must not overwrite" }), /412/);
  assert.equal(attempts, 1);
  const after = await client.get("docs");
  assert.equal(after.name, before.target.name);
  assert.equal(after.description, "Concurrent administrator change");
});

test("caller version conditions gate previews and no-ops while writes remain pinned to the observed version", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"));
  const client = new HubClient(hub);
  const before = await client.getVersioned("docs");
  for (const ifMatch of ['"stale"', "W/" + before.etag]) {
    await assert.rejects(editTarget(client, "docs", { enabled: true }, { dryRun: true, ifMatch }), { statusCode: 412 });
    await assert.rejects(previewRemoval(client, "docs", ifMatch), { statusCode: 412 });
  }
  const listed = await editTarget(client, "docs", { enabled: false }, { dryRun: true, ifMatch: '"other", ' + before.etag });
  assert.equal(listed.baseVersion, before.etag);
  assert.equal((await editTarget(client, "docs", { enabled: true }, { ifMatch: "*" })).applied, false);
  assert.deepEqual(await client.getVersioned("docs"), before);
});

test("invalid edits fail before reads and final tag limits fail before writes", async (t) => {
  let reads = 0;
  const fake = { getVersioned: async () => {
    reads++;
  }, update: async () => assert.fail("Invalid edits cannot write.") };
  for (const patch of [{}, { name: " " }, { description: "" }, { addTags: ["same"], removeTags: [" same "] },
    { addTags: [" "] }, { id: "changed" }, { connection: { transport: "stdio", command: "node" } }]) {
    await assert.rejects(editTarget(fake, "docs", patch));
  }
  await assert.rejects(editTarget(fake, "docs", { name: "Valid" }, { ifMatch: "invalid" }));
  assert.equal(reads, 0);
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs", { tags: Array.from({ length: 50 }, (_, i) => "t" + i) }));
  const client = new HubClient(hub);
  const before = await client.getVersioned("docs");
  await assert.rejects(editTarget(client, "docs", { addTags: ["overflow"] }));
  assert.deepEqual(await client.getVersioned("docs"), before);
  const swapped = await editTarget(client, "docs", { addTags: ["replacement"], removeTags: ["t0"] });
  assert.equal(swapped.target.tags.length, 50);
});

test("removal previews preserve registrations and provide a version for guarded existing CLI deletion", async (t) => {
  const app = await fixture(t, { token: "removal-admin", readToken: "removal-reader" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  await register(app, definition("docs"), { Authorization: "Bearer removal-admin" });
  const client = new HubClient(hub, "removal-admin");
  const before = await client.getVersioned("docs");
  const preview = JSON.parse((await cli(["target", "remove", "docs", "--hub", hub, "--dry-run"], { AGENT_TCDH_TOKEN: "removal-reader" })).stdout);
  assert.equal(preview.action, "remove");
  assert.equal(preview.applied, false);
  assert.equal(preview.baseVersion, before.etag);
  assert.deepEqual(await client.getVersioned("docs"), before);
  await client.update("docs", definition("docs", { name: "Intervening rename" }));
  assert.match((await failure(["target", "remove", "docs", "--hub", hub, "--if-match", preview.baseVersion], { AGENT_TCDH_TOKEN: "removal-admin" })).stderr, /412/);
  assert.equal((await client.get("docs")).name, "Intervening rename");
  const latest = await previewRemoval(client, "docs");
  const removed = JSON.parse((await cli(["target", "remove", "docs", "--hub", hub, "--if-match", latest.baseVersion], { AGENT_TCDH_TOKEN: "removal-admin" })).stdout);
  assert.deepEqual(removed, { deleted: "docs" });
  await assert.rejects(client.get("docs"), /404/);
});

test("management commands neither probe providers nor launch registered stdio commands", async (t) => {
  let requests = 0;
  const source = await cardSource(t, async () => {
    requests++;
    return {};
  });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const marker = join(await temporaryDirectory(t), "must-not-run");
  await register(app, definition("remote", { connection: { transport: "streamable-http", url: source.url + "/custom-card" } }));
  await register(app, definition("local", { connection: { transport: "stdio", command: process.execPath,
    args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')"] } }));
  for (const id of ["remote", "local"]) {
    await cli(["target", "edit", id, "--name", "Managed", "--hub", hub]);
    await cli(["target", "disable", id, "--hub", hub]);
    await cli(["target", "remove", id, "--dry-run", "--hub", hub]);
  }
  assert.equal(requests, 0);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  for (const action of ["edit", "enable", "disable"]) {
    assert.match((await failure(["target", action, "missing", ...(action === "edit" ? ["--name", "Missing"] : []), "--hub", hub])).stderr, /404/);
  }
  assert.equal((await new HubClient(hub).search({ includeDisabled: true })).total, 2);
});
