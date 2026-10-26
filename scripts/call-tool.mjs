import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// CLI fallback for an existing Codex chat whose MCP tool inventory has not reloaded.
const [name, argumentsFile] = process.argv.slice(2);
if (!name) throw new Error("Usage: node scripts/call-tool.mjs <tool-name> [arguments.json]");
const args = argumentsFile ? JSON.parse(await readFile(argumentsFile, "utf8")) : {};
const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map();
let nextId = 1;
let stderr = "";
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  try {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  } catch (error) { for (const request of pending.values()) request.reject(error); }
});
child.on("error", error => { for (const request of pending.values()) request.reject(error); });
child.on("exit", code => { for (const request of pending.values()) request.reject(new Error(`MCP server exited (${code}). ${stderr}`)); });
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const timeout = setTimeout(() => { child.kill(); }, 340000);
try {
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "codex-dsh-bridge-cli", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list", {});
  if (!listed.tools.some(tool => tool.name === name)) throw new Error(`Unknown DSH tool: ${name}`);
  const result = await request("tools/call", { name, arguments: args });
  console.log(JSON.stringify({ transport: "mcp-stdio", server: initialized.serverInfo, tool: name, result }, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { clearTimeout(timeout); lines.close(); child.stdin.end(); child.kill(); }
