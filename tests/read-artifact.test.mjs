import assert from "node:assert/strict";
import test from "node:test";
import { DshClient } from "../scripts/dsh-client.mjs";
import { rc3RpcRequest } from "../scripts/dsh-rc3.mjs";

const page = () => ({ absolutePath: "D:\\workspace\\smoke.txt", version: "v1", bytes: 5,
  offset: 1, text: "hello", lines: 1, eof: true });
const client = () => Object.create(DshClient.prototype);

test("official workspaceFiles/read uses direct named scope, path and one-based range arguments", () => {
  const payload = { sessionId: "s", path: "smoke.txt", range: { offset: 1, limit: 100 } };
  for (const method of ["workspaceFiles.read", "workspaceFiles/read"]) {
    assert.deepEqual(rc3RpcRequest(method, payload), { method: "workspaceFiles/read", payload: {
      args: { workspaceFileScopeId: "s", path: "smoke.txt", range: { offset: 1, limit: 100 } },
    } });
  }
});

test("readArtifact requests one bounded plaintext page for its exact session and relative path", async () => {
  const instance = client();
  instance.rpc = async (method, payload) => {
    assert.equal(method, "workspaceFiles.read");
    assert.deepEqual(payload, { sessionId: "s", path: "results/smoke.txt", range: { offset: 1, limit: 100 } });
    return page();
  };
  assert.deepEqual(await instance.readArtifact({ sessionId: "s", path: "results\\smoke.txt" }), {
    sessionId: "s", path: "results/smoke.txt", ...page(),
  });
});

test("readArtifact rejects absolute paths, traversal, drive-relative paths, streams, and invalid session IDs before RPC", async () => {
  const instance = client();
  instance.rpc = async () => assert.fail("Invalid artifact paths must not reach RPC");
  for (const path of ["", " ", "../secret", "nested/../secret", "..\\secret", "/etc/passwd", "C:\\secret",
    "C:secret", "\\\\server\\share\\file", "\\secret", "//server/share/file", "file:stream", "https://host/file",
    "./file", "a//b", "a/", "bad\0path", "bad\npath", "x".repeat(2049)]) {
    await assert.rejects(instance.readArtifact({ sessionId: "s", path }), { code: "invalid-argument" });
  }
  await assert.rejects(instance.readArtifact({ sessionId: "", path: "smoke.txt" }), { code: "invalid-argument" });
});

test("readArtifact rejects malformed or oversized pages while preserving valid empty and partial text pages", async () => {
  const instance = client();
  for (const response of [null, {}, { ...page(), text: new Uint8Array(2) }, { ...page(), offset: 0 },
    { ...page(), lines: 101 }, { ...page(), lines: -1 }, { ...page(), eof: "true" }, { ...page(), version: undefined }]) {
    instance.rpc = async () => response;
    await assert.rejects(instance.readArtifact({ sessionId: "s", path: "smoke.txt" }), { code: "invalid-response" });
  }
  instance.rpc = async () => ({ ...page(), text: "界".repeat(50_000) });
  await assert.rejects(instance.readArtifact({ sessionId: "s", path: "smoke.txt" }), { code: "artifact-too-large" });
  for (const response of [{ ...page(), text: "", lines: 0 }, { ...page(), lines: 100, eof: false }]) {
    instance.rpc = async () => response;
    const result = await instance.readArtifact({ sessionId: "s", path: "smoke.txt" });
    assert.equal(result.text, response.text);
    assert.equal(result.eof, response.eof);
  }
});

test("readArtifact emits the confirmed workspaceFiles/read HTTP endpoint and exact argument envelope", async t => {
  const instance = client();
  instance.baseUrl = new URL("https://mock.example");
  instance.requestTimeoutMs = 1000;
  instance.localAuth = { headers: async () => ({ cookie: "mock-session=secret" }) };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.href, "https://mock.example/api/workspaceFiles/read");
    assert.equal(options.headers.cookie, "mock-session=secret");
    const request = JSON.parse(options.body);
    assert.equal(request.method, "workspaceFiles/read");
    assert.deepEqual(request.payload, { args: { workspaceFileScopeId: "s", path: "smoke.txt", range: { offset: 1, limit: 100 } } });
    return Response.json({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: page() } });
  });
  assert.equal((await instance.readArtifact({ sessionId: "s", path: "smoke.txt" })).text, "hello");
});
