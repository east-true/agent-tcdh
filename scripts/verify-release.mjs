import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./process-utils.mjs";
import { releaseIdentity, verifyReleaseBundle } from "./release-utils.mjs";

const { values } = parseArgs({ options: { tag: { type: "string" }, directory: { type: "string", default: "release" }, offline: { type: "boolean", default: false } } });
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: project })).stdout.trim();
const identity = releaseIdentity(metadata, values.tag, commit);
const directory = resolve(values.directory);

// 1. Verify asset checksums and the expected source commit before installation.
const manifest = await verifyReleaseBundle(directory, identity);
const tarball = join(directory, manifest.artifact);
const inspected = await runCommand("npm", ["pack", tarball, "--dry-run", "--ignore-scripts", "--json"], { cwd: project });
const output = JSON.parse(inspected.stdout);
const manifests = Array.isArray(output) ? output : Object.values(output);
assert.equal(manifests.length, 1);
assert.equal(manifests[0].name, identity.name);
assert.equal(manifests[0].version, identity.version);

// 2. Exercise the downloaded package, its installed CLI, protocols, and persistent storage.
const checked = await runCommand(process.execPath, [join(project, "scripts/verify-package.mjs"), "--tarball", tarball,
  ...(values.offline ? ["--offline"] : [])], { cwd: project });
process.stdout.write(checked.stdout);
