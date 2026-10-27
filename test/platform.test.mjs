import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { commandVersion, runCommand, spawnCommand, stopProcessTree } from "../scripts/process-utils.mjs";
import { temporaryDirectory } from "./helpers.mjs";

test("command shims preserve paths with spaces, Unicode, and literal argument boundaries", async (t) => {
  const directory = await temporaryDirectory(t);
  const bin = join(directory, "commands with spaces", "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const body = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n';
  if (process.platform === "win32") {
    await writeFile(join(bin, "echo-args.js"), body);
    await writeFile(join(bin, "echo-fixture.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0echo-args.js" %*\r\n');
  } else {
    const executable = join(bin, "echo-fixture");
    await writeFile(executable, "#!/usr/bin/env node\n" + body);
    await chmod(executable, 0o755);
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const args = ["two words", 'a "quoted" value', "(parentheses)", "literal & pipe | value", "semi;colon", "Unicode Ω ☃"];
  const result = await runCommand("echo-fixture", args, { env: { ...process.env, [pathKey]: bin + delimiter + process.env[pathKey] } });
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(commandVersion(join(bin, "echo-fixture")), '["--version"]');
});

test("bounded command execution retains typed exit diagnostics and Unicode output", async () => {
  const text = "Ω☃".repeat(40_000);
  await assert.rejects(runCommand(process.execPath, ["-e",
    'process.stdout.write("Ω☃".repeat(40000)); process.stderr.write("diagnostic"); process.exitCode = 7;',
  ]), (error) => error.code === 7 && error.stdout === text && error.stderr === "diagnostic");
});

test("command deadlines terminate an owned process instead of waiting indefinitely", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 200 }), /timed out/);
});

test("owned process tree cleanup also closes a descendant listener", async (t) => {
  const descendant = `const http = require("node:http"); const server = http.createServer((req,res) => res.end("ok")); server.listen(0,"127.0.0.1",() => console.log(JSON.stringify({port:server.address().port})));`;
  const parent = `const {spawn} = require("node:child_process"); const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","pipe","inherit"]}); child.stdout.pipe(process.stdout); setInterval(() => {},1000);`;
  const child = spawnCommand(process.execPath, ["-e", parent], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => {
    lines.close();
    stopProcessTree(child, true);
  });
  const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
  const url = "http://127.0.0.1:" + JSON.parse(line).port;
  assert.equal((await fetch(url)).status, 200);
  const closed = once(child, "close");
  stopProcessTree(child, true);
  await closed;
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});
