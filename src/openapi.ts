import { z } from "zod";
import {
  searchFields, searchResultSchema, searchSchema, targetDefinitionSchema, targetIdSchema, targetSchema,
} from "./targets/schema.js";
import { importOptionsSchema, importResultSchema, snapshotSchema } from "./registry/schema.js";
import { discoveryCommandSchema } from "./a2a-discovery.js";

type JsonObject = Record<string, unknown>;

/** Rewrite Zod references so they resolve within OpenAPI components. */
function component(name: string, schema: z.ZodType, io: "input" | "output" = "input"): JsonObject {
  // 1. Generate JSON Schema 2020-12 from runtime schemas.
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", io }))) as JsonObject;
  delete json.$schema;

  // 2. Rewrite recursive JSON references relative to the entire document.
  const text = JSON.stringify(json, (key, value: unknown) => {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#")) {
      return "#/components/schemas/" + name + value.slice(1);
    }

    return value;
  });

  return JSON.parse(text) as JsonObject;
}

/** Build a reference to a shared JSON error response. */
function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

/** Build OpenAPI 3.1 from the actual registry and search schemas. */
export function createOpenApiDocument(authEnabled: boolean) {
  // 1. Create request, response, and error components and search parameters.
  const errorSchema = z.strictObject({
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      issues: z.array(z.strictObject({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      })).optional(),
    }),
  });
  const query = component("Search", searchSchema);
  const queryProperties = query.properties as Record<string, JsonObject>;
  const parameters = Object.keys(searchFields).map((name) => ({
    name, in: "query", required: false, schema: queryProperties[name],
  }));
  const idParameter = {
    name: "id", in: "path", required: true, schema: z.toJSONSchema(targetIdSchema),
  };
  const ifMatchParameter = {
    name: "If-Match", in: "header", required: false,
    description: "A previously retrieved strong ETag. Returns 412 if the version changed or the target was deleted. * checks existence only.",
    schema: { type: "string", maxLength: 4096 },
  };
  const importQuery = component("RegistryImport", importOptionsSchema).properties as Record<string, JsonObject>;
  const importParameters = Object.entries(importQuery).map(([name, schema]) => ({
    name, in: "query", required: false, schema,
  }));
  const targetResponse = {
    description: "Target with connection details and creation/update timestamps",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Target" } } },
    headers: {
      ETag: { description: "Strong target version for conditional updates and deletion", schema: { type: "string" } },
    },
  };
  const requestBody = {
    required: true,
    content: { "application/json": { schema: { $ref: "#/components/schemas/TargetDefinition" } } },
  };
  const commonErrors = {
    "400": errorResponse("Invalid input"),
    "401": errorResponse("Hub token authentication failed"),
    "403": errorResponse("Administrator permission required"),
    "413": errorResponse("Request body exceeds the size limit"),
    "500": errorResponse("Server error"),
  };

  // 2. Describe API behavior, public health checks, and authentication requirements.
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "AgentTCDH",
      version: "0.1.0",
      description: "Register and discover MCP servers and A2A agents and retrieve direct connection details",
      license: { name: "Apache-2.0" },
    },
    security: authEnabled ? [{ hubBearer: [] }] : [],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth", summary: "Check server health", security: [], "x-required-role": "public",
          responses: {
            "200": {
              description: "Server is responding",
              content: { "application/json": { schema: {
                type: "object", required: ["status"], additionalProperties: false,
                properties: { status: { const: "ok" } },
              } } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi", summary: "Get the OpenAPI specification", "x-required-role": "read",
          responses: { "200": { description: "OpenAPI 3.1 JSON document" }, "401": commonErrors["401"] },
        },
      },
      "/api/registry/export": {
        get: {
          operationId: "exportRegistry", summary: "Export all registered definitions, including disabled targets", "x-required-role": "admin",
          responses: {
            "200": {
              description: "Snapshot with version, export timestamp, and target definitions",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RegistrySnapshot" } } },
            },
            ...commonErrors,
          },
        },
      },
      "/api/registry/import": {
        post: {
          operationId: "importRegistry", summary: "Import registered definitions in bulk", parameters: importParameters, "x-required-role": "admin",
          description: "Merge into the registry. Roll back all changes on failure; dryRun reports counts without writing.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RegistrySnapshot" } } },
          },
          responses: {
            "200": {
              description: "Expected or applied insert, replace, and skip counts",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RegistryImportResult" } } },
            },
            "409": errorResponse("Target id conflicts with an existing registration"),
            ...commonErrors,
          },
        },
      },
      "/api/targets": {
        post: {
          operationId: "createTarget", summary: "Register a target", requestBody, "x-required-role": "admin",
          responses: { "201": targetResponse, "409": errorResponse("Duplicate target id"), ...commonErrors },
        },
        get: {
          operationId: "searchTargets", summary: "Search, filter, and paginate targets", parameters, "x-required-role": "read",
          responses: {
            "200": {
              description: "Filtered total count and current result page",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResult" } } },
            },
            ...commonErrors,
          },
        },
      },
      "/api/targets/{id}": {
        get: {
          operationId: "getTarget", summary: "Get a target", parameters: [idParameter], "x-required-role": "read",
          responses: { "200": targetResponse, "404": errorResponse("Target not found"), ...commonErrors },
        },
        put: {
          operationId: "updateTarget", summary: "Replace a complete target definition", parameters: [idParameter, ifMatchParameter], requestBody, "x-required-role": "admin",
          responses: {
            "200": targetResponse, "404": errorResponse("Target not found"),
            "412": errorResponse("Target version changed or target deleted"), ...commonErrors,
          },
        },
        delete: {
          operationId: "deleteTarget", summary: "Delete a target", parameters: [idParameter, ifMatchParameter], "x-required-role": "admin",
          responses: {
            "204": { description: "Target deleted" }, "404": errorResponse("Target not found"),
            "412": errorResponse("Target version changed or target deleted"), ...commonErrors,
          },
        },
      },
      "/.well-known/agent-card.json": {
        get: {
          operationId: "getHubAgentCard", summary: "Hub A2A Agent Card", security: [], "x-required-role": "public",
          description: "Publish hub discovery capabilities without target lists or token values. A2A-Version 1.0 returns a native card; omitted, 0.3, or 0.3.0 returns a 0.3 card.",
          parameters: [{ name: "A2A-Version", in: "header", schema: { type: "string", enum: ["1.0", "0.3", "0.3.0"] } }],
          responses: { "200": { description: "Agent Card for the requested version" }, "400": { description: "Unsupported version" }, "403": { description: "Origin not allowed" } },
        },
      },
      "/a2a": {
        post: {
          operationId: "discoverWithA2a", summary: "Search and retrieve targets using A2A messages", "x-required-role": "read",
          description: "Immediate message responses over JSONRPC. Supports SendMessage in 1.0 and message/send in 0.3. "
            + "A text part contains search keywords; a data part contains a DiscoveryCommand. Streaming, push notifications, and stored tasks are not supported.",
          parameters: [{ name: "A2A-Version", in: "header", schema: { type: "string", enum: ["1.0", "0.3", "0.3.0"], default: "0.3" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { description: "A2A message or JSON-RPC error. Data contains SearchResult, Target, or an application error." },
            "400": { description: "Invalid JSON-RPC request or unsupported version" },
            "401": commonErrors["401"], "403": { description: "Origin not allowed" },
            "413": commonErrors["413"], "415": { description: "Unsupported Content-Type" },
            "500": { description: "A2A processing failed" },
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "discoverWithMcp", summary: "Streamable HTTP MCP discovery tools", "x-required-role": "read",
          description: "Stateless MCP request/response with search_targets and get_target.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { description: "MCP JSON-RPC response" },
            "202": { description: "MCP notification accepted" },
            "400": { description: "Invalid MCP request" },
            "401": commonErrors["401"],
            "403": { description: "Origin not allowed" },
            "406": { description: "Unsupported Accept header" },
            "413": commonErrors["413"],
            "415": { description: "Unsupported Content-Type" },
            "500": { description: "MCP processing failed" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        hubBearer: {
          type: "http", scheme: "bearer",
          description: "Administrator tokens allow all APIs. Read tokens allow search, target lookup, specifications, MCP, and A2A discovery.",
        },
      },
      schemas: {
        TargetDefinition: component("TargetDefinition", targetDefinitionSchema),
        Target: component("Target", targetSchema, "output"),
        SearchResult: component("SearchResult", searchResultSchema, "output"),
        Error: component("Error", errorSchema, "output"),
        RegistrySnapshot: component("RegistrySnapshot", snapshotSchema),
        RegistryImportResult: component("RegistryImportResult", importResultSchema, "output"),
        DiscoveryCommand: component("DiscoveryCommand", discoveryCommandSchema),
      },
    },
  };
}
