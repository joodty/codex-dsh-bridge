import { readFileSync } from "node:fs";
import WebSocket from "ws";

function redact(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [redact(key, secrets), redact(item, secrets)]));
  return value;
}

function cookieSecrets(cookie) {
  return [cookie, ...cookie.split(";").map(part => part.slice(part.indexOf("=") + 1).trim()).filter(Boolean)];
}

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
  #connection;
  #socket;
  #generation = 0;
  #secrets;
  #fetch;
  #WebSocket;
  #pending;
  constructor(connection, { fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    this.#connection = connection;
    this.#secrets = [connection.token];
    this.#fetch = fetchImpl;
    this.#WebSocket = WebSocketImpl;
  }
  redact(value) { return redact(value, this.#secrets); }
  async headers() {
    if (!this.#pending) {
      const pending = this.connect().catch(error => {
        if (this.#pending === pending) this.#pending = undefined;
        throw error;
      });
      this.#pending = pending;
    }
    return this.#pending;
  }
  async connect() {
    const generation = this.#generation;
    const url = new URL("/connect", this.#connection.baseUrl);
    url.searchParams.set("token", this.#connection.token);
    url.searchParams.set("interactions", "none");
    let response;
    try {
      response = await this.#fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    } catch { throw new Error("Cannot authenticate to DSH. The service may have restarted; retry the call."); }
    if (response.status !== 302) throw new Error(`DSH API authentication failed (HTTP ${response.status}).`);
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    this.#secrets.push(...cookieSecrets(cookie));
    const location = response.headers.get("location");
    if (!cookie || !location) throw new Error("DSH API authentication response is incomplete.");
    let wsUrl;
    try { wsUrl = new URL(location, this.#connection.baseUrl); }
    catch { throw new Error("DSH API returned an unexpected connection target."); }
    const expectedProtocol = this.#connection.baseUrl.protocol === "https:" ? "wss:" : "ws:";
    const httpOrigin = wsUrl.protocol === "wss:" || wsUrl.protocol === "ws:"
      ? wsUrl.origin.replace(/^ws/, "http") : wsUrl.origin;
    if (httpOrigin !== this.#connection.baseUrl.origin || wsUrl.pathname !== "/api/remote.mux"
      || wsUrl.username || wsUrl.password || wsUrl.hash
      || ![this.#connection.baseUrl.protocol, expectedProtocol].includes(wsUrl.protocol)) {
      throw new Error("DSH API returned an unexpected connection target.");
    }
    wsUrl.protocol = expectedProtocol;
    if (generation !== this.#generation) throw new Error("DSH API connection was closed.");
    await new Promise((resolve, reject) => {
      const socket = new this.#WebSocket(wsUrl, { headers: { cookie }, handshakeTimeout: 10000 });
      this.#socket = socket;
      socket.once("open", resolve);
      socket.on("error", () => reject(new Error("DSH API lifecycle socket failed.")));
      socket.on("close", () => {
        if (this.#socket === socket) { this.#socket = undefined; this.#pending = undefined; }
        reject(new Error("DSH API lifecycle socket closed before connecting."));
      });
    });
    return { cookie };
  }
  close() { this.#generation++; this.#socket?.terminate(); this.#socket = undefined; this.#pending = undefined; }
}

// A persistent browser-session cookie has no API-peer lifecycle. Closing this
// wrapper must not open or release an API connection on the target service.
export class CookieApiConnection {
  #cookie;
  constructor(cookie) { this.#cookie = cookie; }
  redact(value) { return redact(value, cookieSecrets(this.#cookie)); }
  async headers() { return { cookie: this.#cookie }; }
  close() {}
}
