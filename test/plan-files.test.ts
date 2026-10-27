// Which files a plan's run hands over, from the MCP door's plan_run and from the Plan tab.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byRelevance, checkPlan, forgetPlans, makePlan, runView, startRun } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const waiting = new Map<number | string, (m: any) => void>();
let nextId = 1;
beforeAll(async () => {
  url = (await boot()).url;
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" },
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
});
afterAll(() => { try { child?.kill(); } catch {} });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
const write = (msg: unknown) => { (child!.stdin as any).write(JSON.stringify(msg) + "\n"); (child!.stdin as any).flush?.(); };
function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${method}`)); } }, 15000);
  });
}
async function until(ok: () => boolean | Promise<boolean>, ms = 10_000) { for (let i = 0; i < ms / 50 && !(await ok()); i++) await Bun.sleep(50); }
const signal = () => new AbortController().signal;
const MARK = "def pick_deployment_MARKER_4711(deployments):\n    return deployments[0]\n";

describe("the files a plan's run hands over", () => {
  test("MCP: plan_run hands the reading parts the project's files", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "r2a-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "router.py"), MARK);
    const prompts: string[] = [];
    fake.hooks.answer = (p) => { prompts.push(p); return null; };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    const plan = await rpc("tools/call", { name: "plan", arguments: { task: "Reverse engineer the router in this project and build a smaller one", files: [dir], split: "rules", folder: dir } });
    const sc = plan.result.structuredContent;
    const run = await rpc("tools/call", { name: "plan_run", arguments: { id: sc.id, paid: "yes" } });
    expect(run.result.isError).toBeUndefined();
    await until(async () => !(await rpc("tools/call", { name: "plan_status", arguments: { id: sc.id, folder: dir } })).result.structuredContent.running);
    const st = (await rpc("tools/call", { name: "plan_status", arguments: { id: sc.id, folder: dir } })).result.structuredContent;
    rmSync(dir, { recursive: true, force: true });
    expect(st.parts[0].status).toBe("done");
    expect(prompts.some((p) => p.includes("MARKER_4711"))).toBe(true); // part 1 maps the code: it should get the code
  });

  test("Plan tab: past one hand off, the files whose names hold the task's words go first", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "r2b-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "router.py"), MARK);
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, "src", `mod${i}.py`), `x = ${i}\n`);
    const v = checkPlan({ task: "Reverse engineer this router and build a smaller one", paths: [dir], split: "rules" });
    if (typeof v === "string") throw new Error(v);
    const prompts: string[] = [];
    fake.hooks.answer = (p) => { prompts.push(p); return null; };
    const plan = await makePlan({ ...v, signal: signal() });
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    const r = runView(plan.id)!;
    rmSync(dir, { recursive: true, force: true });
    expect(prompts.some((p) => p.includes("MARKER_4711"))).toBe(true);
  });

  test("Plan tab: a .DS_Store in the folder is left out, and the parts that read the folder run", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "r2c-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "router.py"), MARK);
    writeFileSync(join(dir, ".DS_Store"), Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("Bud1"), Buffer.alloc(64)]));
    const v = checkPlan({ task: "Reverse engineer this router and build a smaller one", paths: [dir], split: "rules" });
    if (typeof v === "string") throw new Error(v);
    fake.hooks.answer = () => null;
    const plan = await makePlan({ ...v, signal: signal() });
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    const r = runView(plan.id)!;
    rmSync(dir, { recursive: true, force: true });
    expect(r.parts[0].status).toBe("done");
  });

  test("MCP: past 200 files the parts name real files that delegate can read", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "r2d-"));
    mkdirSync(join(dir, "src"));
    for (let i = 0; i < 201; i++) writeFileSync(join(dir, "src", `mod${i}.py`), `x = ${i}\n`);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    const plan = await rpc("tools/call", { name: "plan", arguments: { task: "Reverse engineer the router in this project and build a smaller one", files: [join(dir, "src")], split: "rules" } });
    const files = plan.result.structuredContent.parts[0].files;
    const d = await rpc("tools/call", { name: "delegate", arguments: { task: "List the modules.", files } }); // as the plan's next step says
    rmSync(dir, { recursive: true, force: true });
    expect(d.result.isError).toBeUndefined();
  });
});

test("the files whose path holds the task's words go first, the rest in the plan's order", () => {
  expect(byRelevance(["/p/src/a.py", "/p/src/router.py", "/p/docs/router.md", "/p/src/b.py"], "Reverse engineer this router")).toEqual(["/p/src/router.py", "/p/docs/router.md", "/p/src/a.py", "/p/src/b.py"]);
  expect(byRelevance(["C:\\p\\a.py", "C:\\p\\router.py"], "the router")).toEqual(["C:\\p\\router.py", "C:\\p\\a.py"]);
  expect(byRelevance(["/litellm/a.py", "/litellm/b.py"], "Port litellm")).toEqual(["/litellm/a.py", "/litellm/b.py"]); // the folder they all share says nothing
  expect(byRelevance(["b.py", "a.py"], "this and that")).toEqual(["b.py", "a.py"]); // no words to go by
});
