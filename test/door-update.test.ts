// A door older than the app (mcp.ts, 0.11): an app keeps the `leanfare mcp` it started running until it restarts, so
// after an update its door can be older than the running Leanfare. Such a door hands each call, the list of tools and
// the MCP Apps' pages to the app, which runs them with its newer code, for that app and its folder; it says so once.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../src/config";
import { db } from "../src/db";
import { TOOLS } from "../src/mcp";
import { boot, keys, reset, ui } from "./app";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const waiting = new Map<number | string, (m: any) => void>();
const notes: any[] = [];
let nextId = 1;
const folder = mkdtempSync(join(tmpdir(), "leanfare-olddoor-"));
beforeAll(async () => {
  url = (await boot()).url;
  writeFileSync(join(folder, "app.log"), "10:00 start\n10:01 error: disk full\n");
  // An older door: its own version below the app's, started in a project folder.
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    cwd: folder, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_DOOR_VERSION: "0.9.0" },
  });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffer += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        if (msg.method) { notes.push(msg); continue; }
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  })();
});
afterAll(() => { try { child?.kill(); } catch {} rmSync(folder, { recursive: true, force: true }); });
beforeEach(async () => { await reset({ ticked: ["deepseek/deepseek-v4-flash"] }); await keys("deepseek"); });
function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    (child!.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    (child!.stdin as any).flush?.();
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${method}`)); } }, 15000);
  });
}

describe("a door older than the app", () => {
  test("hands a call to the app, says so once, and tells the app its tools changed", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai" } });
    expect(init.result.serverInfo.version).toBe("0.9.0");
    const first = await rpc("tools/call", { name: "models", arguments: {} });
    expect(first.result.isError).toBeUndefined();
    const said = first.result.content.at(-1).text;
    expect(said).toBe(`(Leanfare was updated to ${VERSION} while Claude kept its 0.9.0 door running: this call went through the updated app. Quit and reopen Claude to see the new tools.)`);
    for (let i = 0; i < 40 && !notes.some((n) => n.method === "notifications/tools/list_changed"); i++) await Bun.sleep(25);
    expect(notes.filter((n) => n.method === "notifications/tools/list_changed")).toHaveLength(1);
    const again = await rpc("tools/call", { name: "models", arguments: {} });
    expect(again.result.content.some((c: any) => c.text?.startsWith("(Leanfare was updated"))).toBe(false);
  });
  test("lists the app's tools, and serves the app's pages", async () => {
    const list = await rpc("tools/list", {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const page = await rpc("resources/read", { uri: "ui://leanfare/plan" });
    expect(page.result.contents[0].text).toContain("<");
  });
  test("a file named from the app's own folder is read there, by the app, for this door", async () => {
    const r = await rpc("tools/call", { name: "delegate", arguments: { task: "List the errors.", files: ["app.log"], kind: "read", effort: "low", check: "never" } });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text.split("\n\n")[0]).toBe("Hello from deepseek-v4-flash.");
    expect(db.query("SELECT files, file_tokens FROM delegations ORDER BY id DESC LIMIT 1").get()).toEqual({ files: 1, file_tokens: 9 }); // app.log, read
  });
  test("only Leanfare's own door may have the app run a call: it carries the control token", async () => {
    const r = await ui(url, "/api/mcp/call", { name: "models", arguments: {} });
    expect(r.status).toBe(403);
    const tools = await ui(url, "/api/mcp/tools");
    expect([tools.status, tools.json.version]).toEqual([200, VERSION]);
  });
});
