import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { availablePort, runCommand, verifyRuntime, waitForHub } from "./smoke-runtime.mjs";

const { values } = parseArgs({ options: { image: { type: "string", default: "agent-tcdh:ci" } } });
const suffix = randomUUID();
const container = "agent-tcdh-smoke-" + suffix;
const volume = "agent-tcdh-smoke-" + suffix;
let volumeCreated = false;
let containerCreated = false;

/** Wait within a deadline for the image's health check to become healthy. */
async function waitForHealthy() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await runCommand("docker", ["inspect", "--format", "{{.State.Health.Status}}", container]);
    if (state.stdout.trim() === "healthy") {
      return;
    }
    await setTimeout(200);
  }
  throw new Error("The container HEALTHCHECK did not become healthy.");
}

try {
  // 1. Prepare a dedicated volume and loopback port for this verification run.
  await runCommand("docker", ["volume", "create", volume]);
  volumeCreated = true;
  const port = await availablePort();
  const url = "http://127.0.0.1:" + port;
  const credentials = { adminToken: randomUUID(), readToken: randomUUID() };
  await runCommand("docker", ["create", "--name", container, "--init", "--publish", "127.0.0.1:" + port + ":3000",
    "--mount", "type=volume,source=" + volume + ",target=/data", "--health-interval", "1s", "--health-start-period", "1s",
    "--env", "AGENT_TCDH_TOKEN=" + credentials.adminToken,
    "--env", "AGENT_TCDH_READ_TOKEN=" + credentials.readToken,
    "--env", "AGENT_TCDH_PUBLIC_URL=" + url, values.image]);
  containerCreated = true;
  await runCommand("docker", ["start", container]);
  await waitForHub(url);
  await waitForHealthy();
  const uid = await runCommand("docker", ["exec", container, "id", "-u"]);
  assert.notEqual(uid.stdout.trim(), "0", "The container must run as a non-root user.");

  // 2. Verify HTTP, MCP, A2A, and read permissions in the actual container.
  const marker = "container-" + suffix;
  const initial = await verifyRuntime(url, credentials, marker);
  await runCommand("docker", ["restart", "--time", "5", container]);
  await waitForHub(url);
  await waitForHealthy();
  const restarted = await verifyRuntime(url, credentials, marker, true);
  console.log(JSON.stringify({ image: values.image, nonRoot: true, healthcheck: true,
    initial, restarted, volumePersistence: true }, null, 2));
} finally {
  // 3. Remove only this run's container and volume, including on failure.
  try {
    if (containerCreated) {
      await runCommand("docker", ["rm", "--force", container]);
    }
  } finally {
    if (volumeCreated) {
      await runCommand("docker", ["volume", "rm", volume]);
    }
  }
}
