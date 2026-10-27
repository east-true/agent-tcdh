import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseIdentity, sha256, verifyReleaseBundle } from "../scripts/release-utils.mjs";

test("release identity rejects mismatched tags, nonstable versions, and private packages", () => {
  const metadata = { name: "agent-tcdh", version: "0.1.0" };
  const commit = "a".repeat(40);
  assert.equal(releaseIdentity(metadata, "v0.1.0", commit).artifact, "agent-tcdh-0.1.0.tgz");
  assert.throws(() => releaseIdentity(metadata, "v0.2.0", commit));
  assert.throws(() => releaseIdentity({ ...metadata, version: "0.1.0-beta.1" }, "v0.1.0-beta.1", commit));
  assert.throws(() => releaseIdentity({ ...metadata, private: true }, "v0.1.0", commit));
  assert.throws(() => releaseIdentity(metadata, "v0.1.0", "main"));
});

test("release bundles reject tampered packages, manifests, and source identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tcdh-release-test-"));
  const expected = { tag: "v0.1.0", commit: "a".repeat(40), version: "0.1.0" };
  const content = Buffer.from("package fixture");
  const metadata = { schemaVersion: 1, name: "agent-tcdh", ...expected,
    artifact: "agent-tcdh-0.1.0.tgz", sha256: sha256(content) };
  const manifest = JSON.stringify(metadata);
  try {
    await writeFile(join(directory, metadata.artifact), content);
    await writeFile(join(directory, "release.json"), manifest);
    await writeFile(join(directory, "SHA256SUMS"), metadata.sha256 + "  " + metadata.artifact + "\n" + sha256(manifest) + "  release.json\n");
    assert.deepEqual(await verifyReleaseBundle(directory, expected), metadata);
    await assert.rejects(verifyReleaseBundle(directory, { ...expected, commit: "b".repeat(40) }));
    await writeFile(join(directory, metadata.artifact), "tampered");
    await assert.rejects(verifyReleaseBundle(directory, expected));
    await writeFile(join(directory, metadata.artifact), content);
    await writeFile(join(directory, "release.json"), manifest + " ");
    await assert.rejects(verifyReleaseBundle(directory, expected));
    await writeFile(join(directory, "release.json"), JSON.stringify({ ...metadata, artifact: "../package.tgz" }));
    await assert.rejects(verifyReleaseBundle(directory, expected));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
