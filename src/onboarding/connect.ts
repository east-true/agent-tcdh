import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { envNameSchema, normalizeHub } from "./config.js";
import { readConfigText, writeConfigText } from "./files.js";

export const connectionClientSchema = z.enum(["codex", "opencode", "opencode-v1"]);
export type ConnectionClient = z.infer<typeof connectionClientSchema>;

/** Require an object-shaped configuration container before merging a named server. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("The existing configuration container must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Compare configuration values without treating parser-created null prototypes as a semantic change. */
function sameValue(left: unknown, right: unknown): boolean {
  /** Normalize tables recursively while preserving arrays, dates, and integer values. */
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  }
  return isDeepStrictEqual(normalize(left), normalize(right));
}

/** Parse TOML with a fixed diagnostic that never echoes existing secrets. */
function toml(text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch {
    throw new Error("Invalid TOML configuration. Fix it before adding the hub.");
  }
}

/** Generate or merge a single hub entry while keeping unrelated settings intact. */
export function mergeConnection(
  client: ConnectionClient, hub: string, tokenEnv?: string, existing = "", replace = false, name = "agent_tcdh",
): { content: string; notes: string[] } {
  // 1. Validate generated values and select the documented client-specific server format.
  connectionClientSchema.parse(client);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(name)) {
    throw new Error("Connection names must start with a letter and contain only letters, digits, underscores, or hyphens.");
  }
  if (tokenEnv !== undefined) {
    envNameSchema.parse(tokenEnv);
  }
  const url = normalizeHub(hub) + "/mcp";
  const entry = client === "codex"
    ? { url, ...(tokenEnv ? { bearer_token_env_var: tokenEnv } : {}) }
    : { type: "remote", url, oauth: false, ...(tokenEnv ? { headers: { Authorization: "Bearer {env:" + tokenEnv + "}" } } : {}) };

  // 2. Preserve TOML text when appending; require explicit replacement before normalization or a collision.
  if (client === "codex") {
    const root = toml(existing);
    const servers = root.mcp_servers === undefined ? {} : object(root.mcp_servers);
    const previous = servers[name];
    if (previous !== undefined && sameValue(previous, entry)) {
      return { content: existing, notes: [] };
    }
    if (previous !== undefined && !replace) {
      throw new Error("This hub entry already exists with different settings. Use --replace to update only the named server.");
    }
    root.mcp_servers = { ...servers, [name]: entry };
    const start = "# AgentTCDH begin " + name;
    const end = "# AgentTCDH end " + name;
    const fragment = start + "\n[mcp_servers." + JSON.stringify(name) + "]\n"
      + stringifyToml(entry).trimEnd() + "\n" + end;
    let candidate: string | undefined;
    const startAt = existing.indexOf(start + "\n");
    const endAt = existing.indexOf(end, startAt);
    if (previous !== undefined && replace && startAt >= 0 && endAt > startAt) {
      candidate = existing.slice(0, startAt) + fragment + existing.slice(endAt + end.length);
    } else if (previous === undefined) {
      candidate = (existing.trimEnd() ? existing.trimEnd() + "\n\n" : "") + fragment + "\n";
    }
    if (candidate !== undefined) {
      try {
        if (sameValue(parseToml(candidate), root)) {
          return { content: candidate, notes: [] };
        }
      } catch {
        // Inline TOML tables cannot be extended with an appended table declaration.
      }
    }
    if (!replace) {
      throw new Error("This TOML layout requires normalization. Use --replace after previewing; writing keeps an exact backup.");
    }
    return { content: stringifyToml(root), notes: ["TOML formatting and comments are normalized; the original file is preserved in the backup."] };
  }

  // 3. Edit JSONC at the exact server path, preserving comments and neighboring settings.
  const errors: ParseError[] = [];
  const text = existing.trim() ? existing : "{}\n";
  const root = object(parseJsonc(text, errors, { allowTrailingComma: true }));
  if (errors.length > 0) {
    throw new Error("Invalid JSON/JSONC configuration. Fix it before adding the hub.");
  }
  const mcp = root.mcp === undefined ? {} : object(root.mcp);
  if (client === "opencode" && Object.entries(mcp).some(([key, value]) => key !== "servers"
    && value && typeof value === "object" && "type" in value)) {
    throw new Error("This file uses OpenCode v1 server layout. Select opencode-v1 or migrate it first.");
  }
  if (client === "opencode-v1" && mcp.servers !== undefined && !["remote", "local"].includes(String(object(mcp.servers).type))) {
    throw new Error("This file uses OpenCode v2 server layout. Select opencode.");
  }
  const servers = client === "opencode" ? (mcp.servers === undefined ? {} : object(mcp.servers)) : mcp;
  if (servers[name] !== undefined && sameValue(servers[name], entry)) {
    return { content: text, notes: [] };
  }
  if (servers[name] !== undefined && !replace) {
    throw new Error("This hub entry already exists with different settings. Use --replace to update only the named server.");
  }
  const path = client === "opencode" ? ["mcp", "servers", name] : ["mcp", name];
  const content = applyEdits(text, modify(text, path, entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
  const validation: ParseError[] = [];
  const actual = parseJsonc(content, validation, { allowTrailingComma: true });
  const expected = { ...root, mcp: client === "opencode" ? { ...mcp, servers: { ...servers, [name]: entry } } : { ...mcp, [name]: entry } };
  if (validation.length || !sameValue(actual, expected)) {
    throw new Error("Unable to merge this JSONC layout. Use the generated fragment instead.");
  }
  return { content: content.endsWith("\n") ? content : content + "\n", notes: [] };
}

/** Preview a hub configuration or explicitly merge it into a chosen file with a backup. */
export async function connectClient(options: {
  client: string; hub: string; tokenEnv?: string | undefined; write?: string | undefined;
  replace?: boolean | undefined; name?: string | undefined; dryRun?: boolean | undefined;
}) {
  const client = connectionClientSchema.parse(options.client);
  const existing = options.write ? await readConfigText(options.write) : undefined;
  const merged = mergeConnection(client, options.hub, options.tokenEnv, existing, options.replace, options.name);
  const result = options.write && !options.dryRun ? await writeConfigText(options.write, merged.content, existing)
    : { changed: merged.content !== existing, ...(options.write ? { path: options.write } : {}) };
  return { client, hub: normalizeHub(options.hub), ...result, dryRun: Boolean(options.dryRun),
    ...(!options.write || options.dryRun ? { content: mergeConnection(client, options.hub, options.tokenEnv, undefined, false, options.name).content } : {}), notes: merged.notes,
    requiredEnvironmentVariables: options.tokenEnv ? [options.tokenEnv] : [],
    instructions: "Use AgentTCDH search_targets to find capabilities, then get_target to retrieve current connection details. "
      + "Connect directly to the selected MCP server or A2A agent using this client's protocol support, target credentials, and execution permissions. "
      + "The hub supplies metadata; native dynamic tool mounting depends on the client. Restart or reload the client after applying its configuration.",
  };
}
