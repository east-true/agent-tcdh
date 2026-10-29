import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { HubClient } from "../client.js";
import { HubError } from "../errors.js";
import { targetDefinitionSchema, targetIdSchema, targetSchema } from "./schema.js";
import { parseIfMatch } from "./version.js";

const fields = targetSchema.options[0].shape;
const tag = fields.tags.unwrap().element;
export const targetEditSchema = z.strictObject({
  name: fields.name.optional(),
  description: fields.description.optional(),
  enabled: z.boolean().optional(),
  addTags: z.array(tag).max(50).default([]),
  removeTags: z.array(tag).max(50).default([]),
}).superRefine((patch, context) => {
  if (patch.name === undefined && patch.description === undefined && patch.enabled === undefined && !patch.addTags.length && !patch.removeTags.length) {
    context.addIssue({ code: "custom", message: "Choose a name, description, tag change, or enabled state to edit." });
  }
  if (patch.addTags.some((value) => patch.removeTags.includes(value))) {
    context.addIssue({ code: "custom", message: "The same tag cannot be added and removed in one edit." });
  }
});

/** Read a current definition and enforce an optional caller condition before planning any change. */
async function readForChange(client: Pick<HubClient, "getVersioned">, id: string, ifMatch?: string) {
  // 1. Validate the id and caller condition before making a read-only registry request.
  targetIdSchema.parse(id);
  const condition = parseIfMatch(ifMatch);
  const current = await client.getVersioned(id);
  const observed = parseIfMatch(current.etag);
  if (!observed || observed.kind !== "tags" || observed.tags.length !== 1) {
    throw new Error("The hub did not provide a single strong target version. Upgrade the server.");
  }
  if (condition?.kind === "tags" && !condition.tags.includes(observed.tags[0]!)) {
    throw new HubError(412, "PRECONDITION_FAILED", "The supplied version no longer matches. Reread target get --with-version and preview the change again.");
  }

  // 2. Preserve the entire portable definition while omitting server-managed timestamps.
  const target = targetSchema.parse(current.target);
  if (target.id !== id) {
    throw new Error("The hub returned a different target id.");
  }
  const definition = targetDefinitionSchema.parse({ id: target.id, name: target.name, description: target.description,
    protocol: target.protocol, tags: target.tags, enabled: target.enabled, capabilities: target.capabilities, connection: target.connection });
  return { definition, etag: current.etag };
}

/** Preview or conditionally save only administrator-controlled labels, tags, and enabled state. */
export async function editTarget(client: Pick<HubClient, "getVersioned" | "update">, id: string,
  input: z.input<typeof targetEditSchema>, options: { dryRun?: boolean | undefined; ifMatch?: string | undefined } = {}) {
  // 1. Validate the requested edits and merge tags without reordering surviving entries.
  const patch = targetEditSchema.parse(input);
  const current = await readForChange(client, id, options.ifMatch);
  const tags = current.definition.tags.filter((value) => !patch.removeTags.includes(value));
  for (const value of patch.addTags) {
    if (!tags.includes(value)) {
      tags.push(value);
    }
  }
  const target = targetDefinitionSchema.parse({ ...current.definition, tags,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) });

  // 2. Report semantic changes and save with the observed version; never retry a conflicting write.
  const editable = ["name", "description", "tags", "enabled"] as const;
  const changes = editable.filter((field) => !isDeepStrictEqual(current.definition[field], target[field]))
    .map((field) => ({ field, before: current.definition[field], after: target[field] }));
  const applied = changes.length > 0 && !options.dryRun;
  if (applied) {
    await client.update(id, target, current.etag);
  }
  return { id, dryRun: Boolean(options.dryRun), hasChanges: changes.length > 0, applied,
    baseVersion: current.etag, changes, target };
}

/** Preview exactly one existing registration without deleting it or calling its provider. */
export async function previewRemoval(client: Pick<HubClient, "getVersioned">, id: string, ifMatch?: string) {
  const current = await readForChange(client, id, ifMatch);
  return { id, dryRun: true, applied: false, baseVersion: current.etag, target: current.definition };
}
