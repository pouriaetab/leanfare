// Whose limits a plan is placed by, the needs after an entry the split leaves out, and the task
// handed over once.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { forgetPlans, keptPlan, makePlan, readSplit, runView, rulesSplit, startRun } from "../src/planner";
import { saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED });
});
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("placing and splitting a plan", () => {
  test("a Codex user's plan is not placed by Claude's limits", async () => {
    await keys("openai", "google", "deepseek");
    const T = (iso: string) => Date.parse(iso);
    saveSnap({ at: T("2026-10-21T11:00:00Z"), five: { used: 92, resets: T("2026-10-21T15:00:00Z") }, week: { used: 40, resets: T("2026-10-27T12:00:00Z") } });
    const r = await makePlan({ task: "Port the CLI to Rust", files: [], manager: "Codex", split: "rules", signal: new AbortController().signal });
    const design = r.parts.find((p) => p.kind === "reason" && p.effort === "high")!;
    expect(design.where).toBe("you"); // Codex spends the ChatGPT plan; Claude's 92% says nothing about it
  });

  test("an entry the split leaves out does not move the others' needs", () => {
    const parts = readSplit(JSON.stringify({ parts: [
      { title: "Map the code", kind: "read", task: "Map it." },
      {},                                                     // an entry with no words: skipped
      { title: "Read the router", kind: "read", needs: [1], task: "Read it." },
      { title: "Draft the README", kind: "write", needs: [3], task: "Draft it from what part 3 found." },
    ] }), [])!;
    expect(parts.find((p) => p.title === "Draft the README")!.needs).toEqual([2]);
  });

  test("a part split by rules hands the task over once", async () => {
    await keys("openai", "google", "deepseek");
    const task = "Plan a birthday party for twelve people UNIQUE_TASK_WORDS";
    const prompts: string[] = [];
    fake.hooks.answer = (p) => { prompts.push(p); return null; };
    const plan = await makePlan({ task, files: [], manager: null, split: "rules", signal: new AbortController().signal });
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    const first = prompts.find((p) => p.includes("Work out how to do this"))!;
    expect(first.split("UNIQUE_TASK_WORDS").length - 1).toBe(1);
  });
});
