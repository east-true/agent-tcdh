import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentCard, Message } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";

/** Create a demo MCP server returning input text and a receipt generated during execution. */
export function createEchoMcp(onExecute = () => undefined) {
  // 1. Prepare an example server without filesystem or external-service access.
  const server = new McpServer({ name: "agent-tcdh-demo-echo", version: "1.0.0" });

  // 2. Generate a receipt only when the tool executes.
  server.registerTool("echo", { description: "Return the input text and an execution receipt.", inputSchema: { text: z.string().max(2000) } }, async ({ text }) => {
    const result = { text, receipt: randomUUID() };
    onExecute(result);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  return server;
}

/** Prepare loopback-only MCP and A2A demo targets. */
export async function createDemoTargets() {
  // 1. Register echo targets without access to external files, models, or services.
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  const executions = [];
  let baseUrl;
  app.post("/mcp", async (request, reply) => {
    const server = createEchoMcp((result) => executions.push({ protocol: "mcp", ...result }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await server.close();
    }
  });
  app.get("/mcp", async (_request, reply) => {
    return reply.code(405).send();
  });

  // 2. Expose an A2A 1.0 card and executor for a single text message.
  /** Publish the actual listener URL as an A2A JSONRPC interface. */
  function agentCard() {
    return AgentCard.fromJSON({ name: "Demo echo agent", description: "Local text echo agent", version: "1.0.0",
      supportedInterfaces: [{ url: baseUrl + "/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text/plain"], defaultOutputModes: ["application/json"],
      skills: [{ id: "echo", name: "Echo", description: "Return the input text and an execution receipt.", tags: ["demo"] }],
    });
  }
  app.get("/.well-known/agent-card.json", async () => AgentCard.toJSON(agentCard()));
  app.post("/a2a", async (request, reply) => {
    if (request.headers["a2a-version"] !== "1.0") {
      return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32009, message: "This example only supports A2A 1.0." } });
    }
    if (request.body?.method !== "SendMessage") {
      return { jsonrpc: "2.0", id: request.body?.id ?? null, error: { code: -32004, message: "This example only supports SendMessage." } };
    }
    const executor = {
      /** Process a text message and include a fresh receipt in the A2A response. */
      async execute(context, bus) {
        // 1. Prepare the demo text and execution receipt.
        const input = Message.toJSON(context.userMessage);
        const result = { text: input.parts.map((part) => part.text ?? "").join("\n").slice(0, 2000), receipt: randomUUID() };

        // 2. Record execution and finish with an immediate message response.
        executions.push({ protocol: "a2a", ...result });
        bus.publish(AgentEvent.message(Message.fromJSON({ messageId: randomUUID(), contextId: context.contextId,
          role: "ROLE_AGENT", parts: [{ data: result, mediaType: "application/json" }],
        })));
        bus.finished();
      },
      /** Reject cancellation because the example does not create long-running tasks. */
      async cancelTask() {
        throw new Error("This example has no cancellable tasks.");
      },
    };
    const handler = new DefaultRequestHandler(agentCard(), new InMemoryTaskStore(), executor);
    return new JsonRpcTransportHandler(handler).handle(request.body, new ServerCallContext({ requestedVersion: "1.0" }));
  });

  // 3. Open an allocated loopback port and clean up if startup fails.
  try {
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    return { app, url: baseUrl, executions };
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(" ") !== "--stdio") {
    throw new Error("Run the local MCP target with --stdio. Use npm run demo for the complete example.");
  }
  await createEchoMcp().connect(new StdioServerTransport());
}
