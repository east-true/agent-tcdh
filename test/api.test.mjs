// Non-English data below intentionally exercises Unicode metadata and search.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { definition, fixture, register, temporaryDirectory } from "./helpers.mjs";

test("remote MCP capabilities, input schemas, and connection details survive registration", async (t) => {
  const app = await fixture(t);
  const target = definition("docs", {
    capabilities: [{
      name: "search",
      description: "문서 검색",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }],
  });
  const response = await register(app, target);
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers.location, "/api/targets/docs");
  const saved = response.json();
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.capabilities, target.capabilities);
  assert.deepEqual(saved.connection, target.connection);
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)));
  assert.deepEqual((await app.inject("/api/targets/docs")).json(), saved);
});

test("local MCP commands are stored as connection metadata without execution", async (t) => {
  const app = await fixture(t);
  const connection = {
    transport: "stdio",
    command: "/does-not-exist/never-run",
    args: ["--example", "literal; $(never-execute)"],
    envVars: ["EXAMPLE_TOKEN"],
  };
  const response = await register(app, definition("local", { connection }));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().connection, connection);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
});

test("A2A registrations preserve card URLs and authentication requirements", async (t) => {
  const app = await fixture(t);
  const connection = {
    transport: "http", url: "https://agent.example.com",
    agentCardUrl: "https://agent.example.com/.well-known/agent-card.json",
    auth: { type: "bearer", envVars: ["AGENT_TOKEN"] },
  };
  const response = await register(app, definition("research", { protocol: "a2a", connection }));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().connection, connection);
});

test("duplicate target ids preserve existing data and total counts", async (t) => {
  const app = await fixture(t);
  const responses = await Promise.all([
    register(app, definition()),
    register(app, definition("docs", { name: "Duplicate" })),
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal((await app.inject("/api/targets")).json().total, 1);
});

test("updates preserve creation timestamps and replace searchable metadata", async (t) => {
  const app = await fixture(t);
  const original = (await register(app, definition())).json();
  const replacement = definition("docs", { name: "Updated", description: "새로운 기능" });
  const response = await app.inject({ method: "PUT", url: "/api/targets/docs", payload: replacement });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().createdAt, original.createdAt);
  assert.equal((await app.inject("/api/targets?q=Updated")).json().total, 1);
  assert.equal((await app.inject("/api/targets?q=Documentation")).json().total, 0);
  const mismatch = await app.inject({
    method: "PUT", url: "/api/targets/docs", payload: definition("other"),
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal((await app.inject("/api/targets/docs")).json().name, "Updated");
});

test("deletion immediately affects discovery and missing targets return 404", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  assert.equal((await app.inject({ method: "DELETE", url: "/api/targets/docs" })).statusCode, 204);
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  assert.equal((await app.inject("/api/targets/docs")).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/targets/docs" })).statusCode, 404);
  assert.equal((await app.inject({
    method: "PUT", url: "/api/targets/docs", payload: definition(),
  })).statusCode, 404);
});

test("all keywords may match across different fields and results are ranked", async (t) => {
  const app = await fixture(t);
  await register(app, definition("a", { name: "Guide", description: "배포 문서" }));
  await register(app, definition("b", { name: "배포", description: "문서" }));
  await register(app, definition("c", { name: "배포", description: "관련 없는 내용", tags: [], capabilities: [] }));
  const results = (await app.inject("/api/targets?q=" + encodeURIComponent("배포 문서"))).json();
  assert.equal(results.total, 2);
  assert.deepEqual(results.items.map((item) => item.id), ["b", "a"]);
  assert.equal((await app.inject("/api/targets?q=" + encodeURIComponent("' OR 1=1 --"))).json().total, 0);
});

test("protocol and tag filters are applied before pagination and total counts", async (t) => {
  const app = await fixture(t);
  await register(app, definition("a"));
  await register(app, definition("b", { tags: ["Docs"] }));
  await register(app, definition("c", { tags: ["other"] }));
  await register(app, definition("d", {
    protocol: "a2a", connection: { transport: "http", url: "https://agent.example.com" },
  }));
  const results = (await app.inject("/api/targets?protocol=mcp&tag=docs&limit=1&offset=1")).json();
  assert.equal(results.total, 2);
  assert.equal(results.limit, 1);
  assert.equal(results.offset, 1);
  assert.deepEqual(results.items.map((item) => item.id), ["b"]);
  assert.equal((await app.inject("/api/targets?offset=99")).json().items.length, 0);
});

test("disabled targets can be re-enabled and false strings are not treated as true", async (t) => {
  const app = await fixture(t);
  await register(app, definition());
  const disabled = definition("docs", { enabled: false });
  await app.inject({ method: "PUT", url: "/api/targets/docs", payload: disabled });
  assert.equal((await app.inject("/api/targets")).json().total, 0);
  assert.equal((await app.inject("/api/targets?includeDisabled=false")).json().total, 0);
  assert.equal((await app.inject("/api/targets?includeDisabled=true")).json().total, 1);
  assert.equal((await app.inject("/api/targets/docs")).json().enabled, false);
  await app.inject({ method: "PUT", url: "/api/targets/docs", payload: definition() });
  assert.equal((await app.inject("/api/targets")).json().total, 1);
});

test("unsupported search options and invalid pagination are rejected", async (t) => {
  const app = await fixture(t);
  for (const query of [
    "limit=0", "limit=101", "limit=abc", "offset=-1", "offset=1.2",
    "protocol=unknown", "includeDisabled=yes", "unknown=value", "q=a&q=b",
  ]) {
    const response = await app.inject("/api/targets?" + query);
    assert.equal(response.statusCode, 400, query);
  }
});

test("protocol, connection, and metadata boundaries are validated", async (t) => {
  const app = await fixture(t);
  const invalid = [
    definition("../escape"),
    definition("space", { name: "   " }),
    definition("proto", { protocol: "a2a", connection: { transport: "stdio", command: "node" } }),
    definition("url", { connection: { transport: "streamable-http", url: "file:///etc/passwd" } }),
    definition("credentials", { connection: { transport: "sse", url: "https://user:secret@example.com" } }),
    definition("fragment", { connection: { transport: "sse", url: "https://example.com/#fragment" } }),
    definition("env", { connection: { transport: "stdio", command: "node", env: { TOKEN: "secret" } } }),
    definition("auth", { connection: { transport: "sse", url: "https://example.com", auth: { type: "bearer", token: "secret" } } }),
    definition("duplicate", { capabilities: [{ name: "same" }, { name: "same" }] }),
    { ...definition("unknown"), unexpected: true },
  ];
  for (const target of invalid) {
    const response = await register(app, target);
    assert.equal(response.statusCode, 400, target.id);
    assert.equal(response.json().error.code, "INVALID_INPUT");
  }
  assert.equal((await app.inject("/api/targets")).json().total, 0);
});

test("hub tokens protect reads and writes while health remains public", async (t) => {
  const app = await fixture(t, { token: "test-secret" });
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/api/targets")).statusCode, 401);
  assert.equal((await register(app, definition())).statusCode, 401);
  assert.equal((await app.inject({
    url: "/api/targets", headers: { authorization: "Bearer wrong" },
  })).statusCode, 401);
  const headers = { authorization: "Bearer test-secret" };
  assert.equal((await register(app, definition(), headers)).statusCode, 201);
  assert.equal((await app.inject({ url: "/api/targets", headers })).json().total, 1);
});

test("body size limits and invalid JSON use consistent error responses", async (t) => {
  const app = await fixture(t);
  const invalid = await app.inject({
    method: "POST", url: "/api/targets",
    headers: { "content-type": "application/json" }, payload: "{",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_REQUEST");
  const large = await app.inject({
    method: "POST", url: "/api/targets",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ data: "x".repeat(1_048_576) }),
  });
  assert.equal(large.statusCode, 413);
});

test("SQLite preserves updates, deletions, and connection details across restart", async (t) => {
  const directory = await temporaryDirectory(t);
  const dbPath = join(directory, "nested", "registry.sqlite");
  const first = createApp({ logger: false, dbPath });
  await register(first, definition("keep"));
  await register(first, definition("remove"));
  await first.inject({
    method: "PUT", url: "/api/targets/keep", payload: definition("keep", { enabled: false }),
  });
  await first.inject({ method: "DELETE", url: "/api/targets/remove" });
  await first.close();
  const second = await fixture(t, { dbPath });
  assert.equal((await second.inject("/api/targets")).json().total, 0);
  const saved = (await second.inject("/api/targets?includeDisabled=true")).json();
  assert.equal(saved.total, 1);
  assert.equal(saved.items[0].id, "keep");
  assert.equal(saved.items[0].connection.url, "http://127.0.0.1:1/mcp");
});

test("unsupported database versions are not overwritten", async (t) => {
  const directory = await temporaryDirectory(t);
  const dbPath = join(directory, "future.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA user_version = 99");
  database.close();
  assert.throws(() => createApp({ logger: false, dbPath }), /version/);
  const reopened = new DatabaseSync(dbPath);
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 99);
  reopened.close();
});
