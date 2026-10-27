// Links in the project: the shared folder the MCP door writes never follows one, and the plan's
// folder walk leaves out what delegate would refuse.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlan, forgetPlans, makePlan, runView, startRun } from "../src/planner";
import { sizesForPlan } from "../src/readfiles";
import { paths } from "../src/config";
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
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("the shared folder never follows a link out of the project", () => {
  test("a .leanfare link in a cloned repo: nothing is written where it points", async () => {
    const outside = mkdtempSync(join(tmpdir(), "r4a-outside-"));
    const project = mkdtempSync(join(tmpdir(), "r4a-project-"));
    symlinkSync(outside, join(project, ".leanfare")); // a link the repo can carry
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    const r = await rpc("tools/call", { name: "plan", arguments: { task: "Summarize the design of this project", split: "rules", folder: project } });
    const id = r.result.structuredContent.id;
    const leaked = existsSync(join(outside, "plans", id, "plan.md"));
    rmSync(outside, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
    expect(leaked).toBe(false);
  });

  test("a dangling .leanfare/.gitignore link: nothing is made at its target", async () => {
    const outside = mkdtempSync(join(tmpdir(), "r4b-outside-"));
    const project = mkdtempSync(join(tmpdir(), "r4b-project-"));
    mkdirSync(join(project, ".leanfare"));
    const target = join(outside, "made-by-leanfare.sh");
    symlinkSync(target, join(project, ".leanfare", ".gitignore")); // points at a file that does not exist yet
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    await rpc("tools/call", { name: "plan", arguments: { task: "Summarize the design of this project", split: "rules", folder: project } });
    const made = existsSync(target) ? readFileSync(target, "utf8") : null;
    rmSync(outside, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
    expect(made).toBeNull();
  });
});

describe("the folder walk leaves out what delegate refuses", () => {
  test("a link to a secret is left out, and the reading part runs", async () => {
    await keys("openai", "google", "deepseek");
    const ssh = join(process.env.HOME!, ".ssh");
    mkdirSync(ssh, { recursive: true });
    writeFileSync(join(ssh, "config"), "Host prod\n  IdentityFile ~/.ssh/prod_key\n");
    const project = mkdtempSync(join(tmpdir(), "r5a-"));
    writeFileSync(join(project, "router.py"), "def pick(d):\n    return d[0]\n");
    symlinkSync(join(ssh, "config"), join(project, "notes.txt"));
    const counted = sizesForPlan([project], project);
    const v = checkPlan({ task: "Reverse engineer this router and build a smaller one", paths: [project], split: "rules" });
    if (typeof v === "string") throw new Error(v);
    const plan = await makePlan({ ...v, signal: new AbortController().signal });
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    const r = runView(plan.id)!;
    rmSync(project, { recursive: true, force: true });
    expect(Array.isArray(counted) && counted.some((f) => f.name === "notes.txt")).toBe(false);
  });

  test("a linked folder into Leanfare's own data folder is left out", async () => {
    await keys("openai");
    const project = mkdtempSync(join(tmpdir(), "r5b-"));
    symlinkSync(join(paths.keys, ".."), join(project, "lf"));
    const counted = sizesForPlan([project], project);
    rmSync(project, { recursive: true, force: true });
    expect(Array.isArray(counted) && counted.some((f) => f.name.endsWith("keys.json"))).toBe(false);
  });
});
