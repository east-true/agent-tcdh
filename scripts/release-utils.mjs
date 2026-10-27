import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Require an exact stable version tag and a full source commit before preparing publication. */
export function releaseIdentity(metadata, tag, commit) {
  assert.equal(metadata.name, "agent-tcdh");
  assert.match(metadata.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.equal(tag, "v" + metadata.version, "Release tag must match package.json version.");
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.notEqual(metadata.private, true, "Private packages cannot be published.");
  return { name: metadata.name, version: metadata.version, tag, commit, artifact: metadata.name + "-" + metadata.version + ".tgz" };
}

/** Compute a hexadecimal SHA-256 checksum for a release asset. */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Verify the exact bundle against its expected source identity and both recorded checksums. */
export async function verifyReleaseBundle(directory, expected) {
  // 1. Reject a mismatched version, tag, commit, or filename before reading the artifact.
  const manifestContent = await readFile(join(directory, "release.json"));
  const manifest = JSON.parse(manifestContent);
  const identity = releaseIdentity(manifest, expected.tag, expected.commit);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, expected.version);
  assert.equal(manifest.tag, identity.tag);
  assert.equal(manifest.commit, identity.commit);
  assert.equal(manifest.artifact, identity.artifact);

  // 2. Bind the manifest and package bytes to the downloadable checksum file.
  const content = await readFile(join(directory, identity.artifact));
  assert.equal(manifest.sha256, sha256(content), "Release package checksum mismatch.");
  const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  assert.equal(checksums, manifest.sha256 + "  " + identity.artifact + "\n" + sha256(manifestContent) + "  release.json\n");
  return manifest;
}
