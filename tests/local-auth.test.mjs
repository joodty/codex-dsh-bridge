import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { WebSocketServer } from "ws";
import { LocalApiConnection, readLocalConnection } from "../scripts/local-auth.mjs";

test("local API auth uses cookie, holds one lifecycle socket, and releases it", async t => {
  const token = "a".repeat(43);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    assert.equal(url.pathname, "/connect");
    assert.equal(url.searchParams.get("token"), token);
    assert.equal(url.searchParams.get("interactions"), "none");
    res.writeHead(302, { location: "/api/remote.mux", "set-cookie": "dsh_test=value; HttpOnly; SameSite=Strict" });
    res.end();
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/api/remote.mux");
    assert.equal(req.headers.cookie, "dsh_test=value");
    ws.handleUpgrade(req, socket, head, client => ws.emit("connection", client));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = new LocalApiConnection({ baseUrl: new URL(`http://127.0.0.1:${server.address().port}`), token });
  t.after(async () => { client.close(); for (const socket of ws.clients) socket.terminate(); await new Promise(r => ws.close(r)); await new Promise(r => server.close(r)); });
  const connected = once(ws, "connection");
  assert.deepEqual(await client.headers(), { cookie: "dsh_test=value" });
  const [socket] = await connected;
  assert.deepEqual(await client.headers(), { cookie: "dsh_test=value" });
  assert.equal(ws.clients.size, 1);
  const closed = once(socket, "close"); client.close(); await closed;
});

test("malformed local connection errors never echo secret input", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "connection.json");
  await writeFile(path, JSON.stringify({ version: 1, token: "private-input", baseUrl: "https://remote.example" }));
  assert.throws(() => readLocalConnection(path, value => new URL(value)), error => !error.message.includes("private-input"));
});
