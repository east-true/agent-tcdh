import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDiscoveryServer } from "../dist/mcp.js";
import { createHubAgentCard, legacyHubAgentCard } from "../dist/a2a-discovery.js";
import { createOpenApiDocument } from "../dist/openapi.js";
import { PACKAGE_VERSION } from "../dist/version.js";
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

test("release version matches the package manifest, MCP initialization, A2A cards, and OpenAPI", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PACKAGE_VERSION, metadata.version);
  const card = createHubAgentCard("http://127.0.0.1:3000", true);
  assert.equal(card.version, metadata.version);
  assert.equal(legacyHubAgentCard(card).version, metadata.version);
  assert.equal(createOpenApiDocument(true).info.version, metadata.version);
  assert.equal(createOpenApiDocument(false).info.version, metadata.version);
  const server = createDiscoveryServer({ search: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
    get: async () => Promise.reject(new Error("No target lookup is expected during initialization.")) });
  const client = new Client({ name: "release-version-check", version: "1.0.0" });
  const [consumer, provider] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(provider);
    await client.connect(consumer);
    assert.equal(client.getServerVersion().version, metadata.version);
  } finally {
    await client.close();
    await server.close();
  }
});
