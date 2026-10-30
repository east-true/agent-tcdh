import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HubClient } from "./client.js";
import { searchSchema, targetDefinitionSchema, targetIdSchema } from "./targets/schema.js";
import { readClientToken } from "./auth.js";
import { a2aSelectionSchema } from "./targets/a2a.js";
import { loadConfig, consumerTokenEnv } from "./onboarding/config.js";
import { formatCommand, printOnboarding, targetTable } from "./onboarding/output.js";
import type { TargetDefinition } from "./targets/schema.js";
import type { ImportIssue } from "./onboarding/import-config.js";

const help = `AgentTCDH — Agent & Tool Capability Discovery Hub

Usage:
  agent-tcdh init [--yes] [--config FILE] [--hub URL] [--host HOST] [--port PORT] [--db FILE]
  agent-tcdh connect <CLIENT> [--print | --write FILE | --check FILE] [--dry-run] [--replace]
                       CLIENT: codex, opencode, opencode-v1, claude-code, gemini-cli, cursor, vscode
  agent-tcdh doctor [--target ID | --all] [--hub URL]
                       [--q QUERY] [--protocol mcp|a2a] [--tag TAG] [--include-disabled]
                       [--limit COUNT] [--concurrency COUNT]
  agent-tcdh target add <URL> [--protocol auto|mcp|a2a] [--id ID] [--dry-run]
  agent-tcdh target add --command COMMAND [--arg=ARG ...] [--env-var NAME ...] [--name NAME]
  agent-tcdh serve [--host HOST] [--port PORT] [--db FILE]
  agent-tcdh target add <JSON_FILE> [--hub URL]
  agent-tcdh target edit <ID> [--name NAME] [--description TEXT] [--add-tag TAG ...] [--remove-tag TAG ...]
                       [--dry-run] [--if-match ETAG] [--hub URL]
  agent-tcdh target enable|disable <ID> [--dry-run] [--if-match ETAG] [--hub URL]
  agent-tcdh target update <ID> <JSON_FILE> [--if-match ETAG] [--hub URL]
  agent-tcdh target import <URL> --id ID --protocol mcp|a2a [--dry-run] [--hub URL]
  agent-tcdh target refresh <ID> [--dry-run] [--hub URL]
  agent-tcdh target check <ID> [--bearer-env VARIABLE] [--hub URL]
  agent-tcdh target get <ID> [--with-version] [--hub URL]
  agent-tcdh target list [--q QUERY] [--protocol mcp|a2a] [--tag TAG]
                       [--limit COUNT] [--offset OFFSET] [--include-disabled] [--hub URL]
  agent-tcdh target remove <ID> [--dry-run] [--if-match ETAG] [--hub URL]
  agent-tcdh registry import-config <FILE> [--format FORMAT] [--select NAME ...] [--prefix PREFIX] [--apply | --compare] [--details]
  agent-tcdh preset list
  agent-tcdh preset show <NAME> [--select ID ...] [--compare] [--details]
  agent-tcdh preset import <NAME> [--select ID ...] [--prefix PREFIX] [--apply | --compare] [--details]
  agent-tcdh registry diff <JSON_FILE> [--on-conflict error|skip|replace] [--details] [--hub URL]
  agent-tcdh registry export <JSON_FILE> [--overwrite] [--hub URL]
  agent-tcdh registry import <JSON_FILE> [--on-conflict error|skip|replace] [--dry-run] [--hub URL]
  agent-tcdh mcp [--hub URL] [--no-config] [--anonymous | --token-env VARIABLE]

Environment:
  HOST                  Listener address (default: 127.0.0.1)
  PORT                  Listener port (default: 3000)
  AGENT_TCDH_DB_PATH     SQLite file (default: ~/.agent-tcdh/registry.sqlite)
  AGENT_TCDH_CONFIG      Optional setup configuration path (default: ~/.agent-tcdh/config.json)
  AGENT_TCDH_URL         Hub URL for CLI and MCP (default: http://127.0.0.1:3000)
  AGENT_TCDH_TOKEN       Optional administrator Bearer token; default CLI/MCP credential
  AGENT_TCDH_READ_TOKEN  Optional read-only token accepted by the server
  AGENT_TCDH_ALLOWED_ORIGINS  Comma-separated allowed origins for HTTP MCP and A2A
  AGENT_TCDH_PUBLIC_URL  Public base URL advertised in the A2A card behind proxies/containers

Options:
  --help, -h            Show usage
  --compare             Compare a config/preset preview with current hub metadata (read-only)
  --details             Include full definitions and print JSON comparison output
  --apply               Apply a reviewed config/preset import; previews are the default
  --format FORMAT       Client config format: auto, codex, opencode, opencode-v1, mcp-json
  --select NAME         Repeat to select source server names or preset target ids
  --prefix PREFIX       Namespace imported target ids
  --no-config           Ignore setup files for an explicitly configured stdio discovery bridge
  --anonymous           Use anonymous hub access for mcp; never resolve credential variables
  --config FILE         Use setup defaults; flags override environment, then configuration
  --json                Print JSON, including in a terminal; redirected output defaults to JSON
  --remote              Initialize client settings for an existing hub
  --yes                 Initialize without prompts, using supplied options and defaults
  --force               Replace setup configuration with an exact backup
  --read-token-env NAME  Record the read credential environment name during setup
  --print               Print only the generated client configuration fragment
  --check FILE          Check a saved client profile without writes or network calls
  --write FILE          Merge the hub into this explicit client file, preserving a backup
  --replace             Replace a conflicting named hub entry in a client configuration
  --all                 Inspect all matching targets during doctor (default limit: 100)
  --concurrency COUNT   Parallel doctor inspections, 1–8 (default: 3)
  --target ID           Inspect this target's metadata and local prerequisites during doctor
  --command COMMAND     Register a local MCP stdio command without executing it
  --arg ARG             Repeat for each literal stdio argument; use --arg=--flag for flags
  --env-var NAME        Declare a consumer-side environment variable, without storing its value
  --add-tag TAG         Repeat to append a tag during target edit
  --remove-tag TAG      Repeat to remove a tag during target edit
  --name NAME          Set a target display name; connect uses a server entry name
  --description TEXT   Set a target description
  --transport TYPE     MCP import transport: streamable-http or sse
  --a2a-binding TYPE   Select JSONRPC or HTTP+JSON
  --a2a-version VERSION  Select a declared A2A protocol version
  --bearer-env VARIABLE  Environment variable containing the remote Bearer token
  --dry-run            Preview supported changes without writing registry/client files
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
      config: { type: "string" },
      "no-config": { type: "boolean" },
      anonymous: { type: "boolean" },
      apply: { type: "boolean" },
      compare: { type: "boolean" },
      details: { type: "boolean" },
      format: { type: "string" },
      select: { type: "string", multiple: true },
      prefix: { type: "string" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      remote: { type: "boolean" },
      force: { type: "boolean" },
      "read-token-env": { type: "string" },
      print: { type: "boolean" },
      write: { type: "string" },
      check: { type: "string" },
      replace: { type: "boolean" },
      target: { type: "string" },
      all: { type: "boolean" },
      concurrency: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      "env-var": { type: "string", multiple: true },
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
      "add-tag": { type: "string", multiple: true },
      "remove-tag": { type: "string", multiple: true },
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

  // 2. Prepare first-run configuration without loading a file that does not exist yet.
  const command = positionals[0] ?? "serve";
  if ((values["no-config"] || values.anonymous) && command !== "mcp"
    || values["no-config"] && values.config || values.anonymous && values["token-env"]) {
    throw new Error("--no-config and --anonymous are mcp-only options. Do not combine --no-config with --config, or --anonymous with --token-env.");
  }
  if (command === "init") {
    validateArguments(positionals, 1, values, ["config", "json", "yes", "remote", "force", "hub", "host", "port", "db", "token-env", "read-token-env"]);
    const { initialize } = await import("./onboarding/init.js");
    const result = await initialize({ config: values.config, yes: values.yes, remote: values.remote, force: values.force,
      hub: values.hub, host: values.host, port: values.port, db: values.db,
      tokenEnv: values["token-env"], readTokenEnv: values["read-token-env"],
    });
    printOnboarding(result, values.json, () => "Configuration saved: " + result.path + "\nHub: " + result.hub
      + (result.backup ? "\nBackup: " + result.backup : "")
      + (result.credentialEnvironmentVariables.length ? "\nSet these environment variables before starting: " + result.credentialEnvironmentVariables.join(", ") : result.mode === "local" ? "\nLocal setup without explicit credential references; configure tokens before sharing the listener." : "\nExisting hub selected; configure its credential references if required.")
      + "\nNext commands" + (result.mode === "local" ? " (run serve in another terminal)" : "") + ":\n"
      + result.nextCommands.map((args) => formatCommand(args)).join("\n"));
    return;
  }
  const config = values["no-config"] ? undefined : await loadConfig(values.config);
  const hub = values.hub ?? process.env.AGENT_TCDH_URL ?? config?.hub ?? "http://127.0.0.1:3000";

  // 3. Generate consumer settings and run read-only diagnostics before requiring administration credentials.
  if (command === "connect") {
    validateArguments(positionals, 2, values, ["hub", "print", "write", "check", "dry-run", "replace", "name"]);
    if (values.check !== undefined && (values.print || values.write !== undefined || values["dry-run"] || values.replace)) {
      throw new Error("Use --check FILE alone with optional --hub, --token-env, --name, --config, or --json.");
    }
    if (values.check !== undefined) {
      const { checkConnection } = await import("./onboarding/connect.js");
      const result = await checkConnection({ client: positionals[1]!, hub, file: values.check,
        tokenEnv: values["token-env"] ?? consumerTokenEnv(config), name: values.name });
      printOnboarding(result, values.json, () => result.status.toUpperCase() + " " + result.reason + ": " + JSON.stringify(result.path)
        + (result.differingFields.length ? "\nDiffering fields: " + result.differingFields.join(", ") : "")
        + "\n" + result.action + "\n" + result.scope);
      process.exitCode = result.status === "passed" ? 0 : 1;
      return;
    }
    if (values.print && values.write || values.print && values.json || (values["dry-run"] || values.replace) && !values.write) {
      throw new Error("Use --print alone, or --write FILE with optional --dry-run. --print cannot be combined with --json.");
    }
    const { connectClient } = await import("./onboarding/connect.js");
    const result = await connectClient({ client: positionals[1]!, hub,
      tokenEnv: values["token-env"] ?? consumerTokenEnv(config), write: values.write,
      replace: values.replace, name: values.name, dryRun: values["dry-run"],
    });
    if (values.print) {
      process.stdout.write(result.content!);
    } else {
      printOnboarding(result, values.json, () => (result.content ?? "Configuration saved: " + result.path)
        + ("backup" in result && result.backup ? "\nBackup: " + result.backup : "")
        + "\n" + result.notes.join("\n") + "\n" + result.instructions
        + (result.requiredEnvironmentVariables.length ? "\nRequired in the client environment: " + result.requiredEnvironmentVariables.join(", ") : ""));
    }
    return;
  }
  if (command === "doctor") {
    validateArguments(positionals, 1, values, ["hub", "target", "all", "q", "protocol", "tag", "include-disabled", "limit", "concurrency"]);
    if (values.target && values.all || !values.all && ["q", "protocol", "tag", "include-disabled", "limit", "concurrency"].some((key) => values[key as keyof typeof values] !== undefined)) {
      throw new Error("Choose --target or --all. Batch filters and limits require --all.");
    }
    const { batchDiagnosisOptionsSchema } = await import("./onboarding/doctor-batch.js");
    const batch = values.all ? batchDiagnosisOptionsSchema.parse({ q: values.q, protocol: values.protocol, tag: values.tag,
      includeDisabled: values["include-disabled"], limit: values.limit === undefined ? undefined : Number(values.limit),
      concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency) }) : undefined;
    const { diagnose } = await import("./onboarding/doctor.js");
    const result = await diagnose({ hub, tokenEnv: values["token-env"] ?? consumerTokenEnv(config), target: values.target === undefined ? undefined : targetIdSchema.parse(values.target), batch });
    printOnboarding(result, values.json, () => result.checks.map((check) => check.status.toUpperCase() + " " + check.id + ": " + check.message
      + (check.status !== "passed" && check.action ? "\n  Next: " + check.action : "")).join("\n")
      + (result.batch ? "\n" + result.batch.targets.map((target) => target.status.toUpperCase() + " " + target.id + " (" + target.transport + ")\n"
        + target.checks.map((check) => "  " + check.status.toUpperCase() + " " + check.id + ": " + check.message
          + (check.status !== "passed" && check.action ? "\n    Next: " + check.action : "")).join("\n")).join("\n") : "")
      + "\nExecution verification: not performed.");
    process.exitCode = result.status === "failed" ? 1 : 0;
    return;
  }

  // 4. Apply server options using flags, environment, setup configuration, then built-in defaults.
  if (command === "serve") {
    validateArguments(positionals, positionals.length === 0 ? 0 : 1, values, ["host", "port", "db"]);
    if (config?.mode === "remote") {
      throw new Error("This configuration connects to an existing hub. Initialize a local setup configuration to run serve.");
    }
    const { runServer, serverOptionsSchema } = await import("./server.js");
    await runServer(serverOptionsSchema.parse({
      host: values.host ?? process.env.HOST ?? config?.server.host ?? "127.0.0.1",
      port: values.port ?? process.env.PORT ?? config?.server.port ?? "3000",
      dbPath: values.db ?? process.env.AGENT_TCDH_DB_PATH ?? config?.server.dbPath,
      token: readClientToken(config?.tokenEnv, config?.tokenEnv !== undefined),
      readToken: readClientToken(config?.readTokenEnv ?? "AGENT_TCDH_READ_TOKEN", config?.readTokenEnv !== undefined),
      publicUrl: process.env.AGENT_TCDH_PUBLIC_URL || undefined,
      allowedOrigins: (process.env.AGENT_TCDH_ALLOWED_ORIGINS ?? "")
        .split(",").map((origin) => origin.trim()).filter(Boolean),
    }));
    return;
  }

  // 5. Share the authenticated registry API with existing CLI and MCP commands.
  if (!["mcp", "target", "registry", "preset"].includes(command)) {
    throw new Error("Unknown command. Run --help for usage.");
  }
  const metadataPreview = !values.compare && (command === "target" && ["add", "import"].includes(positionals[1] ?? "") && values["dry-run"]
    || command === "registry" && positionals[1] === "import-config" && !values.apply
    || command === "preset" && (positionals[1] !== "import" || !values.apply));
  const readCommand = command === "registry" && (positionals[1] === "diff" || positionals[1] === "import-config" && values.compare)
    || command === "preset" && ["show", "import"].includes(positionals[1] ?? "") && values.compare
    || command === "mcp" || command === "target" && (["list", "get", "check"].includes(positionals[1] ?? "")
    || ["refresh", "edit", "enable", "disable", "remove"].includes(positionals[1] ?? "") && values["dry-run"]);
  if (!readCommand && !metadataPreview && !values["token-env"] && config?.readTokenEnv && !config.tokenEnv && !process.env.AGENT_TCDH_TOKEN) {
    throw new Error("This setup has only read credentials. Select an administrator credential with --token-env for mutations.");
  }
  const clientTokenEnv = values["token-env"] ?? (metadataPreview ? undefined : readCommand ? config?.readTokenEnv ?? config?.tokenEnv : config?.tokenEnv);
  const client = new HubClient(hub, values.anonymous || metadataPreview && values["token-env"] === undefined ? undefined
    : readClientToken(clientTokenEnv, clientTokenEnv !== undefined));
  if (command === "mcp") {
    validateArguments(positionals, 1, values, ["hub", "no-config", "anonymous"]);
    const { runDiscoveryServer } = await import("./mcp.js");
    await runDiscoveryServer(client);
    return;
  }
  if (command === "preset") {
    const action = positionals[1];
    const { listPresets, preparePreset } = await import("./onboarding/presets.js");
    if (action === "list") {
      validateArguments(positionals, 2, values, []);
      const presets = await listPresets();
      printOnboarding({ presets }, values.json, () => presets.map((preset) => preset.id + ": " + preset.targets + " targets\n  " + preset.description
        + "\n  Select: " + preset.targetIds.join(", ") + "\n  Metadata as of: " + preset.metadataAsOf).join("\n"));
      return;
    }
    if (action === "show" || action === "import") {
      validateArguments(positionals, 3, values, action === "show" ? ["select", "prefix", "hub", "compare", "details", "on-conflict"] : ["hub", "select", "prefix", "apply", "dry-run", "on-conflict", "compare", "details"]);
      if (values.apply && (values["dry-run"] || values.compare) || values.details && !values.compare) {
        throw new Error("Choose either --apply or a preview (--compare/--dry-run). --details requires --compare.");
      }
      const preparation = await preparePreset(positionals[2]!, { select: values.select, prefix: values.prefix });
      await finishPreparedImport(preparation, client, action === "import" && Boolean(values.apply), values["on-conflict"], values.json, values.compare, values.details);
      return;
    }
    throw new Error("Unknown preset command. Run preset list or --help.");
  }
  if (command === "registry") {
    const action = positionals[1];
    if (action === "diff") {
      validateArguments(positionals, 3, values, ["hub", "on-conflict", "details"]);
      const { readSnapshot } = await import("./registry/files.js");
      const { compareRegistry, formatComparison } = await import("./registry/diff.js");
      const report = await compareRegistry(client, await readSnapshot(positionals[2]!), { onConflict: values["on-conflict"], details: values.details });
      printOnboarding(report, values.json || values.details, () => formatComparison(report));
      return;
    }
    if (action === "import-config") {
      validateArguments(positionals, 3, values, ["hub", "format", "select", "prefix", "apply", "dry-run", "on-conflict", "compare", "details"]);
      if (values.apply && (values["dry-run"] || values.compare) || values.details && !values.compare) {
        throw new Error("Choose either --apply or a preview (--compare/--dry-run). --details requires --compare.");
      }
      const { inspectConfigFile, sourceFormatSchema } = await import("./onboarding/import-config.js");
      const preparation = await inspectConfigFile(positionals[2]!, { format: sourceFormatSchema.parse(values.format ?? "auto"),
        select: values.select, prefix: values.prefix, hub });
      await finishPreparedImport(preparation, client, Boolean(values.apply), values["on-conflict"], values.json, values.compare, values.details);
      return;
    }
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

  // 6. Validate command arguments and input files before printing results.
  const action = positionals[1];
  if (["edit", "enable", "disable"].includes(action ?? "")) {
    validateArguments(positionals, 3, values, ["hub", "dry-run", "if-match", ...(action === "edit" ? ["name", "description", "add-tag", "remove-tag"] : [])]);
    const { editTarget } = await import("./targets/edit.js");
    const result = await editTarget(client, positionals[2]!, action === "edit" ? {
      name: values.name, description: values.description, addTags: values["add-tag"], removeTags: values["remove-tag"],
    } : { enabled: action === "enable" }, { dryRun: values["dry-run"], ifMatch: values["if-match"] });
    printOnboarding({ action, ...result }, values.json, () => result.id + ": " + (result.applied ? "Updated." : result.hasChanges
      ? "Preview only; no registry changes." : "No changes needed; the observed registration already matches.")
      + "\nBase version: " + result.baseVersion
      + "\n" + result.changes.map((change) => change.field + ": " + JSON.stringify(change.before) + " -> " + JSON.stringify(change.after)).join("\n"));
    return;
  }
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
    const result = await client.search(searchSchema.parse({
      q: values.q,
      protocol: values.protocol,
      tag: values.tag,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      offset: values.offset === undefined ? undefined : Number(values.offset),
      includeDisabled: values["include-disabled"],
    }));
    if (!values.json && process.stdout.isTTY) {
      process.stdout.write(targetTable(result));
    } else {
      printJson(result);
    }
    return;
  }
  if (action === "add") {
    const source = positionals[2];
    const quick = values.command !== undefined || source !== undefined && (/^https?:/iu.test(source) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(source));
    if (quick) {
      validateArguments(positionals, values.command !== undefined ? 2 : 3, values, [
        "hub", "id", "protocol", "name", "description", "tag", "transport", "bearer-env", "dry-run",
        "a2a-binding", "a2a-version", "command", "arg", "env-var",
      ]);
      const { quickDefinition } = await import("./onboarding/add.js");
      const target = await quickDefinition({ url: source, command: values.command, args: values.arg, envVars: values["env-var"],
        id: values.id, protocol: values.protocol, name: values.name, description: values.description, tag: values.tag,
        transport: values.transport, bearerEnv: values["bearer-env"], a2aBinding: values["a2a-binding"], a2aVersion: values["a2a-version"],
      });
      printJson(values["dry-run"] ? target : await client.create(target));
    } else {
      validateArguments(positionals, 3, values, ["hub"]);
      const target = await readDefinition(source!);
      printJson(await client.create(target));
    }
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
    validateArguments(positionals, 3, values, action === "get" ? ["hub", "with-version"] : ["hub", "if-match", "dry-run"]);
    const id = targetIdSchema.parse(positionals[2]);
    if (action === "get") {
      printJson(values["with-version"] ? await client.getVersioned(id) : await client.get(id));
    } else if (values["dry-run"]) {
      const { previewRemoval } = await import("./targets/edit.js");
      const result = await previewRemoval(client, id, values["if-match"]);
      printOnboarding({ action, ...result }, values.json, () => "Removal preview: " + result.id + " (" + JSON.stringify(result.target.name) + ")"
        + "\nBase version: " + result.baseVersion + "\nNo registry changes. Use --if-match with this version when removing the target.");
    } else {
      await client.remove(id, values["if-match"]);
      printJson({ deleted: id });
    }
    return;
  }

  throw new Error("Unknown target command. Run --help for usage.");
}

/** Preview prepared connection metadata or submit one atomic import after explicit application. */
async function finishPreparedImport<T extends {
  ready: boolean; targets: TargetDefinition[]; selected: number; converted: number;
  issues: ImportIssue[]; requiredEnvironmentVariables: string[]; metadataAsOf?: string;
}>(preparation: T, client: HubClient, apply: boolean, onConflict: string | undefined, json: boolean | undefined,
  compare?: boolean, details?: boolean): Promise<void> {
  // 1. Preserve the existing conflict policy and refuse partial application of blocked plans.
  const { importOptionsSchema } = await import("./registry/schema.js");
  const { preparedSnapshot } = await import("./onboarding/import-config.js");
  const options = importOptionsSchema.parse({ onConflict, dryRun: false });
  const result = apply && preparation.ready ? await client.importRegistry(preparedSnapshot(preparation.targets, preparation.metadataAsOf), options) : undefined;
  const { compareRegistry, formatComparison } = await import("./registry/diff.js");
  const comparison = compare && preparation.ready ? await compareRegistry(client, preparedSnapshot(preparation.targets, preparation.metadataAsOf), { onConflict, details }) : undefined;
  const ready = preparation.ready && (comparison?.importReady ?? true);

  // 2. Print only the prepared definitions and fixed diagnostics, never the original source file.
  const report = { ...preparation, ready, applied: result !== undefined, onConflict: options.onConflict,
    hubConflictsChecked: result !== undefined || comparison !== undefined, ...(result ? { result } : {}), ...(comparison ? { comparison } : {}) };
  printOnboarding(report, json || details, () => preparation.converted + "/" + preparation.selected + " selected connections prepared. "
    + (result ? "Applied to the hub." : ready ? "Preview only; no hub changes. Use the import command with --apply to register." : "Not ready; resolve source errors or destination conflicts.")
    + "\n" + preparation.targets.map((target) => target.id + " (" + target.connection.transport + ")").join("\n")
    + "\n" + preparation.issues.map((issue) => issue.severity.toUpperCase() + " " + JSON.stringify(issue.name) + " " + issue.code + ": " + issue.message).join("\n")
    + (preparation.requiredEnvironmentVariables.length ? "\nRequired in the consuming environment: " + preparation.requiredEnvironmentVariables.join(", ") : "")
    + (comparison ? "\n" + formatComparison(comparison) : "")
    + "\nNo target connections or executions were performed.");
  if (!ready) {
    process.exitCode = 1;
  }
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
  const allowed = [...allowedOptions, "config", "json", ...(allowedOptions.includes("hub") ? ["token-env"] : [])];
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
