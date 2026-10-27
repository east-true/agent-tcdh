import { z, ZodError } from "zod";
import { inspectRemote, remoteImportSchema } from "../remote-import.js";
import { targetSchema } from "./schema.js";
import type { Target } from "./schema.js";

export const targetCheckOptionsSchema = z.strictObject({
  bearerEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
});
type CheckOptions = z.infer<typeof targetCheckOptionsSchema>;

export interface TargetCheckReport {
  id: string;
  protocol: Target["protocol"];
  transport: Target["connection"]["transport"];
  status: "passed" | "warning" | "failed" | "skipped";
  scope: "mcp-tools-list" | "a2a-agent-card" | "none";
  checkedAt: string;
  durationMs: number;
  executionVerified: false;
  capabilities?: {
    registered: number;
    observed: number;
    added: string[];
    removed: string[];
    changed: string[];
  };
  connection?: { registeredUrl: string; selectedUrl: string; matches: boolean };
  issues: { code: string; message: string }[];
}

/** Compare registered capabilities while ignoring JSON object key order. */
function comparableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      return Object.fromEntries(Object.entries(current).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return current;
  });
}

/** Classify failures and redact credentials reflected in remote error messages. */
function diagnostic(error: unknown, token?: string) {
  // 1. Replace metadata validation failures with messages that exclude raw values.
  if (error instanceof ZodError) {
    return { code: "INVALID_METADATA", message: "Remote metadata does not match a supported target format." };
  }

  // 2. Redact credentials, bound the diagnostic text, and distinguish timeouts.
  const raw = error instanceof Error ? error.message : "Unable to retrieve remote metadata.";
  const message = (token ? raw.replaceAll(token, "<redacted>") : raw).slice(0, 2000);
  return { code: /timeout|timed out|aborted/iu.test(message) ? "TIMEOUT" : "METADATA_FETCH_FAILED", message };
}

/** Compare remote metadata in the CLI without executing targets or writing registry state. */
export async function checkTarget(
  input: Target, inputOptions: CheckOptions = {}, environment: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000,
): Promise<TargetCheckReport> {
  // 1. Validate the registered definition and declare the scope of inspection.
  const target = targetSchema.parse(input);
  const options = targetCheckOptionsSchema.parse(inputOptions);
  const started = performance.now();
  const report: TargetCheckReport = {
    id: target.id, protocol: target.protocol, transport: target.connection.transport,
    status: "skipped", scope: "none", checkedAt: new Date().toISOString(), durationMs: 0,
    executionVerified: false, issues: [],
  };
  if (target.connection.transport === "stdio") {
    report.issues.push({ code: "STDIO_NOT_CHECKED", message: "Local stdio commands are not executed. Check them in the consuming agent's environment." });
    return report;
  }
  report.scope = target.protocol === "mcp" ? "mcp-tools-list" : "a2a-agent-card";

  // 2. Use explicit Bearer references without falling back to anonymous unsupported authentication.
  const auth = target.connection.auth;
  let bearerEnv = options.bearerEnv;
  if (!bearerEnv && auth && !["none", "bearer"].includes(auth.type)) {
    report.issues.push({ code: "AUTH_NOT_SUPPORTED", message: "Automatic inspection does not support this authentication type. Use --bearer-env if a Bearer token is already available." });
    return report;
  }
  if (!bearerEnv && auth?.type === "bearer") {
    if (auth.envVars.length !== 1) {
      report.issues.push({ code: "BEARER_ENV_REQUIRED", message: "Select the credential environment variable using --bearer-env." });
      return report;
    }
    bearerEnv = auth.envVars[0];
  }
  const token = bearerEnv ? environment[bearerEnv] : undefined;
  if (bearerEnv && !token) {
    report.status = "failed";
    report.issues.push({ code: "AUTH_ENV_MISSING", message: "Required environment variable is missing: " + bearerEnv });
    return report;
  }
  if (token && !/^[\x21-\x7e]+$/u.test(token)) {
    report.status = "failed";
    report.issues.push({ code: "AUTH_TOKEN_INVALID", message: "Bearer tokens must be ASCII strings without whitespace or control characters." });
    return report;
  }

  // 3. Read MCP tool metadata or the A2A card using the saved binding and version.
  try {
    const observed = await inspectRemote(remoteImportSchema.parse({
      id: target.id, protocol: target.protocol,
      url: target.protocol === "a2a" ? target.connection.agentCardUrl
        ?? new URL("/.well-known/agent-card.json", target.connection.url).href : target.connection.url,
      transport: target.protocol === "mcp" ? target.connection.transport : undefined,
      bearerEnv,
      a2aBinding: target.protocol === "a2a" ? target.connection.protocolBinding : undefined,
      a2aVersion: target.protocol === "a2a" ? target.connection.protocolVersion : undefined,
    }), environment, timeoutMs);
    const stored = new Map(target.capabilities.map((capability) => [capability.name, capability]));
    const remote = new Map(observed.capabilities.map((capability) => [capability.name, capability]));
    const added = [...remote.keys()].filter((name) => !stored.has(name)).sort();
    const removed = [...stored.keys()].filter((name) => !remote.has(name)).sort();
    const changed = [...stored.keys()].filter((name) => remote.has(name)
      && comparableJson(stored.get(name)) !== comparableJson(remote.get(name))).sort();
    report.capabilities = { registered: stored.size, observed: remote.size, added, removed, changed };
    if (added.length || removed.length || changed.length) {
      report.issues.push({ code: "CAPABILITIES_CHANGED", message: "Registered capabilities differ from current metadata. Run target refresh if an update is needed." });
    }

    // 4. Report endpoint differences without claiming that task execution fails.
    if (target.protocol === "a2a" && observed.protocol === "a2a") {
      const matches = new URL(target.connection.url).href === new URL(observed.connection.url).href;
      report.connection = { registeredUrl: target.connection.url, selectedUrl: observed.connection.url, matches };
      if (!matches) {
        report.issues.push({ code: "CARD_ENDPOINT_DIFFERS", message: "The selected card endpoint differs from the registered URL. Multiple interfaces may share a binding and version; this does not prove execution failure." });
      }
    }
    report.status = report.issues.length ? "warning" : "passed";
  } catch (error) {
    report.status = "failed";
    report.issues.push(diagnostic(error, token));
  } finally {
    report.durationMs = Math.max(0, Math.round(performance.now() - started));
  }
  return report;
}
