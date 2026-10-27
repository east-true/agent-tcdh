import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";
import { temporaryDirectory } from "./helpers.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
const entry = resolve("examples/local-demo.mjs");

test("demo entry points execute through symlinked directories and Windows junctions", async (t) => {
  const directory = await temporaryDirectory(t);
  const linked = join(directory, "linked examples");
  await symlink(dirname(entry), linked, process.platform === "win32" ? "junction" : "dir");
  const { stdout } = await execute(process.execPath, [join(linked, "local-demo.mjs")], { timeout: 20_000 });
  assert.equal(JSON.parse(stdout).executions.length, 3);
  const client = new Client({ name: "linked-stdio-verifier", version: "0.1.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(linked, "demo-targets.mjs"), "--stdio"], stderr: "pipe" }), { timeout: 10_000 });
    const result = await client.callTool({ name: "echo", arguments: { text: "linked execution" } });
    assert.equal(JSON.parse(result.content[0].text).text, "linked execution");
  } finally {
    await client.close();
  }
});

for (const discovery of ["mcp", "a2a"]) {
  test("the local demo uses " + discovery + " discovery to call three targets directly without using personal configuration", async (t) => {
    const directory = await temporaryDirectory(t);
    const existing = join(directory, "existing.sqlite");
    await writeFile(existing, "existing-user-data");
    const { stdout } = await execute(process.execPath, [entry, "--discovery", discovery], {
      cwd: directory, timeout: 20_000, env: { ...process.env, HOST: "192.0.2.1", PORT: "1",
        AGENT_TCDH_URL: "http://127.0.0.1:1", AGENT_TCDH_DB_PATH: existing,
        AGENT_TCDH_TOKEN: "not-the-demo-admin", AGENT_TCDH_READ_TOKEN: "not-the-demo-reader",
        AGENT_TCDH_PUBLIC_URL: "https://not-the-demo.example.com", AGENT_TCDH_ALLOWED_ORIGINS: "invalid-origin",
      },
    });
    const report = JSON.parse(stdout);
    assert.equal(report.discovery, discovery);
    assert.equal(report.targetsFound, 3);
    assert.deepEqual(new Set(report.executions.map((entry) => entry.transport)), new Set(["streamable-http", "stdio", "http"]));
    assert.equal(new Set(report.executions.map((entry) => entry.receipt)).size, 3);
    assert.equal(report.executionsDuringRegistrationAndDiscovery, 0);
    assert.equal(report.removedTarget, "demo-mcp");
    assert.deepEqual(report.remainingTargets, ["demo-agent", "demo-stdio"]);
    assert.equal(await readFile(existing, "utf8"), "existing-user-data");
    assert.equal(stdout.includes("not-the-demo-admin"), false);
  });
}

// Windows process.kill does not deliver POSIX SIGTERM handlers; IPC covers graceful teardown there.
for (const method of process.platform === "win32" ? ["ipc"] : ["ipc", "signal"]) {
  test("serve mode closes listener ports after " + method + " shutdown", async (t) => {
    const child = spawn(process.execPath, [entry, "--serve"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    });
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
    const ready = JSON.parse(line);
    assert.equal(ready.mode, "serve");
    assert.equal(ready.auth, "none");
    assert.equal(new URL(ready.hubUrl).hostname, "127.0.0.1");
    assert.equal(ready.mcpDiscoveryUrl, ready.hubUrl + "/mcp");
    const response = await fetch(ready.hubUrl + "/api/targets", { signal: AbortSignal.timeout(3000) });
    const targets = await response.json();
    assert.equal(targets.total, 3);
    const targetCard = targets.items.find((entry) => entry.protocol === "a2a").connection.agentCardUrl;
    const exited = once(child, "exit");
    if (method === "ipc") {
      child.send("shutdown");
    } else {
      child.kill("SIGTERM");
    }
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    for (const url of [ready.hubUrl + "/health", targetCard]) {
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
    }
  });
}
