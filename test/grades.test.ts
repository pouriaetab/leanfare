// The manager's grades: the app you work in (or you, in the Plan tab) grades the answer of a part
// Leanfare ran: good, partly or wrong. The grade goes with the model and the kind of part, never the
// words. A model graded below good too often for a kind (3 or more of its last 20, under half good,
// partly counting half) is moved down: Auto, plans and the delegate skip it for that kind while another
// model can take it, until it gets another chance.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { addGrade, giveAnotherChance, movedDown, standing, standingText, standings } from "../src/grades";
import { forgetPlans } from "../src/planner";
import { saveSettings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { forgetPlans(); await reset({ ticked: ALL_TICKED }); });
const grade = (model: string, kind: "read" | "write" | "reason" | "search", ...verdicts: ("good" | "partly" | "wrong")[]) => { for (const v of verdicts) addGrade({ model, kind, effort: "low", verdict: v, source: "manager" }); };

describe("the standing of a model for a kind", () => {
  test("fewer than 3 grades never move a model down; 3 with under half good do; partly counts half", () => {
    grade("deepseek/deepseek-v4-flash", "read", "wrong", "wrong");
    expect(movedDown("deepseek/deepseek-v4-flash", "read")).toBe(false);
    grade("deepseek/deepseek-v4-flash", "read", "good");
    expect(standing("deepseek/deepseek-v4-flash", "read")).toMatchObject({ n: 3, good: 1, wrong: 2, down: true });
    grade("openai/gpt-5-mini", "read", "good", "partly", "partly"); // (1 + 0.5 + 0.5) / 3: two thirds
    expect(standing("openai/gpt-5-mini", "read")).toMatchObject({ n: 3, score: 2 / 3, down: false });
    grade("openai/gpt-5-mini", "write", "partly", "partly", "wrong"); // a third
    expect(movedDown("openai/gpt-5-mini", "write")).toBe(true);
    expect(movedDown("openai/gpt-5-mini", "read")).toBe(false); // each kind stands on its own
  });
  test("only the last 20 grades count: a model that got better is picked again", () => {
    grade("deepseek/deepseek-v4-flash", "reason", "wrong", "wrong", "wrong", "wrong", "wrong");
    expect(movedDown("deepseek/deepseek-v4-flash", "reason")).toBe(true);
    grade("deepseek/deepseek-v4-flash", "reason", ...Array(20).fill("good"));
    expect(standing("deepseek/deepseek-v4-flash", "reason")).toMatchObject({ n: 20, good: 20, wrong: 0, down: false });
    expect(db.query("SELECT COUNT(*) AS n FROM grades").get()).toEqual({ n: 20 }); // and only they are kept
  });
  test("another chance drops its grades for that kind only", () => {
    grade("deepseek/deepseek-v4-flash", "read", "wrong", "wrong", "wrong");
    grade("deepseek/deepseek-v4-flash", "write", "wrong", "wrong", "wrong");
    expect(giveAnotherChance("deepseek/deepseek-v4-flash", "read")).toBe(3);
    expect(movedDown("deepseek/deepseek-v4-flash", "read")).toBe(false);
    expect(movedDown("deepseek/deepseek-v4-flash", "write")).toBe(true);
  });
  test("in words, and the list for Settings (the moved down first)", () => {
    grade("deepseek/deepseek-v4-flash", "read", "good", "wrong", "wrong");
    grade("openai/gpt-5-mini", "read", "good");
    const st = standing("deepseek/deepseek-v4-flash", "read");
    expect(standingText(st)).toBe("DeepSeek V4 Flash for reading: 1 good, 2 wrong of its last 3. Moved down: Auto, plans and the delegate skip it for this kind while another model can take it (Settings, How the models did for you, gives it another chance).");
    expect(standingText(standing("openai/gpt-5-mini", "read"))).toBe("GPT-5 mini for reading: 1 good of its last 1 (it moves down below half good, from 3 grades on).");
    expect(standings().map((s) => [s.model, s.down])).toEqual([["deepseek/deepseek-v4-flash", true], ["openai/gpt-5-mini", false]]);
  });
  test("no words are kept: a grade is a model, a kind, an effort, a verdict, where it came from and when", () => {
    grade("openai/gpt-5-mini", "read", "good");
    const cols = (db.query("PRAGMA table_info(grades)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "ts", "model", "kind", "effort", "verdict", "source"]);
  });
});

describe("what a model moved down changes", () => {
  const delegate = async () => (await ui(url, "/api/delegate", { task: "List the errors in this log: 10:01 error: disk full", files: [], kind: "read", effort: "low", check: "never" })).json;
  test("the delegate picks another model for that kind, and the moved down one again after another chance", async () => {
    await keys("openai", "deepseek");
    const first = (await delegate()).model.id;
    grade(first, "read", "wrong", "wrong", "wrong");
    const second = (await delegate()).model.id;
    expect(second).not.toBe(first);
    giveAnotherChance(first, "read");
    expect((await delegate()).model.id).toBe(first);
  });
  test("when no other model can take it, the moved down one still does (it never leaves a part with no model)", async () => {
    await reset({ ticked: ["deepseek/deepseek-v4-flash"] });
    await keys("deepseek");
    grade("deepseek/deepseek-v4-flash", "read", "wrong", "wrong", "wrong");
    expect((await delegate()).model.id).toBe("deepseek/deepseek-v4-flash");
  });
  test("a plan places the part on another model", async () => {
    await keys("openai", "deepseek");
    const plan = async () => (await ui(url, "/api/plan", { task: "Find the errors in these logs", files: [{ name: "logs/app.log", size: 20_000 }], manager: "Claude Code", split: "rules" })).json;
    const before = (await plan()).parts.filter((p: any) => p.where !== "you" && p.kind === "reason").map((p: any) => p.model.id);
    expect(before.length).toBeGreaterThan(0);
    grade(before[0], "reason", "wrong", "wrong", "wrong");
    const after = (await plan()).parts.filter((p: any) => p.where !== "you" && p.kind === "reason").map((p: any) => p.model.id);
    expect(after).not.toContain(before[0]);
  });
});

describe("grading a plan's part", () => {
  async function ranPlan() {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (p) => (p.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Read the logs", kind: "read", effort: "low", needs: [], size: "small", task: "Find the errors in the logs." },
      { title: "Fix the cause", kind: "code", effort: "high", needs: [1], size: "small", task: "Fix it." },
    ] }) : prompt(p));
    const prompt = (p: string) => (p.includes("Find the errors") ? "Three timeouts at 10:02." : null);
    saveSettings({ planAuto: 5 });
    const plan = (await ui(url, "/api/plan", { task: "The nightly job fails: find out why and fix it", files: [], manager: "Claude Code" })).json;
    await ui(url, "/api/plan/run", { id: plan.id, paid: true });
    let v: any = null;
    for (let i = 0; i < 300 && (!v || v.running); i++) { await Bun.sleep(20); v = (await ui(url, `/api/plan/run?id=${plan.id}`)).json; }
    fake.hooks.answer = null;
    return { plan, v };
  }
  test("a done part: the grade goes with the model that answered and the part's kind; grading again replaces it", async () => {
    const { plan, v } = await ranPlan();
    const done = v.parts.find((r: any) => r.n === 1);
    expect(done).toMatchObject({ status: "done" });
    expect(typeof done.modelId).toBe("string");
    const g = await ui(url, "/api/grades", { id: plan.id, part: 1, verdict: "wrong" });
    expect(g.status).toBe(200);
    expect(g.json.standing).toMatchObject({ model: done.modelId, kind: "read", n: 1, wrong: 1 });
    expect(g.json.text).toContain("for reading: 1 wrong of its last 1");
    const again = await ui(url, "/api/grades", { id: plan.id, part: 1, verdict: "good", source: "you" });
    expect(again.json.standing).toMatchObject({ n: 1, good: 1, wrong: 0 }); // replaced, not added
    expect((db.query("SELECT source FROM grades").all() as any[]).map((r) => r.source)).toEqual(["you"]); // one row: its verdict and grader replaced
    expect((await ui(url, `/api/plan/run?id=${plan.id}`)).json.parts[0]).toMatchObject({ verdict: "good", gradedBy: "you" });
  });
  test("what cannot be graded says why", async () => {
    const { plan } = await ranPlan();
    expect((await ui(url, "/api/grades", { id: plan.id, part: 2, verdict: "good" })).json.error).toBe("Part 2 has no answer to grade (it is yours).");
    expect((await ui(url, "/api/grades", { id: plan.id, part: 9, verdict: "good" })).json.error).toBe("Part 9 of this plan has not run in Leanfare.");
    expect((await ui(url, "/api/grades", { id: "nosuchplan1", part: 1, verdict: "good" })).status).toBe(404);
    expect((await ui(url, "/api/grades", { id: plan.id, part: 1, verdict: "great" })).json.error).toBe("verdict must be good, partly or wrong.");
    expect((await ui(url, "/api/grades", { model: "nobody/nothing", kind: "read", verdict: "good" })).json.error).toBe("Leanfare does not know the model nobody/nothing.");
    expect((await ui(url, "/api/grades", { model: "openai/gpt-5-mini", kind: "code", verdict: "good" })).status).toBe(400);
  });
  test("a delegate answer is graded by its model and kind; Settings lists the standings and gives another chance", async () => {
    for (let i = 0; i < 3; i++) await ui(url, "/api/grades", { model: "openai/gpt-5-mini", kind: "write", verdict: "wrong" });
    const list = (await ui(url, "/api/grades")).json.standings;
    expect(list[0]).toMatchObject({ model: "openai/gpt-5-mini", kind: "write", n: 3, down: true });
    expect(list[0].text).toContain("GPT-5 mini for drafting: 3 wrong of its last 3. Moved down");
    const after = (await ui(url, "/api/grades/reset", { model: "openai/gpt-5-mini", kind: "write" })).json.standings;
    expect(after).toEqual([]);
  });
});
