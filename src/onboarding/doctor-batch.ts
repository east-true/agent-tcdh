import { z } from "zod";
import type { HubClient } from "../client.js";
import type { Target } from "../targets/schema.js";
import { searchResultSchema, searchSchema } from "../targets/schema.js";
import { diagnoseTarget } from "./doctor.js";

export const batchDiagnosisOptionsSchema = z.strictObject({
  q: searchSchema.shape.q,
  protocol: searchSchema.shape.protocol,
  tag: searchSchema.shape.tag,
  includeDisabled: searchSchema.shape.includeDisabled,
  limit: z.number().int().min(1).max(1000).default(100),
  concurrency: z.number().int().min(1).max(8).default(3),
});
export type BatchDiagnosisOptions = z.infer<typeof batchDiagnosisOptionsSchema>;
type TargetDiagnosis = Awaited<ReturnType<typeof diagnoseTarget>>;
type BatchTarget = Omit<TargetDiagnosis, "metadata"> & { metadata?: TargetDiagnosis["metadata"]; targetVersion?: string };
export interface BatchDiagnosisReport {
  status: "passed" | "warning" | "failed";
  selection: BatchDiagnosisOptions;
  matched: number;
  complete: boolean;
  summary: { passed: number; warning: number; failed: number };
  targets: BatchTarget[];
  executionVerified: false;
  selectionIssue?: { code: string; message: string };
}

/** Select all matching registrations before probing, then inspect them with bounded concurrency. */
export async function diagnoseBatch(client: HubClient, input: BatchDiagnosisOptions, environment = process.env): Promise<BatchDiagnosisReport> {
  // 1. Validate the resource limits and gather a bounded, deduplicated list through read-only discovery.
  const options = batchDiagnosisOptionsSchema.parse(input);
  const report: BatchDiagnosisReport = { status: "passed", selection: options, matched: 0, complete: false,
    summary: { passed: 0, warning: 0, failed: 0 }, targets: [], executionVerified: false };
  const definitions: Target[] = [];
  const ids = new Set<string>();
  try {
    for (let offset = 0; ; offset += 100) {
      const page = searchResultSchema.parse(await client.search(searchSchema.parse({
        q: options.q, protocol: options.protocol, tag: options.tag, includeDisabled: options.includeDisabled,
        limit: 100, offset,
      })));
      if (offset === 0) {
        report.matched = page.total;
      }
      if (page.total > options.limit) {
        report.status = "failed";
        report.selectionIssue = { code: "SELECTION_LIMIT_EXCEEDED", message: "Matching targets exceed --limit; no target inspections were started." };
        return report;
      }
      if (page.total !== report.matched || new Set(page.items.map((target) => target.id)).size !== page.items.length || page.items.some((target) => ids.has(target.id))
        || page.items.length !== Math.min(100, report.matched - offset)) {
        report.status = "failed";
        report.selectionIssue = { code: "SELECTION_CHANGED", message: "Discovery pages changed or were incomplete; no target inspections were started. Retry against a stable registry." };
        return report;
      }
      for (const target of page.items) {
        ids.add(target.id);
        definitions.push(target);
      }
      if (definitions.length === report.matched) {
        break;
      }
    }
  } catch {
    report.status = "failed";
    report.selectionIssue = { code: "DISCOVERY_FAILED", message: "Unable to read all matching targets; no target inspections were started." };
    return report;
  }

  // 2. Reread each target and its version before inspecting metadata; isolate individual failures.
  let next = 0;
  const targets: BatchTarget[] = new Array(definitions.length);
  /** Consume independent targets while retaining discovery order in the final report. */
  async function worker() {
    while (next < definitions.length) {
      const index = next++;
      const selected = definitions[index]!;
      try {
        const current = await client.getVersioned(selected.id);
        targets[index] = { ...await diagnoseTarget(current.target, environment), targetVersion: current.etag };
      } catch {
        targets[index] = { id: selected.id, protocol: selected.protocol, transport: selected.connection.transport,
          status: "failed", checks: [{ id: "target", status: "failed", message: "The selected target could not be inspected.",
            action: "Check whether the registration changed or was removed, then retry discovery." }], executionVerified: false };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, definitions.length) }, () => worker()));

  // 3. Summarize prerequisites and metadata outcomes without writing registry state or claiming execution.
  report.targets = targets;
  report.complete = true;
  for (const target of targets) {
    report.summary[target.status]++;
  }
  report.status = report.summary.failed > 0 ? "failed" : report.summary.warning > 0 || targets.length === 0 ? "warning" : "passed";
  return report;
}
