// The one switch on the simple screen (switch.ts). Off, the door's tools that hand work over say so and
// send nothing, Claude Code's prompt hook goes quiet, work handed over by another process is refused,
// and what is running stops.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { paths } from "../src/config";
import { OFF_TEXT, OFF_TRIAL, setSwitch, switchedOn } from "../src/switch";
import { forgetPlans, makePlan, runView, startRun } from "../src/planner";
import { startTrial, trialRunning } from "../src/trial";
import { hookLine } from "../src/statusline";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => { setSwitch(true); });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); setSwitch(true); });

describe("the switch", () => {
  test("off and on again: only a file in the data folder holds it, and the page reads it from the state", async () => {
    expect((await ui(url, "/api/state")).json.switchOn).toBe(true);
    expect((await ui(url, "/api/switch", { on: false })).json).toEqual({ on: false, stopped: { plans: 0, delegates: 0, trial: false } });
    expect((await ui(url, "/api/state")).json.switchOn).toBe(false);
    expect(existsSync(paths.off)).toBe(true);
    expect(switchedOn()).toBe(false);
    expect((await ui(url, "/api/switch", { on: true })).json.on).toBe(true);
    expect(existsSync(paths.off)).toBe(false);
    const bad = await ui(url, "/api/switch", { on: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("on must be true or false");
  });
  test("Claude Code's prompt hook says nothing while it is off", async () => {
    expect(hookLine()).toContain("Leanfare");
    setSwitch(false);
    expect(hookLine()).toBe("");
    const p = Bun.spawnSync([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "hook", "prompt"], { env: { ...process.env } });
    expect(p.stdout.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    setSwitch(true);
    const q = Bun.spawnSync([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "hook", "prompt"], { env: { ...process.env } });
    expect(q.stdout.toString()).toContain("Leanfare");
  });
});

describe("the door while Leanfare is off", () => {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let buffer = "";
  const waiting = new Map<number, (m: any) => void>();
  let id = 1;
  beforeAll(() => {
    child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" } });
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
    const n = id++;
    waiting.set(n, resolve);
    (child!.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name, arguments: args } }) + "\n");
    (child!.stdin as any).flush?.();
    setTimeout(() => { if (waiting.has(n)) { waiting.delete(n); reject(new Error(`no answer to ${name}`)); } }, 8000);
  });

  test("the tools that hand work over say Leanfare is off, as a plain answer, and nothing is sent; the others still answer", async () => {
    await keys("google");
    setSwitch(false);
    const before = fake.seen.length;
    for (const [name, args] of [["delegate", { task: "Find the errors.", files: [] }], ["ask", { prompt: "Hello" }], ["plan", { task: "Find out why the job fails" }], ["plan_run", { id: "p-123" }], ["trial", { action: "start" }]] as const) {
      const r = (await call(name, args)).result;
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("Leanfare is switched off (the switch at the top of the Leanfare app), so nothing was handed over. Do this yourself, as usual.");
      expect(r.structuredContent).toEqual({ off: true });
    }
    expect(fake.seen.length).toBe(before);
    const spend = (await call("spend", {})).result;
    expect(spend.isError).toBeUndefined();
    expect(spend.content[0].text).not.toContain("switched off");
    setSwitch(true);
    const asked = (await call("ask", { prompt: "Hello" })).result;
    expect(asked.content[0].text).not.toContain("switched off");
  }, 30000);
});

describe("while Leanfare is off, work from another process is refused, and what runs stops", () => {
  // The door, an older copy's door and leanfare trial hold the control token; the page and your scripts do not.
  const door = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "x-leanfare": "1", "x-leanfare-token": "test-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const ONE = JSON.stringify({ parts: [{ title: "Pull the errors out of the log", kind: "read", effort: "low", needs: [], size: "small", task: "List every line of the log that reports an error." }] });
  afterEach(() => { fake.hooks.answer = null; fake.hooks.slow = null; forgetPlans(); setSwitch(true); });

  test("each way of handing work over answers that Leanfare is off, and sends nothing", async () => {
    await keys("google");
    setSwitch(false);
    const seen = fake.seen.length;
    for (const [path, body] of [["/api/delegate", { task: "Summarize it.", effort: "low", kind: "read", files: [] }], ["/api/plan", { task: "Find out why the job fails", files: [] }], ["/api/plan/run", { id: "abcdef12" }], ["/api/trial/start", {}]] as const) {
      const r = await door(path, body);
      expect([path, r.status]).toEqual([path, 409]);
      expect((await r.json()).error).toBe(path === "/api/trial/start" ? OFF_TRIAL : OFF_TEXT);
    }
    const chat = await door("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "Hi" }] });
    expect(chat.status).toBe(409);
    expect((await chat.json()).error).toEqual({ message: OFF_TEXT, type: "leanfare_off" });
    const msgs = await door("/v1/messages", { model: "auto", max_tokens: 50, messages: [{ role: "user", content: "Hi" }] });
    expect(msgs.status).toBe(409);
    expect((await msgs.json()).error.type).toBe("leanfare_off");
    expect(fake.seen.length).toBe(seen);
    // A script that calls Leanfare's address itself still works, and so does the page.
    const script = await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hi" }] }) });
    expect(script.status).toBe(200);
    expect((await ui(url, "/api/plan/run", { id: "abcdef12" })).status).toBe(404); // no such plan: the page is not refused
  });

  test("switching off stops the parts of a running plan and the trial, and says so", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (p) => (p.includes("The person works in") ? ONE : null);
    fake.hooks.slow = (p) => (p.includes("List every line") ? 3000 : 0);
    const plan = await makePlan({ task: "Find out why the nightly job fails", files: [], manager: "Claude Code", signal: new AbortController().signal });
    startRun(plan.id, { paid: true });
    for (let i = 0; i < 200 && runView(plan.id)!.parts[0].status !== "running"; i++) await Bun.sleep(25);
    const r = (await ui(url, "/api/switch", { on: false })).json;
    expect(r.on).toBe(false);
    expect(r.stopped).toEqual({ plans: 1, delegates: 0, trial: false });
    for (let i = 0; i < 200 && runView(plan.id)!.running; i++) await Bun.sleep(25);
    expect(runView(plan.id)!.parts[0].status).toBe("stopped");
    setSwitch(true);
    startTrial();
    const t = (await ui(url, "/api/switch", { on: false })).json;
    expect(t.stopped).toEqual({ plans: 0, delegates: 0, trial: true });
    expect(trialRunning()).toBe(false);
  });

  test("the switch is a file: a folder of that name is not off, and turning on leaves it alone", () => {
    mkdirSync(paths.off, { recursive: true });
    try {
      expect(switchedOn()).toBe(true);
      expect(setSwitch(true)).toBe(true);
      expect(existsSync(paths.off)).toBe(true);
    } finally { rmdirSync(paths.off); }
    expect(setSwitch(false)).toBe(false);
    expect(statSync(paths.off).mode & 0o777).toBe(0o600);
    expect(setSwitch(true)).toBe(true);
  });
});
