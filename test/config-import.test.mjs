import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { prepareConfigImport, importedId } from "../dist/onboarding/import-config.js";
import { listPresets, preparePreset } from "../dist/onboarding/presets.js";
import { fixture, register, definition, temporaryDirectory } from "./helpers.mjs";
import { cardSource } from "./import-helpers.mjs";

const execute = promisify(execFile);
const entry = resolve("dist/index.js");

/** Exercise import commands without inheriting personal setup or authentication. */
async function cli(args, environment = {}) {
  const env = { ...process.env, AGENT_TCDH_TOKEN: "", AGENT_TCDH_READ_TOKEN: "" };
  delete env.AGENT_TCDH_CONFIG;
  delete env.AGENT_TCDH_URL;
  return execute(process.execPath, [entry, ...args], { env: { ...env, ...environment }, timeout: 20_000 });
}

/** Preserve failure output for assertions about blocked imports and atomic changes. */
async function failure(args, environment = {}) {
  try {
    await cli(args, environment);
  } catch (error) {
    return error;
  }
  assert.fail("The command must fail.");
}

test("Codex imports preserve variable names and disabled state while omitting inline values", () => {
  const report = prepareConfigImport(`
[mcp_servers.files]
command = "node"
args = ["server.mjs"]
enabled = false
env_vars = ["PASSTHROUGH", { name = "LOCAL_VALUE", source = "local" }]
[mcp_servers.files.env]
API_TOKEN = "private-inline-secret"
MODE = "private-constant-value"
[mcp_servers.docs]
url = "https://docs.example/mcp"
bearer_token_env_var = "DOCS_TOKEN"
`);
  assert.equal(report.format, "codex");
  assert.equal(report.ready, true);
  assert.equal(report.targets[0].enabled, false);
  assert.deepEqual(report.targets[0].connection.envVars, ["API_TOKEN", "MODE", "PASSTHROUGH", "LOCAL_VALUE"]);
  assert.deepEqual(report.targets[1].connection.auth, { type: "bearer", envVars: ["DOCS_TOKEN"] });
  assert.equal(JSON.stringify(report).includes("private-inline-secret"), false);
  assert.equal(JSON.stringify(report).includes("private-constant-value"), false);
  assert.ok(report.issues.some((issue) => issue.code === "INLINE_ENV_OMITTED"));
  assert.equal(report.metadataInspected, false);
  assert.equal(report.executionVerified, false);
  assert.deepEqual(report.targets[0].capabilities, []);
});

test("OpenCode v1 and v2 layouts retain environment references and disabled flags", () => {
  const local = { type: "local", command: ["node", "server.mjs"], environment: { API_TOKEN: "{env:API_TOKEN}" } };
  const remote = { type: "remote", url: "https://docs.example/mcp", oauth: false,
    headers: { Authorization: "Bearer {env:DOCS_TOKEN}" } };
  const v1 = prepareConfigImport(JSON.stringify({ mcp: { local: { ...local, enabled: false }, docs: remote } }));
  assert.equal(v1.format, "opencode-v1");
  assert.equal(v1.targets[0].enabled, false);
  assert.equal(v1.targets[1].connection.auth.envVars[0], "DOCS_TOKEN");
  const v2 = prepareConfigImport(JSON.stringify({ mcp: { timeout: { connection: 10_000 }, servers: { local: { ...local, disabled: true }, docs: remote } } }));
  assert.equal(v2.format, "opencode");
  assert.equal(v2.available, 2);
  assert.equal(v2.ready, true);
  assert.equal(v2.targets[0].enabled, false);
  assert.deepEqual(v2.targets[0].connection.envVars, ["API_TOKEN"]);
});

test("generic MCP JSON imports omit Bearer literals and reject unrepresentable headers and URLs", () => {
  const report = prepareConfigImport(JSON.stringify({ mcpServers: {
    docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer private-bearer-value" } },
    custom: { url: "https://custom.example/mcp", headers: { "X-API-Key": "private-header-value" } },
    query: { url: "https://query.example/mcp?token=private-query-value" },
    credentials: { url: "https://user:private-password@example.test/mcp" },
  } }));
  assert.equal(report.ready, false);
  assert.equal(report.converted, 1);
  assert.equal(report.targets[0].connection.auth.envVars[0], "MCP_DOCS_TOKEN");
  assert.ok(report.issues.some((issue) => issue.code === "INLINE_BEARER_OMITTED"));
  assert.ok(report.issues.some((issue) => issue.code === "HEADER_MAPPING_UNSUPPORTED"));
  for (const secret of ["private-bearer-value", "private-header-value", "private-query-value", "private-password"]) {
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
});

test("unsupported execution contexts, aliases, auth helpers, and credential arguments block only selected entries", () => {
  const source = JSON.stringify({ mcp: { servers: {
    good: { type: "local", command: ["node"] },
    cwd: { type: "local", command: ["node"], cwd: "/private-workspace" },
    alias: { type: "local", command: ["node"], environment: { EXPECTED: "{env:OTHER}" } },
    expansion: { type: "local", command: ["node", "${WORKSPACE}/server.mjs"] },
    secret: { type: "local", command: ["node", "--api-key", "private-command-secret"] },
    oauth: { type: "remote", url: "https://oauth.example/mcp", oauth: { client_secret: "private-oauth-secret" } },
  } } });
  const all = prepareConfigImport(source);
  assert.equal(all.ready, false);
  assert.equal(all.converted, 1);
  assert.equal(JSON.stringify(all).includes("private-command-secret"), false);
  assert.equal(JSON.stringify(all).includes("private-oauth-secret"), false);
  assert.equal(JSON.stringify(all).includes("/private-workspace"), false);
  assert.ok(all.issues.some((issue) => issue.code === "ENV_ALIAS_UNSUPPORTED"));
  const selected = prepareConfigImport(source, { select: ["good"] });
  assert.equal(selected.ready, true);
  assert.equal(selected.selected, 1);
  assert.equal(selected.issues.length, 0);
});

test("remote Codex executor and dynamic header fields are not silently discarded", () => {
  const report = prepareConfigImport(`
[mcp_servers.executor]
command = "node"
experimental_environment = "remote"
env_vars = [{ name = "REMOTE_KEY", source = "remote" }]
[mcp_servers.headers]
url = "https://docs.example/mcp"
http_headers_helper = "private-helper-value"
[mcp_servers.headers.env_http_headers]
Authorization = "RAW_HEADER"
`);
  assert.equal(report.ready, false);
  assert.equal(report.converted, 0);
  assert.ok(report.issues.some((issue) => issue.code === "EXECUTION_CONTEXT_UNSUPPORTED"));
  assert.ok(report.issues.some((issue) => issue.code === "REMOTE_ENV_UNSUPPORTED"));
  assert.equal(JSON.stringify(report).includes("private-helper-value"), false);
});

test("format ambiguity, malformed syntax, duplicate selections, and import bounds fail explicitly", () => {
  const both = JSON.stringify({ mcpServers: { json: { command: "node" } }, mcp: { local: { type: "local", command: ["node"] } } });
  assert.throws(() => prepareConfigImport(both), /--format/);
  assert.equal(prepareConfigImport(both, { format: "mcp-json" }).targets[0].id, "json");
  assert.throws(() => prepareConfigImport('{"mcpServers":{"private-secret'), /--format/);
  assert.throws(() => prepareConfigImport(both, { format: "codex" }), /Invalid configuration syntax/);
  assert.throws(() => prepareConfigImport(both, { format: "mcp-json", select: ["missing"] }), /existing source/);
  assert.throws(() => prepareConfigImport(both, { format: "mcp-json", select: ["json", "json"] }), /unique/);
  assert.throws(() => prepareConfigImport("x".repeat(1_048_577)), /1 MiB/);
  const huge = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => ["n" + index, {}]));
  assert.throws(() => prepareConfigImport(JSON.stringify({ mcpServers: huge })), /10000/);
});

test("import ids remain deterministic and distinct across normalization and prefixes", () => {
  const names = ["docs", "Docs", "my tool", "my-tool", "__proto__", "x".repeat(300)];
  const ids = names.map((name) => importedId(name));
  assert.equal(new Set(ids).size, names.length);
  assert.deepEqual(names.map((name) => importedId(name)), ids);
  assert.ok(ids.every((id) => /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)));
  assert.ok(names.map((name) => importedId(name, "work")).every((id) => id.startsWith("work-") && id.length <= 128));
  assert.throws(() => importedId("docs", "Invalid Prefix"));
});

test("the destination hub discovery entry is excluded without suppressing other MCP registrations", () => {
  const report = prepareConfigImport(JSON.stringify({ mcpServers: {
    agent_tcdh: { type: "http", url: "http://127.0.0.1:3000/mcp" },
    other: { type: "http", url: "https://other.example/mcp" },
  } }), { hub: "http://127.0.0.1:3000" });
  assert.equal(report.ready, true);
  assert.deepEqual(report.targets.map((target) => target.id), ["other"]);
  assert.ok(report.issues.some((issue) => issue.code === "HUB_SELF_REFERENCE"));
});

test("config preview is offline, leaves its source unchanged, and does not need administrator secrets", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, "source.jsonc");
  const setup = join(directory, "setup.json");
  const original = '\uFEFF{ // a source comment\n "mcpServers": {"docs":{"type":"http","url":"https://docs.example/mcp"}} }';
  await writeFile(source, original);
  await cli(["init", "--yes", "--remote", "--hub", "http://127.0.0.1:1", "--read-token-env", "UNSET_READER", "--config", setup]);
  const report = JSON.parse((await cli(["registry", "import-config", source, "--config", setup])).stdout);
  assert.equal(report.applied, false);
  assert.equal(report.ready, true);
  assert.equal(report.hubConflictsChecked, false);
  assert.equal(await readFile(source, "utf8"), original);
  assert.match((await failure(["registry", "import-config", source, "--apply", "--config", setup])).stderr, /administrator credential/);
});

test("config application uses one atomic registry import and preserves source secrets outside the registry", async (t) => {
  const app = await fixture(t, { token: "import-admin" });
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const directory = await temporaryDirectory(t);
  const marker = join(directory, "must-not-run");
  const path = join(directory, "source.json");
  const original = JSON.stringify({ mcpServers: {
    local: { command: process.execPath, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')"], env: { LOCAL_SECRET: "private-value" } },
    remote: { type: "http", url: "https://remote.example/mcp", headers: { Authorization: "Bearer secret-value" } },
  } });
  await writeFile(path, original);
  const report = JSON.parse((await cli(["registry", "import-config", path, "--apply", "--hub", hub], { AGENT_TCDH_TOKEN: "import-admin" })).stdout);
  assert.equal(report.applied, true);
  assert.equal(report.result.inserted, 2);
  const stored = (await app.inject({ url: "/api/targets", headers: { Authorization: "Bearer import-admin" } })).json();
  assert.equal(stored.total, 2);
  assert.equal(JSON.stringify(stored).includes("private-value"), false);
  assert.equal(JSON.stringify(stored).includes("secret-value"), false);
  assert.deepEqual(stored.items.find((target) => target.id === "remote").connection.auth.envVars, ["MCP_REMOTE_TOKEN"]);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.equal(await readFile(path, "utf8"), original);
});

test("blocked plans and conflicting imports do not partially mutate the hub", async (t) => {
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const path = join(await temporaryDirectory(t), "source.json");
  await writeFile(path, JSON.stringify({ mcpServers: { good: { command: "node" }, bad: { command: "node", cwd: "private-directory" } } }));
  const blocked = await failure(["registry", "import-config", path, "--apply", "--hub", hub]);
  assert.equal(JSON.parse(blocked.stdout).applied, false);
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  await register(app, definition("existing"));
  const original = (await app.inject("/api/targets/existing")).json();
  await writeFile(path, JSON.stringify({ mcpServers: { existing: { command: "node" }, fresh: { command: "node" } } }));
  assert.match((await failure(["registry", "import-config", path, "--apply", "--hub", hub])).stderr, /409/);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
  assert.deepEqual((await app.inject("/api/targets/existing")).json(), original);
  const skipped = JSON.parse((await cli(["registry", "import-config", path, "--apply", "--on-conflict", "skip", "--hub", hub])).stdout);
  assert.equal(skipped.result.skipped, 1);
  assert.equal(skipped.result.inserted, 1);
  const replaced = JSON.parse((await cli(["registry", "import-config", path, "--select", "existing", "--apply", "--on-conflict", "replace", "--hub", hub])).stdout);
  assert.equal(replaced.result.replaced, 1);
  assert.equal((await app.inject("/api/targets/existing")).json().connection.transport, "stdio");
});

test("selected remote configurations are not probed during preview or registration", async (t) => {
  let requests = 0;
  const source = await cardSource(t, async () => {
    requests++;
    return { error: "must not inspect providers" };
  });
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const path = join(await temporaryDirectory(t), "source.json");
  await writeFile(path, JSON.stringify({ mcpServers: { remote: { type: "http", url: source.url + "/custom-card" } } }));
  await cli(["registry", "import-config", path, "--hub", hub]);
  await cli(["registry", "import-config", path, "--hub", hub, "--apply"]);
  assert.equal(requests, 0);
});

test("packaged presets expose historical metadata and allow deterministic selections without provider calls", async () => {
  const catalog = await listPresets();
  assert.equal(catalog[0].id, "public-docs");
  assert.equal(catalog[0].targets, 6);
  const subset = await preparePreset("public-docs", { select: ["openai-docs", "tosspayments-docs"], prefix: "work" });
  assert.deepEqual(subset.targets.map((target) => target.id), ["work-openai-docs", "work-tosspayments-docs"]);
  assert.equal(subset.metadataInspected, false);
  assert.equal(subset.executionVerified, false);
  assert.match(subset.metadataAsOf, /^2026-10-27/u);
  assert.equal((await preparePreset("public-docs")).targets[4].id, "openai-docs");
  await assert.rejects(preparePreset("unknown"), /Unknown preset/);
  await assert.rejects(preparePreset("public-docs", { select: ["missing"] }), /unique target ids/);
});

test("preset CLI defaults to preview and applies only selected targets with normal conflict handling", async (t) => {
  const catalog = JSON.parse((await cli(["preset", "list"])).stdout);
  assert.ok(catalog.presets[0].targetIds.includes("openai-docs"));
  const app = await fixture(t);
  const hub = await app.listen({ host: "127.0.0.1", port: 0 });
  const args = ["preset", "import", "public-docs", "--select", "openai-docs", "--prefix", "sample", "--hub", hub];
  const preview = JSON.parse((await cli(args)).stdout);
  assert.equal(preview.applied, false);
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  const applied = JSON.parse((await cli([...args, "--apply"])).stdout);
  assert.equal(applied.result.inserted, 1);
  assert.equal((await app.inject("/api/targets/sample-openai-docs")).json().protocol, "mcp");
  assert.match((await failure([...args, "--apply"])).stderr, /409/);
  const skipped = JSON.parse((await cli([...args, "--apply", "--on-conflict", "skip"])).stdout);
  assert.equal(skipped.result.skipped, 1);
  assert.match((await failure([...args, "--apply", "--dry-run"])).stderr, /either/);
});
