// 0.15.3: Leanfare writes the level as the first line of its level tool's description, and says when it changes
// (notifications/tools/list_changed), so the leanfare-level mod reads it from the tool list with no call: in a Cowork
// task each call through the desktop app's link is a question for the person.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NOW_LINE, FEWER_CALLS, OFF_LEVEL, TOOLS, nowLine, withNowLine } from "../src/mcp";
import { saveSettings } from "../src/settings";
import { setSwitch } from "../src/switch";
import { ALL_TICKED, boot, reset, ui } from "./app";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const seen: any[] = [];
const waiting = new Map<number, (m: any) => void>();
let id = 1;
beforeAll(async () => {
  url = (await boot()).url;
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_LEVEL_WATCH_MS: "150" },
  });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffer += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        if (msg.method) { seen.push(msg); continue; }
        waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
      }
    }
  })();
});
afterAll(() => { try { child?.kill(); } catch {} setSwitch(true); });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); setSwitch(true); });
const rpc = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => {
  const n = id++;
  waiting.set(n, resolve);
  (child!.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); (child!.stdin as any).flush?.();
  setTimeout(() => { if (waiting.has(n)) { waiting.delete(n); reject(new Error(`no answer to ${method}`)); } }, 8000);
});
const levelDescription = (tools: any[]) => tools.find((t: any) => t.name === "level").description as string;
async function changed(ms = 3000) { const start = seen.length, end = Date.now() + ms; while (Date.now() < end) { if (seen.slice(start).some((m) => m.method === "notifications/tools/list_changed")) return true; await Bun.sleep(50); } return false; }

describe("the level line", () => {
  test("its words: the level, on or switched off, and the advice", () => {
    const v = { level: 4 as const, base: 4 as const, from: "default" as const, raised: null };
    expect(nowLine(v, true)).toStartWith("Leanfare now: level 4, on. Leanfare: level 4 (Most) in this chat.");
    expect(nowLine(v, true)).toContain(FEWER_CALLS);
    expect(nowLine(v, false)).toBe(`Leanfare now: level 1, switched off. ${OFF_LEVEL}`);
    expect(nowLine({ ...v, level: 1, base: 1 }, true)).not.toContain(FEWER_CALLS);
    const listed = withNowLine(TOOLS, nowLine(v, true));
    expect(levelDescription(listed)).toStartWith("Leanfare now: level 4, on.");
    expect(levelDescription(withNowLine(listed, nowLine(v, false)))).toStartWith("Leanfare now: level 4, on."); // never twice
    expect(listed.filter((t, i) => t.description !== TOOLS[i].description).map((t) => t.name)).toEqual(["level"]);
    expect(withNowLine(TOOLS, null)).toBe(TOOLS);
  });

  test("the door lists the level tool with the line, and says when the level or the switch changes", async () => {
    saveSettings({ level: 4 });
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
    const list = await rpc("tools/list");
    expect(levelDescription(list.result.tools)).toStartWith("Leanfare now: level 4, on.");
    expect(list.result.tools.filter((t: any) => NOW_LINE.test(t.description)).map((t: any) => t.name)).toEqual(["level"]);
    await Bun.sleep(400);
    expect(await changed(300)).toBe(false); // nothing changed, nothing said
    saveSettings({ level: 2 });
    expect(await changed()).toBe(true);
    expect(levelDescription((await rpc("tools/list")).result.tools)).toStartWith("Leanfare now: level 2, on.");
    setSwitch(false);
    expect(await changed()).toBe(true);
    expect(levelDescription((await rpc("tools/list")).result.tools)).toStartWith("Leanfare now: level 1, switched off.");
  });

  test("the app's own list, for a door older than the app, has the line too", async () => {
    saveSettings({ level: 5 });
    const r = await ui(url, "/api/mcp/tools");
    expect(levelDescription(r.json.tools)).toStartWith("Leanfare now: level 5, on.");
  });
});
