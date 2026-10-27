import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Message, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createApp } from "../dist/app.js";
import { HubClient } from "../dist/client.js";
import { targetDefinitionSchema } from "../dist/targets/schema.js";

const { values } = parseArgs({ options: { output: { type: "string" }, providers: { type: "string" } } });
const directory = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), "agent-tcdh-public-mcp-"));
if (values.output) {
  await mkdir(directory);
}
const credentials = { admin: randomUUID(), read: randomUUID() };
const events = [];
const results = [];
let definitions = [
  { id: "openai-docs", name: "OpenAI Docs", description: "Search and read official OpenAI developer documentation",
    protocol: "mcp", tags: ["public-docs", "openai"], capabilities: [],
    connection: { transport: "streamable-http", url: "https://developers.openai.com/mcp" } },
  { id: "tosspayments-docs", name: "Toss Payments Docs", description: "Search and read official Toss Payments integration documentation",
    protocol: "mcp", tags: ["public-docs", "payments"], capabilities: [],
    connection: { transport: "stdio", command: "npx", args: ["--yes", "@tosspayments/integration-guide-mcp@0.0.31"] } },
];
for (const [id, name, description, url] of [
  ["microsoft-learn", "Microsoft Learn", "Search and read official Microsoft and Azure documentation", "https://learn.microsoft.com/api/mcp"],
  ["cloudflare-docs", "Cloudflare Docs", "Search Cloudflare documentation and read its Pages migration guide", "https://docs.mcp.cloudflare.com/mcp"],
  ["context7", "Context7", "Resolve libraries and retrieve current framework documentation", "https://mcp.context7.com/mcp"],
  ["deepwiki", "DeepWiki", "Read public GitHub repository wiki structure and contents", "https://mcp.deepwiki.com/mcp"],
]) {
  definitions.push({ id, name, description, protocol: "mcp", tags: ["public-docs", id], capabilities: [],
    connection: { transport: "streamable-http", url } });
}
if (values.providers) {
  const requested = values.providers.split(",");
  assert.ok(requested.length && requested.every((id) => definitions.some((item) => item.id === id)), "Unknown provider id.");
  definitions = definitions.filter((item) => requested.includes(item.id));
}
const failures = [];
const allowedTools = new Set(["search_openai_docs", "fetch_openai_doc", "get-documents", "document-by-id",
  "microsoft_docs_search", "microsoft_docs_fetch", "search_cloudflare_documentation", "migrate_pages_to_workers_guide",
  "resolve-library-id", "query-docs", "read_wiki_structure", "read_wiki_contents"]);
const hub = createApp({ logger: false, dbPath: join(directory, "registry.sqlite"), token: credentials.admin, readToken: credentials.read });
hub.addHook("preHandler", async (request) => {
  events.push({ source: "hub", path: request.url, method: request.body?.method, tool: request.body?.params?.name });
});

/** Connect an actual MCP target using only its registered connection definition. */
async function withTarget(target, phase, operation) {
  // 1. Choose the registered transport without substituting a test server.
  const connection = target.connection;
  const transport = connection.transport === "stdio"
    ? new StdioClientTransport({ command: connection.command, args: connection.args, stderr: "pipe",
      ...(process.env.npm_config_cache ? { env: { npm_config_cache: process.env.npm_config_cache } } : {}),
    })
    : new StreamableHTTPClientTransport(new URL(connection.url));
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    events.push({ source: phase, target: target.id, method: message.method, tool: message.params?.name });
    return send(message, options);
  };
  const client = new Client({ name: "agent-tcdh-public-docs-verifier", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 30_000 });
    return await operation(client);
  } finally {
    // 2. Close protocol sessions and owned stdio processes on every outcome.
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      await transport.terminateSession().catch(() => undefined);
    }
    await client.close();
  }
}

/** Call an explicitly allowed documentation tool and retain a compact response fingerprint. */
async function callDocumentation(client, target, discovery, name, args) {
  assert.ok(allowedTools.has(name), "Only documentation search and fetch tools may be called.");
  assert.ok(target.capabilities.some((capability) => capability.name === name), "The discovered target does not declare " + name);
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  assert.ok(!response.isError, "Documentation tool returned isError: " + name);
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.ok(text.trim().length > 100, "Documentation response was empty or unexpectedly short.");
  const serialized = JSON.stringify(response);
  results.push({ target: target.id, discovery, tool: name, arguments: args, passed: true,
    responseBytes: Buffer.byteLength(serialized), textCharacters: text.length,
    sha256: createHash("sha256").update(serialized).digest("hex") });
  return text;
}

/** Verify search and document retrieval through a connection obtained from the hub. */
async function verifyTarget(target, discovery) {
  return withTarget(target, "direct:" + discovery, async (client) => {
    if (target.id === "openai-docs") {
      const found = JSON.parse(await callDocumentation(client, target, discovery, "search_openai_docs", { query: "Docs MCP server", limit: 2 }));
      const hits = found.hits.filter((hit) => {
        try {
          return ["developers.openai.com", "platform.openai.com", "learn.chatgpt.com"].includes(new URL(hit.url).hostname);
        } catch {
          return false;
        }
      });
      assert.ok(hits.length, "No official OpenAI documentation URL was returned.");
      const selected = hits.find((hit) => new URL(hit.url).pathname === "/learn/docs-mcp") ?? hits[0];
      const text = await callDocumentation(client, target, discovery, "fetch_openai_doc", { url: selected.url });
      assert.match(text, /MCP|documentation/iu);
      results.at(-1).documentUrl = selected.url;
    } else if (target.id === "tosspayments-docs") {
      const found = await callDocumentation(client, target, discovery, "get-documents", {
        version: "v2", keywords: ["payment", "widget"], searchMode: "broad", maxTokens: 1500,
      });
      const id = /\bID\s*:\s*(\d+)/u.exec(found)?.[1];
      assert.ok(id, "The Toss search result did not contain a document id.");
      const source = /https:\/\/docs\.tosspayments\.com\/[^\s)\]]+/u.exec(found)?.[0];
      assert.ok(source, "The Toss search result did not contain an official documentation URL.");
      const text = await callDocumentation(client, target, discovery, "document-by-id", { id });
      assert.match(text, /tosspayments|TossPayments/iu);
      results.at(-1).documentId = id;
      results.at(-1).documentUrl = source;
    } else if (target.id === "microsoft-learn") {
      const found = await callDocumentation(client, target, discovery, "microsoft_docs_search", { query: "Microsoft Learn MCP server overview" });
      const hits = JSON.parse(found).results;
      const selected = hits.find((hit) => hit.contentUrl?.includes("/training/support/mcp"))
        ?? hits.find((hit) => {
          try {
            return new URL(hit.contentUrl).hostname === "learn.microsoft.com";
          } catch {
            return false;
          }
        });
      const source = selected?.contentUrl;
      assert.ok(source && new URL(source).hostname === "learn.microsoft.com", "Microsoft search did not return an official Learn URL.");
      const text = await callDocumentation(client, target, discovery, "microsoft_docs_fetch", { url: source });
      assert.match(text, /Microsoft|MCP/iu);
      results.at(-1).documentUrl = source;
    } else if (target.id === "cloudflare-docs") {
      const text = await callDocumentation(client, target, discovery, "search_cloudflare_documentation", { query: "MCP server Streamable HTTP Workers" });
      assert.match(text, /developers\.cloudflare\.com/u);
      const guide = await callDocumentation(client, target, discovery, "migrate_pages_to_workers_guide", {});
      assert.match(guide, /Workers|Pages/u);
    } else if (target.id === "context7") {
      const query = "Create a Fastify TypeScript HTTP server with a GET route";
      const found = await callDocumentation(client, target, discovery, "resolve-library-id", { libraryName: "Fastify", query });
      const libraryId = /(?:library ID|Library ID):\s*(\/[^\s]+)/iu.exec(found)?.[1];
      assert.ok(libraryId, "Context7 did not return a library id (authentication or rate limits may apply).");
      const text = await callDocumentation(client, target, discovery, "query-docs", { libraryId, query, language: "TypeScript" });
      assert.match(text, /fastify/iu);
      assert.doesNotMatch(text, /invalid api key|rate limit exceeded|unauthorized/iu);
      results.at(-1).libraryId = libraryId;
    } else if (target.id === "deepwiki") {
      const args = { repoName: "modelcontextprotocol/typescript-sdk" };
      const structure = await callDocumentation(client, target, discovery, "read_wiki_structure", args);
      assert.match(structure, /SDK|MCP|Overview/iu);
      const text = await callDocumentation(client, target, discovery, "read_wiki_contents", args);
      assert.match(text, /Model Context Protocol|MCP/iu);
    } else {
      assert.fail("No documentation verification profile for " + target.id);
    }
  });
}

/** Query the hub using its A2A interface rather than the administrative HTTP client. */
async function a2aQuery(client, operation, args) {
  const response = await client.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: { operation, arguments: args } }],
  } }));
  return Message.toJSON(response).parts[0].data;
}

const summary = { startedAt: new Date().toISOString(), modelCalls: 0, paymentOperations: 0,
  tossPackage: "@tosspayments/integration-guide-mcp@0.0.31", results, failures, passed: false };
try {
  // 1. Inspect actual provider metadata, then register complete definitions in a persistent hub.
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
  const admin = new HubClient(hubUrl, credentials.admin);
  const observations = [];
  for (const definition of definitions) {
    try {
      await withTarget(definition, "metadata", async (client) => {
      const tools = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const response = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
        tools.push(...response.tools);
        assert.ok(tools.length <= 200);
        cursor = response.nextCursor;
        if (!cursor) {
          break;
        }
      }
      assert.equal(cursor, undefined, "Tool pagination did not finish.");
      definition.capabilities = tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
      observations.push({ id: definition.id, server: client.getServerVersion(), toolNames: tools.map((tool) => tool.name) });
      await admin.create(targetDefinitionSchema.parse(definition));
      });
    } catch (error) {
      failures.push({ target: definition.id, phase: "metadata", error: error.message });
    }
  }
  assert.equal(events.filter((event) => event.source === "metadata" && event.method === "tools/call").length, 0);
  summary.providers = observations;

  // 2. Discover registered providers through MCP and directly call their search and fetch tools.
  const discovery = new Client({ name: "public-docs-mcp-consumer", version: "0.1.0" });
  try {
    await discovery.connect(new StreamableHTTPClientTransport(new URL(hubUrl + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + credentials.read } },
    }));
    const found = await discovery.callTool({ name: "search_targets", arguments: { tag: "public-docs" } });
    const targets = JSON.parse(found.content[0].text).items;
    assert.equal(targets.length, observations.length);
    for (const item of targets) {
      const result = await discovery.callTool({ name: "get_target", arguments: { id: item.id } });
      try {
        await verifyTarget(JSON.parse(result.content[0].text), "mcp");
      } catch (error) {
        failures.push({ target: item.id, phase: "mcp", error: error.message });
      }
    }
  } finally {
    await discovery.close();
  }

  // 3. Repeat discovery using A2A and connect directly from the returned definitions.
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer " + credentials.read);
      return fetch(input, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    },
  })] });
  const agent = await factory.createFromUrl(hubUrl);
  const found = await a2aQuery(agent, "search_targets", { tag: "public-docs" });
  assert.equal(found.total, observations.length);
  for (const item of found.items) {
    try {
      await verifyTarget(await a2aQuery(agent, "get_target", { id: item.id }), "a2a");
    } catch (error) {
      failures.push({ target: item.id, phase: "a2a", error: error.message });
    }
  }
  await writeFile(join(directory, "registry.json"), JSON.stringify(await admin.exportRegistry(), null, 2) + "\n", { flag: "wx" });
  summary.registrationToolCalls = 0;
  summary.directToolCalls = events.filter((event) => event.source.startsWith("direct:") && event.method === "tools/call").length;
  summary.registeredTargets = observations.length;
  summary.expectedDirectToolCalls = definitions.length * 4;
  summary.passed = failures.length === 0 && results.length === summary.expectedDirectToolCalls;
  if (!summary.passed) {
    process.exitCode = 1;
  }
} catch (error) {
  summary.error = error instanceof Error ? error.message : "Verification failed.";
  process.exitCode = 1;
} finally {
  // 4. Save successful or failed observations without copying full copyrighted documents.
  summary.finishedAt = new Date().toISOString();
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(directory, "events.json"), JSON.stringify(events, null, 2) + "\n", { flag: "wx" });
  await hub.close();
  console.log(JSON.stringify({ output: directory, ...summary }, null, 2));
}
