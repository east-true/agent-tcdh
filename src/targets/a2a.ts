import { z } from "zod";
import { a2aBindingSchema, a2aVersionSchema, httpUrl } from "./schema.js";

export const a2aSelectionSchema = z.strictObject({
  protocolBinding: a2aBindingSchema.optional(),
  protocolVersion: a2aVersionSchema.optional(),
});
export type A2aSelection = z.infer<typeof a2aSelectionSchema>;

export const agentCardSchema = z.looseObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  url: z.string().optional(),
  protocolVersion: a2aVersionSchema.optional(),
  preferredTransport: z.string().optional(),
  supportedInterfaces: z.array(z.looseObject({
    url: z.string(),
    protocolBinding: z.string(),
    protocolVersion: a2aVersionSchema.optional(),
  })).optional(),
  additionalInterfaces: z.array(z.looseObject({
    url: z.string(),
    transport: z.string(),
  })).optional(),
  skills: z.array(z.looseObject({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().default(""),
  })).max(200),
});

interface InterfaceCandidate {
  url: string;
  protocolBinding?: string | undefined;
  protocolVersion?: string | undefined;
}
export interface SelectedA2aInterface {
  url: string;
  protocolBinding?: z.infer<typeof a2aBindingSchema>;
  protocolVersion?: string;
}

/** Select an HTTP interface matching the requested binding and version from native or legacy cards. */
export function selectA2aInterface(
  card: z.infer<typeof agentCardSchema>,
  selection: A2aSelection = {},
): SelectedA2aInterface {
  // 1. Treat a native interface list as authoritative; handle legacy declarations separately.
  const candidates: InterfaceCandidate[] = card.supportedInterfaces !== undefined
    ? card.supportedInterfaces
    : [
      ...(card.url === undefined ? [] : [{
        url: card.url, protocolBinding: card.preferredTransport, protocolVersion: card.protocolVersion,
      }]),
      ...(card.additionalInterfaces ?? []).map((entry) => ({
        url: entry.url, protocolBinding: entry.transport, protocolVersion: card.protocolVersion,
      })),
    ];

  // 2. Filter supported HTTP URLs and bindings and apply explicit selection criteria.
  const supported = candidates.filter((entry) => httpUrl.safeParse(entry.url).success
    && (entry.protocolBinding === undefined || a2aBindingSchema.safeParse(entry.protocolBinding).success));
  const selected = supported.find((entry) => (
    (selection.protocolBinding === undefined || entry.protocolBinding === selection.protocolBinding)
    && (selection.protocolVersion === undefined || entry.protocolVersion === selection.protocolVersion)
  ));
  if (!selected) {
    if (supported.length === 0) {
      throw new Error("The Agent Card has no supported HTTP endpoint.");
    }
    throw new Error("The Agent Card has no matching A2A binding and version. Check its declared interfaces.");
  }

  // 3. Return declared metadata only; never infer a missing protocol version.
  return {
    url: selected.url,
    ...(selected.protocolBinding === undefined ? {} : { protocolBinding: a2aBindingSchema.parse(selected.protocolBinding) }),
    ...(selected.protocolVersion === undefined ? {} : { protocolVersion: selected.protocolVersion }),
  };
}
