import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { HubClient } from "../client.js";
import { readClientToken } from "../auth.js";
import { searchSchema, targetIdSchema } from "../targets/schema.js";
import { checkTarget, type TargetCheckReport } from "../targets/check.js";
import { normalizeHub } from "./config.js";

interface Check {
  id: string;
  status: "passed" | "warning" | "failed" | "skipped";
  message: string;
  action?: string;
}

/** Check whether a consumer-side executable exists without spawning it or evaluating a shell command. */
export async function executableAvailable(command: string, environment = process.env): Promise<boolean> {
  const paths = isAbsolute(command) || /[\\/]/u.test(command) ? [command]
    : (environment.PATH ?? environment.Path ?? "").split(delimiter).filter(Boolean).map((path) => join(path, command));
  const suffixes = process.platform === "win32" ? ["", ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const path of paths) {
    for (const suffix of suffixes) {
      try {
        const candidate = path + suffix;
        if ((await stat(candidate)).isFile()) {
          await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
          return true;
        }
      } catch {
        // A missing candidate is normal while checking the remaining PATH entries.
      }
    }
  }
  return false;
}

/** Read a bounded health response without following redirects or printing remote diagnostic bodies. */
async function health(hub: string): Promise<void> {
  const response = await fetch(hub + "/health", { redirect: "manual", signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Health endpoint unavailable.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1_048_576) {
        await response.body.cancel().catch(() => undefined);
        throw new Error("Health response exceeded the byte limit.");
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  if (JSON.parse(Buffer.concat(chunks).toString("utf8")).status !== "ok") {
    throw new Error("Unexpected health response.");
  }
}

/** Diagnose local prerequisites and hub discovery, inspecting one target only when explicitly requested. */
export async function diagnose(options: {
  hub: string; tokenEnv?: string | undefined; target?: string | undefined;
}, environment = process.env) {
  // 1. Check the local runtime and selected credential reference without exposing its value.
  const hub = normalizeHub(options.hub);
  const checks: Check[] = [{ id: "node", status: Number(process.versions.node.split(".")[0]) >= 24 ? "passed" : "failed",
    message: "Node.js " + process.versions.node, action: "Use Node.js 24 or newer." }];
  let token: string | undefined;
  let credentialsReady = true;
  try {
    token = readClientToken(options.tokenEnv, options.tokenEnv !== undefined, environment);
    checks.push({ id: "credentials", status: "passed", message: options.tokenEnv
      ? "Selected environment variable is available: " + options.tokenEnv : "No explicit hub credential selected." });
  } catch {
    credentialsReady = false;
    checks.push({ id: "credentials", status: "failed", message: "Selected hub credential is missing or invalid.",
      action: "Set the selected token environment variable in this terminal, or correct --token-env/configuration." });
  }

  // 2. Separate public liveness from authenticated access to discovery.
  try {
    await health(hub);
    checks.push({ id: "hub", status: "passed", message: "Hub health endpoint responded." });
  } catch {
    checks.push({ id: "hub", status: "failed", message: "Hub health could not be confirmed.",
      action: "Run agent-tcdh serve, or check --hub, listener address, and network access." });
  }
  const client = new HubClient(hub, token);
  let readable = false;
  if (credentialsReady) {
    try {
      await client.search(searchSchema.parse({ limit: 1 }));
      readable = true;
      checks.push({ id: "discovery", status: "passed", message: "Registry discovery is accessible with the selected credentials." });
    } catch (error) {
      const unauthorized = error instanceof Error && /HTTP 40[13] /u.test(error.message);
      checks.push({ id: "discovery", status: "failed", message: unauthorized ? "Hub rejected discovery credentials." : "Registry discovery is unavailable.",
        action: unauthorized ? "Use the hub's read token or administrator token; check --token-env." : "Check the hub URL and server availability." });
    }
  } else {
    checks.push({ id: "discovery", status: "skipped", message: "Discovery was not attempted with an invalid explicit credential." });
  }

  // 3. Inspect the selected target in the consumer environment while keeping metadata and execution distinct.
  let target: TargetCheckReport | undefined;
  if (options.target && readable) {
    try {
      const definition = await client.get(targetIdSchema.parse(options.target));
      const required = [...new Set([...(definition.connection.transport !== "stdio" ? definition.connection.auth?.envVars ?? [] : []),
        ...(definition.connection.transport === "stdio" ? definition.connection.envVars : [])])];
      for (const variable of required) {
        checks.push({ id: "target-env:" + variable, status: environment[variable] ? "passed" : "failed",
          message: environment[variable] ? "Target credential reference is available: " + variable : "Target environment variable is missing: " + variable,
          action: "Set this variable in the consuming agent's environment." });
      }
      if (definition.connection.transport === "stdio") {
        const available = await executableAvailable(definition.connection.command, environment);
        checks.push({ id: "target-command", status: available ? "passed" : "failed",
          message: available ? "The stdio executable is present; it was not launched." : "The stdio executable was not found or is not executable.",
          action: "Install the command or correct its path in the consuming environment." });
      }
      target = await checkTarget(definition, {}, environment);
      checks.push({ id: "target-metadata", status: target.status, message: target.scope === "none"
        ? "Stdio metadata and execution are not checked." : "Remote metadata inspection: " + target.status,
        ...(target.status === "passed" ? {} : { action: target.scope === "none"
          ? "Use the consuming agent MCP client to verify this stdio server."
          : "Review target check output; use target refresh --dry-run to preview metadata changes." }) });
    } catch {
      checks.push({ id: "target", status: "failed", message: "The selected target could not be inspected.",
        action: "Check the target id with target list and confirm discovery permissions." });
    }
  } else if (options.target) {
    checks.push({ id: "target", status: "skipped", message: "Target inspection requires working hub discovery." });
  }
  const status = checks.some((check) => check.status === "failed") ? "failed"
    : checks.some((check) => check.status === "warning") ? "warning" : "passed";
  return { status, hub, checks, executionVerified: false, ...(target ? { target } : {}) };
}
