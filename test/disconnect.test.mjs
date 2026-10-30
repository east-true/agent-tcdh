import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";
import { disconnectClient } from "../dist/onboarding/disconnect.js";
import { mergeConnection } from "../dist/onboarding/connect.js";
import { temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const clients = ["codex", "opencode", "opencode-v1", "claude-code", "gemini-cli", "cursor", "vscode"];
const hub = "http://127.0.0.1:1/offline";

/** Parse a saved profile and expose its client-specific server table for assertions. */
function document(client, content) {
  const root = client === "codex" ? parseToml(content) : parseJsonc(content.replace(/^\uFEFF/u, ""));
  const servers = client === "codex" ? root.mcp_servers : client === "opencode" ? root.mcp?.servers
    : client === "opencode-v1" ? root.mcp : client === "vscode" ? root.servers : root.mcpServers;
  return { root, servers };
}

/** Run the CLI with unusable personal setup and hub settings to prove disconnection stays local. */
async function cli(args, directory) {
  const env = { ...process.env, AGENT_TCDH_CONFIG: join(directory, "missing-personal-setup.json"),
    AGENT_TCDH_URL: "not-a-hub-url", AGENT_TCDH_TOKEN: "private-token-value" };
  try {
    return { ...(await execute(process.execPath, [resolve("dist/index.js"), ...args], { env, timeout: 15_000 })), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return error;
  }
}

test("all seven profiles preview without writes and apply only the named removal with an exact backup", async (t) => {
  for (const client of clients) {
    const directory = await temporaryDirectory(t);
    const file = join(directory, "consumer config");
    const initial = client === "codex" ? '# preserve root comment\napi_key = "private-root-value"\n'
      : '\uFEFF{\n // preserve root comment\n "api_key": "private-root-value",\n}\n';
    const withOther = mergeConnection(client, hub, "OTHER_READER", initial, false, "other").content;
    const original = mergeConnection(client, hub, "SELECTED_READER", withOther, false, "team_hub").content;
    await writeFile(file, original);
    const preview = await disconnectClient({ client, file, name: "team_hub" });
    assert.equal(preview.ready, true);
    assert.equal(preview.reason, "removal-ready");
    assert.equal(preview.hasChanges, true);
    assert.equal(preview.applied, false);
    assert.equal(preview.changed, false);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.content, undefined);
    assert.doesNotMatch(JSON.stringify(preview), /private-root-value|SELECTED_READER/);
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["consumer config"]);
    const result = await disconnectClient({ client, file, name: "team_hub", apply: true });
    assert.equal(result.reason, "removed");
    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    assert.equal(result.executionVerified, false);
    assert.equal(await readFile(result.backup, "utf8"), original);
    const saved = await readFile(file, "utf8");
    assert.ok(saved.includes("preserve root comment"));
    assert.equal(saved.startsWith("\uFEFF"), client !== "codex");
    const parsed = document(client, saved);
    assert.equal(parsed.root.api_key, "private-root-value");
    assert.ok(Object.hasOwn(parsed.servers, "other"));
    assert.equal(Object.hasOwn(parsed.servers, "team_hub"), false);
    const files = await readdir(directory);
    const repeated = await disconnectClient({ client, file, name: "team_hub", apply: true });
    assert.equal(repeated.reason, "entry-missing");
    assert.equal(repeated.applied, false);
    assert.equal(repeated.hasChanges, false);
    assert.equal(await readFile(file, "utf8"), saved);
    assert.deepEqual(await readdir(directory), files);
  }
});

test("missing files never create a file, directory, lock, or backup in preview or apply modes", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "missing", "client");
  for (const apply of [false, true]) {
    const report = await disconnectClient({ client: "cursor", file, apply });
    assert.equal(report.reason, "file-missing");
    assert.equal(report.ready, true);
    assert.equal(report.hasChanges, false);
    assert.equal(report.changed, false);
    assert.equal(report.backup, undefined);
    assert.deepEqual(await readdir(directory), []);
  }
});

test("managed TOML blocks support CRLF, last-server removal, and reserved-looking names", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "codex.toml");
  for (const name of ["agent_tcdh", "constructor"]) {
    const original = mergeConnection("codex", hub, undefined, '# keep\nmodel = "existing"\n', false, name).content.replaceAll("\n", "\r\n");
    await writeFile(file, original);
    const report = await disconnectClient({ client: "codex", file, name, apply: true });
    assert.equal(report.reason, "removed");
    assert.equal(await readFile(report.backup, "utf8"), original);
    const saved = await readFile(file, "utf8");
    assert.ok(saved.includes('# keep\r\nmodel = "existing"\r\n'));
    assert.equal(parseToml(saved).mcp_servers, undefined);
  }
});

test("unmanaged and inline TOML require explicit normalization and preserve unrelated values", async (t) => {
  for (const original of [
    '# keep in backup\n[mcp_servers.agent_tcdh]\nurl="private-url-value"\n[mcp_servers.other]\nurl="https://other.example"\n',
    '# keep in backup\nmcp_servers = { agent_tcdh = { url = "private-url-value" }, other = { url = "https://other.example" } }\n',
  ]) {
    const directory = await temporaryDirectory(t);
    const file = join(directory, "codex.toml");
    await writeFile(file, original);
    for (const apply of [false, true]) {
      const blocked = await disconnectClient({ client: "codex", file, apply });
      assert.equal(blocked.ready, false);
      assert.equal(blocked.reason, "normalization-required");
      assert.equal(blocked.applied, false);
      assert.equal(await readFile(file, "utf8"), original);
      assert.deepEqual(await readdir(directory), ["codex.toml"]);
    }
    const preview = await disconnectClient({ client: "codex", file, normalize: true });
    assert.equal(preview.ready, true);
    assert.match(preview.notes.join(" "), /comments are normalized/);
    assert.doesNotMatch(JSON.stringify(preview), /private-url-value/);
    assert.equal(await readFile(file, "utf8"), original);
    const result = await disconnectClient({ client: "codex", file, normalize: true, apply: true });
    assert.equal(await readFile(result.backup, "utf8"), original);
    assert.equal(parseToml(await readFile(file, "utf8")).mcp_servers.other.url, "https://other.example");
  }
});

test("misplaced TOML markers cannot remove unrelated values or comments inside multiline strings", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "codex.toml");
  const original = 'prompt = """\n# AgentTCDH begin agent_tcdh\nprivate-prompt-value\n# AgentTCDH end agent_tcdh\n"""\n[mcp_servers.agent_tcdh]\nurl = "https://hub.example/mcp"\n';
  await writeFile(file, original);
  const blocked = await disconnectClient({ client: "codex", file, apply: true });
  assert.equal(blocked.reason, "normalization-required");
  assert.equal(await readFile(file, "utf8"), original);
  const result = await disconnectClient({ client: "codex", file, normalize: true, apply: true });
  assert.equal(result.applied, true);
  assert.equal(parseToml(await readFile(file, "utf8")).prompt, parseToml(original).prompt);
  assert.doesNotMatch(JSON.stringify(result), /private-prompt-value/);
});

test("disconnect removes edited and stale entries by name without checking credentials or bridge paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "cursor.json");
  await writeFile(file, JSON.stringify({ mcpServers: { agent_tcdh: { command: "missing-old-node", args: ["old-installation.js"],
    env: { OLD_READER: "private-old-value" } }, other: { command: "other-command" } } }));
  const result = await disconnectClient({ client: "cursor", file, apply: true });
  assert.equal(result.reason, "removed");
  assert.doesNotMatch(JSON.stringify(result), /private-old-value|missing-old-node|old-installation/);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { mcpServers: { other: { command: "other-command" } } });
});

test("malformed, incompatible, oversized, and linked client files are preserved without backups", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client");
  for (const [client, content, expected] of [
    ["codex", 'token="private-source-value', /Invalid TOML/],
    ["cursor", '{"private-source-value":', /Invalid JSON/],
    ["vscode", '{"mcpServers":{}}', /different MCP server container/],
    ["opencode", '{"mcp":{"old":{"type":"remote"}}}', /v1 server layout/],
    ["cursor", '{"mcpServers":[]}', /must be an object/],
  ]) {
    await writeFile(file, content);
    await assert.rejects(disconnectClient({ client, file, apply: true }), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-source-value/);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), content);
    assert.deepEqual(await readdir(directory), ["client"]);
  }
  for (const [content, expected] of [[Buffer.from([0xff]), /valid UTF-8/], ["x".repeat(1_048_577), /1 MiB/]]) {
    await writeFile(file, content);
    await assert.rejects(disconnectClient({ client: "cursor", file, apply: true }), expected);
  }
  try {
    const linked = join(directory, "link");
    await symlink(file, linked);
    await assert.rejects(disconnectClient({ client: "cursor", file: linked, apply: true }), /regular file/);
  } catch (error) {
    if (error.code !== "EPERM" || process.platform !== "win32") {
      throw error;
    }
  }
});

test("an active configuration writer blocks removal without a partial edit or backup", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "cursor.json");
  const original = mergeConnection("cursor", hub).content;
  await writeFile(file, original);
  const lock = await open(file + ".agent-tcdh.lock", "wx");
  try {
    await assert.rejects(disconnectClient({ client: "cursor", file, apply: true }), /write is in progress/);
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual((await readdir(directory)).sort(), ["cursor.json", "cursor.json.agent-tcdh.lock"]);
  } finally {
    await lock.close();
  }
});

test("CLI disconnect ignores personal setup, defaults to preview, and applies only when requested", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "cursor.json");
  const original = mergeConnection("cursor", hub).content;
  await writeFile(file, original);
  for (const extra of [[], ["--dry-run", "--json"]]) {
    const result = await cli(["disconnect", "cursor", "--file", file, ...extra], directory);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).applied, false);
    assert.equal(await readFile(file, "utf8"), original);
  }
  const applied = await cli(["disconnect", "cursor", "--file", file, "--apply"], directory);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).reason, "removed");
  const absent = await cli(["disconnect", "cursor", "--file", file, "--apply"], directory);
  assert.equal(absent.code, 0);
  assert.equal(JSON.parse(absent.stdout).reason, "entry-missing");
});

test("CLI rejects ambiguous modes and unrelated flags and reports blocked TOML with exit one", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "codex.toml");
  await writeFile(file, '[mcp_servers.agent_tcdh]\nurl="private-source-value"\n');
  const blocked = await cli(["disconnect", "codex", "--file", file, "--apply"], directory);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.stderr, "");
  assert.equal(JSON.parse(blocked.stdout).reason, "normalization-required");
  for (const args of [
    ["disconnect", "cursor"], ["disconnect", "cursor", "--file", ""],
    ["disconnect", "cursor", "--file", file, "--apply", "--dry-run"],
    ["disconnect", "cursor", "--file", file, "--write", file],
    ["disconnect", "cursor", "--file", file, "--normalize"],
    ["disconnect", "cursor", "--file", file, "--hub", hub],
    ["disconnect", "cursor", "--file", file, "--config", file],
    ["disconnect", "cursor", "--file", file, "--name", "../unsafe"],
  ]) {
    const result = await cli(args, directory);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-source-value|private-token-value/);
  }
  assert.deepEqual(await readdir(directory), ["codex.toml"]);
});
