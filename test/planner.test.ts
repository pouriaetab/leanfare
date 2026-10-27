// The plan (planner.ts): a task split into parts, each with where it runs and on which model, as a
// table. The split by a model and by rules, where each part goes, and the plan's limits.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainSeconds, checkPlan, forgetPlans, keptPlan, makePlan, paidOf, readSplit, rulesSplit, runView, SIZE_TOKENS, SPLIT_SYSTEM, splitView, startRun, stopRun, tableOf, type Part } from "../src/planner";
import { saveSettings } from "../src/settings";
import { saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  fake.hooks.answer = null;
  forgetPlans();
  await reset({ ticked: ALL_TICKED });
});
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const signal = () => new AbortController().signal;

const SPLIT = JSON.stringify({ parts: [
  { title: "Map the repo's modules", kind: "read", effort: "low", needs: [], size: "large", files: ["src/", "ghost.ts"], task: "List the modules and entry points." },
  { title: "Read the router closely", kind: "read", effort: "medium", needs: [1, 7, 2], size: "medium", files: [], task: "Explain how the router picks a model." },
  { title: "Design our own version", kind: "reason", effort: "high", needs: [2], size: "small", task: "Design a smaller version." },
  { title: "Write the code", kind: "code", effort: "high", needs: [3], size: "medium", task: "Write it." },
  { title: "Draft the README", kind: "write", effort: "medium", needs: [3], size: "small", task: "Draft the README." },
] });

describe("reading the split", () => {
  test("parts from a model's JSON: kinds and efforts checked, needs only on earlier parts, files only as given", () => {
    const parts = readSplit(`Here is the plan:\n${SPLIT}\nHope this helps!`, [{ name: "src/", size: 400_000 }])!;
    expect(parts.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]);
    expect(parts[0]).toMatchObject({ kind: "read", effort: "low", size: "large", files: ["src/"], needs: [] });
    expect(parts[1].needs).toEqual([1]); // 7 is not a part, 2 is itself
    expect(parts[3].kind).toBe("code");
  });

  test("nothing usable, nothing read: no JSON, no parts, or parts with no words", () => {
    expect(readSplit("I cannot help with that.", [])).toBeNull();
    expect(readSplit('{"parts": []}', [])).toBeNull();
    expect(readSplit('{"parts": [{"kind": "read"}]}', [])).toBeNull();
  });

  test("unknown kinds, efforts and sizes fall back to plain ones, and at most 8 parts are kept", () => {
    const many = { parts: Array.from({ length: 12 }, (_, i) => ({ title: `Part ${i + 1}`, kind: "dance", effort: "max", size: "huge", task: "x" })) };
    const parts = readSplit(JSON.stringify(many), [])!;
    expect(parts.length).toBe(8);
    expect(parts[0]).toMatchObject({ kind: "reason", effort: "medium", size: "small" });
  });

  test("the rules: a code task keeps its changes with you, research starts with a search, anything else is three parts", () => {
    const code = rulesSplit("Reverse engineer LiteLLM's router and build a smaller one", []);
    expect(code.map((p) => p.kind)).toEqual(["read", "read", "reason", "code", "reason"]);
    expect(code[0].size).toBe("large");
    const research = rulesSplit("Research the best open models for coding and compare their prices", []);
    expect(research[0].kind).toBe("search");
    expect(rulesSplit("Plan a birthday party for twelve people", []).length).toBe(3);
  });

  test("the split's instructions name every kind, the needs and the JSON shape", () => {
    for (const w of ["read", "write", "reason", "code", "search", "act", "needs", '"parts"']) expect(SPLIT_SYSTEM).toContain(w);
  });

  test("the request is checked: a task, files with sizes, at most 20,000 characters", () => {
    expect(checkPlan({})).toBe("plan needs a task.");
    expect(checkPlan({ task: "x".repeat(20_001) })).toContain("the most is 20,000");
    expect(checkPlan({ task: "x", files: [{ name: "a" }] })).toBe("Each file needs a name and its size in bytes.");
    expect(checkPlan({ task: " do it ", files: [{ name: "a.ts", size: 10 }], manager: "Claude Code", split: "rules" })).toEqual({ task: "do it", files: [{ name: "a.ts", size: 10 }], manager: "Claude Code", split: "rules" });
  });
});

describe("where each part runs", () => {
  test("a model splits it; reading goes to Leanfare, code and high effort judgement stay with you", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
    const r = await makePlan({ task: "Reverse engineer LiteLLM and build a smaller one", files: [{ name: "src/", size: 400_000 }], manager: "Claude Code", signal: signal() });
    expect(r.split.by).toBe("model");
    expect(r.split.model).not.toBeNull();
    const by = (n: number) => r.parts.find((p) => p.n === n)!;
    expect(by(1).where).not.toBe("you");
    expect(by(1).model).not.toBeNull();
    expect(by(1).tokens).toBeGreaterThan(100_000); // the folder's 400 KB, about 100k tokens, and the task
    expect(by(3)).toMatchObject({ where: "you", model: null, cost: null });
    expect(by(3).why).toContain("high effort");
    expect(by(4)).toMatchObject({ where: "you" });
    expect(by(4).why).toContain("Claude Code");
    expect(by(5).where).not.toBe("you");
    expect(r.totals).toMatchObject({ parts: 5, out: 3 });
    expect(r.totals.kept).toBeGreaterThan(r.totals.used);
    expect(r.table).toContain("| # | Part | Kind | Runs on | Model | Time | Tokens | Cost | When |");
    expect(r.table).toContain("you (Claude Code)");
    expect(r.table).toContain("after 3");
    expect(r.next).toContain("Run part 1 now with delegate");
    expect(r.next).toContain("Do parts 3 and 4 yourself.");
    // The split itself is one answer in the ledger, as "plan", with no words.
    const rows = ledger().filter((x: any) => x.source === "plan");
    expect(rows.length).toBe(1);
  });

  test("near a limit of your plan, the high effort judgement goes out too", async () => {
    await keys("openai", "google", "deepseek");
    const T = (iso: string) => Date.parse(iso);
    saveSnap({ at: T("2026-10-21T11:00:00Z"), five: { used: 92, resets: T("2026-10-21T15:00:00Z") }, week: { used: 40, resets: T("2026-10-27T12:00:00Z") } });
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
    const r = await makePlan({ task: "Reverse engineer LiteLLM", files: [], manager: "Claude Code", signal: signal() });
    expect(r.limits).toEqual({ five: 92, week: 40 });
    const design = r.parts.find((p) => p.n === 3)!;
    expect(design.where).not.toBe("you");
    expect(design.why).toContain("the 5 hours at 92%");
    expect(r.parts.find((p) => p.n === 4)!.where).toBe("you"); // code changes stay, whatever the limits
  });

  test("no model ready: split by rules, and every part stays with you, saying why", async () => {
    await reset({ ticked: [] });
    const r = await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: null, signal: signal() });
    expect(r.split.by).toBe("rules");
    expect(r.split.note).toContain("split it by rules");
    expect(r.parts.every((p) => p.where === "you")).toBe(true);
    expect(r.parts[0].why).toContain("Leanfare has no model for it now");
    expect(r.manager).toBe("you");
    expect(r.table).toContain("| you |");
  });

  test("split rules: no model is asked to split it", async () => {
    await keys("openai", "google", "deepseek");
    const r = await makePlan({ task: "Refactor the settings screen", files: [], manager: "Cursor", split: "rules", signal: signal() });
    expect(r.split).toEqual({ by: "rules", model: null, cost: null, note: null });
    expect(ledger().filter((x: any) => x.source === "plan").length).toBe(0);
    expect(r.parts.find((p) => p.kind === "code")!.why).toContain("Cursor");
  });

  test("a split that does not read as parts falls back to the rules, and says so", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? "Sure! First, map the code. Then write it." : null);
    const r = await makePlan({ task: "Port the CLI to Rust", files: [], manager: "Codex", signal: signal() });
    expect(r.split.by).toBe("rules");
    expect(r.split.note).toContain("did not read as parts");
  });

  test("a search part goes to a model that searches the web, or stays with you without one", async () => {
    await keys("openai", "google");
    const r = await makePlan({ task: "Research the cheapest coding models and compare them", files: [], manager: "Claude Code", split: "rules", signal: signal() });
    const search = r.parts.find((p) => p.kind === "search")!;
    expect(search.where).toBe("you");
    expect(search.why).toContain("searches the web");
  });

  test("the time of the parts done at once: the longest chain of needs", () => {
    const part = (n: number, seconds: number | null, needs: number[]) => ({ n, seconds, needs } as unknown as Part);
    expect(chainSeconds([part(1, 10, []), part(2, 30, []), part(3, 5, [1, 2])])).toBe(35);
    expect(chainSeconds([part(1, null, []), part(2, null, [1])])).toBeNull();
  });

  test("the table says how much of the plan each part keeps out or takes, and the totals", () => {
    const parts = [
      { n: 1, title: "Read | the logs", kind: "read", effort: "low", needs: [], task: "", files: [], size: "large", where: "local", model: { id: "ollama/qwen", label: "Qwen" }, seconds: 40, tokens: SIZE_TOKENS.large, cost: 0, why: "" },
      { n: 2, title: "Fix it", kind: "code", effort: "high", needs: [1], task: "", files: [], size: "small", where: "you", model: null, seconds: null, tokens: 5000, cost: null, why: "" },
    ] as Part[];
    const t = tableOf({ task: "x", manager: "Claude Code", parts, totals: { parts: 2, out: 1, later: 0, kept: SIZE_TOKENS.large, used: 5000, seconds: 40, after: null, cost: 0 }, split: { by: "rules", model: null, cost: null, note: null }, limits: null });
    expect(t).toContain("| 1 | Read / the logs | read, low | Leanfare, on this computer | Qwen | ~40 s | ~150k kept | $0 | now |");
    expect(t).toContain("| 2 | Fix it | code, high | you (Claude Code) | your model |  | ~5k of your plan | in your plan | after 1 |");
    expect(t).toContain("1 of 2 parts go to Leanfare, keeping about 150k tokens out of your plan; about 5k stay in it.");
  });

  test("POST /api/plan: checked, then planned", async () => {
    expect((await ui(url, "/api/plan", { task: "" })).json.error).toBe("plan needs a task.");
    const r = await ui(url, "/api/plan", { task: "Write a short story about a lighthouse", split: "rules" });
    expect(r.status).toBe(200);
    expect(r.json.parts.length).toBe(3);
    expect(typeof r.json.table).toBe("string");
  });
});

describe("running a plan here (the Plan tab)", () => {
  test("Leanfare's parts run at once, each after the parts it needs with their answers handed on; a part after one of yours waits", async () => {
    await keys("openai", "google", "deepseek");
    const prompts: string[] = [];
    fake.hooks.answer = (prompt) => {
      if (prompt.includes("The person works in")) return SPLIT;
      prompts.push(prompt);
      return prompt.includes("List the modules") ? "MODULES: proxy, router, cost." : null;
    };
    const plan = await makePlan({ task: "Reverse engineer LiteLLM", files: [], manager: "Claude Code", signal: signal() });
    const v = startRun(plan.id, { paid: true });
    expect(v.running).toBe(true);
    expect(startRun(plan.id)).toBe(v); // asked again while it runs: the same run
    await until(() => !runView(plan.id)!.running);
    const st = Object.fromEntries(runView(plan.id)!.parts.map((p) => [p.n, p.status]));
    expect(st).toEqual({ 1: "done", 2: "done", 3: "yours", 4: "yours", 5: "after_yours" }); // 5 needs 3, which is yours: yours to hand over once 3 is done
    expect(plan.totals.later).toBe(1);
    // The time of Leanfare's parts: 1 then 2 now; 5 counted apart, from when yours are done.
    expect(plan.totals.seconds).toBeCloseTo(plan.parts[0].seconds! + plan.parts[1].seconds!, 5);
    expect(plan.totals.after).toBeCloseTo(plan.parts[4].seconds!, 5);
    expect(plan.table).toContain("the ones after yours take");
    expect(plan.next).toContain("Part 5 waits for yours: once yours are done, run it with delegate");
    const two = prompts.find((x) => x.includes("Explain how the router picks a model"))!;
    expect(two).toContain("What the earlier parts found");
    expect(two).toContain("MODULES: proxy, router, cost."); // part 1's answer, handed on
    expect(runView(plan.id)!.parts[0].receipt).toContain("Leanfare delegate");
    expect(runView(plan.id)!.cost).not.toBeNull();
  });

  test("files named by path in the Plan tab are measured, then handed over when their part runs", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "plan-tab-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "router.py"), "def pick(deployments):\n    return deployments[0]\n");
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-never");
    const v = checkPlan({ task: "Reverse engineer this router and build a smaller one", paths: [dir], split: "rules" });
    if (typeof v === "string") throw new Error(v);
    expect(v.files.map((f) => f.size)).toEqual([Buffer.byteLength("def pick(deployments):\n    return deployments[0]\n")]); // router.py only: .env is never counted
    expect(checkPlan({ task: "x", paths: ["code/x"] })).toBe("code/x is not a full path. Give full paths, like ~/code/project.");
    const prompts: string[] = [];
    fake.hooks.answer = (prompt) => { prompts.push(prompt); return null; };
    const plan = await makePlan({ ...v, signal: signal() });
    expect(plan.parts[0].files.length).toBe(1);
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    expect(runView(plan.id)!.parts[0].status).toBe("done");
    expect(prompts.some((x) => x.includes("def pick(deployments):") && x.includes("router.py"))).toBe(true);
    expect(prompts.some((x) => x.includes("sk-never"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("Stop ends the run: what is running and what waits is stopped", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
    fake.hooks.slow = (prompt) => (prompt.includes("List the modules") ? 3000 : 0);
    try {
      const plan = await makePlan({ task: "Reverse engineer LiteLLM", files: [], manager: "Claude Code", signal: signal() });
      startRun(plan.id, { paid: true });
      await until(() => runView(plan.id)!.parts[0].status === "running");
      stopRun(plan.id);
      await until(() => !runView(plan.id)!.running);
      const st = runView(plan.id)!.parts.map((p) => p.status);
      expect(st[0]).toBe("stopped");
      expect(st[1]).toBe("stopped"); // it was waiting for part 1
    } finally { fake.hooks.slow = null; }
  });

  test("a plan Leanfare no longer has cannot run, and says what to do", async () => {
    expect(() => startRun("nope")).toThrow("Make the plan again.");
    expect((await ui(url, "/api/plan/run", { id: "nope" })).status).toBe(404);
    expect((await ui(url, "/api/plan/run?id=nope")).status).toBe(404);
    expect((await ui(url, "/api/plan/stop", { id: "nope" })).status).toBe(404);
  });
});

describe("paid parts: within the cap they run, above it they wait for a yes", () => {
  test("over the cap (0: always ask), the paid parts wait and the parts after them never start; a yes runs them, keeping what was done", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
    const plan = await makePlan({ task: "Reverse engineer LiteLLM", files: [], manager: "Claude Code", signal: signal() });
    const paid = paidOf(plan);
    expect(paid.parts).toEqual([1, 2, 5]); // on these keys every Leanfare part is pay per use
    const v = startRun(plan.id);
    await until(() => !runView(plan.id)!.running);
    expect(runView(plan.id)!.parts.map((p) => p.status)).toEqual(["asks", "asks", "yours", "yours", "after_yours"]); // part 5 waits for part 3, which is yours
    expect(runView(plan.id)!.asks).toMatchObject({ parts: [1, 2], cap: 0 });
    expect(ledger().filter((x: any) => x.source === "delegate").length).toBe(0); // nothing paid went out
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    expect(runView(plan.id)!.parts.map((p) => p.status)).toEqual(["done", "done", "yours", "yours", "after_yours"]);
    expect(runView(plan.id)!.asks).toBeNull();
    expect(v.id).toBe(plan.id);
  });

  test("within the cap set in Settings, they run without asking", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
    const plan = await makePlan({ task: "Reverse engineer LiteLLM", files: [], manager: "Claude Code", signal: signal() });
    saveSettings({ planAuto: Math.ceil((paidOf(plan).estimate ?? 0) * 100) / 100 + 0.01 });
    startRun(plan.id);
    await until(() => !runView(plan.id)!.running);
    expect(runView(plan.id)!.parts[0].status).toBe("done");
    expect(runView(plan.id)!.asks).toBeNull();
  });

  test("a yes while the free parts run: the paid ones join that run", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
    fake.hooks.slow = (prompt) => (prompt.includes("List the modules") ? 1500 : 0);
    try {
      const plan = await makePlan({ task: "Reverse engineer LiteLLM", files: [], manager: "Claude Code", signal: signal() });
      const kept = keptPlan(plan.id)!;
      Object.assign(kept.parts[0], { where: "free", cost: 0 }); // part 1 free, part 2 (after it) paid
      saveSettings({ providers: { google: { on: true, free: true } } }); // so a free model is there for part 1 (a free part runs on free models only)
      startRun(plan.id);
      await until(() => runView(plan.id)!.parts[0].status === "running");
      expect(runView(plan.id)!.parts[1].status).toBe("waiting"); // it waits for part 1 first
      startRun(plan.id, { paid: true }); // the yes, while part 1 runs
      expect(runView(plan.id)!.parts[1].status).toBe("waiting");
      await until(() => !runView(plan.id)!.running);
      expect(runView(plan.id)!.parts.slice(0, 2).map((p) => p.status)).toEqual(["done", "done"]);
    } finally { fake.hooks.slow = null; }
  });

  test("the cap is a dollar amount from 0 to 1,000", async () => {
    const { validatePatch } = await import("../src/settings");
    expect(validatePatch({ planAuto: "0.25" })).toEqual({ patch: { planAuto: 0.25 } });
    expect(validatePatch({ planAuto: "" })).toEqual({ patch: { planAuto: 0 } });
    expect(validatePatch({ planAuto: -1 })).toEqual({ error: "planAuto must be a dollar amount from 0 to 1,000" });
  });
});

describe("folders and searches", () => {
  test("past 200 files the split model sees their folders; past 200 folders, the largest and the rest together", () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ name: `repo/m${i}/a.py`, size: 1000 + i }));
    const shown = splitView(files);
    expect(shown.length).toBe(200);
    expect(shown[0].name).toBe("repo/m249/a.py"); // the largest first; a folder of one file is named by its file
    expect(shown.at(-1)).toMatchObject({ name: "(everything else) (51 files)", size: files.slice(0, 51).reduce((n, f) => n + f.size, 0) });
    expect(shown.at(-1)!.members.length).toBe(51);
    expect(shown.reduce((n, g) => n + g.members.length, 0)).toBe(250); // every file is in one of them
  });

  test("a search part runs on the model the plan named; one that fails says so, and the parts after it wait", async () => {
    await reset({ ticked: [...ALL_TICKED, "perplexity/sonar"] });
    await keys("openai", "google", "deepseek", "perplexity");
    const make = () => makePlan({ task: "Research the open source vector databases and compare them", files: [], manager: "Claude Code", split: "rules", signal: signal() });
    const plan = await make();
    expect(plan.parts[0]).toMatchObject({ kind: "search", where: "paid", model: { id: "perplexity/sonar" } });
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    const one = runView(plan.id)!.parts[0];
    expect(one).toMatchObject({ status: "done", answer: "Hello from sonar." });
    expect(one.receipt).toContain("Sonar");
    fake.hooks.fail = (_text, provider) => (provider === "perplexity" ? 500 : null);
    const again = await make();
    startRun(again.id, { paid: true });
    await until(() => !runView(again.id)!.running);
    const [first, second] = runView(again.id)!.parts;
    expect(first.status).toBe("failed");
    expect(first.error).toBeTruthy();
    expect(second.status).toBe("blocked"); // it needs the sources
  });
});
