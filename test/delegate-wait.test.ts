// A hand off that takes longer than an app waits for a tool (Cowork's link to the computer waits 60 seconds):
// asked with a wait, it runs on its own; the answer comes within the wait, or later through its id. Switching
// Leanfare off stops the ones still working.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setSwitch } from "../src/switch";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); setSwitch(true); });
afterAll(() => { setSwitch(true); });

const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };

describe("a hand off with a wait", () => {
  test("done within the wait: the answer, as before, with its id", async () => {
    await keys("google");
    const r = await ui(url, "/api/delegate", { task: "Summarize the log.", files: [LOG], kind: "read", effort: "low", check: "never", wait: 10 });
    expect(r.status).toBe(200);
    expect(r.json.running).toBe(false);
    expect(r.json.answer).toContain("Hello from");
    expect(r.json.receipt).toContain("Leanfare delegate");
    expect(r.json.id).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  });

  test("longer than the wait: an id at once, the work goes on, and the id gives the answer", async () => {
    await keys("google");
    const t0 = Date.now();
    const r = await ui(url, "/api/delegate", { task: "Summarize the log. [slow 2500]", files: [LOG], kind: "read", effort: "low", check: "never", wait: 0.5 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.json).toMatchObject({ running: true });
    const id = r.json.id;
    expect((await ui(url, `/api/delegate?id=${id}&wait=0`)).json.running).toBe(true);
    const done = await ui(url, `/api/delegate?id=${id}&wait=10`);
    expect(done.status).toBe(200);
    expect(done.json.running).toBe(false);
    expect(done.json.answer).toContain("Hello from");
    expect(done.json.id).toBe(id);
    // An id Leanfare does not know: said plainly.
    const gone = await ui(url, "/api/delegate?id=nosuchid12&wait=0");
    expect(gone.status).toBe(404);
    expect(gone.json.error).toContain("No hand off with that id");
  });

  test("without a wait, as before: the answer when it is done", async () => {
    await keys("google");
    const r = await ui(url, "/api/delegate", { task: "Summarize the log. [slow 600]", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(r.status).toBe(200);
    expect(r.json.running).toBeUndefined();
    expect(r.json.answer).toContain("Hello from");
  });

  test("switching off stops a hand off still working, and says so", async () => {
    await keys("google");
    const r = await ui(url, "/api/delegate", { task: "Summarize the log. [slow 4000]", files: [LOG], kind: "read", effort: "low", check: "never", wait: 0.3 });
    expect(r.json.running).toBe(true);
    const off = await ui(url, "/api/switch", { on: false });
    expect(off.json.stopped).toEqual({ plans: 0, delegates: 1, trial: false });
    const after = await ui(url, `/api/delegate?id=${r.json.id}&wait=5`);
    expect(after.status).toBe(499);
    expect(after.json.error).toContain("Stopped");
  });
});

describe("the door's delegate", () => {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let buffer = "";
  const waiting = new Map<number, (m: any) => void>();
  let n = 1;
  beforeAll(() => {
    child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_DELEGATE_WAIT: "1" } });
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
        buffer += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) { const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } }
      }
    })();
  });
  afterAll(() => { try { child?.kill(); } catch {} });
  const call = (name: string, args: unknown) => new Promise<any>((resolve, reject) => {
    const id = n++;
    waiting.set(id, resolve);
    (child!.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    (child!.stdin as any).flush?.();
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${name}`)); } }, 8000);
  });

  test("a slow one answers with an id within the wait; delegate with only that id gives the answer", async () => {
    await keys("google");
    const first = (await call("delegate", { task: "Say hello. [slow 2500]", kind: "write", effort: "low", check: "never" })).result;
    expect(first.content[0].text).toContain("Still working in Leanfare");
    expect(first.structuredContent.running).toBe(true);
    const id = first.structuredContent.id;
    expect(first.content[0].text).toContain(`Call delegate again with id "${id}"`);
    let got = (await call("delegate", { id })).result;
    for (let i = 0; i < 5 && got.structuredContent?.running; i++) got = (await call("delegate", { id })).result;
    expect(got.content[0].text).toContain("Hello from");
    expect(got.content[0].text).toContain("grade, with model");
    expect(got.content[0].text).toMatch(/, kind write and handoff \d+\.\)$/);
    const bad = (await call("delegate", { id: "../etc" })).result;
    expect(bad.isError).toBe(true);
    const none = (await call("delegate", {})).result;
    expect(none.content[0].text).toContain("delegate needs a task, or the id of one still working");
  });
});
