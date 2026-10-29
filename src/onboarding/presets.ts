import { fileURLToPath } from "node:url";
import { readSnapshot } from "../registry/files.js";
import { importedId, preparedSnapshot, requiredVariables } from "./import-config.js";

const presets = [{ id: "public-docs", description: "Six documentation MCP examples: OpenAI, Toss Payments, Microsoft Learn, Cloudflare, Context7, and DeepWiki.",
  file: new URL("../../examples/public-docs-registry.json", import.meta.url) }];

/** List packaged example collections without probing or executing their providers. */
export async function listPresets() {
  return Promise.all(presets.map(async (preset) => {
    const snapshot = await readSnapshot(fileURLToPath(preset.file));
    return { id: preset.id, description: preset.description, targets: snapshot.targets.length,
      metadataAsOf: snapshot.exportedAt, targetIds: snapshot.targets.map((target) => target.id) };
  }));
}

/** Select and namespace packaged registrations while preserving their historical metadata date. */
export async function preparePreset(id: string, options: { select?: string[] | undefined; prefix?: string | undefined } = {}) {
  // 1. Resolve a packaged collection and validate explicit selections before constructing a snapshot.
  const preset = presets.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error("Unknown preset. Run agent-tcdh preset list for available example collections.");
  }
  const source = await readSnapshot(fileURLToPath(preset.file));
  const selected = new Set(options.select ?? []);
  if (selected.size !== (options.select ?? []).length || [...selected].some((name) => !source.targets.some((target) => target.id === name))) {
    throw new Error("Selections must be unique target ids shown by preset list.");
  }
  const targets = source.targets.filter((target) => selected.size === 0 || selected.has(target.id))
    .map((target) => ({ ...target, id: importedId(target.id, options.prefix) }));

  // 2. Return an offline preview; example collections do not restrict arbitrary target registration.
  preparedSnapshot(targets, source.exportedAt);
  return { preset: preset.id, description: preset.description, metadataAsOf: source.exportedAt,
    available: source.targets.length, selected: targets.length, converted: targets.length, ready: targets.length > 0,
    targets, requiredEnvironmentVariables: requiredVariables(targets), issues: [],
    metadataInspected: false, executionVerified: false,
  };
}
