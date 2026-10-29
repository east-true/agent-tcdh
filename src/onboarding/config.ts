import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readConfigText } from "./files.js";

export const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment variable name, not a token value.");

/** Normalize a hub base URL without accepting embedded credentials, queries, or fragments. */
export function normalizeHub(value: string): string {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hub URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Hub URLs must use HTTP(S) without credentials, queries, or fragments.");
  }
  return url.href.replace(/\/+$/u, "");
}

export const localConfigSchema = z.strictObject({
  formatVersion: z.literal(1),
  mode: z.enum(["local", "remote"]).default("local"),
  hub: z.string().transform(normalizeHub),
  server: z.strictObject({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    dbPath: z.string().trim().min(1),
  }),
  tokenEnv: envNameSchema.optional(),
  readTokenEnv: envNameSchema.optional(),
}).superRefine((value, context) => {
  if (value.readTokenEnv && (value.readTokenEnv === value.tokenEnv || value.mode === "local" && !value.tokenEnv)) {
    context.addIssue({ code: "custom", path: ["readTokenEnv"], message: "Read credentials require a distinct administrator environment variable." });
  }
});
export type LocalConfig = z.infer<typeof localConfigSchema>;

/** Resolve an explicit or default setup path without changing the user's home variables. */
export function configPath(explicit?: string, environment = process.env): string {
  return resolve(explicit ?? environment.AGENT_TCDH_CONFIG ?? join(homedir(), ".agent-tcdh", "config.json"));
}

/** Load optional defaults while rejecting missing explicit files and malformed configuration. */
export async function loadConfig(explicit?: string, environment = process.env): Promise<LocalConfig | undefined> {
  const path = configPath(explicit, environment);
  const text = await readConfigText(path);
  if (text === undefined) {
    if (explicit !== undefined || environment.AGENT_TCDH_CONFIG !== undefined) {
      throw new Error("Configuration file was not found. Run agent-tcdh init --config with this path first.");
    }
    return undefined;
  }
  let config;
  try {
    config = localConfigSchema.parse(JSON.parse(text.replace(/^\uFEFF/u, "")));
  } catch {
    throw new Error("Invalid AgentTCDH configuration. Check formatVersion, hub, server, and credential environment names.");
  }
  return { ...config, server: { ...config.server, dbPath: resolve(dirname(path), config.server.dbPath) } };
}

/** Prefer consumer read credentials when generating agent settings or checking discovery. */
export function consumerTokenEnv(config?: LocalConfig, environment = process.env): string | undefined {
  return config?.readTokenEnv ?? (environment.AGENT_TCDH_READ_TOKEN ? "AGENT_TCDH_READ_TOKEN" : undefined)
    ?? config?.tokenEnv ?? (environment.AGENT_TCDH_TOKEN ? "AGENT_TCDH_TOKEN" : undefined);
}
