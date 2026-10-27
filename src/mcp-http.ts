import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDiscoveryServer, type DiscoveryReader } from "./mcp.js";

/** Expose the same discovery tools through isolated Streamable HTTP MCP requests. */
export function registerHttpDiscovery(
  app: FastifyInstance,
  reader: DiscoveryReader,
  allowedOrigins: readonly string[] = [],
): void {
  // 1. Accept Origin headers only when the origin is explicitly allowed.
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url !== "/mcp") {
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return reply.code(403).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin is not allowed." },
        id: null,
      });
    }
  });

  // 2. Create a stateless server per POST and query the shared store directly.
  app.post("/mcp", {
    config: { access: "read" },
    errorHandler: (error, _request, reply) => {
      const status = error.statusCode ?? 500;
      return reply.code(status).send({
        jsonrpc: "2.0",
        error: {
          code: error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? -32700 : -32600,
          message: status >= 500 ? "Unable to process the MCP request." : "Check the MCP request format.",
        },
        id: null,
      });
    },
  }, async (request, reply) => {
    const server = createDiscoveryServer(reader);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP HTTP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Unable to process the MCP request." },
          id: null,
        }));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } finally {
      await server.close();
    }
  });

  // 3. Advertise POST request/response support without long-lived streams or sessions.
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    config: { access: "read" },
    handler: async (_request, reply) => {
      return reply.header("Allow", "POST").code(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This MCP endpoint only supports POST requests." },
        id: null,
      });
    },
  });
}
