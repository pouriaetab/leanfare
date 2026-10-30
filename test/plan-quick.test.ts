// A plan's split (planner.ts, 0.11): it goes to a model that answers within about 15 seconds by its record here, and a
// try that does not start in time is passed to the next pick, so a slow or busy model cannot eat the 40 seconds. And a
// list of questions is not split like code: the facts are read outside, and the answers stay with your app.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { QUESTIONS_WHY, isQuestions, makePlan, rulesSplit } from "../src/planner";
import { saveSettings } from "../src/settings";
import { forgetSpeeds } from "../src/speed";
import { boot, fake, keys, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash";
const SPLIT = JSON.stringify({ parts: [
  { title: "Read the logs", kind: "read", effort: "low", needs: [], size: "medium", files: [], task: "Find the errors." },
  { title: "Fix it", kind: "code", effort: "high", needs: [1], size: "small", task: "Fix the cause." },
] });
beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset({ ticked: [GEMINI, DEEPSEEK] }); await keys("google", "deepseek"); fake.hooks.answer = (p) => (p.includes("The person works in") ? SPLIT : null); });
afterEach(() => { fake.hooks.answer = null; fake.hooks.slow = null; delete process.env.LEANFARE_SPLIT_SECONDS; });
const signal = () => new AbortController().signal;
// Answers as the ledger keeps them: this model's first word after `first` seconds.
function answered(model: string, first: number, n = 8) {
  for (let i = 0; i < n; i++) db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, ms, first_ms, in_tokens, out_tokens)
    VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'delegate', ?, ?, 'listed', 'reported', 'ok', ?, ?, 1000, 400)`).run(model.split("/")[0], model, first * 1000 + 400, first * 1000); // then 1,000 tokens a second
  forgetSpeeds();
}

describe("the split goes to a model that answers in seconds", () => {
  test("by its record here: one that took 3 minutes to start is passed over for one that starts in 2 seconds", async () => {
    saveSettings({ providers: { google: { on: true, free: true } } }); // the slow one is also the cheaper: free
    answered(GEMINI, 180);
    answered(DEEPSEEK, 2);
    const r = await makePlan({ task: "Fix the nightly job: read its logs and find why it fails", files: [], manager: "Claude Code", signal: signal() });
    expect([r.split.by, r.split.model?.id]).toEqual(["model", DEEPSEEK]);
  });
  test("a try that does not start in time is passed to the next pick, and that one splits it", async () => {
    process.env.LEANFARE_SPLIT_SECONDS = "3"; // each try then has 1.2 seconds to start
    saveSettings({ providers: { google: { on: true, free: true } } }); // Gemini first: free, and quick by its record
    answered(GEMINI, 2);
    answered(DEEPSEEK, 2);
    fake.hooks.slow = (prompt, provider) => (provider === "google" && prompt.includes("The person works in") ? 5000 : 0);
    const t0 = Date.now();
    const r = await makePlan({ task: "Fix the nightly job: read its logs and find why it fails", files: [], manager: "Claude Code", signal: signal() });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect([r.split.by, r.split.model?.id]).toEqual(["model", DEEPSEEK]);
    const tries = db.query("SELECT model, status, fail FROM ledger WHERE source = 'plan' ORDER BY id").all() as any[]; // this time it was slow
    expect(tries).toEqual([{ model: GEMINI, status: "error", fail: "timeout" }, { model: DEEPSEEK, status: "ok", fail: null }]);
  });
});

describe("questions are not split like code", () => {
  test("which tasks are questions", () => {
    expect(isQuestions("Why is it not used more? Should grades be numbers?")).toBe(true);
    expect(isQuestions("Is it ready to list everywhere?")).toBe(true);
    expect(isQuestions("Fix the login bug. Why does it fail?")).toBe(false); // asks for a change
    expect(isQuestions("Port the CLI to Rust")).toBe(false);
    expect(isQuestions(`${"Tell me what you think of the design, with the reasons, ".repeat(12)}?`)).toBe(false); // one, long
  });
  test("with files: the facts are read outside, the answers stay with you; without: you answer them", () => {
    const files = [{ name: "notes/listing.md", size: 9_000 }, { name: "notes/lessons.md", size: 30_000 }];
    const parts = rulesSplit("Why is it not used more? Is it ready to list everywhere?", files);
    expect(parts.map((p) => [p.title, p.kind, !!p.keep])).toEqual([["Gather the facts the questions need", "read", false], ["Answer the questions", "reason", true]]);
    expect(parts[1].keepWhy).toBe(QUESTIONS_WHY);
    expect(rulesSplit("Why is it not used more? Is it ready?", []).map((p) => [p.title, !!p.keep])).toEqual([["Answer the questions", true]]);
  });
  test("the plan says so: read the facts with delegate, then answer them yourself", async () => {
    const r = await makePlan({ task: "Why is Leanfare not used more? Is it ready to list everywhere?", files: [{ name: "/tmp/notes/listing.md", size: 9_000 }], manager: "Claude Code", split: "rules", signal: signal() });
    expect(r.parts.map((p) => [p.title, p.where === "you"])).toEqual([["Gather the facts the questions need", false], ["Answer the questions", true]]);
    expect(r.parts[1].why).toBe(QUESTIONS_WHY);
    expect(r.next).toContain(`Answer the questions yourself once the facts are back: ${QUESTIONS_WHY}.`);
  });
});
