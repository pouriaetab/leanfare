// Your ChatGPT plan, through Codex: a plan's reading, drafting and working out parts run on Codex
// (codex exec, read only) instead of pay per use, once the switch in Settings is on and Codex is
// signed in; never when you work in Codex itself, nor near the ChatGPT plan's limits. A stand-in
// codex command plays Codex: it answers --version, login status and exec, writes what it was given
// to files, and can fail, give nothing, or take long.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFor, codexPrompt, codexState, forgetCodex, runCodex } from "../src/codex";
import { commonFolder, forgetPlans } from "../src/planner";
import { forgetLogs } from "../src/plans";
import { saveSettings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

const FAKE = `#!/bin/sh
D="$FAKE_CODEX_DIR"
echo "$PWD|$*" >> "$D/calls.log"
case "$1" in
  --version) echo "codex-cli 0.159.0"; exit 0 ;;
  login) if [ -f "$D/signed-out" ]; then echo "Not logged in" >&2; exit 1; fi; echo "Logged in using ChatGPT"; exit 0 ;;
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
  for (const f of ["calls.log", "prompts.log", "signed-out", "slow", "fail", "empty"]) rmSync(join(dir, f), { force: true });
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
