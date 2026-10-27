import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

export type AccessRole = "public" | "read" | "admin";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: AccessRole;
  }
}

export const hubTokenSchema = z.string().regex(
  /^[\x21-\x7e]+$/,
  "Hub tokens must be ASCII strings without whitespace or control characters.",
);
export const hubAuthFields = {
  token: hubTokenSchema.optional(),
  readToken: hubTokenSchema.optional(),
};

/** Validate the administrator token requirement and distinct read token. */
export function validateTokenPair(
  value: { token?: string | undefined; readToken?: string | undefined },
  context: z.RefinementCtx,
): void {
  // 1. Require an administrator token so read-only mode cannot expose anonymous mutations.
  if (value.readToken && !value.token) {
    context.addIssue({
      code: "custom", path: ["readToken"], message: "A read token requires an administrator token.",
    });
  }

  // 2. Reject a token shared by different access roles.
  if (value.readToken && value.readToken === value.token) {
    context.addIssue({
      code: "custom", path: ["readToken"], message: "Administrator and read tokens must be different.",
    });
  }
}

export const hubAuthSchema = z.strictObject(hubAuthFields).superRefine(validateTokenPair);
export type HubAuthOptions = z.infer<typeof hubAuthSchema>;

/** Check tokens and declared route permissions before processing request bodies. */
export function registerAccessControl(app: FastifyInstance, input: HubAuthOptions): void {
  // 1. Validate configuration and retain fixed-length token hashes.
  const options = hubAuthSchema.parse(input);
  if (!options.token) {
    return;
  }
  const adminHash = createHash("sha256").update(options.token).digest();
  const readHash = options.readToken ? createHash("sha256").update(options.readToken).digest() : undefined;

  // 2. Authenticate every non-public request and enforce administrator permissions.
  app.addHook("onRequest", async (request, reply) => {
    const access = request.routeOptions.config.access ?? "admin";
    if (access === "public") {
      return;
    }
    const raw = request.headers.authorization ?? "";
    const token = /^Bearer +([\x21-\x7e]+)$/i.exec(raw)?.[1] ?? "";
    const candidate = createHash("sha256").update(token).digest();
    const admin = timingSafeEqual(adminHash, candidate);
    const read = readHash ? timingSafeEqual(readHash, candidate) : false;
    if (!admin && !read) {
      return reply.header("WWW-Authenticate", "Bearer").code(401).send({
        error: { code: "UNAUTHORIZED", message: "A valid hub token is required." },
      });
    }
    if (!admin && access !== "read") {
      return reply.code(403).send({
        error: { code: "FORBIDDEN", message: "An administrator hub token is required." },
      });
    }
  });
}

/** Read the hub token from the environment variable selected by the CLI. */
export function readClientToken(
  variable = "AGENT_TCDH_TOKEN",
  required = false,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // 1. Validate the variable name and explicitly selected credential.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error("Specify a valid token environment variable name.");
  }
  const token = environment[variable] || undefined;
  if (required && !token) {
    throw new Error("The hub token environment variable is empty: " + variable);
  }

  // 2. Use fixed validation messages to avoid exposing token values.
  if (token && !hubTokenSchema.safeParse(token).success) {
    throw new Error("Hub tokens must be ASCII strings without whitespace or control characters.");
  }

  return token;
}
