import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export { runCommand } from "./process-utils.mjs";

/** Ask the operating system for an available loopback port. */
export async function availablePort() {
  // 1. Allocate an unused port.
  const allocator = createServer();
  await new Promise((resolve, reject) => {
    allocator.once("error", reject);
    allocator.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = allocator.address().port;

  // 2. Close the allocation socket so the verification process can bind the port.
  await new Promise((resolve, reject) => {
    allocator.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

/** Wait within a deadline for the public health endpoint to become ready. */
export async function waitForHub(url, alive = () => true) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && alive()) {
    try {
      const response = await fetch(url + "/health", { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") {
        return;
      }
    } catch {
      // Retry startup connection failures only within the overall deadline.
    }
    await setTimeout(100);
  }
  throw new Error("The deployed hub did not become ready before the deadline.");
}

/** Validate the HTTP status and decode the JSON response. */
async function requestJson(url, path, token, method = "GET", body, expectedStatus = 200) {
  const response = await fetch(url + path, {
    method, signal: AbortSignal.timeout(5000),
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, method + " " + path + ": " + text);
  return JSON.parse(text);
}

/** Verify authentication, registration, MCP, and both A2A versions in a deployed artifact. */
export async function verifyRuntime(url, credentials, marker, existing = false) {
  // 1. Verify roles using isolated test credentials unrelated to operational tokens.
  const { adminToken, readToken } = credentials;
  await requestJson(url, "/api/targets", undefined, "GET", undefined, 401);
  const ids = { mcp: marker + "-mcp", a2a: marker + "-a2a" };
  const definitions = ["mcp", "a2a"].map((protocol) => ({
    id: ids[protocol], name: "Runtime " + protocol, description: "Deployment verification " + marker,
    protocol, tags: [marker], capabilities: [{ name: "probe", description: "Deployment verification metadata" }],
    connection: protocol === "mcp" ? { transport: "streamable-http", url: "http://127.0.0.1:1/mcp" }
      : { transport: "http", url: "http://127.0.0.1:1/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  }));
  await requestJson(url, "/api/targets", readToken, "POST", definitions[0], 403);
  if (!existing) {
    for (const definition of definitions) {
      await requestJson(url, "/api/targets", adminToken, "POST", definition, 201);
    }
  }
  const http = await requestJson(url, "/api/targets?tag=" + marker, readToken);
  assert.equal(http.total, 2);
  assert.deepEqual(new Set(http.items.map((item) => item.id)), new Set(Object.values(ids)));

  // 2. Connect with a read token and verify HTTP MCP discovery and connection metadata.
  const mcp = new Client({ name: "deployment-probe", version: "1.0.0" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + readToken } },
    }));
    const search = await mcp.callTool({ name: "search_targets", arguments: { tag: marker } });
    assert.equal(JSON.parse(search.content[0].text).total, 2);
    const found = await mcp.callTool({ name: "get_target", arguments: { id: ids.a2a } });
    assert.equal(JSON.parse(found.content[0].text).connection.protocolVersion, "1.0");
  } finally {
    await mcp.close();
  }

  // 3. Discover the public card and query A2A 1.0 and 0.3 with the official SDK.
  /** Apply the verification read token and timeout to every request. */
  const authenticatedFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer " + readToken);
    return fetch(input, { ...init, headers, signal: AbortSignal.timeout(5000) });
  };
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({
    fetchImpl: authenticatedFetch, legacyCompat: { enabled: true },
  })] });
  const client = await factory.createFromUrl(url);
  const card = await client.getAgentCard();
  assert.equal(card.supportedInterfaces[0].url, url + "/a2a");
  assert.equal(card.capabilities.streaming, false);
  assert.ok(Object.hasOwn(card.securitySchemes, "hubBearer"));
  const native = await client.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "get_target", arguments: { id: ids.a2a } } }],
  } }));
  assert.equal(Message.toJSON(native).parts[0].data.connection.protocolBinding, "JSONRPC");
  const legacy = await factory.createFromAgentCard({ ...card,
    supportedInterfaces: [{ ...card.supportedInterfaces[0], protocolVersion: "0.3" }],
  });
  const older = await legacy.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation: "search_targets", arguments: { tag: marker } } }],
  } }));
  assert.equal(Message.toJSON(older).parts[0].data.total, 2);
  return { http: true, permissions: true, mcp: true, a2a10: true, a2a03: true };
}
