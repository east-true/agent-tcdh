import { z } from "zod";
import type { HubClient } from "../client.js";
import { searchResultSchema, searchSchema, type Target } from "./schema.js";

export const batchTargetOptionsSchema = z.strictObject({
  q: searchSchema.shape.q,
  protocol: searchSchema.shape.protocol,
  tag: searchSchema.shape.tag,
  includeDisabled: searchSchema.shape.includeDisabled,
  limit: z.number().int().min(1).max(1000).default(100),
  concurrency: z.number().int().min(1).max(8).default(3),
});
export type BatchTargetOptions = z.infer<typeof batchTargetOptionsSchema>;

/** Collect bounded discovery membership before any per-target metadata requests or registry updates. */
export async function selectBatchTargets(client: Pick<HubClient, "search">, input: BatchTargetOptions) {
  // 1. Validate filters and collect complete, deduplicated pages with a stable observed count.
  const options = batchTargetOptionsSchema.parse(input);
  const targets: Target[] = [];
  const ids = new Set<string>();
  let matched = 0;
  let issue: { code: string; message: string } | undefined;
  try {
    for (let offset = 0; ; offset += 100) {
      const page = searchResultSchema.parse(await client.search(searchSchema.parse({
        q: options.q, protocol: options.protocol, tag: options.tag, includeDisabled: options.includeDisabled, limit: 100, offset,
      })));
      if (offset === 0) {
        matched = page.total;
      }
      if (page.total > options.limit) {
        issue = { code: "SELECTION_LIMIT_EXCEEDED", message: "Matching targets exceed --limit; no target inspections or updates were started." };
        break;
      }
      if (page.total !== matched || page.limit !== 100 || page.offset !== offset
        || page.items.length !== Math.min(100, matched - offset)
        || new Set(page.items.map((target) => target.id)).size !== page.items.length || page.items.some((target) => ids.has(target.id))) {
        issue = { code: "SELECTION_CHANGED", message: "Discovery pages changed or were incomplete; no target inspections or updates were started. Retry against a stable registry." };
        break;
      }
      for (const target of page.items) {
        ids.add(target.id);
        targets.push(target);
      }
      if (targets.length === matched) {
        break;
      }
    }
  } catch {
    issue = { code: "DISCOVERY_FAILED", message: "Unable to read all matching targets; no target inspections or updates were started." };
  }

  // 2. Discard partial membership after any selection failure.
  return { matched, targets: issue ? [] : targets, ...(issue ? { issue } : {}) };
}
