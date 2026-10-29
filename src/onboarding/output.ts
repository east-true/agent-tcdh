import type { SearchResult } from "../targets/schema.js";

/** Remove terminal controls before displaying user-provided metadata in a compact table. */
function cell(value: unknown, width = 32): string {
  const text = String(value).replace(/[\p{Cc}\p{Cf}]/gu, " ");
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}

/** Format terminal target lists while leaving JSON output untouched for automation. */
export function targetTable(result: SearchResult): string {
  const rows = [["ID", "PROTOCOL", "TRANSPORT", "ENABLED", "CAPABILITIES"], ...result.items.map((target) => [
    target.id, target.protocol, target.connection.transport, String(target.enabled), String(target.capabilities.length),
  ])].map((row) => row.map((value) => cell(value)));
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd()).join("\n")
    + "\n" + result.items.length + " shown; " + result.total + " matches; offset " + result.offset + ".\n";
}

/** Print human-oriented text only in a terminal, or stable JSON when requested or redirected. */
export function printOnboarding(value: unknown, json: boolean | undefined, text: () => string): void {
  process.stdout.write(!json && process.stdout.isTTY ? text() + "\n" : JSON.stringify(value, null, 2) + "\n");
}

/** Render copied setup commands for POSIX shells or Windows PowerShell without evaluating arguments. */
export function formatCommand(args: string[], platform = process.platform): string {
  const words = args.map((value) => /^[a-zA-Z0-9_./:-]+$/u.test(value) ? value
    : "'" + value.replaceAll("'", platform === "win32" ? "''" : "'\\''") + "'");
  return (platform === "win32" ? "& " : "") + words.join(" ");
}
