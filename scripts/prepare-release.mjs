import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./process-utils.mjs";
import { releaseIdentity, sha256 } from "./release-utils.mjs";

const { values } = parseArgs({ options: { tag: { type: "string" }, out: { type: "string", default: "release" } } });
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: project })).stdout.trim();
const identity = releaseIdentity(metadata, values.tag, commit);
const status = await runCommand("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: project });
assert.equal(status.stdout.trim(), "", "Prepare releases from a clean committed checkout.");
const directory = resolve(values.out);

// 1. Build and pack into a new directory without replacing existing release assets.
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory);
await runCommand("npm", ["run", "build"], { cwd: project });
const packed = await runCommand("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: project });
const output = JSON.parse(packed.stdout);
const manifests = Array.isArray(output) ? output : Object.values(output);
assert.equal(manifests.length, 1);
const [manifest] = manifests;
assert.equal(manifest.filename, identity.artifact);
assert.equal(manifest.version, identity.version);

// 2. Record source identity and checksums for the exact installable package.
const checksum = sha256(await readFile(join(directory, identity.artifact)));
const release = JSON.stringify({ schemaVersion: 1, ...identity, sha256: checksum }, null, 2) + "\n";
await writeFile(join(directory, "release.json"), release, { flag: "wx" });
await writeFile(join(directory, "SHA256SUMS"), checksum + "  " + identity.artifact + "\n" + sha256(release) + "  release.json\n", { flag: "wx" });
console.log(release.trim());
