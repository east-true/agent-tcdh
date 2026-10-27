import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "./app.js";
import { hubAuthFields, validateTokenPair } from "./auth.js";
import { publicUrlSchema } from "./a2a-http.js";

export const defaultDatabasePath = join(homedir(), ".agent-tcdh", "registry.sqlite");
export const serverOptionsSchema = z.strictObject({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  dbPath: z.string().trim().min(1).default(defaultDatabasePath),
  publicUrl: publicUrlSchema.optional(),
  ...hubAuthFields,
  allowedOrigins: z.array(z.string().refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && value === url.origin;
    } catch {
      return false;
    }
  }, "Origins must be HTTP(S) origins without paths.")).default([]),
}).superRefine(validateTokenPair);
export type ServerOptions = z.infer<typeof serverOptionsSchema>;

/** Start the persistent HTTP server and clean up connections on shutdown signals. */
export async function runServer(options: ServerOptions): Promise<void> {
  // 1. Create the API from validated settings and open the listener.
  const app = createApp({
    dbPath: options.dbPath,
    allowedOrigins: options.allowedOrigins,
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.readToken ? { readToken: options.readToken } : {}),
  });
  try {
    await app.listen({ host: options.host, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }

  // 2. Ignore duplicate shutdown signals while closing the database and HTTP connections.
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await app.close();
    } catch (error) {
      app.log.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
