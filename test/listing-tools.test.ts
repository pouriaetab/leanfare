// The tools as the MCP directories read them (0.15.5): plan_status with no id lists the plans Leanfare keeps,
// plan_stop with forget puts a plan away for good, and delegate with an id and stop ends a hand off that still works.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FORGOTTEN, forgetPlans } from "../src/planner";
import { getSetting } from "../src/db";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const waiting = new Map<number | string, (m: any) => void>();
let nextId = 1;
beforeAll(async () => {
  url = (await boot()).url;
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_DELEGATE_WAIT: "1" },
  });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffer += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        const msg = JSON.parse(line);
        if (msg.method) continue;
        waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
      }
    }
  })();
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
});
afterAll(() => { try { child?.kill(); } catch {} });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); await keys("openai", "google", "deepseek"); });
const write = (msg: unknown) => { (child!.stdin as any).write(JSON.stringify(msg) + "\n"); (child!.stdin as any).flush?.(); };
function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${method}`)); } }, 20_000);
  });
}
const tool = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result;

describe("the tools as the directories read them", () => {
  test("tools/list: plan_status needs no id, plan_stop takes forget, delegate takes stop, and the three weak descriptions say when to use them", async () => {
    const list = (await rpc("tools/list", {})).result.tools;
    const by = Object.fromEntries(list.map((t: any) => [t.name, t]));
    expect(list.length).toBe(16);
    expect(by.plan_status.inputSchema.required).toBeUndefined();
    expect(by.plan_stop.inputSchema.properties.forget.type).toBe("boolean");
    expect(by.delegate.inputSchema.properties.stop.type).toBe("boolean");
    expect(by.helper.description).toContain("never by the model in a chat");
    expect(by.models.description).toContain("Use it to name a model in ask or estimate");
    expect(by.spend.description).toContain("(use report)");
    expect(by.report.description).toContain("(use spend)");
    for (const n of ["helper", "spend", "models", "plan_status", "report", "ask", "plan_stop"]) expect(by[n].description).toStartWith(n === "plan_stop" ? "Stops" : n === "ask" ? "Sends" : "Returns"); // what it does, first
    for (const t of list) expect(t.description.length).toBeGreaterThan(80); // every tool says what it does and when
  });

  test("plan_status with no id lists the plans, newest first; plan_stop with forget puts one away for good", async () => {
    const empty = await tool("plan_status", {});
    expect(empty.isError).toBeUndefined();
    expect(empty.structuredContent.plans).toEqual([]);
    expect(empty.content[0].text).toContain("keeps no plans");
    const a = (await tool("plan", { task: "Summarize the first log and list its errors", split: "rules", run: false })).structuredContent.id;
    await Bun.sleep(5);
    const b = (await tool("plan", { task: "Review the second module and draft its README", split: "rules", run: false })).structuredContent.id;
    const listed = await tool("plan_status", {});
    expect(listed.structuredContent.plans.map((p: any) => p.id)).toEqual([b, a]);
    expect(listed.structuredContent.plans[0]).toMatchObject({ task: "Review the second module and draft its README", ran: false });
    expect(listed.content[0].text).toContain(a);
    const gone = await tool("plan_stop", { id: a, forget: true });
    expect(gone.isError).toBeUndefined();
    expect(gone.structuredContent).toEqual({ id: a, forgotten: true });
    expect((await tool("plan_status", {})).structuredContent.plans.map((p: any) => p.id)).toEqual([b]);
    expect((await tool("plan_run", { id: a })).isError).toBe(true); // its id no longer works
    expect((await tool("plan_stop", { id: a, forget: true })).isError).toBe(true); // nothing left to forget
    expect(getSetting<string[]>(FORGOTTEN, [])).toContain(a); // Claude Code's stop hook skips it
  });

  test("delegate with an id and stop ends a hand off that still works; stop alone is refused", async () => {
    const started = await tool("delegate", { task: "[slow 8000] List the errors in this text: disk full, retry failed.", effort: "low", check: "never" });
    expect(started.structuredContent.running).toBe(true);
    const id = started.structuredContent.id;
    const t0 = Date.now();
    const stopped = await tool("delegate", { id, stop: true });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.structuredContent).toMatchObject({ id, stopped: true });
    expect(Date.now() - t0).toBeLessThan(6000); // it does not wait for the slow model
    const after = await tool("delegate", { id });
    expect(after.structuredContent?.running).not.toBe(true); // ended: no answer comes from it
    expect((await tool("delegate", { id, stop: true })).structuredContent.stopped).toBe(false); // already ended
    expect((await tool("delegate", { stop: true })).isError).toBe(true);
  });
});
