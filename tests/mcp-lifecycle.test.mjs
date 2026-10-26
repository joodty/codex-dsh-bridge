import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import test from "node:test";

test("MCP creation retains authenticated peer until async operation finishes", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mcp-"));
  const ws = new WebSocketServer({ noServer: true });
  let closedDuringRequest = false;
  const server = createServer(async (req, res) => {
    if (req.url.startsWith("/connect?")) {
      res.writeHead(302, { location: "/api/remote.mux", "set-cookie": "test_session=ok; HttpOnly" });
      res.end(); return;
    }
    assert.equal(req.url, "/api/session/create");
    assert.equal(req.headers.cookie, "test_session=ok");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.method, "session/create");
    assert.equal(body.payload.args.request.cwd, directory);
    const socket = [...ws.clients][0];
    assert.ok(socket, "peer must be connected before RPC");
    const listener = () => { closedDuringRequest = true; };
    socket.once("close", listener);
    await new Promise(resolve => setTimeout(resolve, 80));
    socket.off("close", listener);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { sessionId: "new-session" } } }));
  });
  server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head, peer => ws.emit("connection", peer)));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const path = join(directory, "connection.json");
  await writeFile(path, JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${server.address().port}`, token: "a".repeat(43) }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/server.mjs", import.meta.url))], { env: { ...process.env, DSH_HOME: directory, DSH_BASE_URL: "", DSH_BRIDGE_CONNECTION_FILE: path }, windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => { child.kill(); lines.close(); for (const peer of ws.clients) peer.terminate(); await new Promise(r => ws.close(r)); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); });
  const reply = once(lines, "line");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dsh_create_session", arguments: { cwd: directory } } }) + "\n");
  const [line] = await reply;
  const result = JSON.parse(line).result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.sessionId, "new-session");
  assert.equal(closedDuringRequest, false, "finally must not dispose an unresolved tool operation");
});
