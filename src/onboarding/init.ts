import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { configPath, localConfigSchema, normalizeHub } from "./config.js";
import { readConfigText, writeConfigText } from "./files.js";

export interface InitOptions {
  config?: string | undefined;
  remote?: boolean | undefined;
  hub?: string | undefined;
  host?: string | undefined;
  port?: string | undefined;
  db?: string | undefined;
  tokenEnv?: string | undefined;
  readTokenEnv?: string | undefined;
  yes?: boolean | undefined;
  force?: boolean | undefined;
}

/** Collect setup defaults without reading secret values, then write a validated private configuration. */
export async function initialize(options: InitOptions) {
  // 1. Reject accidental replacement and non-interactive prompting before asking any questions.
  const path = configPath(options.config);
  const previous = await readConfigText(path);
  if (previous !== undefined && !options.force) {
    throw new Error("Configuration already exists. Use --force to replace it with a backup, or choose another --config path.");
  }
  if (!options.yes && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new Error("Interactive setup requires a terminal. Use init --yes with explicit options for automation.");
  }
  const prompt = options.yes ? undefined : createInterface({ input: process.stdin, output: process.stderr });
  /** Ask for an optional setting while keeping the supplied default visible. */
  async function ask(label: string, initial: string): Promise<string> {
    return prompt ? (await prompt.question(label + (initial ? " [" + initial + "]" : " (optional)") + ": ")).trim() || initial : initial;
  }
  let config;
  try {
    const mode = options.remote ? "remote" : await ask("Setup mode: local or remote", "local");
    if (mode !== "local" && mode !== "remote") {
      throw new Error("Choose local or remote setup mode.");
    }
    if (mode === "remote" && (options.host || options.port || options.db)) {
      throw new Error("Remote setup uses an existing hub. Omit local --host, --port, and --db settings.");
    }
    const host = mode === "remote" ? "127.0.0.1" : options.host ?? await ask("Local listen host", process.env.HOST || "127.0.0.1");
    const port = mode === "remote" ? "3000" : options.port ?? await ask("Local listen port", process.env.PORT || "3000");
    const clientHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
    const defaultHub = "http://" + (clientHost.includes(":") ? "[" + clientHost + "]" : clientHost) + ":" + port;
    if (mode === "remote" && options.yes && !options.hub && !process.env.AGENT_TCDH_URL) {
      throw new Error("Remote setup requires --hub URL or AGENT_TCDH_URL.");
    }
    const hub = options.hub ?? await ask("Hub URL used by consumers", process.env.AGENT_TCDH_URL || (mode === "local" ? defaultHub : ""));
    const db = mode === "remote" ? join(homedir(), ".agent-tcdh", "registry.sqlite")
      : options.db ?? await ask("SQLite database path", process.env.AGENT_TCDH_DB_PATH || join(homedir(), ".agent-tcdh", "registry.sqlite"));
    const tokenEnv = options.tokenEnv ?? await ask("Administrator token environment variable", process.env.AGENT_TCDH_TOKEN ? "AGENT_TCDH_TOKEN" : "");
    const readTokenEnv = options.readTokenEnv ?? (tokenEnv || mode === "remote" ? await ask("Read token environment variable", process.env.AGENT_TCDH_READ_TOKEN ? "AGENT_TCDH_READ_TOKEN" : "") : "");
    config = localConfigSchema.parse({
      formatVersion: 1, mode, hub: normalizeHub(hub), server: { host, port: Number(port), dbPath: resolve(dirname(path), db) },
      ...(tokenEnv ? { tokenEnv } : {}), ...(readTokenEnv ? { readTokenEnv } : {}),
    });
  } finally {
    prompt?.close();
  }

  // 2. Publish the configuration and report the exact next commands without starting background processes.
  const written = await writeConfigText(path, JSON.stringify(config, null, 2) + "\n", previous);
  return { ...written, mode: config.mode, hub: config.hub, server: config.server,
    credentialEnvironmentVariables: [config.tokenEnv, config.readTokenEnv].filter(Boolean),
    nextCommands: [...(config.mode === "local" ? [["agent-tcdh", "serve", "--config", path]] : []),
      ["agent-tcdh", "doctor", "--config", path], ["agent-tcdh", "connect", "codex", "--config", path]],
  };
}
