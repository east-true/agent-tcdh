import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HubClient } from "./client.js";
import { searchSchema, targetDefinitionSchema, targetIdSchema } from "./targets/schema.js";
import { readClientToken } from "./auth.js";
import { a2aSelectionSchema } from "./targets/a2a.js";

const help = `AgentTCDH — Agent & Tool Capability Discovery Hub

Usage:
  agent-tcdh serve [--host HOST] [--port PORT] [--db FILE]
  agent-tcdh target add <JSON_FILE> [--hub URL]
  agent-tcdh target update <ID> <JSON_FILE> [--if-match ETAG] [--hub URL]
  agent-tcdh target import <URL> --id ID --protocol mcp|a2a [--dry-run] [--hub URL]
  agent-tcdh target refresh <ID> [--dry-run] [--hub URL]
  agent-tcdh target check <ID> [--bearer-env VARIABLE] [--hub URL]
  agent-tcdh target get <ID> [--with-version] [--hub URL]
  agent-tcdh target list [--q QUERY] [--protocol mcp|a2a] [--tag TAG]
                       [--limit COUNT] [--offset OFFSET] [--include-disabled] [--hub URL]
  agent-tcdh target remove <ID> [--if-match ETAG] [--hub URL]
  agent-tcdh registry export <JSON_FILE> [--overwrite] [--hub URL]
  agent-tcdh registry import <JSON_FILE> [--on-conflict error|skip|replace] [--dry-run] [--hub URL]
  agent-tcdh mcp [--hub URL]

Environment:
  HOST                  Listener address (default: 127.0.0.1)
  PORT                  Listener port (default: 3000)
  AGENT_TCDH_DB_PATH     SQLite file (default: ~/.agent-tcdh/registry.sqlite)
  AGENT_TCDH_URL         Hub URL for CLI and MCP (default: http://127.0.0.1:3000)
  AGENT_TCDH_TOKEN       Optional administrator Bearer token; default CLI/MCP credential
  AGENT_TCDH_READ_TOKEN  Optional read-only token accepted by the server
  AGENT_TCDH_ALLOWED_ORIGINS  Comma-separated allowed origins for HTTP MCP and A2A
  AGENT_TCDH_PUBLIC_URL  Public base URL advertised in the A2A card behind proxies/containers

Options:
  --help, -h            Show usage
  --name NAME          Override the imported target's display name
  --description TEXT   Override the imported target's description
  --transport TYPE     MCP import transport: streamable-http or sse
  --a2a-binding TYPE   Select JSONRPC or HTTP+JSON
  --a2a-version VERSION  Select a declared A2A protocol version
  --bearer-env VARIABLE  Environment variable containing the remote Bearer token
  --dry-run            Print the proposed import or refresh without writing
  --on-conflict POLICY  Bulk import conflict policy (default: error)
  --overwrite          Allow replacement of an existing export file
  --with-version       Include the target ETag in lookup output
  --if-match ETAG      Require a matching version for updates or deletion
  --token-env VARIABLE  CLI/stdio MCP credential variable (default: AGENT_TCDH_TOKEN)

The default command is serve. Administrative results are printed as JSON.
`;

/** Validate commands and options before dispatching to the server, registry API, or MCP discovery. */
export async function runCli(args: string[]): Promise<void> {
  // 1. Parse shared options and handle help requests.
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      port: { type: "string" },
      db: { type: "string" },
      hub: { type: "string" },
      q: { type: "string" },
      protocol: { type: "string" },
      tag: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      "include-disabled": { type: "boolean" },
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      transport: { type: "string" },
      "bearer-env": { type: "string" },
      "dry-run": { type: "boolean" },
      "on-conflict": { type: "string" },
      overwrite: { type: "boolean" },
      "token-env": { type: "string" },
      "with-version": { type: "boolean" },
      "if-match": { type: "string" },
      "a2a-binding": { type: "string" },
      "a2a-version": { type: "string" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }

  // 2. Apply server settings only to the serve command.
  const command = positionals[0] ?? "serve";
  if (command === "serve") {
    validateArguments(positionals, positionals.length === 0 ? 0 : 1, values, ["host", "port", "db"]);
    const { runServer, serverOptionsSchema } = await import("./server.js");
    await runServer(serverOptionsSchema.parse({
      host: values.host ?? process.env.HOST ?? "127.0.0.1",
      port: values.port ?? process.env.PORT ?? "3000",
      dbPath: values.db ?? process.env.AGENT_TCDH_DB_PATH,
      token: process.env.AGENT_TCDH_TOKEN || undefined,
      readToken: process.env.AGENT_TCDH_READ_TOKEN || undefined,
      publicUrl: process.env.AGENT_TCDH_PUBLIC_URL || undefined,
      allowedOrigins: (process.env.AGENT_TCDH_ALLOWED_ORIGINS ?? "")
        .split(",").map((origin) => origin.trim()).filter(Boolean),
    }));
    return;
  }

  // 3. Share a hub client across MCP discovery and registry commands.
  const client = new HubClient(
    values.hub ?? process.env.AGENT_TCDH_URL ?? "http://127.0.0.1:3000",
    readClientToken(values["token-env"], values["token-env"] !== undefined),
  );
  if (command === "mcp") {
    validateArguments(positionals, 1, values, ["hub"]);
    const { runDiscoveryServer } = await import("./mcp.js");
    await runDiscoveryServer(client);
    return;
  }
  if (command === "registry") {
    const action = positionals[1];
    if (action === "export") {
      validateArguments(positionals, 3, values, ["hub", "overwrite"]);
      const { writeSnapshot } = await import("./registry/files.js");
      const snapshot = await client.exportRegistry();
      const path = await writeSnapshot(positionals[2]!, snapshot, values.overwrite);
      printJson({ path, targets: snapshot.targets.length });
      return;
    }
    if (action === "import") {
      validateArguments(positionals, 3, values, ["hub", "on-conflict", "dry-run"]);
      const { readSnapshot } = await import("./registry/files.js");
      const { importOptionsSchema } = await import("./registry/schema.js");
      const options = importOptionsSchema.parse({
        onConflict: values["on-conflict"], dryRun: values["dry-run"],
      });
      printJson(await client.importRegistry(await readSnapshot(positionals[2]!), options));
      return;
    }
    throw new Error("Unknown registry command. Run --help for usage.");
  }
  if (command !== "target") {
    throw new Error("Unknown command. Run --help for usage.");
  }

  // 4. Validate command arguments and input files before printing results.
  const action = positionals[1];
  if (action === "check") {
    validateArguments(positionals, 3, values, ["hub", "bearer-env"]);
    const id = targetIdSchema.parse(positionals[2]);
    const { checkTarget, targetCheckOptionsSchema } = await import("./targets/check.js");
    const options = targetCheckOptionsSchema.parse({ bearerEnv: values["bearer-env"] });
    const versioned = await client.getVersioned(id);
    const report = await checkTarget(versioned.target, options);
    printJson({ ...report, targetVersion: versioned.etag });
    process.exitCode = report.status === "failed" ? 1 : report.status === "skipped" ? 2 : 0;
    return;
  }
  if (action === "import") {
    validateArguments(positionals, 3, values, [
      "hub", "id", "protocol", "name", "description", "tag", "transport", "bearer-env", "dry-run",
      "a2a-binding", "a2a-version",
    ]);
    if (values.protocol === "a2a" && values.transport !== undefined) {
      throw new Error("--transport is only available for MCP imports.");
    }
    const { inspectRemote, remoteImportSchema } = await import("./remote-import.js");
    const target = await inspectRemote(remoteImportSchema.parse({
      id: values.id, protocol: values.protocol, url: positionals[2],
      name: values.name, description: values.description, transport: values.transport,
      tags: values.tag ? [values.tag] : [], bearerEnv: values["bearer-env"],
      a2aBinding: values["a2a-binding"], a2aVersion: values["a2a-version"],
    }));
    printJson(values["dry-run"] ? target : await client.create(target));
    return;
  }
  if (action === "refresh") {
    validateArguments(positionals, 3, values, ["hub", "bearer-env", "dry-run", "a2a-binding", "a2a-version"]);
    const id = targetIdSchema.parse(positionals[2]);
    const { refreshDefinition } = await import("./remote-import.js");
    const selection = a2aSelectionSchema.parse({
      protocolBinding: values["a2a-binding"], protocolVersion: values["a2a-version"],
    });
    const proposal = await refreshDefinition(client, id, values["bearer-env"], selection);
    printJson(values["dry-run"] ? proposal.target : await client.update(id, proposal.target, proposal.etag));
    return;
  }
  if (action === "list") {
    validateArguments(positionals, 2, values, ["hub", "q", "protocol", "tag", "limit", "offset", "include-disabled"]);
    printJson(await client.search(searchSchema.parse({
      q: values.q,
      protocol: values.protocol,
      tag: values.tag,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      offset: values.offset === undefined ? undefined : Number(values.offset),
      includeDisabled: values["include-disabled"],
    })));
    return;
  }
  if (action === "add") {
    validateArguments(positionals, 3, values, ["hub"]);
    const target = await readDefinition(positionals[2]!);
    printJson(await client.create(target));
    return;
  }
  if (action === "update") {
    validateArguments(positionals, 4, values, ["hub", "if-match"]);
    const id = targetIdSchema.parse(positionals[2]);
    const target = await readDefinition(positionals[3]!);
    if (id !== target.id) {
      throw new Error("The command and JSON file must use the same target id.");
    }
    printJson(await client.update(id, target, values["if-match"]));
    return;
  }
  if (action === "get" || action === "remove") {
    validateArguments(positionals, 3, values, action === "get" ? ["hub", "with-version"] : ["hub", "if-match"]);
    const id = targetIdSchema.parse(positionals[2]);
    if (action === "get") {
      printJson(values["with-version"] ? await client.getVersioned(id) : await client.get(id));
    } else {
      await client.remove(id, values["if-match"]);
      printJson({ deleted: id });
    }
    return;
  }

  throw new Error("Unknown target command. Run --help for usage.");
}

/** Validate positional argument counts and supported options for each command. */
function validateArguments(
  positionals: string[],
  expectedCount: number,
  values: Record<string, unknown>,
  allowedOptions: string[],
): void {
  // 1. Reject missing or extra positional arguments.
  if (positionals.length !== expectedCount) {
    throw new Error("Check the command argument count. Run --help for usage.");
  }

  // 2. Reject options belonging to another command instead of silently ignoring them.
  const allowed = allowedOptions.includes("hub") ? [...allowedOptions, "token-env"] : allowedOptions;
  const unexpected = Object.keys(values).filter((name) => name !== "help" && !allowed.includes(name));
  if (unexpected.length > 0) {
    throw new Error("Unsupported options for this command: " + unexpected.join(", "));
  }
}

/** Read a bounded JSON file and validate its target definition. */
async function readDefinition(path: string) {
  // 1. Apply the same body size limit as the HTTP API.
  if ((await stat(path)).size > 1_048_576) {
    throw new Error("Target definition files must not exceed 1 MiB.");
  }

  // 2. Validate JSON syntax, protocol, and connection details.
  return targetDefinitionSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Print CLI results as JSON for automation. */
function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
