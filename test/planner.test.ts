// The plan (planner.ts): a task split into parts, each with where it runs and on which model, as a
// table. The split by a model and by rules, where each part goes, and the plan's limits.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chainSeconds, checkPlan, makePlan, readSplit, rulesSplit, SIZE_TOKENS, SPLIT_SYSTEM, tableOf, type Part } from "../src/planner";
import { saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  fake.hooks.answer = null;
  await reset({ ticked: ALL_TICKED });
});
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
    const t = tableOf({ task: "x", manager: "Claude Code", parts, totals: { parts: 2, out: 1, kept: SIZE_TOKENS.large, used: 5000, seconds: 40, cost: 0 }, split: { by: "rules", model: null, cost: null, note: null }, limits: null });
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
