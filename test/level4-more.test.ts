// Level 4 sends more out (0.14, his levels: "4 means more favoring and allocation to the outside models"): working
// things out below high effort goes out as drafting does; a change to files is drafted outside as a patch the app
// reads and applies; free models take medium working out at 4; Claude Desktop and Cowork hear which of Claude's own
// models a part that stays should run on.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgetPlans, gradePart, makePlan, PATCH_ASK, picksPerPart, runView, startRun } from "../src/planner";
import { JOB_DEFAULTS } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  fake.hooks.answer = null;
  forgetPlans();
  await reset({ ticked: ALL_TICKED, jobs: JOB_DEFAULTS });
  await keys("openai", "google", "deepseek", "anthropic");
});
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const signal = () => new AbortController().signal;
const SPLIT = JSON.stringify({ parts: [
  { title: "Find where the cap is read", kind: "read", effort: "low", needs: [], size: "small", task: "List where the paid cap is read." },
  { title: "Work out the fix", kind: "reason", effort: "medium", needs: [1], size: "small", task: "Work out why the cap is skipped." },
  { title: "Decide the design", kind: "reason", effort: "high", needs: [2], size: "small", task: "Decide how the cap should hold across plans." },
  { title: "Change the code", kind: "code", effort: "medium", needs: [], size: "small", files: ["src/cap.ts"], task: "Make the cap hold for a plan's paid parts." }, // 0.15: a patch needs the files it changes
  { title: "Run the tests", kind: "act", effort: "low", needs: [4], size: "none", task: "Run the tests." },
] });
const plan = (level: 2 | 3 | 4 | 5, manager = "Claude Code") => {
  fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? SPLIT : null);
  return makePlan({ task: "Fix the paid cap for plans", files: [{ name: "src/cap.ts", size: 4000 }], manager, level, signal: signal() });
};
const at = (r: any, n: number) => r.parts.find((p: any) => p.n === n);

describe("level 4 sends more out", () => {
  test("below 4 a change to files stays; at 4 a model drafts it as a patch you apply, and the table and the next steps say so", async () => {
    const at3 = await plan(3);
    expect([at(at3, 4).where, at(at3, 4).patch ?? false, at(at3, 4).why]).toEqual(["you", false, "it changes the project, which only Claude Code can do"]);
    const at4 = await plan(4);
    const code = at(at4, 4);
    expect([code.kind, code.where !== "you", code.patch]).toEqual(["code", true, true]);
    expect(code.why).toStartWith("your Leanfare level is 4 (Most): a model drafts the change as a patch, and you read it and apply it (");
    expect(at4.table).toContain("| code (patch), medium |");
    expect(at4.next).toContain("Part 4 comes back as a patch: read it, apply what is right with your own tools, and grade it.");
    expect(at(at4, 5).where).toBe("you"); // running the tests needs the app's own tools, at every level
  });

  test("your rule that keeps drafting with your app keeps a patch with it too", async () => {
    await reset({ ticked: ALL_TICKED, jobs: { ...JOB_DEFAULTS, write: "app" }, jobsSet: true });
    await keys("openai", "google", "deepseek", "anthropic");
    const r = await plan(4);
    expect([at(r, 4).where, at(r, 4).patch ?? false, at(r, 4).why]).toEqual(["you", false, "your rules keep drafting with Claude Code (Settings, Jobs)"]);
  });

  test("at 4 working things out goes out below high effort; the hardest stays with your strongest model until 5", async () => {
    const at4 = await plan(4);
    expect(at(at4, 2).where).not.toBe("you");
    expect([at(at4, 3).where, at(at4, 3).why]).toEqual(["you", "high effort working out stays with your strongest model below level 5"]);
    const at5 = await plan(5);
    expect(at(at5, 3).where).not.toBe("you");
  });

  test("a patch part runs as drafting, asked for a diff, and is graded as drafting", async () => {
    const prompts: string[] = [];
    fake.hooks.answer = (prompt) => {
      if (prompt.includes("The person works in")) return SPLIT;
      prompts.push(prompt);
      return prompt.includes("Draft this change as a patch") ? "--- a/src/cap.ts\n+++ b/src/cap.ts\n@@ -1 +1 @@\n-x\n+y\nsrc/cap.ts: the cap holds." : null;
    };
    mkdirSync(join(process.cwd(), "src"), { recursive: true });
    writeFileSync(join(process.cwd(), "src", "cap.ts"), "x\n"); // the file the change names, in the tests' own project
    const r = await makePlan({ task: "Fix the paid cap for plans", files: [{ name: "src/cap.ts", size: 2 }], manager: "Claude Code", level: 4, signal: signal() });
    startRun(r.id, { paid: true });
    await until(() => !runView(r.id)!.running);
    rmSync(join(process.cwd(), "src"), { recursive: true, force: true });
    const four = runView(r.id)!.parts.find((p) => p.n === 4)!;
    expect(four.status).toBe("done");
    expect(four.answer).toContain("+++ b/src/cap.ts");
    expect(prompts.find((x) => x.includes("Make the cap hold"))!).toContain(`${PATCH_ASK}\n\nMake the cap hold for a plan's paid parts.`);
    expect(gradePart(r.id, 4, "good", "manager").text).toContain("for drafting");
  });

  test("Claude Desktop and Cowork hear which of Claude's models a part that stays should run on, and to do it themselves when they cannot start a helper", async () => {
    expect([picksPerPart("Claude Code"), picksPerPart("Claude"), picksPerPart("Cowork"), picksPerPart("Codex")]).toEqual([true, true, true, false]);
    const r = await plan(2, "Claude");
    const mine = r.parts.filter((p) => p.where === "you");
    expect(mine.length).toBeGreaterThan(0);
    expect(r.next).toContain("start a helper (a subagent) with that model if your app can (model: haiku, sonnet, opus or fable); if it cannot, do the part yourself.");
    expect((await plan(2)).next).toContain("use a subagent with that model (model: haiku, sonnet, opus or fable).");
  });
});
