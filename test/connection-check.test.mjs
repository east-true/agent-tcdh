import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { checkConnection, mergeConnection } from "../dist/onboarding/connect.js";
import { temporaryDirectory } from "./helpers.mjs";

const execute = promisify(execFile);
const clients = ["codex", "opencode", "opencode-v1", "claude-code", "gemini-cli", "cursor", "vscode"];
const hub = "http://127.0.0.1:1/offline";

/** Run checks with explicit isolated setup defaults and capture diagnostic exit codes. */
async function cli(args, setup) {
  const env = { ...process.env, AGENT_TCDH_CONFIG: setup, AGENT_TCDH_URL: "", AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_URL;
  try {
    return { ...(await execute(process.execPath, [resolve("dist/index.js"), ...args], { env, timeout: 15_000 })), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") {
      throw error;
    }
    return error;
  }
}

/** Select the profile's named JSON server table for deliberate drift fixtures. */
function servers(client, root) {
  return client === "opencode" ? root.mcp.servers : client === "opencode-v1" ? root.mcp
    : client === "vscode" ? root.servers : root.mcpServers;
}

test("all seven checks match saved profiles offline without credentials, backups, or file changes", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const client of clients) {
    const file = join(directory, client + " config");
    const generated = mergeConnection(client, hub + "/", "UNSET_CONNECTION_CHECK_READER", "", false, "constructor").content;
    const content = client === "codex" ? "# preserve original TOML\n" + generated
      : "\uFEFF// preserve original JSONC\n" + generated;
    await writeFile(file, content);
    const before = await readdir(directory);
    const report = await checkConnection({ client, hub, tokenEnv: "UNSET_CONNECTION_CHECK_READER", file, name: "constructor" });
    assert.equal(report.status, "passed");
    assert.equal(report.reason, "matched");
    assert.equal(report.hub, hub);
    assert.equal(report.path, resolve(file));
    assert.equal(report.changed, false);
    assert.equal(report.executionVerified, false);
    assert.equal(report.content, undefined);
    assert.deepEqual(report.differingFields, []);
    assert.deepEqual(report.requiredEnvironmentVariables, ["UNSET_CONNECTION_CHECK_READER"]);
    assert.equal(await readFile(file, "utf8"), content);
    assert.deepEqual(await readdir(directory), before);
  }
});

test("missing files and named entries return distinct failures and never create files", async (t) => {
  const directory = await temporaryDirectory(t);
  const missing = join(directory, "absent", "client config");
  assert.equal((await checkConnection({ client: "codex", hub, file: missing })).reason, "file-missing");
  assert.deepEqual(await readdir(directory), []);
  for (const client of clients) {
    const file = join(directory, client);
    const content = mergeConnection(client, hub, undefined, "", false, "other").content;
    await writeFile(file, content);
    const report = await checkConnection({ client, hub, file });
    assert.equal(report.reason, "entry-missing");
    assert.equal(report.status, "failed");
    assert.equal(await readFile(file, "utf8"), content);
  }
});

test("checks redact mismatched URLs, credentials, commands, environment maps, and arbitrary field names", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const client of clients) {
    const file = join(directory, client);
    let content;
    if (client === "codex") {
      content = 'private_root = "private-root-value"\n[mcp_servers.agent_tcdh]\nurl = "https://private-url-value"\nbearer_token_env_var = "PRIVATE_READER_VALUE"\n"private-field-name" = "private-field-value"\n';
    } else {
      const root = JSON.parse(mergeConnection(client, hub, "EXPECTED_READER").content);
      root.privateRoot = "private-root-value";
      const entry = servers(client, root).agent_tcdh;
      if (["opencode", "opencode-v1"].includes(client)) {
        entry.url = "https://private-url-value";
        entry.headers.Authorization = "Bearer private-token-value";
      } else {
        entry.command = "private-command-value";
        entry.args = ["private-argument-value"];
        entry.env = { PRIVATE_READER_VALUE: "private-token-value" };
      }
      entry["private-field-name"] = "private-field-value";
      content = JSON.stringify(root);
    }
    await writeFile(file, content);
    const report = await checkConnection({ client, hub, tokenEnv: "EXPECTED_READER", file });
    assert.equal(report.reason, "settings-differ");
    assert.ok(report.differingFields.includes("additional-settings"));
    assert.ok(report.differingFields.includes(client === "codex" ? "bearer_token_env_var"
      : ["opencode", "opencode-v1"].includes(client) ? "headers" : "args"));
    assert.doesNotMatch(JSON.stringify(report), /private-|PRIVATE_READER_VALUE/);
    assert.equal(await readFile(file, "utf8"), content);
  }
});

test("stale bridge installation paths fail while object ordering and unrelated settings do not", async (t) => {
  const file = join(await temporaryDirectory(t), "cursor.jsonc");
  const root = JSON.parse(mergeConnection("cursor", hub).content);
  const entry = root.mcpServers.agent_tcdh;
  root.unrelated = { private: "private-unrelated-value" };
  root.mcpServers.agent_tcdh = Object.fromEntries(Object.entries(entry).reverse());
  await writeFile(file, JSON.stringify(root));
  assert.equal((await checkConnection({ client: "cursor", hub, file })).status, "passed");
  entry.args[0] = "/old-installation/private-entry.js";
  await writeFile(file, JSON.stringify(root));
  const report = await checkConnection({ client: "cursor", hub, file });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.differingFields, ["args"]);
  assert.doesNotMatch(JSON.stringify(report), /old-installation|private-/);
});

test("non-object named entries fail as entry differences without printing their values", async (t) => {
  const file = join(await temporaryDirectory(t), "client.json");
  for (const value of [null, false, "private-entry-value", ["private-entry-value"]]) {
    await writeFile(file, JSON.stringify({ mcpServers: { agent_tcdh: value } }));
    const report = await checkConnection({ client: "cursor", hub, file });
    assert.equal(report.reason, "settings-differ");
    assert.deepEqual(report.differingFields, ["entry"]);
    assert.doesNotMatch(JSON.stringify(report), /private-entry-value/);
  }
});

test("checks reject malformed, incompatible, oversized, and linked configurations without changing them", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "client");
  for (const [client, content, message] of [
    ["codex", 'key = "private-source-value', /Invalid TOML/],
    ["cursor", '{"private-source-value":', /Invalid JSON/],
    ["cursor", '{"mcpServers":[]}', /must be an object/],
    ["vscode", '{"mcpServers":{}}', /different MCP server container/],
    ["opencode", '{"mcp":{"old":{"type":"remote","url":"private-source-value"}}}', /v1 server layout/],
    ["opencode-v1", '{"mcp":{"servers":{"hub":{"type":"remote"}}}}', /v2 server layout/],
  ]) {
    await writeFile(file, content);
    await assert.rejects(checkConnection({ client, hub, file }), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /private-source-value/);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), content);
  }
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(checkConnection({ client: "cursor", hub, file }), /valid UTF-8/);
  await writeFile(file, "x".repeat(1_048_577));
  await assert.rejects(checkConnection({ client: "cursor", hub, file }), /1 MiB/);
  const linked = join(directory, "link");
  try {
    await symlink(file, linked);
    await assert.rejects(checkConnection({ client: "cursor", hub, file: linked }), /regular file/);
  } catch (error) {
    if (error.code !== "EPERM" || process.platform !== "win32") {
      throw error;
    }
  }
});

test("CLI checks use setup read references and overrides with stable JSON and diagnostic exit codes", async (t) => {
  const directory = await temporaryDirectory(t);
  const setup = join(directory, "setup.json");
  await writeFile(setup, JSON.stringify({ formatVersion: 1, mode: "remote", hub, readTokenEnv: "SETUP_READER", server: { host: "127.0.0.1", port: 3000, dbPath: "unused.sqlite" } }));
  const file = join(directory, "codex.toml");
  await writeFile(file, mergeConnection("codex", hub, "SETUP_READER").content);
  const passed = await cli(["connect", "codex", "--check", file, "--json"], setup);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, "passed");
  const failed = await cli(["connect", "codex", "--check", file, "--hub", "https://override.example", "--token-env", "OVERRIDE_READER"], setup);
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, "");
  assert.deepEqual(JSON.parse(failed.stdout).differingFields, ["url", "bearer_token_env_var"]);
  const missing = await cli(["connect", "codex", "--check", join(directory, "absent")], setup);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).reason, "file-missing");
});

test("CLI rejects mixed check/write modes before touching the selected file", async (t) => {
  const directory = await temporaryDirectory(t);
  const setup = join(directory, "setup.json");
  await writeFile(setup, JSON.stringify({ formatVersion: 1, mode: "remote", hub, server: { host: "127.0.0.1", port: 3000, dbPath: "unused.sqlite" } }));
  const file = join(directory, "must-not-create");
  for (const extra of [["--write", file], ["--print"], ["--replace"], ["--dry-run"]]) {
    const result = await cli(["connect", "codex", "--check", file, ...extra], setup);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Use --check FILE alone/);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(await readdir(directory), ["setup.json"]);
});
