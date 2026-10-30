import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { restoreConfig } from "../dist/onboarding/restore.js";
import { connectClient } from "../dist/onboarding/connect.js";
import { disconnectClient } from "../dist/onboarding/disconnect.js";
import { temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const hub = "http://127.0.0.1:1/offline";

/** Run restoration with unavailable hub and personal setup settings to verify local recovery behavior. */
async function cli(args, directory) {
  const env = { ...process.env, AGENT_TCDH_CONFIG: join(directory, "missing-personal-setup.json"),
    AGENT_TCDH_URL: "not-a-hub-url", AGENT_TCDH_TOKEN: "private-hub-token" };
  try {
    return { ...(await execute(process.execPath, [resolve("dist/index.js"), ...args], { env, timeout: 15_000 })), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return error;
  }
}

test("restoration previews preserve both files and applications back up the replaced file exactly", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client config.jsonc");
  const source = join(directory, "selected backup");
  const original = '\uFEFF{\r\n // original comment\r\n "private": "private-original-value",\r\n}\r\n';
  const current = '{"private":"private-current-value","other":"new-setting"}\n';
  await writeFile(source, original);
  await writeFile(file, current);
  const files = await readdir(directory);
  const preview = await restoreConfig({ source, file });
  assert.equal(preview.reason, "restore-ready");
  assert.equal(preview.hasChanges, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.changed, false);
  assert.equal(preview.destinationExists, true);
  assert.equal(preview.destinationBytes, Buffer.byteLength(current));
  assert.equal(preview.sourceBytes, Buffer.byteLength(original));
  assert.equal(preview.content, undefined);
  assert.doesNotMatch(JSON.stringify(preview), /private-original-value|private-current-value|new-setting/);
  assert.equal(await readFile(source, "utf8"), original);
  assert.equal(await readFile(file, "utf8"), current);
  assert.deepEqual(await readdir(directory), files);
  const applied = await restoreConfig({ source, file, apply: true });
  assert.equal(applied.reason, "restored");
  assert.equal(applied.applied, true);
  assert.equal(applied.executionVerified, false);
  assert.deepEqual(await readFile(file), Buffer.from(original));
  assert.deepEqual(await readFile(applied.backup), Buffer.from(current));
  assert.deepEqual(await readFile(source), Buffer.from(original));
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(applied.backup)).mode & 0o777, 0o600);
  }
  const after = await readdir(directory);
  const noOp = await restoreConfig({ source, file, apply: true });
  assert.equal(noOp.reason, "unchanged");
  assert.equal(noOp.hasChanges, false);
  assert.equal(noOp.backup, undefined);
  assert.equal(noOp.changed, false);
  assert.deepEqual(await readdir(directory), after);
});

test("restore creates a missing destination only on apply without changing the source", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "backup");
  const file = join(directory, "missing", "client config");
  await writeFile(source, "# exact text\r\n");
  const preview = await restoreConfig({ source, file });
  assert.equal(preview.destinationExists, false);
  assert.equal(preview.destinationBytes, null);
  assert.deepEqual(await readdir(directory), ["backup"]);
  const applied = await restoreConfig({ source, file, apply: true });
  assert.equal(applied.reason, "restored");
  assert.equal(applied.backup, undefined);
  assert.equal(await readFile(file, "utf8"), "# exact text\r\n");
  assert.equal(await readFile(source, "utf8"), "# exact text\r\n");
});

test("restoration supports empty backups and repairs malformed destination syntax without parsing it", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "empty-backup");
  const file = join(directory, "broken.json");
  const broken = '{"token":"private-malformed-value';
  await writeFile(source, "");
  await writeFile(file, broken);
  const result = await restoreConfig({ source, file, apply: true });
  assert.equal(result.sourceBytes, 0);
  assert.equal(await readFile(file, "utf8"), "");
  assert.equal(await readFile(result.backup, "utf8"), broken);
  assert.doesNotMatch(JSON.stringify(result), /private-malformed-value/);
});

test("real connect and disconnect backups can each be restored with all seven profiles", async (t) => {
  for (const client of ["codex", "opencode", "opencode-v1", "claude-code", "gemini-cli", "cursor", "vscode"]) {
    const directory = await temporaryDirectory(t);
    const file = join(directory, "consumer config");
    const original = client === "codex" ? '# exact original\nmodel="existing"\n' : '\uFEFF{\n // exact original\n "model":"existing",\n}\n';
    await writeFile(file, original);
    const connected = await connectClient({ client, hub, write: file });
    const withHub = await readFile(file, "utf8");
    const disconnected = await disconnectClient({ client, file, apply: true });
    await restoreConfig({ source: disconnected.backup, file, apply: true });
    assert.equal(await readFile(file, "utf8"), withHub);
    const restored = await restoreConfig({ source: connected.backup, file, apply: true });
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(await readFile(restored.backup, "utf8"), withHub);
    assert.equal(await readFile(connected.backup, "utf8"), original);
    assert.equal(await readFile(disconnected.backup, "utf8"), withHub);
  }
});

test("restore rejects missing, identical, empty, malformed UTF-8, oversized, and linked paths without writes", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "backup");
  const file = join(directory, "destination");
  await writeFile(file, "private-current-value");
  await assert.rejects(restoreConfig({ source, file, apply: true }), /Backup source was not found/);
  await assert.rejects(restoreConfig({ source: file, file, apply: true }), /must be different/);
  await assert.rejects(restoreConfig({ source: join(directory, ".", "destination"), file }), /must be different/);
  for (const paths of [{ source: "", file }, { source: file, file: " " }]) {
    await assert.rejects(restoreConfig(paths), /non-empty/);
  }
  for (const [content, expected] of [[Buffer.from([0xff]), /valid UTF-8/], ["x".repeat(1_048_577), /1 MiB/]]) {
    await writeFile(source, content);
    await assert.rejects(restoreConfig({ source, file, apply: true }), expected);
    assert.equal(await readFile(file, "utf8"), "private-current-value");
  }
  await writeFile(source, "valid-backup");
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(restoreConfig({ source, file, apply: true }), /valid UTF-8/);
  await writeFile(file, "private-current-value");
  try {
    const linked = join(directory, "link");
    await symlink(source, linked);
    await assert.rejects(restoreConfig({ source: linked, file, apply: true }), /regular file/);
    await assert.rejects(restoreConfig({ source, file: linked, apply: true }), /regular file/);
  } catch (error) {
    if (error.code !== "EPERM" || process.platform !== "win32") {
      throw error;
    }
  }
  assert.equal((await readdir(directory)).some((name) => name.includes(".agent-tcdh-")), false);
});

test("an active writer blocks restoration and retains the selected source and current destination", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "backup");
  const file = join(directory, "destination");
  await writeFile(source, "source-value");
  await writeFile(file, "current-value");
  const lock = await open(file + ".agent-tcdh.lock", "wx");
  try {
    await assert.rejects(restoreConfig({ source, file, apply: true }), /write is in progress/);
    assert.equal(await readFile(source, "utf8"), "source-value");
    assert.equal(await readFile(file, "utf8"), "current-value");
    assert.equal((await readdir(directory)).some((name) => name.includes(".agent-tcdh-backup-")), false);
  } finally {
    await lock.close();
  }
});

test("CLI restores locally despite missing personal setup and reports JSON without source values", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "backup");
  const file = join(directory, "destination");
  await writeFile(source, "private-backup-value");
  await writeFile(file, "private-current-value");
  for (const extra of [[], ["--dry-run", "--json"]]) {
    const result = await cli(["config", "restore", source, "--file", file, ...extra], directory);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "restore-ready");
    assert.doesNotMatch(result.stdout, /private-backup-value|private-current-value|private-hub-token/);
    assert.equal(await readFile(file, "utf8"), "private-current-value");
  }
  const applied = await cli(["config", "restore", source, "--file", file, "--apply"], directory);
  assert.equal(applied.code, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.equal(report.reason, "restored");
  assert.equal(await readFile(report.backup, "utf8"), "private-current-value");
  const unchanged = await cli(["config", "restore", source, "--file", file, "--apply"], directory);
  assert.equal(unchanged.code, 0);
  assert.equal(JSON.parse(unchanged.stdout).reason, "unchanged");
});

test("CLI rejects ambiguous modes, missing arguments, and unrelated settings before writing", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "backup");
  const file = join(directory, "destination");
  await writeFile(source, "private-backup-value");
  await writeFile(file, "private-current-value");
  for (const args of [
    ["config"], ["config", "unknown"], ["config", "restore"], ["config", "restore", source],
    ["config", "restore", source, "--file", ""],
    ["config", "restore", source, "--file", file, "--apply", "--dry-run"],
    ["config", "restore", source, "--file", file, "--config", source],
    ["config", "restore", source, "--file", file, "--hub", hub],
    ["config", "restore", source, "--file", file, "--name", "agent_tcdh"],
    ["config", "restore", source, "--file", file, "--token-env", "READER"],
  ]) {
    const result = await cli(args, directory);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-backup-value|private-current-value|private-hub-token/);
    assert.equal(await readFile(file, "utf8"), "private-current-value");
  }
  assert.deepEqual((await readdir(directory)).sort(), ["backup", "destination"]);
});
