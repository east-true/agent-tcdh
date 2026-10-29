import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PACKAGE_VERSION } from "./version.js";
import { HubClient } from "./client.js";
import { searchFields, searchSchema, targetIdSchema } from "./targets/schema.js";
import type { SearchOptions, SearchResult, Target } from "./targets/schema.js";

export interface DiscoveryReader {
  search(options: SearchOptions): SearchResult | Promise<SearchResult>;
  get(id: string): Target | Promise<Target>;
}

/** Configure read-only MCP discovery tools that query current registry data on every call. */
export function createDiscoveryServer(client: DiscoveryReader): McpServer {
  // 1. Explain discovery and direct connections to the consuming agent.
  const server = new McpServer(
    { name: "agent-tcdh", version: PACKAGE_VERSION },
    {
      instructions: "Use search_targets to find capabilities and get_target to inspect connection details. "
        + "Connect directly using the returned connection protocol, URL, or executable command. "
        + "This server returns registered metadata and does not execute target tools.",
    },
  );

  // 2. Register search and lookup tools backed by the common HTTP client.
  server.registerTool("search_targets", {
    description: "Search registered MCP servers and A2A agents by capability, description, or tag and return connection details. "
      + "All search terms must match; only enabled targets are returned by default.",
    inputSchema: searchFields,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    return toolResult(async () => client.search(searchSchema.parse(input)));
  });
  server.registerTool("get_target", {
    description: "Get current capabilities and direct connection details for a target id.",
    inputSchema: { id: targetIdSchema.describe("Target id") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ id }) => {
    return toolResult(async () => client.get(id));
  });

  return server;
}

/** Return HTTP failures as tool errors without closing the protocol connection. */
async function toolResult(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Hub query failed" }],
    };
  }
}

/** Serve discovery over stdio and clean up the MCP connection on shutdown. */
export async function runDiscoveryServer(client: HubClient): Promise<void> {
  // 1. Connect the client to the MCP transport.
  const server = createDiscoveryServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 2. Handle stdin completion and process termination signals.
  const close = async () => {
    await server.close();
  };
  process.stdin.once("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
