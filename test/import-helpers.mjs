// Non-English data below intentionally exercises Unicode metadata and search.
import Fastify from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Create a remote MCP fixture with controlled tool pages and execution counters. */
export async function mcpSource(t, options = {}) {
  const app = Fastify({ logger: false, ...(options.forceCloseConnections === true ? { forceCloseConnections: true } : {}) });
  const state = {
    pages: options.pages ?? [{ tools: [{ name: "search_docs", description: "공식 문서 검색", inputSchema: { type: "object" } }] }],
    calls: 0,
    listCalls: 0,
    headers: [],
    fail: false,
  };
  const active = new Map();

  /** Handle only initialization and tool listing on each metadata connection. */
  function server() {
    const peer = new Server({ name: "Remote MCP", version: "1.0.0" }, { capabilities: { tools: {} } });
    peer.setRequestHandler(ListToolsRequestSchema, async (request) => {
      state.listCalls++;
      if (options.onList) {
        await options.onList();
      }
      const index = request.params?.cursor ? Number(request.params.cursor) : 0;
      return state.pages[index] ?? { tools: [] };
    });
    peer.setRequestHandler(CallToolRequestSchema, async () => {
      state.calls++;
      throw new Error("메타데이터 수집에서 도구를 실행하면 안 됩니다.");
    });

    return peer;
  }

  app.addHook("preHandler", async (request, reply) => {
    state.headers.push(request.headers.authorization);
    if (state.fail) {
      return reply.code(503).send({ error: "unavailable" });
    }
    if (options.token && request.headers.authorization !== "Bearer " + options.token) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
  app.post("/mcp", async (request, reply) => {
    const peer = server();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await peer.connect(transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await peer.close();
    }
  });
  app.get("/mcp", async (_request, reply) => {
    return reply.code(405).send();
  });
  app.get("/sse", async (_request, reply) => {
    reply.hijack();
    const peer = server();
    const transport = new SSEServerTransport("/messages", reply.raw);
    active.set(transport.sessionId, { peer, transport });
    reply.raw.once("close", () => {
      active.delete(transport.sessionId);
      void peer.close();
    });
    await peer.connect(transport);
  });
  app.post("/messages", async (request, reply) => {
    const item = active.get(request.query.sessionId);
    if (!item) {
      return reply.code(404).send();
    }
    reply.hijack();
    await item.transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const item of active.values()) {
      await item.peer.close();
    }
    await app.close();
  });

  return { app, url, state };
}

/** Prepare an HTTP source returning a selected Agent Card or response failure. */
export async function cardSource(t, handler) {
  const app = Fastify({ logger: false });
  app.get("/.well-known/agent-card.json", handler);
  app.get("/custom-card", handler);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });

  return { app, url };
}
