import { z } from "zod";
import { targetDefinitionSchema } from "../targets/schema.js";
import { HubError } from "../errors.js";

export const MAX_SNAPSHOT_BYTES = 16_777_216;
export const MAX_SNAPSHOT_TARGETS = 10_000;

export const snapshotSchema = z.strictObject({
  format: z.literal("agent-tcdh"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  targets: z.array(targetDefinitionSchema).max(MAX_SNAPSHOT_TARGETS),
}).superRefine((snapshot, context) => {
  const ids = snapshot.targets.map((target) => target.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom", path: ["targets"], message: "Target ids must be unique within a snapshot.",
    });
  }
});

export const conflictSchema = z.enum(["error", "skip", "replace"]);
export const importOptionsSchema = z.strictObject({
  onConflict: conflictSchema.default("error"),
  dryRun: z.boolean().default(false),
});
export const importQuerySchema = z.strictObject({
  onConflict: conflictSchema.default("error"),
  dryRun: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
}).transform((value) => importOptionsSchema.parse(value));

export const importResultSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  replaced: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  dryRun: z.boolean(),
});

export type RegistrySnapshot = z.infer<typeof snapshotSchema>;
export type ImportOptions = z.infer<typeof importOptionsSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;

/** Enforce the target count limit before validating the entire snapshot. */
export function parseSnapshot(input: unknown): RegistrySnapshot {
  // 1. Reject oversized target arrays before validating individual fields.
  if (typeof input === "object" && input !== null && "targets" in input
    && Array.isArray(input.targets) && input.targets.length > MAX_SNAPSHOT_TARGETS) {
    throw new HubError(413, "SNAPSHOT_TOO_LARGE", "Snapshots may contain at most 10000 targets.");
  }

  // 2. Validate the supported version, unique ids, and target definitions.
  return snapshotSchema.parse(input);
}

/** Serialize a complete JSON snapshot that can be imported using the same limits. */
export function serializeSnapshot(snapshot: RegistrySnapshot): string {
  // 1. Validate the format and all target definitions.
  const normalized = parseSnapshot(snapshot);
  const text = JSON.stringify(normalized, null, 2) + "\n";

  // 2. Ensure the exported file fits the import size limit.
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new HubError(413, "SNAPSHOT_TOO_LARGE", "Snapshot files must not exceed 16 MiB.");
  }

  return text;
}
