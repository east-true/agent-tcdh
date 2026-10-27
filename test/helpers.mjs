// Non-English data below intentionally exercises Unicode metadata and search.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../dist/app.js";
import { after } from "node:test";

const temporaryDirectories = new Set();
// File-level cleanup follows all per-test server, worker, and SQLite teardown hooks.
after(async () => {
  for (const path of temporaryDirectories) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/** Create an isolated directory and retain it until per-test database handles are closed. */
export async function temporaryDirectory(_t) {
  const path = await mkdtemp(join(tmpdir(), "agent-tcdh-test-"));
  temporaryDirectories.add(path);
  return path;
}

/** Build an MCP registration fixture without requiring external connections. */
export function definition(id = "docs", overrides = {}) {
  return {
    id,
    name: "Documentation",
    description: "개발 문서와 배포 가이드 검색",
    protocol: "mcp",
    tags: ["docs"],
    capabilities: [{ name: "search_docs", description: "공식 자료 조사" }],
    connection: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp" },
    ...overrides,
  };
}

/** Prepare an isolated API store and close it after the test. */
export async function fixture(t, options = {}) {
  const app = createApp({ logger: false, dbPath: ":memory:", ...options });
  await app.ready();
  t.after(async () => {
    await app.close();
  });

  return app;
}

/** Submit a registration request for server-side validation. */
export async function register(app, target, headers = {}) {
  return app.inject({ method: "POST", url: "/api/targets", payload: target, headers });
}
