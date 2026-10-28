// A yes given after the door stopped waiting for it still runs the paid parts.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";
import { forgetPlans } from "../src/planner";
import { setSwitch } from "../src/switch";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const lines: any[] = [];
const waiting = new Map<number | string, (m: any) => void>();
let nextId = 1;
beforeAll(async () => {
  url = (await boot()).url;
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_ASK_WAIT_MS: "800" }, // the door waits 0.8 s for the yes, not 120 s
  });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffer += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        lines.push(msg);
        if (!msg.method) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
      }
    }
  })();
});
afterAll(() => { try { child?.kill(); } catch {} });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
const write = (msg: unknown) => { (child!.stdin as any).write(JSON.stringify(msg) + "\n"); (child!.stdin as any).flush?.(); };
function rpc(method: string, params?: unknown, ms = 15000): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${method}`)); } }, ms);
  });
}

test("a yes after the door stopped waiting still runs the paid parts", async () => {
  await keys("openai", "google", "deepseek");
  fake.hooks.answer = (p) => (p.includes("The person works in") ? JSON.stringify({ parts: [{ title: "Read the logs", kind: "read", effort: "low", needs: [], size: "small", task: "Find the errors in the logs." }] }) : null);
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "2.1" } });
  const plan = await rpc("tools/call", { name: "plan", arguments: { task: "The nightly job fails: find out why" } });
  const id = plan.result.structuredContent.id;
  const run = await rpc("tools/call", { name: "plan_run", arguments: { id } }); // nobody answers the question in time
  expect(run.result.structuredContent.parts[0].status).toBe("asks"); // the tool's answer: the paid part waits for the yes
  const question = lines.find((m) => m.method === "elicitation/create");
  expect(lines.some((m) => m.method === "notifications/cancelled" && m.params.requestId === question.id)).toBe(true); // the question is withdrawn
  const before = lines.length;
  write({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { run: true } } }); // the person comes back and says yes
  let st: any = null;
  for (let i = 0; i < 60 && st?.parts[0].status !== "done"; i++) { await Bun.sleep(50); st = (await rpc("tools/call", { name: "plan_status", arguments: { id } })).result.structuredContent; }
  expect(st.parts[0].status).toBe("done");
  expect(lines.slice(before).some((m) => m.id === question.id)).toBe(false); // the yes, a response, is never answered
});

test("a yes that comes after Leanfare was switched off runs nothing", async () => {
  await keys("openai", "google", "deepseek");
  fake.hooks.answer = (p) => (p.includes("The person works in") ? JSON.stringify({ parts: [{ title: "Read the logs", kind: "read", effort: "low", needs: [], size: "small", task: "Find the errors in the logs." }] }) : null);
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "2.1" } });
  const plan = await rpc("tools/call", { name: "plan", arguments: { task: "The nightly job fails: find out why" } });
  const id = plan.result.structuredContent.id;
  const asked = lines.length;
  const run = await rpc("tools/call", { name: "plan_run", arguments: { id } }); // nobody answers the question in time
  expect(run.result.structuredContent.parts[0].status).toBe("asks");
  const question = lines.slice(asked).find((m) => m.method === "elicitation/create");
  setSwitch(false); // then the person switches Leanfare off in the app
  try {
    const seen = fake.seen.length;
    write({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { run: true } } }); // and later says yes
    await Bun.sleep(600);
    const st = (await rpc("tools/call", { name: "plan_status", arguments: { id } })).result.structuredContent;
    expect(st.parts[0].status).toBe("asks");
    expect(fake.seen.length).toBe(seen);
  } finally { setSwitch(true); }
});
