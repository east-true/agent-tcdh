import { z } from "zod";

const label = z.string().trim().min(1).max(200);
export const httpUrl = z.string().max(4096).refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}, "Enter an HTTP(S) URL without credentials or a fragment.");

export const targetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const protocolSchema = z.enum(["mcp", "a2a"]);
export const a2aBindingSchema = z.enum(["JSONRPC", "HTTP+JSON"]).describe("Protocol binding of the selected A2A HTTP interface");
export const a2aVersionSchema = z.string().max(64).regex(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/)
  .describe("Declared A2A version of the selected interface, such as 1.0 or 0.3.0");
export const capabilitySchema = z.strictObject({
  name: label,
  description: z.string().trim().max(4000).default(""),
  inputSchema: z.record(z.string(), z.json()).optional(),
});

const authSchema = z.strictObject({
  type: z.enum(["none", "bearer", "api-key", "oauth2"]),
  description: z.string().trim().max(2000).optional(),
  envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50).default([]),
});

const stdioConnection = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(100).default([]),
  envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50).default([]),
});

const mcpRemoteConnection = z.strictObject({
  transport: z.enum(["streamable-http", "sse"]),
  url: httpUrl,
  auth: authSchema.optional(),
});

const a2aConnection = z.strictObject({
  transport: z.literal("http"),
  url: httpUrl,
  agentCardUrl: httpUrl.optional(),
  protocolBinding: a2aBindingSchema.optional(),
  protocolVersion: a2aVersionSchema.optional(),
  auth: authSchema.optional(),
});

const commonFields = {
  id: targetIdSchema,
  name: label,
  description: z.string().trim().min(1).max(8000),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  capabilities: z.array(capabilitySchema).max(200).default([]),
  enabled: z.boolean().default(true),
};

const mcpDefinitionSchema = z.strictObject({
  ...commonFields,
  protocol: z.literal("mcp"),
  connection: z.union([stdioConnection, mcpRemoteConnection]),
});
const a2aDefinitionSchema = z.strictObject({
  ...commonFields,
  protocol: z.literal("a2a"),
  connection: a2aConnection,
});

export const targetDefinitionSchema = z.discriminatedUnion("protocol", [
  mcpDefinitionSchema,
  a2aDefinitionSchema,
]).superRefine((target, context) => {
  const names = target.capabilities.map((capability) => capability.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Capability names must be unique within a target.",
    });
  }
});

export const searchFields = {
  q: z.string().trim().max(500).default(""),
  protocol: protocolSchema.optional(),
  tag: z.string().trim().min(1).max(100).optional(),
  includeDisabled: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
};

export const searchSchema = z.strictObject(searchFields);
const timestamps = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const targetSchema = z.discriminatedUnion("protocol", [
  mcpDefinitionSchema.extend(timestamps),
  a2aDefinitionSchema.extend(timestamps),
]);
export const searchResultSchema = z.strictObject({
  items: z.array(targetSchema),
  total: z.number().int().nonnegative(),
  limit: searchFields.limit,
  offset: searchFields.offset,
});
export const searchQuerySchema = z.strictObject({
  ...searchFields,
  includeDisabled: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
}).transform((value) => searchSchema.parse(value));

export type TargetDefinition = z.infer<typeof targetDefinitionSchema>;
export type Target = z.infer<typeof targetSchema>;
export type SearchOptions = z.infer<typeof searchSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
