import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishConnection } from "../lib/local-connection.js";

test("publish current endpoint; old plugin cleanup preserves newer connection", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "private", "connection.json");
  const ctx = { webServer: { getOrigin: () => "http://127.0.0.1:43210" }, connection: { authenticatedUrl: origin => `${origin}/?token=${"a".repeat(43)}` } };
  const removeOld = await publishConnection(ctx, { path, instanceId: "old" });
  const removeNew = await publishConnection(ctx, { path, instanceId: "new" });
  await removeOld();
  const connection = JSON.parse(await readFile(path, "utf8"));
  assert.equal(connection.baseUrl, "http://127.0.0.1:43210");
  assert.equal(connection.instanceId, "new");
  await removeNew(); await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("publisher refuses remote targets", async () => {
  await assert.rejects(publishConnection({ webServer: { getOrigin: () => "http://remote.example:3080" } }), /loopback/);
});
