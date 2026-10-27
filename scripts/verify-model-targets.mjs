import assert from "node:assert/strict";
import { commandVersion, runCommand } from "./process-utils.mjs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createApp } from "../dist/app.js";
import { HubClient } from "../dist/client.js";

const { values } = parseArgs({ options: {
  output: { type: "string" }, discovery: { type: "string", default: "mcp" },
  only: { type: "string", default: "both" },
  "gemini-model": { type: "string", default: "gemini-3.5-flash-lite" },
  "jev-model": { type: "string", default: "jev-latest" },
} });
assert.ok(["mcp", "a2a"].includes(values.discovery));
assert.ok(["both", "gemini", "jev"].includes(values.only));
const enabled = (id) => values.only === "both" || values.only === id;
const directory = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), "agent-tcdh-model-targets-"));
if (values.output) {
  await mkdir(directory);
}
const workspace = join(directory, "gemini-workspace");
await mkdir(join(workspace, ".gemini"), { recursive: true });
const geminiModel = values["gemini-model"];
const jevModel = values["jev-model"];
await writeFile(join(workspace, ".gemini/settings.json"), JSON.stringify({
  model: { maxSessionTurns: 1 },
  general: { previewFeatures: false, maxAttempts: 1, retryFetchErrors: false, plan: { modelRouting: false } },
  mcpServers: {}, ide: { enabled: false },
}, null, 2));
const policy = join(directory, "no-tools.toml");
await writeFile(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n');
const credentials = { admin: randomUUID(), read: randomUUID(), target: randomUUID() };
const events = [];
const calls = { gemini: 0, jev: 0 };
const observations = [];
const failures = [];
const target = Fastify({ logger: false, requestTimeout: 660_000 });
const hub = createApp({ logger: false, token: credentials.admin, readToken: credentials.read });
let targetUrl;

/** Remove configured credential values from diagnostics before saving them. */
function redact(text) {
  return [...Object.values(credentials), process.env.TYPESAFE_API_KEY, process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY].filter(Boolean).reduce((result, token) => result.replaceAll(token, "<credential>"), text);
}

/** Make one authenticated request to the official TypeSafe API without retries or redirects. */
async function typesafe(path, body) {
  assert.ok(process.env.TYPESAFE_API_KEY, "TYPESAFE_API_KEY is required for the official TypeSafe API.");
  const response = await fetch("https://api.typesafe.ai/v1/" + path, {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(45_000),
    headers: { Authorization: "Bearer " + process.env.TYPESAFE_API_KEY, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  events.push({ source: "typesafe", operation: path, httpStatus: response.status });
  assert.ok(response.ok, "Official TypeSafe API returned HTTP " + response.status + "; no retry was made.");
  const text = await response.text();
  assert.ok(!text.includes(process.env.TYPESAFE_API_KEY), "The service reflected a credential.");
  return JSON.parse(text);
}

/** Run one bounded, tool-free Gemini CLI request and retain its actual model statistics. */
async function generateGemini(prompt) {
  assert.equal(calls.gemini++, 0, "Only one Gemini invocation is permitted per run.");
  const version = commandVersion("gemini", 20_000);
  const args = ["--skip-trust", "--approval-mode", "plan", "--model", geminiModel,
    "--output-format", "json", "--extensions", "none", "--policy", policy, "--prompt", prompt];
  let result;
  try {
    result = await runCommand("gemini", args, { cwd: workspace, timeout: 600_000, maxBuffer: 2_097_152,
      env: { ...process.env, PWD: workspace } });
  } catch (error) {
    await writeFile(join(directory, "gemini-stdout.json"), redact(error.stdout ?? ""));
    await writeFile(join(directory, "gemini-stderr.log"), redact(error.stderr ?? ""));
    throw new Error("Gemini CLI failed; inspect its saved diagnostics. No second invocation was made.");
  }
  await writeFile(join(directory, "gemini-stdout.json"), redact(result.stdout));
  await writeFile(join(directory, "gemini-stderr.log"), redact(result.stderr));
  const output = JSON.parse(result.stdout);
  assert.ok(!output.error && typeof output.response === "string" && output.response.trim());
  observations.push({ provider: "gemini", clientVersion: version, requestedModel: geminiModel,
    stats: output.stats, response: output.response });
  return { response: output.response, stats: output.stats };
}

target.addHook("preHandler", async (request, reply) => {
  events.push({ source: "target", path: request.url, method: request.body?.method, tool: request.body?.params?.name });
  if (request.headers.authorization !== "Bearer " + credentials.target) {
    return reply.code(401).send({ error: "Authentication required." });
  }
});
hub.addHook("preHandler", async (request) => {
  events.push({ source: "hub", path: request.url, method: request.body?.method, tool: request.body?.params?.name });
});

target.get("/gemini/agent-card.json", async () => ({
  protocolVersion: "0.3.0", name: "Gemini CLI test adapter", description: "Generate a short tool-free text response using the locally configured Gemini CLI.",
  url: targetUrl + "/gemini/a2a", preferredTransport: "JSONRPC", version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"], defaultOutputModes: ["application/json"],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
  skills: [{ id: "generate_text", name: "Generate text", description: "Run one short Gemini request.", tags: ["live-models"] }],
}));
target.post("/gemini/a2a", async (request) => {
  try {
    const message = request.body?.params?.message;
    assert.equal(request.body?.method, "message/send");
    assert.ok(message?.messageId && message.kind === "message" && message.role === "user");
    assert.equal(message.parts?.length, 1);
    assert.equal(message.parts[0].kind, "text");
    const result = await generateGemini(message.parts[0].text);
    return { jsonrpc: "2.0", id: request.body.id, result: { kind: "message", role: "agent", messageId: randomUUID(),
      parts: [{ kind: "data", data: result }] } };
  } catch (error) {
    return { jsonrpc: "2.0", id: request.body?.id ?? null, error: { code: -32603, message: redact(error.message) } };
  }
});
target.post("/jev/mcp", async (request, reply) => {
  const peer = new Server({ name: "Official TypeSafe Jev test adapter", version: "0.1.0" }, { capabilities: { tools: {} } });
  peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "choose_protocol", description: "Ask the official TypeSafe Jev API to select MCP, A2A, or neither for a supplied task.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: false },
  }] }));
  peer.setRequestHandler(CallToolRequestSchema, async (request) => {
    assert.equal(request.params.name, "choose_protocol");
    assert.equal(calls.jev++, 0, "Only one TypeSafe inference request is permitted per run.");
    const input = { model: jevModel, state: { task: request.params.arguments.task }, questions: { protocol: {
      type: "choice", instructions: "Select the protocol that fits the task in state.task.", criteria: {
        mcp: "Discover and invoke tools or retrieve resources from a tool server.",
        a2a: "Delegate a task to another autonomous agent through agent-to-agent communication.",
        none: "Neither description matches the task.",
      },
    } } };
    await writeFile(join(directory, "jev-request.json"), JSON.stringify(input, null, 2) + "\n");
    const response = await typesafe("systemone", input);
    await writeFile(join(directory, "jev-response.json"), JSON.stringify(response, null, 2) + "\n");
    observations.push({ provider: "typesafe-jev", requestedModel: jevModel, ...response });
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  });
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  await peer.connect(transport);
  reply.hijack();
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } finally {
    await peer.close();
  }
});

const summary = { startedAt: new Date().toISOString(), discovery: values.discovery, scope: "test adapters backed by real providers",
  automaticRetries: 0, modelInvocations: calls, observations, failures, passed: false };
let discovery;
try {
  // 1. Inspect account availability without inference and prepare isolated target adapters.
  if (enabled("jev")) {
    const models = await typesafe("models");
    summary.availableJevModels = models.models.map((model) => model.name);
    assert.ok(summary.availableJevModels.includes(jevModel), "The requested Jev model was not advertised to this account.");
  }
  targetUrl = await target.listen({ host: "127.0.0.1", port: 0 });
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
  const admin = new HubClient(hubUrl, credentials.admin);
  for (const id of ["gemini", "jev"].filter(enabled)) {
    const protocol = id === "gemini" ? "a2a" : "mcp";
    await admin.create({ id: "live-" + id, name: id + " test adapter", protocol,
      description: id === "gemini" ? "Generate a short response using Gemini CLI" : "Make typed protocol choices using official TypeSafe Jev",
      tags: ["live-models"], capabilities: [{ name: id === "gemini" ? "generate_text" : "choose_protocol", description: "One bounded real-provider request" }],
      connection: { transport: id === "gemini" ? "http" : "streamable-http", url: targetUrl + "/" + id + "/" + protocol,
        ...(id === "gemini" ? { agentCardUrl: targetUrl + "/gemini/agent-card.json", protocolBinding: "JSONRPC", protocolVersion: "0.3.0" } : {}),
        auth: { type: "bearer", envVars: ["TCDH_MODEL_TARGET_TOKEN"] } } });
  }
  const query = values.discovery === "mcp" ? await (async () => {
    discovery = new Client({ name: "model-targets-consumer", version: "0.1.0" });
    await discovery.connect(new StreamableHTTPClientTransport(new URL(hubUrl + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + credentials.read } },
    }));
    return async (name, args) => {
      const response = await discovery.callTool({ name, arguments: args });
      assert.ok(!response.isError);
      return JSON.parse(response.content[0].text);
    };
  })() : await (async () => {
    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer " + credentials.read);
      return fetch(input, { ...init, headers });
    } })] });
    const agent = await factory.createFromUrl(hubUrl);
    return async (operation, args) => {
      const response = await agent.sendMessage(SendMessageRequest.fromJSON({ message: {
        messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation, arguments: args } }],
      } }));
      return Message.toJSON(response).parts[0].data;
    };
  })();

  // 2. Discover mixed protocols and execute each target directly without a hub relay.
  const found = await query("search_targets", { tag: "live-models" });
  for (const item of found.items) {
    try {
      const definition = await query("get_target", { id: item.id });
      if (definition.protocol === "mcp") {
        const client = new Client({ name: "jev-target-consumer", version: "0.1.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(definition.connection.url), {
            requestInit: { headers: { Authorization: "Bearer " + credentials.target } },
          }));
          const result = await client.callTool({ name: "choose_protocol", arguments: { task: "Delegate a travel-planning task to another autonomous specialist agent." } }, undefined, { timeout: 60_000 });
          assert.ok(!result.isError, "The Jev adapter returned a tool error.");
          const answer = JSON.parse(result.content[0].text);
          assert.equal(answer.answers.protocol.type, "choice");
          assert.equal(answer.answers.protocol.choice, "a2a");
          assert.ok(answer.model && answer.usage && answer.answers.protocol.probabilities);
        } finally {
          await client.close();
        }
      } else {
        const cardResponse = await fetch(definition.connection.agentCardUrl, { headers: { Authorization: "Bearer " + credentials.target } });
        assert.ok(cardResponse.ok);
        const card = await cardResponse.json();
        assert.equal(card.protocolVersion, "0.3.0");
        assert.equal(card.url, definition.connection.url);
        const challenge = randomUUID();
        const result = await fetch(card.url, { method: "POST", signal: AbortSignal.timeout(620_000),
          headers: { Authorization: "Bearer " + credentials.target, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send", params: { message: {
            kind: "message", role: "user", messageId: randomUUID(), parts: [{ kind: "text", text: "Do not use tools. Reply with exactly: agent-tcdh " + challenge }],
          } } }),
        });
        assert.ok(result.ok);
        const response = await result.json();
        assert.ok(!response.error, response.error?.message);
        assert.ok(response.result.parts[0].data.response.includes(challenge), "The Gemini response did not contain the fresh challenge.");
      }
    } catch (error) {
      failures.push({ target: item.id, error: redact(error.message) });
    }
  }
  assert.equal(found.total, values.only === "both" ? 2 : 1);
  assert.equal(events.filter((event) => event.source === "hub" && event.method === "tools/call"
    && !["search_targets", "get_target"].includes(event.tool)).length, 0);
  summary.passed = failures.length === 0;
} catch (error) {
  failures.push({ phase: "setup", error: redact(error.message) });
} finally {
  // 3. Keep successful and failed observations and clean up only the verification listeners.
  await discovery?.close();
  await hub.close();
  await target.close();
  summary.finishedAt = new Date().toISOString();
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(join(directory, "events.json"), JSON.stringify(events, null, 2) + "\n");
  console.log(JSON.stringify({ output: directory, ...summary }, null, 2));
  if (!summary.passed) {
    process.exitCode = 1;
  }
}
