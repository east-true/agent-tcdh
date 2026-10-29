import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { availablePort, runCommand, verifyRuntime, waitForHub } from "./smoke-runtime.mjs";

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, tarball: { type: "string" } } });
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "agent-tcdh package-"));
let child;

/** Stop the installed package process, escalating to termination if necessary. */
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

try {
  // 1. Verify required files and documentation in the built package.
  let tarball = values.tarball ? resolve(values.tarball) : undefined;
  if (!tarball) {
    const packed = await runCommand("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: project });
    const output = JSON.parse(packed.stdout);
    const [manifest] = Array.isArray(output) ? output : Object.values(output);
    tarball = join(directory, manifest.filename);
  }
  const packed = await runCommand("npm", ["pack", tarball, "--dry-run", "--ignore-scripts", "--json"], { cwd: directory });
  const output = JSON.parse(packed.stdout);
  const manifests = Array.isArray(output) ? output : Object.values(output);
  assert.equal(manifests.length, 1, "Exactly one package must be inspected.");
  const [manifest] = manifests;
  assert.equal(manifest.name, "agent-tcdh");
  const files = new Set(manifest.files.map((entry) => entry.path));
  for (const required of ["dist/index.js", "dist/onboarding/connect.js", "dist/onboarding/doctor.js", "docs/onboarding.md", "dist/onboarding/import-config.js", "dist/onboarding/presets.js", "docs/config-import.md", "dist/app.js", "dist/a2a-http.js", "dist/targets/check.js", "docs/agent-compatibility.md", "docs/agent-verification.md", "examples/a2a.json", "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) {
    assert.ok(files.has(required), "Required package file is missing: " + required);
  }
  for (const required of ["examples/local-demo.mjs", "examples/demo-targets.mjs", "docs/local-demo.md", "examples/public-docs-registry.json", "docs/public-mcp-verification.md", "docs/selection-verification.md", "docs/model-target-verification.md", "docs/platform-compatibility.md", "docs/reference.md"]) {
    assert.ok(files.has(required), "Local demo artifact is missing: " + required);
  }
  assert.equal([...files].some((file) => /^(src|test|node_modules|\.github)\//u.test(file) || /(^|\/)\.env(?:\.|$)|\.sqlite(?:$|-)/u.test(file)), false);

  // 2. Install production dependencies in isolation from the repository's development dependencies.
  const installation = join(directory, "consumer");
  await mkdir(installation);
  await runCommand("npm", ["install", "--prefix", installation, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock=false", ...(values.offline ? ["--offline"] : []), tarball], { cwd: installation });
  const installed = join(installation, "node_modules", "agent-tcdh");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const executable = process.platform === "win32" ? process.execPath : join(installation, "node_modules", ".bin", "agent-tcdh");
  const prefix = process.platform === "win32" ? [join(installed, metadata.bin[metadata.name])] : [];
  const help = await runCommand(executable, [...prefix, "--help"], { cwd: installation });
  assert.ok(help.stdout.includes("AgentTCDH"));

  // 3. Start the installed CLI and verify protocols before and after restarting.
  const port = await availablePort();
  const url = "http://127.0.0.1:" + port;
  const credentials = { adminToken: randomUUID(), readToken: randomUUID() };
  const environment = { ...process.env, AGENT_TCDH_TOKEN: credentials.adminToken,
    AGENT_TCDH_READ_TOKEN: credentials.readToken, AGENT_TCDH_PUBLIC_URL: url, AGENT_TCDH_ALLOWED_ORIGINS: "" };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  /** Start the deployed artifact using a dedicated verification database. */
  async function startServer() {
    child = spawn(executable, [...prefix, "serve", "--host", "127.0.0.1", "--port", String(port),
      "--db", join(directory, "registry.sqlite")], { cwd: installation, env: environment, stdio: ["ignore", "ignore", "ignore"] });
    await once(child, "spawn");
    await waitForHub(url, () => child.exitCode === null && child.signalCode === null);
  }
  // Exercise onboarding from the installed artifact using only isolated configuration files.
  const setupPath = join(directory, "setup.json");
  await runCommand(executable, [...prefix, "init", "--yes", "--config", setupPath, "--hub", url,
    "--port", String(port), "--db", join(directory, "registry.sqlite"),
    "--token-env", "AGENT_TCDH_TOKEN", "--read-token-env", "AGENT_TCDH_READ_TOKEN"], { cwd: installation, env: environment });
  environment.AGENT_TCDH_CONFIG = setupPath;
  const consumerConfig = join(directory, "consumer.jsonc");
  const connected = await runCommand(executable, [...prefix, "connect", "opencode", "--write", consumerConfig], { cwd: installation, env: environment });
  assert.equal(JSON.parse(connected.stdout).changed, true);
  assert.ok((await readFile(consumerConfig, "utf8")).includes("AGENT_TCDH_READ_TOKEN"));
  const codex = await runCommand(executable, [...prefix, "connect", "codex", "--print"], { cwd: installation, env: environment });
  assert.ok(codex.stdout.includes("bearer_token_env_var"));
  assert.ok(!codex.stdout.includes(credentials.readToken));
  const local = await runCommand(executable, [...prefix, "target", "add", "--command", process.execPath,
    "--name", "Package stdio registration", "--dry-run"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(local.stdout).connection.transport, "stdio");
  const clientSource = join(directory, "source.jsonc");
  const sourceContents = "\uFEFF" + JSON.stringify({ mcpServers: { "packaged-local": { command: process.execPath } } });
  await writeFile(clientSource, sourceContents, "utf8");
  const importPreview = await runCommand(executable, [...prefix, "registry", "import-config", clientSource], { cwd: installation, env: environment });
  assert.equal(JSON.parse(importPreview.stdout).ready, true);
  assert.equal(JSON.parse(importPreview.stdout).applied, false);
  const presets = await runCommand(executable, [...prefix, "preset", "list"], { cwd: installation, env: environment });
  assert.ok(JSON.parse(presets.stdout).presets.some((preset) => preset.id === "public-docs"));
  const presetPreview = await runCommand(executable, [...prefix, "preset", "show", "public-docs", "--select", "openai-docs"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(presetPreview.stdout).targets.length, 1);
  assert.equal(JSON.parse(presetPreview.stdout).executionVerified, false);
  const marker = "package-" + randomUUID();
  await startServer();
  const initial = await verifyRuntime(url, credentials, marker);
  const imported = await runCommand(executable, [...prefix, "registry", "import-config", clientSource, "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(imported.stdout).applied, true);
  assert.equal(await readFile(clientSource, "utf8"), sourceContents);
  const presetImport = await runCommand(executable, [...prefix, "preset", "import", "public-docs", "--select", "openai-docs", "--prefix", "packaged", "--apply"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(presetImport.stdout).applied, true);
  const doctor = await runCommand(executable, [...prefix, "doctor"], { cwd: installation, env: environment });
  assert.equal(JSON.parse(doctor.stdout).status, "passed");
  assert.equal(JSON.parse(doctor.stdout).executionVerified, false);

  // 4. Verify JSON failure diagnostics for an unreachable metadata endpoint using the installed CLI.
  let diagnostic;
  try {
    await runCommand(executable, [...prefix, "target", "check", marker + "-mcp", "--hub", url,
      "--token-env", "AGENT_TCDH_READ_TOKEN"], { cwd: installation, env: environment });
    assert.fail("The unreachable test target must produce a failure report.");
  } catch (error) {
    assert.equal(error.code, 1);
    diagnostic = JSON.parse(error.stdout);
  }
  assert.equal(diagnostic.status, "failed");
  assert.equal(diagnostic.scope, "mcp-tools-list");
  assert.equal(diagnostic.executionVerified, false);

  // 5. Restart with the same database and verify registration and discovery again.
  await stopServer();
  await startServer();
  const restarted = await verifyRuntime(url, credentials, marker, true);
  for (const id of ["packaged-local", "packaged-openai-docs"]) {
    const persisted = await runCommand(executable, [...prefix, "target", "get", id], { cwd: installation, env: environment });
    assert.equal(JSON.parse(persisted.stdout).id, id);
  }

  // 6. Run stdio and A2A direct-call examples with production dependencies only.
  const demo = await runCommand(process.execPath, [join(installed, "examples/local-demo.mjs"), "--discovery", "a2a"], {
    cwd: installation, env: environment,
  });
  const demoResult = JSON.parse(demo.stdout);
  assert.equal(demoResult.executions.length, 3);
  assert.ok(demoResult.executions.some((entry) => entry.transport === "stdio"));
  assert.equal(demoResult.remainingTargets.length, 2);
  console.log(JSON.stringify({ package: manifest.filename, isolatedProductionInstall: true,
    installedBinary: true, onboarding: true, configImport: true, presets: true, documentation: true, targetDiagnostics: true, localDemo: true, initial, restarted, persistence: true }, null, 2));
} finally {
  // 7. Clean up only the processes and temporary files created by this run.
  try {
    await stopServer();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
