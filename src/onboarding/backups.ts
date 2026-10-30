import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCommand } from "./output.js";

type BackupEntry = {
  path: string; sizeBytes: number | null; modifiedAt: string | null;
  status: "candidate" | "too-large" | "unsupported-file" | "unavailable";
  restoreCommand?: string[];
};

/** Sort matching backup metadata and expose only the requested newest entries. */
function backupReport(path: string, entries: BackupEntry[], limit: number, scannedEntries: number) {
  entries.sort((left, right) => (right.modifiedAt === null ? -Infinity : Date.parse(right.modifiedAt))
    - (left.modifiedAt === null ? -Infinity : Date.parse(left.modifiedAt))
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { path, items: entries.slice(0, limit), total: entries.length, limit,
    truncated: entries.length > limit, scannedEntries, metadataOnly: true, changed: false, executionVerified: false,
    instructions: "Names and file metadata only. Select a backup and run its restore preview to validate the file; no backup contents were read or restoration performed.",
  };
}

/** List bounded sibling backup metadata without opening source contents or requiring the destination to exist. */
export async function listConfigBackups(options: { file: string; limit?: number | undefined }) {
  // 1. Validate the explicit destination and open its parent without consulting personal setup defaults.
  if (!options.file.trim()) {
    throw new Error("Backup listing requires a non-empty destination file path.");
  }
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Backup listing limit must be an integer from 1 to 100.");
  }
  const path = resolve(options.file);
  let directory;
  try {
    directory = await opendir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return backupReport(path, [], limit, 0);
    }
    throw error;
  }

  // 2. Scan a bounded directory and match only this destination's generated UUID backup naming convention.
  const prefix = basename(path) + ".agent-tcdh-backup-";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const entries: BackupEntry[] = [];
  let scannedEntries = 0;
  for await (const entry of directory) {
    if (++scannedEntries > 10_000) {
      throw new Error("Backup directory exceeds the 10000-entry scan limit. No partial listing was returned.");
    }
    const name = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
    const expectedPrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (!name.startsWith(expectedPrefix) || !uuid.test(entry.name.slice(prefix.length))) {
      continue;
    }
    const source = join(dirname(path), entry.name);
    try {
      const info = await lstat(source);
      const status = !info.isFile() || info.isSymbolicLink() ? "unsupported-file"
        : info.size > 1_048_576 ? "too-large" : "candidate";
      entries.push({ path: source, sizeBytes: info.size, modifiedAt: info.mtime.toISOString(), status,
        ...(status === "candidate" ? { restoreCommand: [process.execPath, fileURLToPath(new URL("../../dist/index.js", import.meta.url)), "config", "restore", source, "--file", path] } : {}) });
    } catch {
      entries.push({ path: source, sizeBytes: null, modifiedAt: null, status: "unavailable" });
    }
  }
  return backupReport(path, entries, limit, scannedEntries);
}

/** Render backup metadata and copyable preview commands without emitting terminal controls from file paths. */
export function formatBackupList(report: Awaited<ReturnType<typeof listConfigBackups>>): string {
  const items = report.items.map((entry) => (entry.modifiedAt ?? "unknown") + "  " + (entry.sizeBytes ?? "unknown")
    + " bytes  " + entry.status + "  " + JSON.stringify(entry.path)
    + (entry.restoreCommand ? "\n  " + (entry.restoreCommand.some((arg) => /[\p{Cc}\p{Cf}]/u.test(arg))
      ? "Preview arguments (JSON): " + JSON.stringify(entry.restoreCommand) : formatCommand(entry.restoreCommand)) : ""));
  return "Backups for: " + JSON.stringify(report.path) + "\n" + (items.length ? items.join("\n") : "No matching backups.")
    + "\n" + report.items.length + " shown; " + report.total + " matches." + (report.truncated ? report.limit < 100 ? " Increase --limit to show more (maximum 100)." : " Output capped at 100 entries." : "")
    + "\n" + report.instructions;
}
