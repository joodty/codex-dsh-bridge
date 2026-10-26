import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeLoopbackBaseUrl, resolveBridgeConfigPath } from "./config.js";

export function connectionFilePath() {
  return join(dirname(resolveBridgeConfigPath()), ".codex-dsh-bridge", "connection.json");
}

// This is a local credential handoff, never a public settings response or log.
export async function publishConnection(ctx, { path = connectionFilePath(), instanceId = randomUUID() } = {}) {
  const baseUrl = normalizeLoopbackBaseUrl(ctx.webServer.getOrigin());
  const url = new URL(ctx.connection.authenticatedUrl(baseUrl));
  const token = url.searchParams.get("token");
  if (!token) throw new Error("DSH did not provide an API launch token.");
  const value = { version: 1, baseUrl, token, pid: process.pid, instanceId };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${instanceId}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return async () => {
    try {
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.instanceId === instanceId) await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}
