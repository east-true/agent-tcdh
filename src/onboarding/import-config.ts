import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { targetDefinitionSchema, targetIdSchema } from "../targets/schema.js";
import type { TargetDefinition } from "../targets/schema.js";
import { parseSnapshot, serializeSnapshot, MAX_SNAPSHOT_TARGETS } from "../registry/schema.js";
import type { RegistrySnapshot } from "../registry/schema.js";
import { envNameSchema, normalizeHub } from "./config.js";
import { readConfigText } from "./files.js";

export const sourceFormatSchema = z.enum(["auto", "codex", "opencode", "opencode-v1", "mcp-json"]);
export type SourceFormat = z.infer<typeof sourceFormatSchema>;
export const importPrefixSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u, "Prefixes must use lowercase target-id characters and be at most 32 characters.");

export interface ImportIssue {
  name: string;
  severity: "warning" | "error";
  code: string;
  message: string;
}
export interface ConfigPreparation {
  format: Exclude<SourceFormat, "auto">;
  available: number;
  selected: number;
  converted: number;
  ready: boolean;
  targets: TargetDefinition[];
  requiredEnvironmentVariables: string[];
  issues: ImportIssue[];
  metadataInspected: false;
  executionVerified: false;
}

/** Reject values that are not object-shaped configuration containers. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("Expected an object-shaped configuration container.");
  }
  return value as Record<string, unknown>;
}

/** Build a deterministic import id while preserving valid source names where possible. */
export function importedId(name: string, prefix?: string): string {
  if (prefix !== undefined) {
    importPrefixSchema.parse(prefix);
  }
  const lead = prefix ? prefix + "-" : "";
  const budget = 128 - lead.length;
  if (name.length <= budget && targetIdSchema.safeParse(name).success) {
    return lead + name;
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[._-]+|[-]+$/gu, "") || "target";
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return lead + slug.slice(0, budget - 13) + "-" + hash;
}

/** Return declared credential names without inspecting the process environment. */
export function requiredVariables(targets: TargetDefinition[]): string[] {
  return [...new Set(targets.flatMap((target) => target.connection.transport === "stdio"
    ? target.connection.envVars : target.connection.auth?.envVars ?? []))].sort();
}

/** Wrap prepared definitions in the existing bounded, versioned bulk-import contract. */
export function preparedSnapshot(targets: TargetDefinition[], exportedAt = new Date().toISOString()): RegistrySnapshot {
  const snapshot = parseSnapshot({ format: "agent-tcdh", version: 1, exportedAt, targets });
  serializeSnapshot(snapshot);
  return snapshot;
}

/** Convert a selected source entry into portable connection metadata with explicit unsupported-field diagnostics. */
function convertEntry(name: string, input: unknown, format: ConfigPreparation["format"], prefix: string | undefined, issues: ImportIssue[]) {
  const entry = record(input);
  const id = importedId(name, prefix);
  /** Record a fixed diagnostic without echoing credential values or arbitrary source fields. */
  function issue(code: string, message: string, severity: ImportIssue["severity"] = "error") {
    issues.push({ name, code, message, severity });
  }
  if (entry.cwd !== undefined || entry.experimental_environment === "remote") {
    issue("EXECUTION_CONTEXT_UNSUPPORTED", "Working directories and remote execution placement require an explicit target definition or adapter.");
  }
  if (entry.oauth !== undefined && entry.oauth !== false || entry.auth !== undefined) {
    issue("CLIENT_AUTH_UNSUPPORTED", "Client-managed authentication settings cannot be migrated automatically; configure authentication in the consuming environment.");
  }
  if (entry.http_headers_helper !== undefined || entry.env_http_headers !== undefined && Object.keys(record(entry.env_http_headers)).length > 0) {
    issue("HEADER_MAPPING_UNSUPPORTED", "Dynamic header helpers or raw header environment mappings are not portable Bearer token references.");
  }
  if (entry.enabled_tools !== undefined || entry.disabled_tools !== undefined || entry.tools !== undefined) {
    issue("CLIENT_POLICY_NOT_IMPORTED", "Client tool filters and permissions remain in the originating client; enforce them in each consuming environment.", "warning");
  }
  const disabled = format === "opencode" ? entry.disabled : entry.enabled === undefined ? entry.disabled : !entry.enabled;
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean" || entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
    issue("INVALID_ENABLED_STATE", "Enabled and disabled settings must be booleans.");
  }
  if (format === "opencode" && entry.enabled !== undefined || ["opencode-v1", "codex"].includes(format) && entry.disabled !== undefined
    || entry.enabled !== undefined && entry.disabled !== undefined) {
    issue("ENABLED_STATE_AMBIGUOUS", "Use the selected client's documented enabled/disabled field without mixing layouts.");
  }
  const common = { id, name, description: "Imported MCP connection: " + name, protocol: "mcp", capabilities: [], enabled: !disabled, tags: ["imported-config"] };
  const isOpenCode = format === "opencode" || format === "opencode-v1";
  const local = isOpenCode ? entry.type === "local" : entry.command !== undefined;
  if (isOpenCode && !["local", "remote"].includes(String(entry.type))) {
    issue("TRANSPORT_UNSUPPORTED", "Choose a local or remote OpenCode server entry.");
  }
  if (local) {
    if (entry.url !== undefined || entry.headers !== undefined || entry.http_headers !== undefined || entry.bearer_token_env_var !== undefined) {
      issue("MIXED_CONNECTION_FIELDS", "A stdio command cannot contain remote URL or header settings.");
    }
    if (format === "mcp-json" && entry.type !== undefined && entry.type !== "stdio") {
      issue("TRANSPORT_UNSUPPORTED", "Command entries must use stdio transport.");
    }
    const command = isOpenCode ? z.array(z.string()).min(1).parse(entry.command) : [z.string().parse(entry.command), ...z.array(z.string()).parse(entry.args ?? [])];
    if (isOpenCode && entry.args !== undefined) {
      issue("ARGUMENT_LAYOUT_UNSUPPORTED", "OpenCode stores its executable and arguments together in command.");
    }
    if (command.some((part) => /(?:\{(?:env|file|workspace)|\$\{)/u.test(part))) {
      issue("ARGUMENT_EXPANSION_UNSUPPORTED", "Client-specific argument substitutions require an explicit target definition.");
    }
    if (command.some((part) => /--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)|(?:TOKEN|SECRET|PASSWORD|API_KEY)=/iu.test(part))) {
      issue("CREDENTIAL_ARGUMENT", "Credential-bearing arguments require a manual definition using consumer-side environment references.");
    }
    const variables = new Set<string>();
    for (const [key, value] of Object.entries(record((isOpenCode ? entry.environment : entry.env) ?? {}))) {
      envNameSchema.parse(key);
      const text = z.string().parse(value);
      const reference = isOpenCode ? /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(text) : undefined;
      if (reference) {
        if (reference[1] !== key) {
          issue("ENV_ALIAS_UNSUPPORTED", "Environment aliases require matching variable names or an explicit adapter.");
        }
      } else if (/(?:\{(?:env|file):|\$\{)/u.test(text)) {
        issue("ENV_EXPANSION_UNSUPPORTED", "This environment substitution cannot be represented by a portable variable name.");
      } else {
        issue("INLINE_ENV_OMITTED", "Inline environment values were omitted; supply these variable names in the consuming environment.", "warning");
      }
      variables.add(key);
    }
    for (const variable of z.array(z.unknown()).parse(entry.env_vars ?? [])) {
      if (typeof variable === "string") {
        variables.add(envNameSchema.parse(variable));
      } else {
        const selected = record(variable);
        if (selected.source !== undefined && selected.source !== "local") {
          issue("REMOTE_ENV_UNSUPPORTED", "Remote executor environment references require an adapter.");
        }
        variables.add(envNameSchema.parse(selected.name));
      }
    }
    if (command.length > 1) {
      issue("LITERAL_ARGUMENTS", "Command arguments are copied literally; review them for credentials and consumer-specific paths before applying.", "warning");
    }
    return targetDefinitionSchema.parse({ ...common, connection: { transport: "stdio", command: command[0], args: command.slice(1), envVars: [...variables] } });
  }

  // Remote import never sends a request to the source endpoint or resolves its credentials.
  if (entry.command !== undefined || entry.args !== undefined || entry.env !== undefined || entry.environment !== undefined || entry.env_vars !== undefined) {
    issue("MIXED_CONNECTION_FIELDS", "Remote entries cannot contain stdio process settings.");
  }
  const url = new URL(z.string().parse(entry.url));
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    issue("UNSAFE_URL", "Remote import requires HTTP(S) URLs without embedded credentials, queries, or fragments.");
  }
  let transport: "streamable-http" | "sse" = "streamable-http";
  if (format === "mcp-json" && entry.type === "sse") {
    transport = "sse";
  } else if (format === "mcp-json" && entry.type !== undefined && entry.type !== "http") {
    issue("TRANSPORT_UNSUPPORTED", "Remote JSON entries must use http or sse transport.");
  } else if (format === "mcp-json" && entry.type === undefined) {
    issue("TRANSPORT_ASSUMED", "Remote transport defaults to Streamable HTTP; verify it with target check.", "warning");
  }
  let bearerEnv = entry.bearer_token_env_var === undefined ? undefined : envNameSchema.parse(entry.bearer_token_env_var);
  const headers = record((format === "codex" ? entry.http_headers : entry.headers) ?? {});
  if (format === "codex" && entry.headers !== undefined || format !== "codex" && entry.http_headers !== undefined) {
    issue("HEADER_LAYOUT_UNSUPPORTED", "Header settings do not match the selected configuration format.");
  }
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== "authorization" || bearerEnv !== undefined) {
      issue("HEADER_MAPPING_UNSUPPORTED", "Custom or conflicting headers require an explicit target definition or adapter.");
      continue;
    }
    const value = z.string().parse(raw);
    const reference = isOpenCode ? /^Bearer \{env:([A-Za-z_][A-Za-z0-9_]*)\}$/iu.exec(value) : undefined;
    if (reference) {
      bearerEnv = reference[1];
    } else if (/^Bearer [\x21-\x7e]+$/iu.test(value) && !/(?:\{(?:env|file):|\$\{)/u.test(value)) {
      bearerEnv = "MCP_" + id.toUpperCase().replace(/[^A-Z0-9_]/gu, "_") + "_TOKEN";
      issue("INLINE_BEARER_OMITTED", "The inline Bearer value was omitted; put the raw token in the proposed environment variable.", "warning");
    } else {
      issue("AUTH_HEADER_UNSUPPORTED", "Use an explicit Bearer environment reference or configure authentication manually.");
    }
  }
  if (!bearerEnv) {
    issue("AUTH_NOT_INSPECTED", "Remote authentication was not inspected. The consumer must establish any required credentials.", "warning");
  }
  return targetDefinitionSchema.parse({ ...common, connection: { transport, url: url.href,
    ...(bearerEnv ? { auth: { type: "bearer", envVars: [bearerEnv] } } : {}) } });
}

/** Parse one client configuration, select entries, and produce a reviewable offline import plan. */
export function prepareConfigImport(text: string, options: {
  format?: SourceFormat | undefined; select?: string[] | undefined; prefix?: string | undefined; hub?: string | undefined;
} = {}): ConfigPreparation {
  // 1. Detect a single known root container while keeping parser failures free of source contents.
  if (Buffer.byteLength(text, "utf8") > 1_048_576) {
    throw new Error("Configuration files must not exceed 1 MiB.");
  }
  const requested = sourceFormatSchema.parse(options.format ?? "auto");
  if (options.prefix !== undefined) {
    importPrefixSchema.parse(options.prefix);
  }
  let root;
  let tomlRoot;
  let jsonRoot;
  try {
    tomlRoot = record(parseToml(text.replace(/^\uFEFF/u, "")));
  } catch {
    // JSON/JSONC is attempted independently from TOML.
  }
  const errors: ParseError[] = [];
  try {
    jsonRoot = record(parseJsonc(text.replace(/^\uFEFF/u, ""), errors, { allowTrailingComma: true }));
    if (errors.length) {
      jsonRoot = undefined;
    }
  } catch {
    // Invalid syntax is reported below without echoing secret-bearing lines.
  }
  const formats: ConfigPreparation["format"][] = [];
  if (requested === "auto") {
    if (tomlRoot?.mcp_servers !== undefined) {
      formats.push("codex");
    }
    if (jsonRoot?.mcpServers !== undefined) {
      formats.push("mcp-json");
    }
    if (jsonRoot?.mcp !== undefined) {
      const mcp = record(jsonRoot.mcp);
      const servers = mcp.servers;
      formats.push(servers !== undefined && !["remote", "local"].includes(String(record(servers).type)) ? "opencode" : "opencode-v1");
    }
  }
  if (requested === "auto" && formats.length !== 1) {
    throw new Error("Choose --format codex, opencode, opencode-v1, or mcp-json for an unambiguous valid configuration.");
  }
  const format = requested === "auto" ? formats[0]! : requested;
  root = format === "codex" ? tomlRoot : jsonRoot;
  if (!root) {
    throw new Error("Invalid configuration syntax for the selected format. Source values were not printed.");
  }
  const container = format === "codex" ? root.mcp_servers : format === "mcp-json" ? root.mcpServers
    : format === "opencode" ? record(root.mcp).servers : root.mcp;
  const entries = Object.entries(record(container));
  if (entries.length > MAX_SNAPSHOT_TARGETS) {
    throw new Error("Configurations may contain at most 10000 server entries.");
  }
  const selected = new Set(options.select ?? []);
  if (selected.size !== (options.select ?? []).length || [...selected].some((name) => !Object.hasOwn(record(container), name))) {
    throw new Error("Selections must be unique existing source server names.");
  }

  // 2. Convert only selected entries and retain fixed per-entry diagnostics instead of source values.
  const issues: ImportIssue[] = [];
  const targets: TargetDefinition[] = [];
  const chosen = entries.filter(([name]) => selected.size === 0 || selected.has(name));
  for (const [name, value] of chosen) {
    const before = issues.length;
    try {
      const target = convertEntry(name, value, format, options.prefix, issues);
      if (target.connection.transport !== "stdio" && options.hub
        && target.connection.url.replace(/\/$/u, "") === normalizeHub(options.hub) + "/mcp") {
        issues.push({ name, severity: "warning", code: "HUB_SELF_REFERENCE", message: "The destination hub's own discovery entry was excluded." });
        continue;
      }
      if (!issues.slice(before).some((issue) => issue.severity === "error")) {
        targets.push(target);
      }
    } catch {
      issues.push({ name, severity: "error", code: "INVALID_ENTRY", message: "The selected entry does not match the portable MCP connection format; source values were not printed." });
    }
  }
  preparedSnapshot(targets);
  return { format, available: entries.length, selected: chosen.length, converted: targets.length,
    ready: targets.length > 0 && !issues.some((issue) => issue.severity === "error"), targets,
    requiredEnvironmentVariables: requiredVariables(targets), issues, metadataInspected: false, executionVerified: false };
}

/** Read an explicitly selected file without changing it or consulting personal agent paths. */
export async function inspectConfigFile(path: string, options: Parameters<typeof prepareConfigImport>[1]) {
  const text = await readConfigText(path);
  if (text === undefined) {
    throw new Error("The selected client configuration file does not exist.");
  }
  return prepareConfigImport(text, options);
}
