import { readFileSync } from "node:fs";
import WebSocket from "ws";

// Pin the exact company desktop file via env; never search browser profiles or remote hosts.
export function readLocalConnection(path, validateBaseUrl) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Local DSH connection is unavailable. Start the company DSH desktop with its bridge companion enabled."); }
  if (value?.version !== 1 || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(value.token)) {
    throw new Error("Invalid local DSH connection file.");
  }
  return { ...value, baseUrl: validateBaseUrl(value.baseUrl) };
}

export class LocalApiConnection {
  constructor(connection) { this.connection = connection; }
  async headers() {
    if (!this.pending) this.pending = this.connect().catch(error => { this.pending = undefined; throw error; });
    return this.pending;
  }
  async connect() {
    const url = new URL("/connect", this.connection.baseUrl);
    url.searchParams.set("token", this.connection.token);
    url.searchParams.set("interactions", "none");
    let response;
    try {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    } catch { throw new Error("Cannot authenticate to the local company DSH desktop. It may have restarted; retry the call."); }
    if (response.status !== 302) throw new Error(`Local DSH API authentication failed (HTTP ${response.status}).`);
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const location = response.headers.get("location");
    if (!cookie || !location) throw new Error("DSH API authentication response is incomplete.");
    const wsUrl = new URL(location, this.connection.baseUrl);
    if (wsUrl.origin.replace(/^ws/, "http") !== this.connection.baseUrl.origin || wsUrl.pathname !== "/api/remote.mux") {
      throw new Error("DSH API returned an unexpected connection target.");
    }
    wsUrl.protocol = "ws:";
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { cookie }, handshakeTimeout: 10000 });
      this.socket = socket;
      socket.once("open", resolve);
      socket.on("error", () => reject(new Error("Local DSH API lifecycle socket failed.")));
      socket.on("close", () => { this.pending = undefined; });
    });
    return { cookie };
  }
  close() { this.socket?.terminate(); this.pending = undefined; }
}
