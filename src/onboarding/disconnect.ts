import { resolve } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { connectionClientSchema, connectionDocument, sameValue, validateConnectionName, type ConnectionClient } from "./connect.js";
import { readConfigText, writeConfigText } from "./files.js";

/** Ignore an empty top-level server container when comparing a TOML block removal. */
function comparableToml(root: Record<string, unknown>): Record<string, unknown> {
  const result = { ...root };
  if (result.mcp_servers !== undefined && Object.keys(result.mcp_servers as Record<string, unknown>).length === 0) {
    delete result.mcp_servers;
  }
  return result;
}

/** Verify that a TOML candidate removes exactly the selected entry without changing other parsed values. */
function matchesToml(content: string, expected: Record<string, unknown>, name: string): boolean {
  try {
    const actual = connectionDocument("codex", content, name).root;
    return sameValue(comparableToml(actual), comparableToml(expected));
  } catch {
    return false;
  }
}

/** Prepare a named-entry removal while retaining all unrelated configuration values. */
function prepareRemoval(client: ConnectionClient, existing: string, name: string, normalize: boolean) {
  // 1. Parse the selected layout and distinguish absent entries from malformed configuration.
  const document = connectionDocument(client, existing, name);
  const notes: string[] = [];
  if (!Object.hasOwn(document.servers, name)) {
    return { ready: true, reason: "entry-missing", content: existing, notes };
  }
  delete document.servers[name];

  // 2. Preserve managed TOML blocks verbatim when removal has exactly the expected semantic effect.
  if (client === "codex") {
    const markerPattern = new RegExp("^# AgentTCDH (begin|end) " + name + "\\r?$", "gm");
    const markers: RegExpExecArray[] = [];
    for (const marker of existing.matchAll(markerPattern)) {
      markers.push(marker);
      if (markers.length > 2) {
        break;
      }
    }
    if (markers.length === 2 && markers[0]![1] === "begin" && markers[1]![1] === "end") {
      const end = markers[1]!.index + markers[1]![0].length;
      const candidate = existing.slice(0, markers[0]!.index) + existing.slice(existing[end] === "\n" ? end + 1 : end);
      if (matchesToml(candidate, document.root, name)) {
        return { ready: true, reason: "removal-ready", content: candidate, notes };
      }
    }
    if (!normalize) {
      notes.push("This TOML layout cannot be removed as a managed block. Preview with --normalize to allow formatting/comment normalization; applying keeps an exact backup.");
      return { ready: false, reason: "normalization-required", content: existing, notes };
    }
    let candidate;
    try {
      candidate = stringifyToml(comparableToml(document.root));
    } catch {
      throw new Error("Unable to normalize this TOML configuration. The original file was preserved.");
    }
    if (!matchesToml(candidate, document.root, name)) {
      throw new Error("TOML normalization changed unrelated settings. The original file was preserved.");
    }
    notes.push("TOML formatting and comments are normalized; applying keeps the exact original in a backup.");
    return { ready: true, reason: "removal-ready", content: candidate, notes };
  }

  // 3. Remove the exact JSONC path and validate the resulting document before allowing a write.
  const content = applyEdits(document.text, modify(document.text, document.path, undefined,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
  const errors: ParseError[] = [];
  const actual = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length || !sameValue(actual, document.root)) {
    throw new Error("Unable to remove only the named entry from this JSONC layout. The original file was preserved.");
  }
  return { ready: true, reason: "removal-ready", content: document.bom + content, notes };
}

/** Preview or explicitly remove one named client entry, backing up only an actual file replacement. */
export async function disconnectClient(options: {
  client: string; file: string; name?: string | undefined; apply?: boolean | undefined; normalize?: boolean | undefined;
}) {
  // 1. Validate the explicit file and entry selection independently of hub settings or installation paths.
  const client = connectionClientSchema.parse(options.client);
  const name = options.name ?? "agent_tcdh";
  validateConnectionName(name);
  if (!options.file.trim()) {
    throw new Error("Disconnect requires a non-empty client configuration file path.");
  }
  if (options.normalize && client !== "codex") {
    throw new Error("--normalize is only supported for the codex TOML profile.");
  }
  const existing = await readConfigText(options.file);
  const prepared = existing === undefined ? { ready: true, reason: "file-missing", content: undefined, notes: [] as string[] }
    : prepareRemoval(client, existing, name, Boolean(options.normalize));
  const hasChanges = prepared.reason === "removal-ready";

  // 2. Apply only a ready removal using the existing guarded writer and an exact backup.
  const written = options.apply && prepared.ready && hasChanges
    ? await writeConfigText(options.file, prepared.content!, existing) : undefined;
  const applied = Boolean(written?.changed);
  return { client, name, path: resolve(options.file), ready: prepared.ready,
    reason: applied ? "removed" : prepared.reason, dryRun: !options.apply, hasChanges, applied,
    changed: applied, ...(written && "backup" in written ? { backup: written.backup } : {}),
    notes: prepared.notes, executionVerified: false,
    instructions: applied ? "Reload or restart the consuming client to load the updated configuration."
      : !prepared.ready ? "No changes. Review a preview with --normalize before applying this TOML removal."
        : hasChanges ? "Preview only. Use --apply to remove this named entry and save an exact backup."
          : "The named entry is already absent. No configuration files or backups were created.",
  };
}
