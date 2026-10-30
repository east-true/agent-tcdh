import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { listConfigBackups, formatBackupList } from "../dist/onboarding/backups.js";
import { restoreConfig } from "../dist/onboarding/restore.js";
import { connectClient } from "../dist/onboarding/connect.js";
import { disconnectClient } from "../dist/onboarding/disconnect.js";
import { temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);

/** Create a conventionally named sibling backup with a deterministic modification time. */
async function backup(file, timestamp, content = "private-backup-value") {
  const path = file + ".agent-tcdh-backup-" + randomUUID();
  await writeFile(path, content);
  await utimes(path, new Date(timestamp), new Date(timestamp));
  return path;
}

/** Run local configuration commands without usable personal setup, hub URL, or credentials. */
async function cli(args, directory) {
  const env = { ...process.env, AGENT_TCDH_CONFIG: join(directory, "missing-setup.json"),
    AGENT_TCDH_URL: "invalid-hub-url", AGENT_TCDH_TOKEN: "private-hub-token" };
  try {
    return { ...(await execute(process.execPath, [resolve("dist/index.js"), ...args], { env, timeout: 15_000 })), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return error;
  }
}

test("backup lists sort newest metadata before limiting and break timestamp ties by path", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client config");
  await writeFile(file, "private-destination-value");
  const first = await backup(file, "2001-01-01T00:00:00Z");
  const second = await backup(file, "2003-01-01T00:00:00Z");
  const third = await backup(file, "2003-01-01T00:00:00Z");
  const before = await readdir(directory);
  const result = await listConfigBackups({ file, limit: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.metadataOnly, true);
  assert.equal(result.changed, false);
  assert.equal(result.executionVerified, false);
  assert.equal(result.items[0].path, [second, third].sort()[0]);
  assert.equal(result.items[0].modifiedAt, "2003-01-01T00:00:00.000Z");
  assert.equal(result.items[0].sizeBytes, Buffer.byteLength("private-backup-value"));
  assert.equal(result.items[0].status, "candidate");
  assert.deepEqual(result.items[0].restoreCommand, [process.execPath, resolve("dist/index.js"), "config", "restore", result.items[0].path, "--file", resolve(file)]);
  const all = await listConfigBackups({ file });
  assert.equal(all.limit, 20);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.items.map((entry) => entry.path), [...[second, third].sort(), first]);
  assert.doesNotMatch(JSON.stringify(all), /private-backup-value|private-destination-value/);
  assert.deepEqual(await readdir(directory), before);
  assert.equal(await readFile(file, "utf8"), "private-destination-value");
});

test("only exact destination names and generated UUID patterns are listed without recursion", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client[1].json");
  const expected = await backup(file, "2001-01-01T00:00:00Z");
  for (const path of [file + ".agent-tcdh-backup-not-a-uuid", file + ".agent-tcdh-backup-" + randomUUID() + ".extra",
    file + ".other.agent-tcdh-backup-" + randomUUID(), join(directory, "different.agent-tcdh-backup-" + randomUUID()),
    file + ".agent-tcdh-backup-00000000-0000-1000-8000-000000000000"]) {
    await writeFile(path, "private-unrelated-value");
  }
  const nested = join(directory, "nested");
  await mkdir(nested);
  await backup(join(nested, "client[1].json"), "2005-01-01T00:00:00Z");
  const result = await listConfigBackups({ file });
  assert.deepEqual(result.items.map((entry) => entry.path), [expected]);
  assert.equal(result.total, 1);
});

test("directories, symlinks, and oversized matching entries have no generated restore command", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client");
  const large = await backup(file, "2001-01-01T00:00:00Z");
  await truncate(large, 1_048_577);
  const folder = file + ".agent-tcdh-backup-" + randomUUID();
  await mkdir(folder);
  let linked;
  try {
    linked = file + ".agent-tcdh-backup-" + randomUUID();
    await symlink(large, linked);
  } catch (error) {
    linked = undefined;
    if (error.code !== "EPERM" || process.platform !== "win32") {
      throw error;
    }
  }
  const result = await listConfigBackups({ file });
  const entries = new Map(result.items.map((entry) => [entry.path, entry]));
  assert.equal(entries.get(large).status, "too-large");
  assert.equal(entries.get(large).sizeBytes, 1_048_577);
  assert.equal(entries.get(folder).status, "unsupported-file");
  if (linked) {
    assert.equal(entries.get(linked).status, "unsupported-file");
  }
  assert.ok(result.items.every((entry) => entry.restoreCommand === undefined));
});

test("listing reads metadata only even when source or destination contents are not valid UTF-8", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client");
  await writeFile(file, Buffer.from([0xff]));
  const source = await backup(file, "2001-01-01T00:00:00Z", Buffer.from([0xff]));
  const result = await listConfigBackups({ file });
  assert.equal(result.items[0].status, "candidate");
  assert.equal(result.items[0].sizeBytes, 1);
  await assert.rejects(restoreConfig({ source, file }), /valid UTF-8/);
  assert.deepEqual(await readFile(file), Buffer.from([0xff]));
  await rm(file);
  assert.equal((await listConfigBackups({ file })).total, 1);
});

test("missing parents and empty directories return empty results without creating files", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const file of [join(directory, "missing", "client"), join(directory, "client")]) {
    const result = await listConfigBackups({ file });
    assert.equal(result.total, 0);
    assert.equal(result.scannedEntries, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.truncated, false);
  }
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(listConfigBackups({ file: " " }), /non-empty/);
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
    await assert.rejects(listConfigBackups({ file: join(directory, "client"), limit }), /integer from 1 to 100/);
  }
});

test("all seven profiles expose actual connect, disconnect, and restoration backups", async (t) => {
  for (const client of ["codex", "opencode", "opencode-v1", "claude-code", "gemini-cli", "cursor", "vscode"]) {
    const directory = await temporaryDirectory(t);
    const file = join(directory, "client");
    await writeFile(file, client === "codex" ? '# original\nmodel="existing"\n' : '{"model":"existing"}\n');
    const connected = await connectClient({ client, hub: "http://127.0.0.1:1", write: file });
    const disconnected = await disconnectClient({ client, file, apply: true });
    const restored = await restoreConfig({ source: disconnected.backup, file, apply: true });
    const result = await listConfigBackups({ file });
    assert.equal(result.total, 3);
    assert.deepEqual(result.items.map((entry) => entry.path).sort(), [connected.backup, disconnected.backup, restored.backup].sort());
    assert.ok(result.items.every((entry) => entry.status === "candidate"));
  }
});

test("CLI backup listing ignores missing setup and returns a working restore preview command", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client with spaces.json");
  const source = await backup(file, "2001-01-01T00:00:00Z");
  const listed = await cli(["config", "backups", "--file", file, "--limit", "1", "--json"], directory);
  assert.equal(listed.code, 0, listed.stderr);
  const report = JSON.parse(listed.stdout);
  assert.equal(report.items[0].path, source);
  const command = report.items[0].restoreCommand;
  const preview = await execute(command[0], command.slice(1), { cwd: directory, timeout: 15_000,
    env: { ...process.env, AGENT_TCDH_CONFIG: join(directory, "missing-setup.json"), AGENT_TCDH_URL: "invalid-hub-url" } });
  assert.equal(JSON.parse(preview.stdout).reason, "restore-ready");
  assert.doesNotMatch(listed.stdout + preview.stdout, /private-backup-value|private-hub-token/);
  assert.deepEqual(await readdir(directory), [source.slice(directory.length + 1)]);
  for (const extra of [["--apply"], ["--dry-run"], ["--config", source], ["--hub", "http://localhost"], ["--token-env", "READER"], ["--limit", "101"]]) {
    const invalid = await cli(["config", "backups", "--file", file, ...extra], directory);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, "");
  }
  const missing = await cli(["config", "backups"], directory);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
});

test("human reports show preview commands and escape control characters in path metadata", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client with spaces");
  await backup(file, "2001-01-01T00:00:00Z");
  const result = await listConfigBackups({ file });
  const human = formatBackupList(result);
  assert.match(human, /config restore/);
  assert.match(human, /1 shown; 1 matches/);
  const controlled = "path\u001b[31m\nnext";
  const escaped = formatBackupList({ ...result, path: controlled, items: [{ ...result.items[0], path: controlled,
    restoreCommand: ["agent-tcdh", "config", "restore", controlled, "--file", controlled] }] });
  assert.equal(escaped.includes("\u001b"), false);
  assert.match(escaped, /Preview arguments \(JSON\)/);
  assert.ok(escaped.includes("\\u001b"));
  assert.match(formatBackupList({ ...result, items: [], total: 0 }), /No matching backups/);
  assert.match(formatBackupList({ ...result, limit: 100, truncated: true }), /Output capped at 100/);
});
