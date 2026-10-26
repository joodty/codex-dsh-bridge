import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import test from "node:test";
import { DshClient, validateTargetEndpoint } from "../scripts/dsh-client.mjs";
import { CookieApiConnection, LocalApiConnection } from "../scripts/local-auth.mjs";

async function configFiles(t) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-remote-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, configPath: join(dir, "hub-target.json") };
}

const remoteEnv = extra => ({ DSH_ALLOW_REMOTE: "true", DSH_BASE_URL: "https://home.example", ...extra });

test("remote endpoint validation requires explicit HTTPS opt-in and never permits remote HTTP", () => {
  assert.equal(validateTargetEndpoint("https://home.example", { allowRemote: true }).origin, "https://home.example");
  assert.equal(validateTargetEndpoint("https://home.example:9443/", { allowRemote: true }).port, "9443");
  for (const value of ["https://home.example", "https://127.0.0.1:3080"]) assert.throws(() => validateTargetEndpoint(value));
  for (const value of ["http://home.example:3080", "http://192.168.1.2:3080", "http://127.0.0.2:3080",
    "https://user:secret@home.example", "https://home.example/api", "https://home.example?token=secret",
    "https://home.example#secret", "wss://home.example", "not a URL secret"]) {
    assert.throws(() => validateTargetEndpoint(value, { allowRemote: true }), error => !inspect(error).includes("secret"));
  }
});

test("target env and configPath are isolated from the company settings with constructor precedence", async t => {
  const { dir, configPath } = await configFiles(t);
  await writeFile(join(dir, "codex-dsh-bridge.json"), JSON.stringify({ enabled: false, baseUrl: "http://localhost:4090" }));
  await writeFile(configPath, JSON.stringify({ enabled: true, baseUrl: "http://localhost:5090" }));
  const env = remoteEnv({ DSH_HOME: dir, DSH_BRIDGE_COOKIE: "dsh_browser=private-cookie" });
  const client = new DshClient({ env, configPath });
  assert.equal(client.baseUrl.origin, "https://home.example");
  assert.equal(client.configSource, "environment");
  assert.equal(client.configPath, configPath);
  const explicit = new DshClient({ baseUrl: "https://office.example", env, configPath });
  assert.equal(explicit.baseUrl.origin, "https://office.example");
  assert.equal(explicit.configSource, "constructor");
  assert.throws(() => new DshClient({ env, configPath: join(dir, "codex-dsh-bridge.json") }), { code: "bridge-disabled" });
});

test("HTTPS needs one credential mode and local connection files retain exact origin pinning", async t => {
  const { dir, configPath } = await configFiles(t);
  for (const env of [remoteEnv(), remoteEnv({ DSH_ALLOW_REMOTE: "TRUE", DSH_BRIDGE_TOKEN: "secret" }),
    remoteEnv({ DSH_BRIDGE_TOKEN: "secret", DSH_BRIDGE_COOKIE: "a=b" }),
    remoteEnv({ DSH_BRIDGE_COOKIE: "a=b\r\nInjected: yes" }), remoteEnv({ DSH_BRIDGE_COOKIE: "Set-Cookie: secret" }),
    remoteEnv({ DSH_BRIDGE_TOKEN: "" })]) assert.throws(() => new DshClient({ env, configPath }));
  const connection = join(dir, "connection.json");
  await writeFile(connection, JSON.stringify({ version: 1, token: "a".repeat(43), baseUrl: "http://127.0.0.1:3080" }));
  const env = { DSH_BRIDGE_CONNECTION_FILE: connection };
  assert.equal(new DshClient({ env, configPath }).baseUrl.origin, "http://127.0.0.1:3080");
  for (const baseUrl of ["http://localhost:3080", "http://127.0.0.1:3081", "https://home.example"]) {
    assert.throws(() => new DshClient({ baseUrl, env: { ...env, DSH_ALLOW_REMOTE: "true" }, configPath }), { code: "connection-mismatch" });
    assert.throws(() => new DshClient({ env: { ...env, DSH_ALLOW_REMOTE: "true", DSH_BASE_URL: baseUrl }, configPath }), { code: "connection-mismatch" });
  }
  assert.throws(() => new DshClient({ env: { ...env, DSH_BRIDGE_TOKEN: "secret" }, configPath }), { code: "invalid-auth-config" });
});

function mockTransport(location = "/api/remote.mux") {
  const sockets = [];
  const requests = [];
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; sockets.push(this); queueMicrotask(() => this.emit("open")); }
    terminate() { this.emit("close"); }
  }
  return { sockets, requests, WebSocketImpl: Socket, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 302, headers: { location, "set-cookie": `dsh_api=issued-secret-${requests.length}; HttpOnly; Secure` } });
  } };
}

test("HTTPS launch token uses interactions=none, same-origin WSS, one peer, and reconnects after restart", async () => {
  const transport = mockTransport();
  const auth = new LocalApiConnection({ baseUrl: new URL("https://home.example"), token: "private-token" }, transport);
  const headers = await Promise.all([auth.headers(), auth.headers()]);
  assert.deepEqual(headers, [{ cookie: "dsh_api=issued-secret-1" }, { cookie: "dsh_api=issued-secret-1" }]);
  assert.equal(transport.requests.length, 1);
  const { url, options } = transport.requests[0];
  assert.equal(url.origin, "https://home.example");
  assert.equal(url.pathname, "/connect");
  assert.equal(url.searchParams.get("token"), "private-token");
  assert.equal(url.searchParams.get("interactions"), "none");
  assert.equal(options.redirect, "manual");
  assert.equal(transport.sockets[0].url.href, "wss://home.example/api/remote.mux");
  assert.equal(transport.sockets[0].options.headers.cookie, "dsh_api=issued-secret-1");
  assert.ok(!inspect(auth).includes("private-token"));
  assert.ok(!inspect(auth).includes("issued-secret"));
  transport.sockets[0].emit("close");
  assert.deepEqual(await auth.headers(), { cookie: "dsh_api=issued-secret-2" });
  assert.equal(transport.sockets.length, 2);
  assert.equal(auth.redact("private-token issued-secret-1 issued-secret-2"), "[redacted] [redacted] [redacted]");
  auth.close();
});

test("launch authentication rejects foreign, downgraded, malformed, and credential-bearing lifecycle redirects", async () => {
  for (const location of ["https://evil.example/api/remote.mux", "wss://evil.example/api/remote.mux",
    "ws://home.example/api/remote.mux", "http://home.example/api/remote.mux", "https://home.example:9443/api/remote.mux",
    "wss://user:secret@home.example/api/remote.mux", "/api/remote.mux#secret", "/other", "https://["]) {
    const transport = mockTransport(location);
    const auth = new LocalApiConnection({ baseUrl: new URL("https://home.example"), token: "secret" }, transport);
    await assert.rejects(auth.headers(), error => !inspect(error).includes("secret"));
    assert.equal(transport.sockets.length, 0);
  }
  for (const location of ["wss://home.example/api/remote.mux", "https://home.example/api/remote.mux"]) {
    const transport = mockTransport(location);
    const auth = new LocalApiConnection({ baseUrl: new URL("https://home.example"), token: "secret" }, transport);
    await auth.headers();
    assert.equal(transport.sockets[0].url.protocol, "wss:");
    auth.close();
  }
});

test("cookie mode uses HTTPS RPC headers directly across client restarts without connecting API peers", async t => {
  const { configPath } = await configFiles(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url.href);
    assert.equal(url.origin, "https://home.example");
    assert.equal(url.pathname, "/api/session/modelCatalog");
    assert.equal(options.headers.cookie, "dsh_browser=private-cookie; session=other-private");
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    return Response.json({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: { default: { provider: "mock", model: "mock" }, groups: [], failures: [] } } });
  });
  for (let i = 0; i < 2; i++) {
    const client = new DshClient({ env: remoteEnv({ DSH_BRIDGE_COOKIE: "dsh_browser=private-cookie; session=other-private" }), configPath });
    assert.ok(client.localAuth instanceof CookieApiConnection);
    assert.ok(!inspect(client).includes("private-cookie"));
    assert.equal((await client.describe()).defaultModel.model, "mock");
    client.close();
  }
  assert.equal(calls.length, 2);
});

test("response and network errors do not echo launch tokens or persistent cookies", async t => {
  const { configPath } = await configFiles(t);
  const client = new DshClient({ env: remoteEnv({ DSH_BRIDGE_COOKIE: "dsh_browser=private-cookie" }), configPath });
  const tokenClient = new DshClient({ env: remoteEnv({ DSH_BRIDGE_TOKEN: "private-token" }), configPath });
  // This test exercises RPC errors without opening a socket. Lifecycle transport is tested above.
  tokenClient.localAuth.headers = async () => ({ cookie: "mock" });
  let reply;
  t.mock.method(globalThis, "fetch", async () => { if (reply instanceof Error) throw reply; return reply; });
  for (const current of [client, tokenClient]) for (const value of [
    new Error("private-token private-cookie"),
    new Response("private-token private-cookie", { status: 502 }),
    Response.json({ secret: "private-token private-cookie" }, { status: 403 }),
    Response.json({ secret: "private-token private-cookie" }),
  ]) {
    reply = value;
    await assert.rejects(current.describe(), error => !inspect(error).includes("private-token") && !inspect(error).includes("private-cookie"));
  }
  t.mock.method(globalThis, "fetch", async (_url, options) => Response.json({ type: "server-response", rpcId: JSON.parse(options.body).rpcId,
    result: { ok: false, error: { code: "echo-private-cookie", message: "echo private-cookie", details: { secret: "private-cookie" } } } }));
  await assert.rejects(client.describe(), error => !inspect(error).includes("private-cookie") && error.code === "echo-[redacted]");
});
