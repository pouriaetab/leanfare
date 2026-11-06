// 0.15.2: fewer calls to Leanfare's tools. Each call can be a question in an app that asks before a tool runs (Cowork
// can), and he saw them even with Leanfare switched off and the knob at 1. Switched off, the apps hear level 1, so the
// leanfare-level mod adds nothing and turns nothing back; on, the level line says not to call the level tool again and
// to grade a prompt's answers in one call; and grade takes a plan's answers, its checks and the whole result at once.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { draw } from "../src/delegate";
import { FEWER_CALLS, OFF_LEVEL, planReview, runToolFor } from "../src/mcp";
import { forgetPlans } from "../src/planner";
import { saveSettings } from "../src/settings";
import { setSwitch } from "../src/switch";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";

const DATA = () => process.env.LEANFARE_DATA_DIR!;
const ctx = { client: "Claude", cwd: process.env.LEANFARE_DATA_DIR!, canAsk: false };
const tool = (name: string, args: any) => runToolFor({ ...ctx, cwd: DATA() }, name, args, new AbortController().signal);
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); setSwitch(true); forgetPlans(); draw.next = () => 0.5; });
afterAll(() => { setSwitch(true); draw.next = () => Math.random(); });

describe("the level, as the apps hear it", () => {
  test("switched off: level 1 and the reason, so nothing calls Leanfare; the knob is kept as it was", async () => {
    saveSettings({ level: 4 });
    setSwitch(false);
    const r = await tool("level", {});
    expect(r.structuredContent).toMatchObject({ level: 1, name: "Off", off: true, knob: 4, advice: OFF_LEVEL });
    expect(r.content[0].text).toStartWith(OFF_LEVEL);
    expect(r.content[0].text).not.toContain(FEWER_CALLS);
    setSwitch(true);
    const on = await tool("level", {});
    expect(on.structuredContent).toMatchObject({ level: 4, name: "Most" });
    expect(on.structuredContent.off).toBeUndefined();
    // On, the line the mod puts in the prompt asks for no level call and one grade call a prompt.
    expect(on.structuredContent.note).toContain(FEWER_CALLS);
    expect(FEWER_CALLS).toContain("no need to call Leanfare's level tool again");
    expect(FEWER_CALLS).toContain("in one grade call");
    // At 1 nothing is asked, so nothing more is said.
    saveSettings({ level: 1 });
    const one = await tool("level", {});
    expect(one.structuredContent).toMatchObject({ level: 1, name: "Off" });
    expect(one.content[0].text).not.toContain(FEWER_CALLS);
  });

  test("the level tool's own words: no call to read the level where the mod gives it, and none at all at 1 or switched off", async () => {
    const { TOOLS } = await import("../src/mcp");
    const d = TOOLS.find((t) => t.name === "level")!.description;
    expect(d).toContain("Where the leanfare-level mod puts the level in the system prompt (Cowork and Claude Desktop), do not call it to read the level");
    expect(d).toContain("Level 1, or Leanfare switched off: do not call Leanfare's tools unless the user asks.");
  });
});

describe("a plan's answers graded in one call", () => {
  const plan = async () => {
    await keys("google", "deepseek");
    const files = [{ name: "a.log", size: 4000 }, { name: "b.md", size: 3000 }];
    const r = await ui(url, "/api/plan", { task: "Read the logs and the notes, then write a summary", files, manager: "Claude", split: "rules", run: true, parts: [
      { title: "Read the logs", kind: "read", effort: "low", files: ["a.log"], task: "Find the errors." },
      { title: "Read the notes", kind: "read", effort: "low", files: ["b.md"], task: "Find the open items." },
    ] });
    if ((await ui(url, `/api/plan/run?id=${r.json.id}`)).json.asks) await ui(url, "/api/plan/run", { id: r.json.id, paid: true }); // the paid parts: yes
    for (let i = 0; i < 100; i++) { const v = (await ui(url, `/api/plan/run?id=${r.json.id}`)).json; if (!v.running) break; await Bun.sleep(50); }
    return r.json;
  };

  test("grades: each part as one grade would, and the whole result, in one call", async () => {
    const p = await plan();
    const outside = p.parts.filter((x: any) => x.where !== "you").map((x: any) => x.n);
    expect(outside.length).toBe(2);
    const r = await tool("grade", { id: p.id, grades: outside.map((n: number) => ({ part: n, verdict: "good" })), whole: true, verdict: "good" });
    expect(r.isError).toBeUndefined();
    for (const n of outside) expect(r.content[0].text).toContain(`Part ${n}: Graded good.`);
    expect(r.content[0].text).toContain("Graded the whole result good.");
    expect(r.structuredContent.graded.map((g: any) => g.part ?? (g.whole ? "whole" : null))).toEqual([...outside, "whole"]);
    const kept = db.query("SELECT COUNT(*) AS n FROM delegations WHERE plan LIKE ? AND grade = 'good'").get(`${p.id}:%`) as { n: number };
    expect(kept.n).toBe(2); // each part's hand off keeps its grade, as with one grade a part
    // A part that cannot be graded says so, and the others are still graded.
    const again = await tool("grade", { id: p.id, grades: [{ part: 9, verdict: "good" }, { part: outside[0], verdict: "partly", fix: "myself" }] });
    expect(again.content[0].text).toContain("Part 9: ");
    expect(again.content[0].text).toContain(`Part ${outside[0]}: Graded partly.`);
    expect(again.structuredContent.graded[0].error).toBe(true);
  });

  test("checked first: the plan's id, each part's number and verdict, and the whole result's verdict", async () => {
    expect((await tool("grade", { grades: [{ part: 1, verdict: "good" }] })).content[0].text).toBe("grades go with the plan's id.");
    expect((await tool("grade", { id: "abcdefgh", grades: [] })).content[0].text).toContain("grades is a list of 1 to 20 parts");
    expect((await tool("grade", { id: "abcdefgh", grades: [{ part: "one", verdict: "good" }] })).content[0].text).toBe("each of grades needs part (the part's number) and verdict (good, partly or wrong).");
    expect((await tool("grade", { id: "abcdefgh", grades: [{ part: 1, verdict: "good" }], whole: true })).content[0].text).toBe("whole needs verdict: good, partly or wrong for the whole result.");
    // A single grade still works as before.
    expect((await tool("grade", {})).content[0].text).toBe("grade needs a verdict: good, partly or wrong.");
  });

  test("the plan's answers ask for one grade call when there are several", () => {
    const two = planReview({ review: true, parts: [{ n: 1, answer: "a" }, { n: 2, answer: "b" }] });
    expect(two).toContain("then grade them all in one grade call (the plan's id, and grades with each part's number and verdict: good, partly or wrong)");
    const one = planReview({ review: true, parts: [{ n: 1, answer: "a" }] });
    expect(one).toContain("then grade it with grade (good, partly or wrong, with the plan's id and the part)");
    expect(planReview({ review: false, parts: [{ n: 1, answer: "a" }, { n: 2, answer: "b" }] })).toContain("grade them all in one grade call");
  });
});
