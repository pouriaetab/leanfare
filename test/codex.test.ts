// Your ChatGPT plan, through Codex: a plan's reading, drafting and working out parts run on Codex
// (codex exec, read only) instead of pay per use, once the switch in Settings is on and Codex is
// signed in; never when you work in Codex itself, nor near the ChatGPT plan's limits. A stand-in
// codex command plays Codex: it answers --version, login status, mcp list and exec, writes what it was
// given to files, and can fail, give nothing, or take long.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexBin, codexBusy, codexFor, codexPrompt, codexState, forgetCodex, nativeCodex, runCodex } from "../src/codex";
import { addGrade } from "../src/grades";
import { forgetShellEnv } from "../src/shellenv";
import { commonFolder, forgetPlans } from "../src/planner";
import { forgetLogs } from "../src/plans";
import { saveSettings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

const FAKE = `#!/bin/sh
D="$FAKE_CODEX_DIR"
echo "$PWD|$*" >> "$D/calls.log"
case "$1" in
  --version) echo "codex-cli 0.159.0"; exit 0 ;;
  login) if [ -f "$D/signed-out" ]; then echo "Not logged in" >&2; exit 1; fi
         if [ -f "$D/apikey" ]; then echo "API key configured - sk-proj-***ABCDE" >&2; exit 0; fi
         echo "Logged in using ChatGPT" >&2; exit 0 ;;
  mcp) if [ -f "$D/mcp-fail" ]; then echo "error: unexpected argument '--json' found" >&2; exit 2; fi
       if [ -f "$D/mcp.json" ]; then cat "$D/mcp.json"; else echo "[]"; fi; exit 0 ;;
  exec) ;;
  *) exit 2 ;;
esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > "$D/prompt-$$.txt"
cat "$D/prompt-$$.txt" >> "$D/prompts.log"
if [ -f "$D/slow" ]; then sleep "$(cat "$D/slow")"; fi
if [ -f "$D/fail" ]; then echo "Reading files..." ; echo "You've hit your usage limit. Try again later." >&2; exit 1; fi
if [ -f "$D/empty" ]; then exit 0; fi
part=$(grep -m1 '^Part ' "$D/prompt-$$.txt")
printf 'Codex read it. %s' "$part" > "$out"
echo done
`;
let dir = "", bin = "";
let url = "";
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);
const prompts = () => (existsSync(join(dir, "prompts.log")) ? readFileSync(join(dir, "prompts.log"), "utf8") : "");
const knob = (name: string, value = "") => writeFileSync(join(dir, name), value);
const was = { bin: process.env.LEANFARE_CODEX_BIN };
beforeAll(async () => {
  url = (await boot()).url;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-fakecodex-"))); // its real path: on macOS the temp folder is a link
  bin = join(dir, "codex");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  process.env.FAKE_CODEX_DIR = dir;
});
afterAll(() => { process.env.LEANFARE_CODEX_BIN = was.bin; if (was.bin === undefined) delete process.env.LEANFARE_CODEX_BIN; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  forgetPlans(); forgetCodex(); forgetLogs();
  await reset({ ticked: ALL_TICKED });
  for (const f of ["calls.log", "prompts.log", "signed-out", "apikey", "slow", "fail", "empty", "mcp-fail", "mcp.json"]) rmSync(join(dir, f), { force: true });
  process.env.LEANFARE_CODEX_BIN = bin;
});

// A project with files the plan reads, by their real paths (as the Plan tab measures them).
function project(): string {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-codex-project-")));
  mkdirSync(join(p, "logs"), { recursive: true });
  writeFileSync(join(p, "logs", "app.log"), "10:00 start\n10:01 error: disk full\n".repeat(200));
  writeFileSync(join(p, "logs", "worker.log"), "10:02 error: timeout\n".repeat(100));
  return p;
}
const plan = (body: Record<string, unknown>) => ui(url, "/api/plan", { manager: "Claude Code", split: "rules", ...body });

describe("whether Codex is there", () => {
  test("installed and signed in: its version; signed out: says so; not installed: says so", async () => {
    expect(await codexState(true)).toMatchObject({ installed: true, signedIn: true, version: "0.159.0" });
    knob("signed-out");
    expect(await codexState(true)).toMatchObject({ installed: true, signedIn: false });
    process.env.LEANFARE_CODEX_BIN = "";
    expect(await codexState(true)).toMatchObject({ installed: false, signedIn: false, version: null });
  });
  test("Settings asks /api/codex: the state and whether plans may use it", async () => {
    saveSettings({ codexPlan: true });
    expect((await ui(url, "/api/codex?fresh=1")).json).toMatchObject({ installed: true, signedIn: true, version: "0.159.0", on: true });
    expect((await ui(url, "/api/settings", { codexPlan: "yes" })).status).toBe(400); // true or false only
  });
  test("a plan may use it only when it is on, signed in, and you are not working in Codex itself", async () => {
    expect(await codexFor("Claude Code")).toEqual({ ok: false, why: null }); // off by default: nothing to say
    saveSettings({ codexPlan: true });
    expect(await codexFor("Claude Code")).toEqual({ ok: true, why: null });
    expect(await codexFor("Codex")).toEqual({ ok: false, why: null });
    forgetCodex(); knob("signed-out");
    expect(await codexFor("Claude Code")).toEqual({ ok: false, why: "Codex is not signed in (run codex login in Terminal)" });
    forgetCodex(); process.env.LEANFARE_CODEX_BIN = "";
    expect((await codexFor("Claude Code")).why).toContain("Codex is not on this computer");
  });
  test("near the ChatGPT plan's limit (85% of its 5 hours or week), Codex is left alone", async () => {
    saveSettings({ codexPlan: true });
    const root = process.env.CODEX_HOME!;
    const f = join(root, "sessions", "2026", "10", "21", "rollout-2026-10-21T11-00-00-near.jsonl");
    mkdirSync(join(root, "sessions", "2026", "10", "21"), { recursive: true });
    writeFileSync(f, [
      JSON.stringify({ timestamp: "2026-10-21T11:00:00Z", type: "turn_context", payload: { cwd: "/x", model: "gpt-6.1-sol" } }),
      JSON.stringify({ timestamp: "2026-10-21T11:00:05Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }, last_token_usage: null }, rate_limits: { primary: { used_percent: 92, window_minutes: 300, resets_at: 1792600000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1793000000 }, plan_type: "plus" } } }),
    ].join("\n") + "\n");
    try {
      forgetLogs();
      expect(await codexFor("Claude Code")).toEqual({ ok: false, why: "your ChatGPT plan is near its limit (the 5 hours at 92%)" });
    } finally { rmSync(f, { force: true }); forgetLogs(); }
  });
});

describe("in a plan", () => {
  test("a reading part that would go to pay per use goes to Codex instead: its row, its cost, and plan_run named to start it", async () => {
    await keys("openai");
    saveSettings({ codexPlan: true });
    const p = project();
    try {
      const r = await plan({ task: "Find the errors in these logs and list them", paths: [join(p, "logs")] });
      expect(r.status).toBe(200);
      const viaCodex = r.json.parts.filter((x: any) => x.where === "codex");
      expect(viaCodex.length).toBeGreaterThan(0);
      expect(viaCodex[0]).toMatchObject({ model: { id: "codex", label: "Codex (your ChatGPT plan)" }, cost: 0 });
      expect(viaCodex[0].why).toContain("your ChatGPT plan through Codex, not pay per use");
      expect(r.json.parts.some((x: any) => x.where === "paid")).toBe(false);
      expect(r.json.table).toContain("| Leanfare, through Codex | Codex (your ChatGPT plan) |");
      expect(r.json.table).toContain("| in your ChatGPT plan |");
      expect(r.json.next).toMatch(/run(s)? on Codex with your ChatGPT plan: start (it|them) with plan_run \(delegate cannot run (it|them)\)\./);
      expect(r.json.local ?? null).toBeNull(); // nothing goes to pay per use: no local model to suggest
    } finally { rmSync(p, { recursive: true, force: true }); }
  });
  test("off, or working in Codex: the same part goes to pay per use as before", async () => {
    await keys("openai");
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    expect(r.json.parts.some((x: any) => x.where === "codex")).toBe(false);
    expect(r.json.parts.some((x: any) => x.where === "paid")).toBe(true);
    saveSettings({ codexPlan: true });
    const inCodex = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }], manager: "Codex" });
    expect(inCodex.json.parts.some((x: any) => x.where === "codex")).toBe(false);
  });
  test("on but signed out: pay per use, and the table says why Codex took no part", async () => {
    await keys("openai");
    saveSettings({ codexPlan: true });
    knob("signed-out");
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    expect(r.json.parts.some((x: any) => x.where === "codex")).toBe(false);
    expect(r.json.table).toContain("Codex took no part: Codex is not signed in (run codex login in Terminal).");
  });
  test("with no model ticked in Leanfare for it, a reading part goes to Codex rather than back to you", async () => {
    saveSettings({ codexPlan: true });
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    const out = r.json.parts.filter((x: any) => x.where !== "you");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((x: any) => x.where === "codex" && x.why.includes("no model you ticked in Leanfare could take it"))).toBe(true);
  });
});

describe("running a part on Codex", () => {
  async function runAndWait(id: string) {
    await ui(url, "/api/plan/run", { id, paid: false });
    let v: any = null;
    for (let i = 0; i < 300 && (!v || v.running); i++) { await Bun.sleep(20); v = (await ui(url, `/api/plan/run?id=${id}`)).json; }
    return v;
  }
  test("read only, never asking, at the part's effort, in the folder of its files, with the part on its input; the answer and its receipt come back", async () => {
    saveSettings({ codexPlan: true });
    const p = project();
    try {
      const r = await plan({ task: "Find the errors in these logs and list them", paths: [join(p, "logs")] });
      const part = r.json.parts.find((x: any) => x.where === "codex");
      const v = await runAndWait(r.json.id);
      const got = v.parts.find((x: any) => x.n === part.n);
      expect(got).toMatchObject({ status: "done", model: "Codex (your ChatGPT plan)", cost: 0, answer: `Codex read it. Part ${part.n}: ${part.title}` });
      expect(got.receipt).toContain("Codex (your ChatGPT plan), read only");
      expect(got.receipt).toContain("nothing to pay here");
      const exec = calls().find((c) => c.includes("|exec "))!;
      const [cwd, args] = exec.split("|");
      expect(cwd).toBe(join(p, "logs")); // the folder that holds its files
      expect(args).toContain("exec --sandbox read-only --skip-git-repo-check --color never -c approval_policy=\"never\"");
      expect(args).toContain(`-c model_reasoning_effort="${part.effort}"`);
      expect(args.endsWith(" -")).toBe(true); // the part comes on its input
      expect(prompts()).toContain(`Part ${part.n}: ${part.title}`);
      expect(prompts()).toContain("The files it reads, from this folder:");
      expect(prompts()).toContain("app.log");
      expect(prompts()).toContain("Do not change any file");
      expect(fake.seen.some((s) => s.path.endsWith("/chat/completions") && JSON.stringify(s.body).includes("disk full"))).toBe(false); // no model got the files
    } finally { rmSync(p, { recursive: true, force: true }); }
  });
  test("Codex at its limit: the part fails with what Codex said, and nothing else is run in its place", async () => {
    saveSettings({ codexPlan: true });
    knob("fail");
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    const part = r.json.parts.find((x: any) => x.where === "codex");
    const v = await runAndWait(r.json.id);
    const got = v.parts.find((x: any) => x.n === part.n);
    expect(got.status).toBe("failed");
    expect(got.error).toBe("Codex stopped with an error: You've hit your usage limit. Try again later.");
    expect(fake.seen.filter((s) => s.path.endsWith("/chat/completions")).length).toBe(0);
  });
  test("Codex that ends with no answer: the part fails and says so", async () => {
    saveSettings({ codexPlan: true });
    knob("empty");
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    const part = r.json.parts.find((x: any) => x.where === "codex");
    const v = await runAndWait(r.json.id);
    expect(v.parts.find((x: any) => x.n === part.n)).toMatchObject({ status: "failed", error: "Codex finished without an answer." });
  });
  test("Stop ends a Codex part that is running", async () => {
    saveSettings({ codexPlan: true });
    knob("slow", "5");
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    const part = r.json.parts.find((x: any) => x.where === "codex");
    await ui(url, "/api/plan/run", { id: r.json.id, paid: false });
    await Bun.sleep(300);
    await ui(url, "/api/plan/stop", { id: r.json.id });
    let v: any = null;
    for (let i = 0; i < 200 && (!v || v.running); i++) { await Bun.sleep(20); v = (await ui(url, `/api/plan/run?id=${r.json.id}`)).json; }
    expect(v.parts.find((x: any) => x.n === part.n).status).toBe("stopped");
  }, 15000);
  test("a part that takes longer than it may is ended and says how long it had", async () => {
    knob("slow", "3");
    const ac = new AbortController();
    await expect(runCodex({ n: 1, title: "Read", task: "Read it.", folder: null, files: [], effort: "low" }, ac.signal, 300)).rejects.toThrow("Codex did not finish this part within 0 minutes.");
  });
  test("with no folder, Codex runs in an empty one of its own, never in yours", async () => {
    const r = await runCodex({ n: 2, title: "Draft", task: "Write it.", folder: null, files: [], effort: "medium" }, new AbortController().signal);
    expect(r.answer).toBe("Codex read it. Part 2: Draft");
    const cwd = calls().find((c) => c.includes("|exec "))!.split("|")[0];
    expect(cwd).toContain("leanfare-codex-");
    expect(existsSync(cwd)).toBe(false); // and it is gone afterwards
  });
});

describe("the pieces", () => {
  test("the folder that holds all the files", () => {
    expect(commonFolder([])).toBeNull();
    expect(commonFolder(["/p/a/x.ts", "/p/a/y.ts"])).toBe("/p/a");
    expect(commonFolder(["/p/a/x.ts", "/p/b/y.ts"])).toBe("/p");
    expect(commonFolder(["/p/ab/x.ts", "/p/a/y.ts"])).toBe("/p"); // a folder name that starts the same is not the same folder
    expect(commonFolder(["/x.ts", "/p/y.ts"])).toBeNull(); // only the top folder holds both
  });
  test("what Codex is given", () => {
    const t = codexPrompt({ n: 3, title: "Map the code", task: "List the modules.", folder: "/p", files: ["src/a.ts", "src/b.ts"], effort: "low" });
    expect(t).toContain("Part 3: Map the code\n\nList the modules.");
    expect(t).toContain("The files it reads, from this folder: src/a.ts, src/b.ts");
    expect(codexPrompt({ n: 1, title: "x", task: "y", folder: null, files: [], effort: "low" })).toContain("No files were named for this part");
  });
});

describe("only the ChatGPT plan, only while the switch is on", () => {
  test("signed in with an API key: not the ChatGPT plan, so plans pay per use and say why", async () => {
    knob("apikey");
    await keys("openai");
    saveSettings({ codexPlan: true });
    expect(await codexState(true)).toMatchObject({ installed: true, signedIn: false, login: "other" });
    expect((await codexFor("Claude Code")).why).toContain("signed in with an API key or another login, not with ChatGPT");
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    expect(r.json.parts.some((x: any) => x.where === "codex")).toBe(false);
    expect(r.json.table).toContain("Codex took no part: Codex is signed in with an API key");
  });
  test("the switch turned off after the plan was made: the part does not run on Codex, and says why", async () => {
    saveSettings({ codexPlan: true });
    const r = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    const part = r.json.parts.find((x: any) => x.where === "codex");
    saveSettings({ codexPlan: false });
    await ui(url, "/api/plan/run", { id: r.json.id, paid: false });
    let v: any = null;
    for (let i = 0; i < 300 && (!v || v.running); i++) { await Bun.sleep(20); v = (await ui(url, `/api/plan/run?id=${r.json.id}`)).json; }
    expect(v.parts.find((x: any) => x.n === part.n)).toMatchObject({ status: "failed", error: "This part was to run on Codex, but Codex is off in Settings now. Make the plan again to place it elsewhere." });
    expect(calls().some((c) => c.includes("|exec "))).toBe(false);
  });
});

describe("Codex runs a part without what acts outside its sandbox", () => {
  const read = () => runCodex({ n: 1, title: "Read", task: "Read it.", folder: null, files: [], effort: "low" }, new AbortController().signal);
  test("its MCP servers (Leanfare's own among them) are turned off for the part, and so are ChatGPT's apps, plugins, hooks and the browser", async () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify([{ name: "leanfare", enabled: true }, { name: "docs", enabled: false }, { name: "git-hub_2", enabled: true }]));
    await read();
    const exec = calls().find((c) => c.includes("|exec "))!;
    expect(exec).toContain("-c mcp_servers.leanfare.enabled=false");
    expect(exec).toContain("-c mcp_servers.git-hub_2.enabled=false");
    expect(exec).not.toContain("mcp_servers.docs"); // already off: a server Codex does not have would break its settings
    for (const f of ["apps", "plugins", "hooks", "browser_use", "computer_use"]) expect(exec).toContain(`-c features.${f}=false`);
    const list = calls().findIndex((c) => c.includes("|mcp list --json"));
    expect(list).toBeGreaterThanOrEqual(0);
    expect(list).toBeLessThan(calls().findIndex((c) => c.includes("|exec "))); // asked first, in the same folder
  });
  test("when Codex cannot say which MCP servers it would start, or one cannot be turned off, the part does not run", async () => {
    knob("mcp-fail");
    await expect(read()).rejects.toThrow("Leanfare could not see which MCP servers Codex would start");
    rmSync(join(dir, "mcp-fail"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify([{ name: "my.server", enabled: true }]));
    await expect(read()).rejects.toThrow('Codex has an MCP server named "my.server"');
    expect(calls().some((c) => c.includes("|exec "))).toBe(false);
  });
});

describe("Stop, the time limit, and two at a time", () => {
  test("Stop ends the commands Codex started too", async () => {
    const spawner = join(dir, "codex-spawner");
    writeFileSync(spawner, `#!/bin/sh\nD="$FAKE_CODEX_DIR"\ncase "$1" in mcp) echo "[]"; exit 0 ;; esac\nsh -c 'echo $$ > "'"$D"'/grandchild.pid"; exec sleep 30' &\ncat > /dev/null\nsleep 20\n`);
    chmodSync(spawner, 0o755);
    process.env.LEANFARE_CODEX_BIN = spawner;
    rmSync(join(dir, "grandchild.pid"), { force: true });
    const ac = new AbortController();
    const run = runCodex({ n: 1, title: "Read", task: "Read it.", folder: null, files: [], effort: "low" }, ac.signal).catch((e) => e.message);
    for (let i = 0; i < 250 && !existsSync(join(dir, "grandchild.pid")); i++) await Bun.sleep(20);
    const t0 = Date.now();
    ac.abort();
    expect(await run).toBe("Stopped.");
    expect(Date.now() - t0).toBeLessThan(5000); // not the 20 seconds it would sleep
    const pid = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
    // Gone, or ended and waiting to be collected (a zombie: "Z"), as in a container whose first process collects none.
    const running = () => { const st = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim(); return st !== "" && !st.startsWith("Z"); };
    for (let i = 0; i < 50 && running(); i++) await Bun.sleep(20);
    const alive = running();
    try { process.kill(pid, "SIGKILL"); } catch {}
    expect(alive).toBe(false);
  }, 15_000);
  test("a run stopped while it waits for a slot leaves the line: never more than two at once", async () => {
    knob("slow", "3");
    const part = (n: number) => ({ n, title: `P${n}`, task: "Read it.", folder: null, files: [], effort: "low" as const });
    const s1 = new AbortController(), s2 = new AbortController();
    const a = runCodex(part(1), s1.signal).catch(() => null);
    const b = runCodex(part(2), s1.signal).catch(() => null);
    const until = async (ok: () => boolean) => { for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10); };
    await until(() => codexBusy().running === 2);
    const c = runCodex(part(3), s2.signal).catch((e) => e.message);
    const d = runCodex(part(4), s1.signal).catch(() => null);
    await until(() => codexBusy().waiting === 2);
    expect(codexBusy()).toEqual({ running: 2, waiting: 2 });
    s2.abort();
    expect(await c).toBe("Stopped.");
    expect(codexBusy()).toEqual({ running: 2, waiting: 1 });
    await Promise.all([a, b, d]);
    expect(codexBusy()).toEqual({ running: 0, waiting: 0 });
  }, 15_000);
  test("a run that fails before Codex starts gives its slot back", async () => {
    const was = process.env.TMPDIR;
    process.env.TMPDIR = join(dir, "gone"); // a temp folder that is not there (or a full disk)
    try {
      for (let i = 0; i < 3; i++) await expect(runCodex({ n: i, title: "P", task: "Read it.", folder: null, files: [], effort: "low" }, new AbortController().signal)).rejects.toThrow();
    } finally { if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was; }
    expect(codexBusy()).toEqual({ running: 0, waiting: 0 });
  });
});

describe("where Codex is placed", () => {
  test("a part that waits for one of yours is not put on Codex: your app hands it over with delegate, which cannot run Codex", async () => {
    await keys("openai");
    saveSettings({ codexPlan: true });
    const r = await plan({ task: "Refactor the router module and add tests", files: [{ name: "src/router.ts", size: 20_000 }] });
    const mine = new Set(r.json.parts.filter((p: any) => p.where === "you").map((p: any) => p.n));
    expect(mine.size).toBeGreaterThan(0);
    const waiting = r.json.parts.filter((p: any) => p.where !== "you" && p.needs.some((n: number) => mine.has(n)));
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.some((p: any) => p.where === "codex")).toBe(false);
    expect(r.json.next).not.toMatch(/once yours are done, run (it|them) with delegate[^.]*\bcodex/i);
  });
  test("Codex moved down for a kind still takes a part no model can take, and leaves a part another can take", async () => {
    saveSettings({ codexPlan: true });
    for (let i = 0; i < 3; i++) addGrade({ model: "codex", kind: "reason", effort: "medium", verdict: "wrong", source: "manager" });
    const none = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] }); // no keys: no model of Leanfare's is ready
    const reasoning = none.json.parts.filter((p: any) => p.kind === "reason" && p.where !== "you");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.every((p: any) => p.where === "codex")).toBe(true);
    await keys("openai");
    const some = await plan({ task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }] });
    expect(some.json.parts.filter((p: any) => p.kind === "reason" && p.where !== "you").every((p: any) => p.where === "paid")).toBe(true);
  });
});

describe("finding Codex's own program", () => {
  test("npm's, Bun's and pnpm's codex is a Node script: Leanfare runs the program it starts (its package for this computer)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-codex-npm-")));
    try {
      // npm on a Mac: bin/codex links to lib/node_modules/@openai/codex/bin/codex.js; the program is in the
      // package for this computer, nested in Codex's own node_modules or next to it.
      const pkg = join(root, "lib", "node_modules", "@openai", "codex");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      writeFileSync(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
      mkdirSync(join(root, "bin"));
      symlinkSync(join(pkg, "bin", "codex.js"), join(root, "bin", "codex"));
      const nested = join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "codex"), "");
      expect(nativeCodex(join(root, "bin", "codex"), "darwin", "arm64")).toBe(join(nested, "codex"));
      const hoisted = join(root, "lib", "node_modules", "@openai", "codex-darwin-x64", "vendor", "x86_64-apple-darwin", "bin");
      mkdirSync(hoisted, { recursive: true });
      writeFileSync(join(hoisted, "codex"), "");
      expect(nativeCodex(join(root, "bin", "codex"), "darwin", "x64")).toBe(join(hoisted, "codex"));
      // npm on Windows: codex.cmd in npm's folder, the program in node_modules beside it.
      const win = join(root, "npm");
      const exe = join(win, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
      mkdirSync(exe, { recursive: true });
      writeFileSync(join(exe, "codex.exe"), "");
      writeFileSync(join(win, "codex.cmd"), "@echo off\r\n");
      expect(nativeCodex(join(win, "codex.cmd"), "win32", "x64")).toBe(join(exe, "codex.exe"));
      // A program already (Homebrew's, or a download): as it is.
      writeFileSync(join(root, "codex-native"), "");
      expect(nativeCodex(join(root, "codex-native"), "darwin", "arm64")).toBe(join(root, "codex-native"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("on Windows, the codex.cmd npm makes is found", async () => {
    const npmDir = join(dir, "npm-global");
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, "codex.cmd"), "@echo off\r\n");
    delete process.env.LEANFARE_CODEX_BIN;
    const real = process.platform, path = process.env.PATH;
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PATH = npmDir;
    let found: string | null = null;
    try { found = await codexBin(); } finally { Object.defineProperty(process, "platform", { value: real }); process.env.PATH = path; }
    expect(found).toBe(join(npmDir, "codex.cmd"));
  });
  test("found through the login shell's PATH (the Mac app starts without it), Codex runs with that PATH too", async () => {
    const shellBin = join(dir, "shellbin");
    mkdirSync(shellBin, { recursive: true });
    writeFileSync(join(shellBin, "fakenode"), "#!/bin/sh\nexec /bin/sh \"$@\"\n"); chmodSync(join(shellBin, "fakenode"), 0o755);
    writeFileSync(join(shellBin, "codex"), FAKE.replace("#!/bin/sh", "#!/usr/bin/env fakenode")); chmodSync(join(shellBin, "codex"), 0o755);
    const shell = join(dir, "fakeshell");
    writeFileSync(shell, `#!/bin/sh\nPATH="${shellBin}:$PATH"; export PATH\nexec /bin/sh -c "$2"\n`); chmodSync(shell, 0o755);
    const was = { path: process.env.PATH, shell: process.env.SHELL };
    delete process.env.LEANFARE_CODEX_BIN;
    process.env.LEANFARE_SHELL_ENV = "on";
    process.env.SHELL = shell;
    process.env.PATH = "/usr/bin:/bin"; // what an app started from the Dock gets
    forgetShellEnv(); forgetCodex();
    let st: any;
    try { st = await codexState(true); } finally { process.env.PATH = was.path; process.env.LEANFARE_SHELL_ENV = "off"; process.env.SHELL = was.shell; forgetShellEnv(); }
    expect(st).toMatchObject({ installed: true, version: "0.159.0", signedIn: true, login: "chatgpt" });
  });
});
