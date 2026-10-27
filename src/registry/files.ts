import { createReadStream } from "node:fs";
import { link, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_SNAPSHOT_BYTES, parseSnapshot, serializeSnapshot } from "./schema.js";
import type { RegistrySnapshot } from "./schema.js";

/** Read and validate a complete backup while enforcing the file size limit. */
export async function readSnapshot(path: string): Promise<RegistrySnapshot> {
  // 1. Read chunks and stop immediately when the size limit is exceeded.
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("Snapshot files must not exceed 16 MiB.");
    }
    chunks.push(buffer);
  }

  // 2. Validate UTF-8 JSON, snapshot version, and target definitions.
  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, "");
  const snapshot = parseSnapshot(JSON.parse(text));
  serializeSnapshot(snapshot);
  return snapshot;
}

/** Write a complete backup atomically while preserving existing files by default. */
export async function writeSnapshot(
  path: string,
  snapshot: RegistrySnapshot,
  overwrite = false,
): Promise<string> {
  // 1. Write the complete contents to a temporary file on the same filesystem.
  const text = serializeSnapshot(snapshot);
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const directory = await mkdtemp(join(dirname(destination), ".agent-tcdh-export-"));
  const temporary = join(directory, "registry.json");
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    // 2. Replace an existing file only when explicitly requested.
    if (overwrite) {
      await rename(temporary, destination);
    } else {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error("The backup file already exists. Use --overwrite to replace it.");
        }
        throw error;
      }
    }

    return destination;
  } finally {
    // 3. Preserve the existing backup on failure and remove only this operation's temporary files.
    await rm(directory, { recursive: true, force: true });
  }
}
