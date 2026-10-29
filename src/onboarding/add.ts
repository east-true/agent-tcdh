import { createHash } from "node:crypto";
import { basename } from "node:path";
import { inspectRemote, remoteImportSchema } from "../remote-import.js";
import { httpUrl, targetDefinitionSchema } from "../targets/schema.js";
import type { TargetDefinition } from "../targets/schema.js";
import { envNameSchema } from "./config.js";

/** Generate a stable identifier from a connection without relying on remote display names. */
function identifier(label: string, connection: string): string {
  const prefix = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 100) || "target";
  return prefix + "-" + createHash("sha256").update(connection).digest("hex").slice(0, 8);
}

export interface QuickAddOptions {
  url?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  envVars?: string[] | undefined;
  id?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  protocol?: string | undefined;
  transport?: string | undefined;
  bearerEnv?: string | undefined;
  tag?: string | undefined;
  a2aBinding?: string | undefined;
  a2aVersion?: string | undefined;
}

/** Build a stdio registration without launching its command, or inspect explicitly selected remote metadata. */
export async function quickDefinition(options: QuickAddOptions, environment = process.env): Promise<TargetDefinition> {
  // 1. Keep local command registration separate from network inspection.
  if (options.command !== undefined) {
    if (options.url || options.protocol && options.protocol !== "mcp" || options.transport || options.bearerEnv
      || options.a2aBinding || options.a2aVersion) {
      throw new Error("A local command requires MCP stdio options, without a URL, remote transport, or remote authentication.");
    }
    const command = options.command.trim();
    const args = options.args ?? [];
    const name = options.name ?? basename(command);
    return targetDefinitionSchema.parse({
      id: options.id ?? identifier(name, JSON.stringify([command, args])), name,
      description: options.description ?? name + " local MCP server", protocol: "mcp", tags: options.tag ? [options.tag] : [],
      connection: { transport: "stdio", command, args, envVars: options.envVars ?? [] },
    });
  }
  if (options.args || options.envVars) {
    throw new Error("--arg and --env-var require --command.");
  }
  const url = new URL(httpUrl.parse(options.url));
  const id = options.id ?? identifier(url.hostname + url.pathname, url.href);
  const common = { id, url: url.href, name: options.name, description: options.description,
    tags: options.tag ? [options.tag] : [], bearerEnv: options.bearerEnv,
    a2aBinding: options.a2aBinding, a2aVersion: options.a2aVersion, transport: options.transport };
  const protocol = options.protocol ?? "auto";
  if (protocol === "a2a" && options.transport) {
    throw new Error("--transport is only available for MCP imports.");
  }
  if (protocol !== "auto") {
    return inspectRemote(remoteImportSchema.parse({ ...common, protocol }), environment);
  }

  // 2. Validate credential references before bounded metadata probes; never execute a target.
  if (options.transport || options.a2aBinding || options.a2aVersion) {
    throw new Error("Choose --protocol mcp or a2a when selecting a transport, binding, or protocol version.");
  }
  if (options.bearerEnv) {
    envNameSchema.parse(options.bearerEnv);
    if (!environment[options.bearerEnv]) {
      throw new Error("Required environment variable is missing: " + options.bearerEnv);
    }
  }
  const deadline = Date.now() + 15_000;
  /** Probe a selected Agent Card URL, then the standard same-origin discovery location if necessary. */
  async function a2a() {
    try {
      return await inspectRemote(remoteImportSchema.parse({ ...common, protocol: "a2a" }), environment, 7500);
    } catch {
      const card = new URL("/.well-known/agent-card.json", url).href;
      if (url.pathname === "/" || url.href === card) {
        throw new Error("No supported Agent Card at the selected URL.");
      }
      return inspectRemote(remoteImportSchema.parse({ ...common, url: card, protocol: "a2a" }), environment, Math.max(1, deadline - Date.now()));
    }
  }
  const observed = await Promise.allSettled([
    inspectRemote(remoteImportSchema.parse({ ...common, protocol: "mcp" }), environment, 10_000), a2a(),
  ]);
  const targets = observed.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (targets.length === 0) {
    throw new Error("Unable to identify MCP or A2A metadata. Check the URL and credentials, or specify --protocol and --transport explicitly.");
  }
  if (targets.length > 1) {
    throw new Error("Both MCP and A2A metadata are available. Select --protocol mcp or --protocol a2a explicitly.");
  }
  return targets[0]!;
}
