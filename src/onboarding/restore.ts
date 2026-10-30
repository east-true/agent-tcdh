import { resolve } from "node:path";
import { readConfigText, writeConfigText } from "./files.js";

/** Preview or explicitly restore an entire configuration file while preserving the current file in a backup. */
export async function restoreConfig(options: {
  source: string; file: string; apply?: boolean | undefined;
}) {
  // 1. Read only the explicit backup and destination, independently of setup defaults and client schemas.
  if (!options.source.trim() || !options.file.trim()) {
    throw new Error("Restore requires non-empty backup source and destination file paths.");
  }
  const source = resolve(options.source);
  const path = resolve(options.file);
  if (source === path) {
    throw new Error("Backup source and destination must be different files.");
  }
  const content = await readConfigText(source);
  if (content === undefined) {
    throw new Error("Backup source was not found. Select an existing backup file.");
  }
  const existing = await readConfigText(path);
  const hasChanges = content !== existing;

  // 2. Use the guarded writer only for an explicitly applied change; identical files remain untouched.
  const written = options.apply && hasChanges ? await writeConfigText(path, content, existing) : undefined;
  const applied = Boolean(written?.changed);
  return { source, path, reason: applied ? "restored" : hasChanges ? "restore-ready" : "unchanged",
    dryRun: !options.apply, hasChanges, applied, changed: applied,
    sourceBytes: Buffer.byteLength(content, "utf8"), destinationExists: existing !== undefined,
    destinationBytes: existing === undefined ? null : Buffer.byteLength(existing, "utf8"),
    ...(written && "backup" in written ? { backup: written.backup } : {}), executionVerified: false,
    instructions: applied ? "The entire file was restored. Reload or restart any client that reads it."
      : hasChanges ? "Preview only. Use --apply to restore the entire file, including unrelated settings; an existing destination will be backed up."
        : "The destination already matches the backup. No files or backups were created.",
  };
}
