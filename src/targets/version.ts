import { HubError } from "../errors.js";
import type { Target } from "./schema.js";

export type EntityCondition = { kind: "any" } | { kind: "tags"; tags: string[] };
export interface VersionedTarget {
  target: Target;
  etag: string;
}

/** Convert a stored revision into a strong HTTP ETag. */
export function entityTag(revision: string): string {
  return '"' + revision + '"';
}

/** Parse If-Match wildcards and tag lists into strong comparison conditions. */
export function parseIfMatch(value: string | undefined): EntityCondition | undefined {
  // 1. Distinguish omitted headers and wildcards and reject excessive input.
  if (value === undefined) {
    return undefined;
  }
  if (value.length > 4096) {
    throw new HubError(400, "INVALID_IF_MATCH", "If-Match headers must not exceed 4096 characters.");
  }
  if (value.trim() === "*") {
    return { kind: "any" };
  }

  // 2. Preserve commas inside quoted tags and exclude weak tags from matches.
  const pattern = /(?:W\/)?"[!#-~\x80-\xff]*"/y;
  const tags: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (cursor < value.length && /[ \t,]/u.test(value[cursor]!)) {
      cursor++;
    }
    if (cursor === value.length) {
      break;
    }
    pattern.lastIndex = cursor;
    const match = pattern.exec(value);
    if (!match) {
      throw new HubError(400, "INVALID_IF_MATCH", "If-Match requires a quoted ETag or *.");
    }
    const token = match[0];
    if (!token.startsWith("W/")) {
      tags.push(token.slice(1, -1));
    }
    cursor = pattern.lastIndex;
    while (cursor < value.length && /[ \t]/u.test(value[cursor]!)) {
      cursor++;
    }
    if (cursor < value.length && value[cursor] !== ",") {
      throw new HubError(400, "INVALID_IF_MATCH", "ETag lists must be comma-separated.");
    }
  }

  return { kind: "tags", tags: [...new Set(tags)] };
}
