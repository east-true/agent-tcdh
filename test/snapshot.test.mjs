import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { MAX_SNAPSHOT_BYTES, serializeSnapshot } from "../dist/registry/schema.js";
import { readSnapshot, writeSnapshot } from "../dist/registry/files.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);

/** Wrap mixed-protocol definitions in a registry snapshot. */
function snapshot(targets) {
  return { format: "agent-tcdh", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", targets };
}

/** Submit bulk imports to exercise real validation and transactions. */
async function restore(app, targets, query = "", headers = {}) {
  return app.inject({
    method: "POST", url: "/api/registry/import" + query,
    payload: snapshot(targets), headers,
  });
}

/** Run the administrative CLI in a separate process. */
async function cli(args) {
  return execute(process.execPath, [resolve("dist/index.js"), ...args], {
    env: { ...process.env, AGENT_TCDH_TOKEN: "" }, timeout: 15_000,
  });
}

test("exports include disabled and mixed-protocol registrations beyond one search page", async (t) => {
  const app = await fixture(t);
  for (let index = 0; index < 105; index++) {
    await register(app, definition("item-" + String(index).padStart(3, "0"), { enabled: index % 2 === 0 }));
  }
  await register(app, definition("agent", {
    protocol: "a2a", connection: { transport: "http", url: "https://agent.example.com" },
  }));
  await register(app, definition("local", {
    connection: { transport: "stdio", command: "/never-execute", args: ["--literal"], envVars: ["LOCAL_TOKEN"] },
  }));
  const response = await app.inject("/api/registry/export");
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-disposition"], /agent-tcdh-registry.json/);
  const data = response.json();
  assert.equal(data.format, "agent-tcdh");
  assert.equal(data.version, 1);
  assert.equal(data.targets.length, 107);
  assert.ok(!Number.isNaN(Date.parse(data.exportedAt)));
  assert.equal(data.targets[0].id, "agent");
  assert.ok(data.targets.some((target) => !target.enabled));
  assert.equal(data.targets.some((target) => "createdAt" in target || "updatedAt" in target), false);
  const destination = await fixture(t);
  const imported = await destination.inject({ method: "POST", url: "/api/registry/import", payload: data });
  assert.equal(imported.json().inserted, 107);
  assert.deepEqual((await destination.inject("/api/registry/export")).json().targets, data.targets);
});

test("duplicate ids, invalid items, and unsupported snapshot versions fail before writes", async (t) => {
  const app = await fixture(t);
  const invalid = [
    snapshot([definition("valid"), definition("bad", { connection: { transport: "stdio" } })]),
    snapshot([definition("same"), definition("same")]),
    { ...snapshot([definition()]), version: 2 },
    { ...snapshot([definition()]), format: "unknown" },
    { ...snapshot([definition()]), exportedAt: "not-a-date" },
  ];
  for (const payload of invalid) {
    const response = await app.inject({ method: "POST", url: "/api/registry/import", payload });
    assert.equal(response.statusCode, 400);
    assert.equal((await app.inject("/api/registry/export")).json().targets.length, 0);
  }
});

test("the default conflict policy rejects the entire import including new targets", async (t) => {
  const app = await fixture(t);
  const original = (await register(app, definition("existing"))).json();
  const response = await restore(app, [definition("new"), definition("existing", { name: "Changed" })]);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "SNAPSHOT_CONFLICT");
  assert.equal((await app.inject("/api/targets/new")).statusCode, 404);
  assert.deepEqual((await app.inject("/api/targets/existing")).json(), original);
});

test("skip preserves existing data and timestamps while inserting new targets", async (t) => {
  const app = await fixture(t);
  const original = (await register(app, definition("existing"))).json();
  const response = await restore(app, [
    definition("existing", { name: "Ignored" }), definition("new"),
  ], "?onConflict=skip");
  assert.deepEqual(response.json(), { total: 2, inserted: 1, replaced: 0, skipped: 1, dryRun: false });
  assert.deepEqual((await app.inject("/api/targets/existing")).json(), original);
  assert.equal((await app.inject("/api/targets/new")).statusCode, 200);
});

test("replace changes matching ids and preserves targets absent from the snapshot", async (t) => {
  const app = await fixture(t);
  const original = (await register(app, definition("replace"))).json();
  await register(app, definition("keep"));
  const response = await restore(app, [
    definition("replace", {
      protocol: "a2a", name: "New agent", enabled: false,
      connection: { transport: "http", url: "https://agent.example.com" },
    }),
    definition("new"),
  ], "?onConflict=replace");
  assert.deepEqual(response.json(), { total: 2, inserted: 1, replaced: 1, skipped: 0, dryRun: false });
  const replaced = (await app.inject("/api/targets/replace")).json();
  assert.equal(replaced.createdAt, original.createdAt);
  assert.equal(replaced.protocol, "a2a");
  assert.equal(replaced.enabled, false);
  assert.equal((await app.inject("/api/targets/keep")).statusCode, 200);
  const empty = await restore(app, [], "?onConflict=replace");
  assert.equal(empty.json().total, 0);
  assert.equal((await app.inject("/api/registry/export")).json().targets.length, 3);
});

test("previews report counts without writing and false strings apply actual changes", async (t) => {
  const app = await fixture(t);
  const original = (await register(app, definition("existing"))).json();
  const targets = [definition("existing", { name: "Replaced" }), definition("new")];
  const preview = await restore(app, targets, "?onConflict=replace&dryRun=true");
  assert.deepEqual(preview.json(), { total: 2, inserted: 1, replaced: 1, skipped: 0, dryRun: true });
  assert.deepEqual((await app.inject("/api/targets/existing")).json(), original);
  assert.equal((await app.inject("/api/targets/new")).statusCode, 404);
  const applied = await restore(app, targets, "?onConflict=replace&dryRun=false");
  assert.equal(applied.json().dryRun, false);
  assert.equal((await app.inject("/api/targets/existing")).json().name, "Replaced");
});

test("mid-import failures roll back replacements and inserts and allow a later retry", async (t) => {
  const directory = await temporaryDirectory(t);
  const dbPath = join(directory, "registry.sqlite");
  const app = await fixture(t, { dbPath });
  const original = (await register(app, definition("existing"))).json();
  const database = new DatabaseSync(dbPath);
  t.after(() => {
    database.close();
  });
  database.exec(`
    CREATE TRIGGER reject_import BEFORE INSERT ON targets WHEN NEW.id = 'blocked'
    BEGIN SELECT RAISE(ABORT, 'blocked import'); END;
  `);
  const targets = [definition("existing", { name: "Changed" }), definition("new"), definition("blocked")];
  const failed = await restore(app, targets, "?onConflict=replace");
  assert.equal(failed.statusCode, 500);
  assert.deepEqual((await app.inject("/api/targets/existing")).json(), original);
  assert.equal((await app.inject("/api/targets/new")).statusCode, 404);
  database.exec("DROP TRIGGER reject_import");
  assert.equal((await restore(app, targets, "?onConflict=replace")).statusCode, 200);
  assert.equal((await app.inject("/api/registry/export")).json().targets.length, 3);
});

test("bulk imports accept valid data above 1 MiB and enforce the 16 MiB limit", async (t) => {
  const app = await fixture(t);
  const targets = Array.from({ length: 1200 }, (_, index) => definition("bulk-" + index, {
    description: "x".repeat(1000),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot(targets))) > 1_048_576);
  const imported = await restore(app, targets);
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().inserted, 1200);
  const oversized = await app.inject({
    method: "POST", url: "/api/registry/import",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ data: "x".repeat(MAX_SNAPSHOT_BYTES) }),
  });
  assert.equal(oversized.statusCode, 413);
  const tooMany = await app.inject({
    method: "POST", url: "/api/registry/import",
    payload: snapshot(Array.from({ length: 10001 }, () => ({}))),
  });
  assert.equal(tooMany.statusCode, 413);
  assert.equal((await app.inject("/api/registry/export")).json().targets.length, 1200);
});

test("bulk policy, preview options, and hub authentication are validated", async (t) => {
  const app = await fixture(t, { token: "snapshot-secret" });
  assert.equal((await app.inject("/api/registry/export")).statusCode, 401);
  assert.equal((await restore(app, [])).statusCode, 401);
  const headers = { authorization: "Bearer snapshot-secret" };
  for (const query of ["?onConflict=unknown", "?dryRun=yes", "?unexpected=true"]) {
    assert.equal((await restore(app, [], query, headers)).statusCode, 400);
  }
  assert.equal((await restore(app, [], "?dryRun=true", headers)).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/registry/export", headers })).statusCode, 200);
});

test("backup files are not overwritten by default and replacement failure preserves the existing file", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "nested", "backup.json");
  const original = snapshot([definition("one")]);
  await writeSnapshot(path, original);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await assert.rejects(writeSnapshot(path, snapshot([definition("two")])), /--overwrite/);
  assert.deepEqual((await readSnapshot(path)).targets.map((target) => target.id), ["one"]);
  await writeSnapshot(path, snapshot([definition("two")]), true);
  assert.deepEqual((await readSnapshot(path)).targets.map((target) => target.id), ["two"]);
  const before = await readFile(path, "utf8");
  await assert.rejects(writeSnapshot(path, { ...original, version: 2 }, true));
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(join(directory, "nested")), ["backup.json"]);
});

test("exports do not generate snapshots exceeding the import size limit", () => {
  const targets = Array.from({ length: 2200 }, (_, index) => definition("large-" + index, {
    description: "x".repeat(8000),
  }));
  assert.throws(() => serializeSnapshot(snapshot(targets)), (error) => error.statusCode === 413);
});

test("the actual CLI backs up and restores definitions between hubs", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "registry.json");
  const source = await fixture(t);
  const destination = await fixture(t);
  const sourceUrl = await source.listen({ host: "127.0.0.1", port: 0 });
  const destinationUrl = await destination.listen({ host: "127.0.0.1", port: 0 });
  await register(source, definition("docs", { enabled: false }));
  const exported = JSON.parse((await cli(["registry", "export", file, "--hub", sourceUrl])).stdout);
  assert.equal(exported.targets, 1);
  await assert.rejects(cli(["registry", "export", file, "--hub", sourceUrl]), /--overwrite/);
  const preview = JSON.parse((await cli([
    "registry", "import", file, "--hub", destinationUrl, "--dry-run",
  ])).stdout);
  assert.equal(preview.inserted, 1);
  assert.equal(preview.dryRun, true);
  assert.equal((await destination.inject("/api/registry/export")).json().targets.length, 0);
  const applied = JSON.parse((await cli(["registry", "import", file, "--hub", destinationUrl])).stdout);
  assert.equal(applied.inserted, 1);
  assert.equal((await destination.inject("/api/targets/docs")).json().enabled, false);
  const skipped = JSON.parse((await cli([
    "registry", "import", file, "--hub", destinationUrl, "--on-conflict", "skip",
  ])).stdout);
  assert.equal(skipped.skipped, 1);
  await cli(["registry", "export", file, "--hub", sourceUrl, "--overwrite"]);
  await writeFile(file, "{");
  await assert.rejects(cli(["registry", "import", file, "--hub", destinationUrl]));
  assert.equal((await destination.inject("/api/registry/export")).json().targets.length, 1);
});

test("OpenAPI snapshot and bulk result definitions match runtime responses", async (t) => {
  const app = await fixture(t);
  await register(app, definition("nested", {
    capabilities: [{ name: "tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
  }));
  const spec = (await app.inject("/openapi.json")).json();
  const validator = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  validator.addSchema(spec, "urn:agent-tcdh:snapshot-openapi");
  const data = (await app.inject("/api/registry/export")).json();
  const schema = validator.compile({ $ref: "urn:agent-tcdh:snapshot-openapi#/components/schemas/RegistrySnapshot" });
  assert.ok(schema(data), JSON.stringify(schema.errors));
  const result = validator.compile({ $ref: "urn:agent-tcdh:snapshot-openapi#/components/schemas/RegistryImportResult" });
  const preview = (await restore(app, [definition("new")], "?dryRun=true")).json();
  assert.ok(result(preview), JSON.stringify(result.errors));
  assert.equal(spec.paths["/api/registry/import"].post.operationId, "importRegistry");
});

test("oversized exports return neither partial lists nor backup attachments", async (t) => {
  const directory = await temporaryDirectory(t);
  const dbPath = join(directory, "large.sqlite");
  const app = await fixture(t, { dbPath });
  const database = new DatabaseSync(dbPath);
  try {
    database.exec("BEGIN");
    const insert = database.prepare(
      "INSERT INTO targets (id, protocol, enabled, definition, created_at, updated_at) VALUES (?, 'mcp', 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    for (let index = 0; index < 10001; index++) {
      const target = definition("large-" + index, { enabled: true });
      insert.run(target.id, JSON.stringify(target));
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const exported = await app.inject("/api/registry/export");
  assert.equal(exported.statusCode, 413);
  assert.equal(exported.json().error.code, "SNAPSHOT_TOO_LARGE");
  assert.equal(exported.headers["content-disposition"], undefined);
  assert.equal((await app.inject("/api/targets/large-0")).statusCode, 200);
});
