// The loop (0.14, his design): at levels 1 to 4 the app's own split comes first and Leanfare places each part; at 5
// Leanfare's model splits. A part the app grades partly or wrong goes out again, one step up, to another model, with
// what was wrong (at 4 by itself); the last round may go to a paid model; missed in every round it is the app's. The
// app's own parts are rows too: once done, the parts that waited for them run with their answers.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkPlan, forgetPlans, makePlan, MAX_ROUNDS, OWN_SPLIT, runView, sendAgain, startRun, yoursDone } from "../src/planner";
import { statusText } from "../src/mcp";
import { JOB_DEFAULTS } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  fake.hooks.answer = null;
  forgetPlans();
  await reset({ ticked: ALL_TICKED, jobs: JOB_DEFAULTS });
  await keys("openai", "google", "deepseek", "anthropic");
});
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const signal = () => new AbortController().signal;
const MINE = [
  { title: "Read the cap code", kind: "read", effort: "low", needs: [], files: [], task: "List where the paid cap is read in the code." },
  { title: "Decide the fix", kind: "reason", effort: "high", needs: [1], files: [], task: "Decide how the cap should hold for a plan." },
  { title: "Draft the notes", kind: "write", effort: "low", needs: [2], files: [], task: "Draft the release notes for the fix." },
];
const given = (level: number, parts: unknown = MINE) => {
  const v = checkPlan({ task: "Fix the paid cap for plans", files: [], parts, level });
  if (typeof v === "string") throw new Error(v);
  return makePlan({ ...v, manager: "Claude Code", signal: signal() });
};

describe("who splits", () => {
  test("at 1 to 4 the app's own split is used as given, and Leanfare places each part; at 5 Leanfare's model splits", async () => {
    let asked = 0;
    fake.hooks.answer = (prompt) => { if (prompt.includes("The person works in")) asked++; return null; };
    const at4 = await given(4);
    expect([at4.split.by, at4.parts.map((p) => p.title), asked]).toEqual(["you", ["Read the cap code", "Decide the fix", "Draft the notes"], 0]);
    expect(at4.parts[0].where).not.toBe("you");
    expect(at4.next).not.toContain(OWN_SPLIT);
    const at5 = await given(5);
    expect(at5.split.by).not.toBe("you");
    expect(at5.split.note).toStartWith("At level 5 Leanfare makes the split, so the parts you gave were set aside.");
    expect(asked).toBe(1);
  });

  test("split by Leanfare at 4, the next steps say the app's own split comes first; bad parts are refused", async () => {
    const r = await makePlan({ task: "Fix the paid cap for plans, then write the notes", files: [], manager: "Claude Code", level: 4, split: "rules", signal: signal() });
    expect(r.next).toContain(OWN_SPLIT);
    expect(checkPlan({ task: "x", parts: [] })).toStartWith("parts must be a list of 1 to 8 parts");
    expect(checkPlan({ task: "x", parts: [{ kind: "read" }] })).toBe("parts must each have a title or a task.");
  });
});

describe("the loop", () => {
  test("graded partly at 4, a part goes out again one tier up to another model with what was wrong; missed in every round it is the app's", async () => {
    const asked: { prompt: string; model: string }[] = [];
    fake.hooks.answer = (prompt, _provider, model) => { if (!prompt.includes("The person works in")) asked.push({ prompt, model: String(model ?? "") }); return prompt.includes("List where the paid cap") ? "src/cap.ts:12" : null; };
    const r = await given(4, [MINE[0]]);
    startRun(r.id, { paid: true });
    await until(() => !runView(r.id)!.running);
    const first = runView(r.id)!.parts[0];
    expect(first.status).toBe("done");
    // through the server, as the app grades it: at 4 it goes out again by itself
    const g = await ui(url, "/api/grades", { id: r.id, part: 1, verdict: "partly", why: "it missed src/plan.ts" });
    expect(g.json.again).toMatchObject({ part: 1, round: 2, status: "waiting", effort: "medium", paid: false });
    await until(() => !runView(r.id)!.running && runView(r.id)!.parts[0].status === "done");
    const second = runView(r.id)!.parts[0];
    expect([second.round, second.modelId === first.modelId]).toEqual([2, false]);
    expect(asked.at(-1)!.prompt).toContain("An earlier answer to this part was graded partly: it missed src/plan.ts. Answer it again, and avoid that.");
    expect(statusText(runView(r.id), null)).toContain("| 1 | Read the cap code | done (round 2) |");
    const third = sendAgain(r.id, 1, "wrong", "still missing it");
    expect([third.round, third.paid]).toEqual([MAX_ROUNDS, true]); // the last round may go to a paid model
    await until(() => !runView(r.id)!.running && runView(r.id)!.parts[0].status !== "waiting" && runView(r.id)!.parts[0].status !== "running");
    expect(sendAgain(r.id, 1, "wrong", null)).toMatchObject({ status: "yours", round: MAX_ROUNDS });
    expect(runView(r.id)!.parts[0]).toMatchObject({ status: "yours", note: "Leanfare's models missed it in 3 rounds: it is yours now." });
  });

  test("below 4 a partly grade only goes out again with fix leanfare; fixed by the app, it stays", async () => {
    fake.hooks.answer = () => null;
    const r = await given(2, [MINE[0]]);
    startRun(r.id, { paid: true });
    await until(() => !runView(r.id)!.running);
    const g = await ui(url, "/api/grades", { id: r.id, part: 1, verdict: "partly" });
    expect(g.json.again).toBeUndefined();
    const f = await ui(url, "/api/grades", { id: r.id, part: 1, verdict: "partly", fix: "leanfare", why: "too short" });
    expect(f.json.again.round).toBe(2);
  });

  test("the app's own parts are rows: done with what the next ones need, and the parts that waited for them run with it", async () => {
    const prompts: string[] = [];
    fake.hooks.answer = (prompt) => { if (!prompt.includes("The person works in")) prompts.push(prompt); return null; };
    const r = await given(4);
    expect(r.parts.map((p) => p.where === "you")).toEqual([false, true, false]); // the hardest judgement stays below 5
    startRun(r.id, { paid: true });
    await until(() => !runView(r.id)!.running);
    expect(runView(r.id)!.parts.map((p) => p.status)).toEqual(["done", "yours", "after_yours"]);
    const v = yoursDone(r.id, [{ part: 2, answer: "Hold the cap per plan, counting checks." }], "Claude Opus 5.5");
    expect(v.parts[1]).toMatchObject({ status: "done", mine: true, model: "Claude Opus 5.5" });
    await until(() => !runView(r.id)!.running);
    expect(runView(r.id)!.parts[2].status).toBe("done");
    expect(prompts.find((x) => x.includes("Draft the release notes"))!).toContain("Hold the cap per plan, counting checks.");
    expect(statusText(runView(r.id), null)).toContain("| 2 | Decide the fix | done by you | Claude Opus 5.5 |");
    expect(() => yoursDone(r.id, [{ part: 1 }], null)).toThrow("Part 1 is not yours (it is done).");
  });
});
