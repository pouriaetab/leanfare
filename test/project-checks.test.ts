// Checks set once per project (checks.ts, 0.14, his loop: cheap tests set at the start of the project): kept for the
// folder, shown with every plan made there, words scanned by Leanfare itself, commands and the rest left to the app,
// which reports them with grade; Settings lists them and can take a project's away.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResult, checksFor, parseChecks, wordsFound } from "../src/checks";
import { checkPlan, checkedOf, forgetPlans, makePlan, NO_CHECKS, recordChecks, runView, startRun } from "../src/planner";
import { checksNext, statusText } from "../src/mcp";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  fake.hooks.answer = null;
  forgetPlans();
  await reset({ ticked: ALL_TICKED });
  await keys("openai", "google", "deepseek");
}, 20000);
afterEach(closeApp, 20000);
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const signal = () => new AbortController().signal;
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "lf-proj-")));
const LIST = ["run: bun test", "words: utilize, leverage", "the Savings page fits one screen", "bash scripts/leakscan.sh"];

describe("a project's checks", () => {
  test("read from plain lines: run, words and look; a line that starts like a command is one to run", () => {
    expect(parseChecks(LIST)).toEqual([
      { n: 1, kind: "run", what: "bun test" }, { n: 2, kind: "words", what: "utilize, leverage" },
      { n: 3, kind: "look", what: "the Savings page fits one screen" }, { n: 4, kind: "run", what: "bash scripts/leakscan.sh" },
    ]);
    expect(parseChecks([])).toStartWith("checks must be a list of 1 to 12 short lines");
    expect(parseChecks(["x".repeat(301)])).toStartWith("checks must be a list");
    expect(wordsFound(parseChecks(LIST) as any, "We Leverage it. Utilized is fine.")).toEqual(["leverage"]);
  });

  test("set with a plan, kept for the folder, shown with every plan there; a folder with none says how to set them", async () => {
    const dir = folder();
    const none = await makePlan({ task: "Fix the cap", files: [], manager: "Claude Code", split: "rules", folder: dir, signal: signal() });
    expect(none.table).toContain(NO_CHECKS);
    const v = checkPlan({ task: "Fix the cap", files: [], folder: dir, checks: LIST });
    if (typeof v === "string") throw new Error(v);
    const set = await makePlan({ ...v, manager: "Claude Code", split: "rules", signal: signal() });
    expect(set.table).toContain("Checks for this project: 1. run bun test; 2. none of these in what comes back: utilize, leverage; 3. the Savings page fits one screen; 4. run bash scripts/leakscan.sh.");
    expect(set.next).toContain("run the project's checks (1, 2, 3, 4) and report them with grade");
    const later = await makePlan({ task: "Another task", files: [], manager: "Claude Code", split: "rules", folder: dir, signal: signal() });
    expect(later.checks!.map((c) => c.n)).toEqual([1, 2, 3, 4]);
    expect(checksFor(dir)).toHaveLength(4);
    expect(checkPlan({ task: "x", checks: LIST })).toBe("checks are kept for a project's folder: give plan the folder too.");
  });

  test("words on the list are found in an answer by Leanfare itself; once the parts end the app is asked to run the rest and report", async () => {
    const dir = folder();
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? null : "We leverage the cache.");
    const v = checkPlan({ task: "Summarize the notes in this folder for the README", files: [], folder: dir, checks: LIST });
    if (typeof v === "string") throw new Error(v);
    const r = await makePlan({ ...v, manager: "Claude Code", split: "rules", level: 4, signal: signal() });
    startRun(r.id, { paid: true });
    await until(() => !runView(r.id)!.running);
    const run = runView(r.id)!;
    const worded = run.parts.find((p) => p.words?.length)!;
    expect(worded.words).toEqual(["leverage"]);
    const said = statusText(run, null);
    expect(said).toContain(`Part ${worded.n} holds words the project's checks keep out: leverage.`);
    expect(checksNext(run)).toStartWith("Once you have applied what came back, run the project's checks: 1. run bun test; 2. none of these in the work: utilize, leverage;");
    // the app reports them: numbers on the list only
    expect(() => recordChecks(r.id, { passed: [1, 9] })).toThrow("There is no check 9 in this project's list (1 to 4).");
    expect(recordChecks(r.id, { passed: [1, 3, 4], failed: [2], why: "part 2 said leverage" })).toMatchObject({ passed: [1, 3, 4], failed: [2], why: "part 2 said leverage" });
    expect(checkedOf(r.id)!.failed).toEqual([2]);
    expect(checksNext(runView(r.id))).toBe("The project's checks: 3 passed, 1 failed (2).");
    expect(checkResult([{ n: 1, kind: "run", what: "x" }], { passed: [1], failed: [1] })).toBe("A check cannot both pass and fail.");
  });

  test("Settings lists each project's checks, one line a check, and takes a project's away", async () => {
    const dir = folder();
    const v = checkPlan({ task: "Fix the cap", files: [], folder: dir, checks: LIST });
    if (typeof v === "string") throw new Error(v);
    await makePlan({ ...v, manager: "Claude Code", split: "rules", signal: signal() });
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 200 && !doc.querySelector("#checksCard .chk-list"); i++) await Bun.sleep(50);
    const card = doc.querySelector("#checksCard")!;
    expect(card.closest("details.group")!.getAttribute("data-group")).toBe("jobs");
    expect([...card.querySelectorAll(".chk-list li")].map((li: any) => [li.querySelector(".chip").textContent, li.querySelector(".chk-what").textContent]))
      .toEqual([["Run", "bun test"], ["Keep out", "utilize, leverage"], ["Look", "the Savings page fits one screen"], ["Run", "bash scripts/leakscan.sh"]]);
    (card.querySelector(".chk-head button") as any).click();
    for (let i = 0; i < 100 && checksFor(dir).length; i++) await Bun.sleep(30);
    expect(checksFor(dir)).toEqual([]);
    expect((await ui(url, "/api/checks")).json.projects).toEqual([]);
  }, 30000);
});
