// Claude's own models for helpers (0.15): the order comes from llmledger's catalogue (the newest of each family, a new
// family the day it is listed, a retired one dropped), each helper Claude starts gets a model picked for its part, the
// strongest one (Fable today) for the hardest parts and final checks within your rules, and what each used is kept.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claudeRungs, familyOf, pickClaude, REST_MS, restFamily, topHeld, usedToday } from "../src/claudeladder";
import { getModel, setExtraModels, type Model } from "../src/data";
import { db } from "../src/db";
import { guessHelper, helperPick } from "../src/helpers";
import { HELPER_MATCHER, helperOutput } from "../src/helperhook";
import { forgetPlans, makePlan } from "../src/planner";
import { HELPER_DEFAULTS, saveSettings, settings } from "../src/settings";
import { saveSnap } from "../src/statusline";
import { setSwitch } from "../src/switch";
import { localDay, now } from "../src/util";
import { CLAUDE_HOOKS } from "../src/workers";
import { boot, reset, ui } from "./app";

// Claude's models as llmledger's catalogue (built 25 Oct 2026) lists them: Fable 5 and 5.1, Opus 4.8, 5 and 5.5,
// Sonnet 5 and 5.5, Haiku 4.5 and 5.5, and Mythos 5.1 (not rated yet).
const CLAUDE = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "claude-models.json"), "utf8")).models as Model[]);
const DAY = "2026-11-05";
const labels = (models: Model[] = CLAUDE, day = DAY) => claudeRungs(day, models).map((r) => r.label);
const pick = (kind: string, effort: "low" | "medium" | "high", top = false, models: Model[] = CLAUDE) => pickClaude(kind, effort, top, claudeRungs(DAY, models));
const model = (id: string, label: string, input: number, output: number, ratings: Record<string, number>, extra: Partial<Model> = {}): Model =>
  ({ ...CLAUDE.find((m) => m.id === "anthropic/claude-opus-5-5")!, id: `anthropic/${id}`, apiId: id, name: id, label, input, output, ratings, retire: null, ...extra });
const files = () => { for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true }); };

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { files(); forgetPlans(); await reset(); });
// The server's catalogue is the tests' small one; these tests add Claude's models to it and take them out again.
const addClaude = () => setExtraModels(CLAUDE.filter((m) => !getModel(m.id)), new Set(["anthropic"]));
afterEach(() => { setExtraModels([], new Set(["anthropic"])); files(); });

describe("Claude's order, from the catalogue", () => {
  test("today: Fable 5.1 on top, then Opus 5.5, Sonnet 5.5 and Haiku 5.5; Mythos is listed but not rated, so last", () => {
    expect(labels()).toEqual(["Claude Fable 5.1", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Mythos 5.1"]);
    // Opus 5.5's rating is 5 points over Fable 5.1's: the votes cannot tell them apart, so the bigger one leads.
    const [fable, opus] = claudeRungs(DAY, CLAUDE);
    expect(opus.model.ratings.overall).toBeGreaterThan(fable.model.ratings.overall);
    expect(claudeRungs(DAY, CLAUDE).find((r) => r.family === "mythos")!.rated).toBe(false);
  });

  test("each part's pick: the hardest parts and final checks on Fable 5.1, high effort on Opus 5.5, medium on Sonnet 5.5, light code on Haiku 5.5", () => {
    for (const kind of ["code", "reason", "read"]) expect(pick(kind, "high", true)!.rung.label).toBe("Claude Fable 5.1");
    for (const kind of ["code", "reason", "read", "write"]) expect(pick(kind, "high")!.rung.label).toBe("Claude Opus 5.5");
    expect(pick("code", "medium")!.rung.label).toBe("Claude Sonnet 5.5");
    expect(pick("reason", "medium")!.rung.label).toBe("Claude Sonnet 5.5");
    expect(pick("code", "low")!.rung.label).toBe("Claude Haiku 5.5");
    // Light reading: the votes put Haiku 5.5 102 points under the best on long prompts, past the 80 a light part allows.
    expect(pick("read", "low")!.rung.label).toBe("Claude Sonnet 5.5");
    // Writing: Fable 5.1 is 21 points under Opus 5.5 on following instructions, so Opus is the strongest there.
    expect(pick("write", "high", true)!.rung.label).toBe("Claude Opus 5.5");
    expect(pick("code", "high", true)!.why).toContain("the votes cannot tell it from the best, and it is the biggest");
    expect(pick("code", "low")!.why).toContain("within 80 points of the best for coding");
  });

  test("a new model takes its place the day llmledger lists it: a newer Opus replaces 5.5, and a new family above Fable takes the top", () => {
    const opus6 = model("claude-opus-6", "Claude Opus 6", 4, 20, { overall: 1512, coding: 1552, hard_prompts: 1538 }, { added: "2026-12-01" });
    expect(labels([...CLAUDE, opus6], "2026-12-02")).toEqual(["Claude Fable 5.1", "Claude Opus 6", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Mythos 5.1"]);
    const saga = model("claude-saga-6", "Claude Saga 6", 15, 75, { overall: 1590, coding: 1620, hard_prompts: 1610, longer_query: 1600 });
    expect(labels([...CLAUDE, saga])[0]).toBe("Claude Saga 6");
    expect(pick("code", "high", true, [...CLAUDE, saga])!.rung.label).toBe("Claude Saga 6");
    expect(pick("code", "high", false, [...CLAUDE, saga])!.rung.label).toBe("Claude Saga 6"); // 68 points over the rest: nothing else is within 15
    // Rated later: Mythos joins the order by its rating, and is picked like the rest.
    const rated = CLAUDE.map((m) => (m.id.endsWith("mythos-5-1") ? { ...m, ratings: { overall: 1530, coding: 1570, hard_prompts: 1560 } } : m));
    expect(labels(rated)[0]).toBe("Claude Mythos 5.1");
    expect(pick("code", "high", true, rated)!.rung.label).toBe("Claude Mythos 5.1");
  });

  test("a retired model drops out: with every Haiku retired, light code goes to Sonnet; with only Haiku 5.5 retired, Haiku 4.5 is the newest left", () => {
    const allHaikuGone = CLAUDE.map((m) => (m.id.includes("haiku") ? { ...m, retire: "2026-11-01" } : m));
    expect(labels(allHaikuGone)).not.toContain("Claude Haiku 5.5");
    expect(labels(allHaikuGone).some((l) => l.includes("Haiku"))).toBe(false);
    expect(pick("code", "low", false, allHaikuGone)!.rung.label).toBe("Claude Sonnet 5.5");
    const newestGone = CLAUDE.map((m) => (m.id.endsWith("haiku-5-5") ? { ...m, retire: "2026-11-01" } : m));
    expect(labels(newestGone)).toContain("Claude Haiku 4.5");
    // Retiring later than today: still in the order.
    expect(labels(CLAUDE.map((m) => (m.id.endsWith("haiku-5-5") ? { ...m, retire: "2027-01-01" } : m)))).toContain("Claude Haiku 5.5");
  });

  test("a family and version from each id; snapshots are the same model; other makers are not Claude", () => {
    expect(familyOf("anthropic/claude-opus-5-5")).toEqual({ family: "opus", version: [5, 5] });
    expect(familyOf("claude-fable-5-1")).toEqual({ family: "fable", version: [5, 1] });
    expect(familyOf("anthropic/claude-3-5-haiku")).toEqual({ family: "haiku", version: [3, 5] });
    expect(familyOf("anthropic/claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: [4, 5] });
    expect(familyOf("openai/gpt-5")).toBe(null);
    expect(familyOf("anthropic/claude-instant-1")).toBe(null);
    expect(familyOf("anthropic/claude-2")).toBe(null); // no family word
  });

  test("no rated Claude model at all: no pick", () => {
    expect(pick("code", "high", true, CLAUDE.filter((m) => m.id.includes("mythos")))).toBe(null);
    expect(pick("code", "low", false, [])).toBe(null);
  });
});

describe("your rules hold Fable back", () => {
  const fable = () => claudeRungs(DAY, CLAUDE)[0];

  test("turned off for helpers: the hardest parts go to the next strongest, Opus 5.5", () => {
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, top: false } });
    const p = pick("code", "high", true)!;
    expect(p.rung.label).toBe("Claude Opus 5.5");
    expect(p.held).toBe("you turned it off for helpers");
    expect(p.why).toBe("Claude Fable 5.1 is held back (you turned it off for helpers), so the next strongest");
  });

  test("your Claude plan's week at or over your cap (80% unless you set it)", () => {
    const resets = now().getTime() + 3 * 86_400_000;
    saveSnap({ at: now().getTime(), five: null, week: { used: 79, resets } });
    expect(topHeld(fable())).toBe(null);
    saveSnap({ at: now().getTime() + 1000, five: null, week: { used: 80, resets } });
    expect(topHeld(fable())).toBe("your Claude plan's week is 80% used, at or over your 80%");
    expect(pick("reason", "high", true)!.rung.label).toBe("Claude Opus 5.5");
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, topUntil: 90 } });
    expect(topHeld(fable())).toBe(null);
    // A week that has reset: its old number no longer holds Fable back.
    saveSnap({ at: now().getTime() + 2000, five: null, week: { used: 95, resets: now().getTime() - 1000 } });
    expect(topHeld(fable())).toBe(null);
  });

  test("at most so many a day (20 unless you set it), counted per family from today's helpers", () => {
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, topPerDay: 2 } });
    const add = (family: string, day = localDay()) => db.query("INSERT INTO helpers(ts, day, app, family, model) VALUES(?,?,?,?,?)").run(now().toISOString(), day, "Claude", family, `anthropic/claude-${family}`);
    add("fable"); add("opus"); add("fable", "2026-10-20");
    expect(usedToday("fable")).toBe(1);
    expect(topHeld(fable())).toBe(null);
    add("fable");
    expect(topHeld(fable())).toBe("2 helpers ran on it today, your most a day");
    expect(pick("code", "high", true)!.rung.label).toBe("Claude Opus 5.5");
  });

  test("an hour off after a helper on it ended with an error and nothing written", () => {
    restFamily("fable");
    expect(topHeld(fable())).toContain("ended with nothing at");
    expect(pick("code", "high", true)!.rung.label).toBe("Claude Opus 5.5");
    expect(topHeld(fable(), now().getTime() + REST_MS + 1000)).toBe(null);
    // The usual picks never wait on Fable's rules: high effort is Opus 5.5 either way.
    expect(pick("code", "high")!.rung.label).toBe("Claude Opus 5.5");
  });
});

describe("a helper's model, as the mod and Claude Code's hook ask for it", () => {
  test("a helper's kind from its agent type and words", () => {
    expect(guessHelper("Explore", "anything")).toEqual({ kind: "read", effort: "low", top: false });
    expect(guessHelper("Plan", "anything")).toEqual({ kind: "reason", effort: "high", top: false });
    expect(guessHelper("general-purpose", "Verify the final result against the spec")).toEqual({ kind: "reason", effort: "high", top: true });
    expect(guessHelper(null, "Double-check the changes for missed cases")).toEqual({ kind: "reason", effort: "high", top: true });
    expect(guessHelper(null, "Fix the failing test in the parser")).toEqual({ kind: "code", effort: "medium", top: false });
    expect(guessHelper(null, "Find where the router picks a model")).toEqual({ kind: "read", effort: "low", top: false });
  });

  test("the answer names Claude's alias, keeps a row, and a helper that ended with an error and wrote nothing rests its family", async () => {
    addClaude();
    const a = await ui(url, "/api/helper", { app: "Claude", session: "s-help-1", agent: "Explore", description: "Find the router", task: "Find where the router picks a model", asked: null });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ model: "sonnet", label: "Claude Sonnet 5.5", family: "sonnet", from: "guess", top: false });
    expect(a.json.why).toContain("a read helper at low effort");
    const v = await ui(url, "/api/helper", { app: "Claude", description: "Final check", task: "Verify the final result against the task" });
    expect(v.json).toMatchObject({ model: "fable", label: "Claude Fable 5.1", top: true });
    expect(v.json.why).toContain("the final check");
    const row = db.query("SELECT * FROM helpers WHERE id = ?").get(v.json.id) as any;
    expect(row).toMatchObject({ app: "Claude", kind: "reason", effort: "high", top: 1, family: "fable", model: "anthropic/claude-fable-5-1", label: "Claude Fable 5.1", day: localDay() });
    // What it used, as the mod saw it at its end: an error and no words, so Fable rests an hour.
    const d = await ui(url, "/api/helper/done", { id: v.json.id, model: "claude-fable-5-1", input: 1200, cached: 3400, output: 0, seconds: 2.5, reason: "error" });
    expect(d.json).toEqual({ ok: true, rested: "fable" });
    expect(db.query("SELECT input, cached, output, seconds, ended FROM helpers WHERE id = ?").get(v.json.id)).toEqual({ input: 1200, cached: 3400, output: 0, seconds: 2.5, ended: "error" });
    const again = await ui(url, "/api/helper", { app: "Claude", description: "Final check", task: "Verify the final result against the task" });
    expect(again.json).toMatchObject({ model: "opus", label: "Claude Opus 5.5", top: true });
    expect(again.json.why).toContain("Claude Fable 5.1 is held back (a helper on it ended with nothing at");
    // A helper that answered: kept, nothing rests.
    expect((await ui(url, "/api/helper/done", { id: a.json.id, model: "claude-sonnet-5-5", input: 900, cached: 0, output: 300, reason: "answer" })).json).toEqual({ ok: true, rested: null });
    expect((await ui(url, "/api/helper/done", { id: "7" })).status).toBe(400);
    expect((await ui(url, "/api/helper/done", { id: 999999 })).json).toEqual({ ok: false, rested: null });
  });

  test("a helper for a part of the plan: the part's own kind and effort, and the plan and part kept with it", async () => {
    addClaude();
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, starts: "each" } }); // a helper for each part (0.15.1: one per prompt by default)
    const r = await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    const part = r.parts.find((p) => p.title === "Make the changes and run the tests")!;
    expect(part.where).toBe("you");
    const a = await ui(url, "/api/helper", { app: "Claude Code", description: "Make the changes and run the tests", task: "Make the changes the design calls for, then run the tests." });
    expect(a.json).toMatchObject({ model: "opus", label: "Claude Opus 5.5", from: "plan" });
    expect(a.json.why).toBe(`part ${part.n} of plan ${r.id}: the cheapest of Claude's models rated within 15 points of the best for coding`);
    expect(db.query("SELECT plan, part, kind, effort FROM helpers WHERE id = ?").get(a.json.id)).toEqual({ plan: r.id, part: part.n, kind: "code", effort: "high" });
    // Another app's plan is not this helper's.
    expect((await ui(url, "/api/helper", { app: "Codex", description: "Make the changes and run the tests" })).json.from).toBe("guess");
  });

  // 0.15.1: Cowork can ask before each helper starts, so by default a plan asks for one helper: the parts on other
  // models than yours go to it together, on the strongest model they need; or none, every part in the chat.
  const coding = () => makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Claude", split: "rules", yourModel: "claude-sonnet-5-5", signal: new AbortController().signal });
  test("one helper per prompt (the default): the parts that need a stronger model than yours go to one helper, on the strongest they need; the others run in the chat", async () => {
    addClaude();
    expect(settings().claudeHelpers?.starts).toBe("once");
    const r = await coding(); // you run on Sonnet 5.5
    const on = (label: string) => r.parts.filter((p) => p.where === "you" && p.use?.label === label).map((p) => p.n);
    const strong = on("Claude Fable 5.1"), light = on("Claude Sonnet 5.5");
    expect(strong.length).toBeGreaterThan(1); // the hardest part on Fable 5.1, and the high effort ones (Opus 5.5 on their own) with it
    expect(light.length).toBeGreaterThan(0); // the light ones stay with Sonnet 5.5, in the chat
    expect(on("Claude Opus 5.5")).toEqual([]);
    expect(r.batch).toEqual({ parts: strong, lead: r.parts.find((p) => p.top)!.n }); // the hardest part leads
    expect(r.table).toContain("Claude Fable 5.1 (platform model)");
    expect(r.table).toContain("Claude Sonnet 5.5 (main model)");
    const names = (ns: number[]) => (ns.length === 1 ? `part ${ns[0]}` : `parts ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);
    expect(r.next).toContain(`Start one helper (a subagent) for ${names(strong)} together, on Claude Fable 5.1 (model: fable), with each part's title and task in its prompt`);
    expect(r.next).toContain(`Do ${names(light)} yourself in this chat.`);
    // The helper's words name a part of the batch: it runs on the batch's model, and the row keeps the lead part.
    const lead = r.parts.find((p) => p.n === r.batch!.lead)!, other = r.parts.find((p) => p.n === strong.find((n) => n !== lead.n))!;
    const a = await ui(url, "/api/helper", { app: "Claude", description: "Parts of the plan", task: `${other.title}: ${other.task}\n${lead.title}: ${lead.task}` });
    expect(a.json).toMatchObject({ model: "fable", label: "Claude Fable 5.1", from: "plan", top: true });
    expect(a.json.why).toStartWith(`parts ${strong.join(", ")} of plan ${r.id}, on one helper: `);
    expect(db.query("SELECT plan, part FROM helpers WHERE id = ?").get(a.json.id)).toEqual({ plan: r.id, part: lead.n });
    // On Opus 5.5 only the hardest part needs a stronger model: one helper for it, the rest in the chat on Opus.
    const opus = await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Claude", split: "rules", yourModel: "claude-opus-5-5", signal: new AbortController().signal });
    const top = opus.parts.find((p) => p.top)!;
    expect(opus.batch).toEqual({ parts: [top.n], lead: top.n });
    expect(opus.parts.filter((p) => p !== top).every((p) => p.use?.label === "Claude Opus 5.5")).toBe(true);
    expect(opus.next).toContain(`Start one helper (a subagent) for part ${top.n}, on Claude Fable 5.1 (model: fable), with the part's title and task in its prompt, once the parts it needs are back; if your app cannot start one, do it yourself.`);
    // On Fable 5.1 none does: the one helper takes the parts a lighter model can do, on the strongest of those.
    const fable = await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Claude", split: "rules", yourModel: "claude-fable-5-1", signal: new AbortController().signal });
    expect(fable.batch!.parts).toEqual(fable.parts.filter((p) => !p.top).map((p) => p.n));
    expect(fable.next).toContain("together, on Claude Opus 5.5 (model: opus)");
    expect(fable.next).toContain(`Do part ${fable.parts.find((p) => p.top)!.n} yourself in this chat.`);
  });

  test("a helper for each part, or none: each part on its own model, or every part in the chat on yours", async () => {
    addClaude();
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, starts: "each" } });
    const each = await coding();
    expect(each.batch).toBeNull();
    expect(new Set(each.parts.filter((p) => p.where === "you" && !p.keep).map((p) => p.use?.label)).size).toBeGreaterThan(1);
    expect(each.next).toContain("start a helper (a subagent) with that model if your app can");
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, starts: "never" } });
    const none = await coding();
    const mine = none.parts.filter((p) => p.where === "you");
    expect(none.batch).toBeNull();
    for (const p of mine) expect(p.use?.label ?? "Claude Sonnet 5.5").toBe("Claude Sonnet 5.5");
    expect(none.table).not.toContain("(platform model)");
    expect(none.table).toContain("Claude Sonnet 5.5 (main model)");
    expect(none.next).toContain(`Do these yourself in this chat, without a helper (Leanfare's setting): parts ${mine.map((p) => p.n).slice(0, -1).join(", ")} and ${mine.at(-1)!.n}.`);
    expect(none.next).not.toContain("helper (a subagent)");
    // Claude Code's plans follow it too; the other apps run one model a chat, as before.
    expect((await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal })).next).toContain("yourself in this chat, without a helper");
    expect((await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Codex", split: "rules", signal: new AbortController().signal })).starts).toBeUndefined();
  });

  test("Settings, Helpers: each, once or never, checked", async () => {
    expect((await ui(url, "/api/settings", { claudeHelpers: { starts: "always" } })).json.error).toBe("claudeHelpers.starts must be each, once or never");
    expect((await ui(url, "/api/settings", { claudeHelpers: { starts: "never" } })).status).toBe(200);
    expect(settings().claudeHelpers?.starts).toBe("never");
  });

  test("a new family above Fable: the mod gets its full id; Claude Code, whose Agent tool takes haiku, sonnet, opus or fable, gets the strongest it can name", async () => {
    const saga = model("claude-saga-6", "Claude Saga 6", 15, 75, { overall: 1590, coding: 1620, hard_prompts: 1610, longer_query: 1600 });
    setExtraModels([...CLAUDE.filter((m) => !getModel(m.id)), saga], new Set(["anthropic"]));
    const ask = { description: "Final check", task: "Verify the final result against the task" };
    expect((await ui(url, "/api/helper", { app: "Claude", ...ask })).json).toMatchObject({ model: "claude-saga-6", label: "Claude Saga 6", top: true });
    expect((await ui(url, "/api/helper", { app: "Claude Code", ...ask })).json).toMatchObject({ model: "fable", label: "Claude Fable 5.1", top: true });
  });

  // 0.15.2: switched off, Leanfare does nothing for the apps: it leaves the helper's model alone, and still keeps what
  // the helper used (numbers only), so the report shows the prompt whole.
  test("Leanfare switched off: no model for the helper, a row kept, and its model and tokens filled in at its end", async () => {
    addClaude();
    setSwitch(false);
    try {
      const a = await ui(url, "/api/helper", { app: "Claude", session: "s-off", agent: "Explore", task: "Find where the router picks a model" });
      expect(a.json).toMatchObject({ model: null, label: null, from: "off", why: "Leanfare is switched off: the helper runs on the model the app picks" });
      expect(Number.isInteger(a.json.id)).toBe(true);
      expect((await ui(url, "/api/helper/done", { id: a.json.id, model: "claude-sonnet-5-5", input: 900, cached: 4000, output: 300 })).json.ok).toBe(true);
      expect(db.query("SELECT model, input, cached, output FROM helpers WHERE id = ?").get(a.json.id)).toEqual({ model: "anthropic/claude-sonnet-5-5", input: 900, cached: 4000, output: 300 });
    } finally { setSwitch(true); }
  });

  test("Settings, Claude's own models, off: no model, so the helper runs on the one the app picks, and no row", async () => {
    addClaude();
    saveSettings({ claudeHelpers: { ...HELPER_DEFAULTS, on: false } });
    const a = await ui(url, "/api/helper", { app: "Claude", agent: "Explore", task: "Find it" });
    expect(a.json).toMatchObject({ id: null, model: null, from: "off" });
    expect((db.query("SELECT COUNT(*) AS n FROM helpers").get() as { n: number }).n).toBe(0);
  });

  test("the main model's own turns in Cowork and Claude Desktop, numbers only", async () => {
    expect((await ui(url, "/api/app-turn", { app: "Claude", session: "s-1", model: "claude-opus-5-5", effort: "high", input: 10, cached: 20, output: 30 })).json).toEqual({ ok: true });
    expect((await ui(url, "/api/app-turn", { app: "Claude", model: "claude-opus-5-5", effort: "bogus", input: -5 })).json).toEqual({ ok: true });
    expect(db.query("SELECT app, session, model, effort, input, cached, output FROM app_turns ORDER BY id").all()).toEqual([
      { app: "Claude", session: "s-1", model: "claude-opus-5-5", effort: "high", input: 10, cached: 20, output: 30 },
      { app: "Claude", session: null, model: "claude-opus-5-5", effort: null, input: 0, cached: 0, output: 0 },
    ]);
    expect((await ui(url, "/api/app-turn", { app: "Claude", input: 3 })).status).toBe(400);
  });

  test("Settings shows the order, each kind's picks and today's helpers; your rules are checked", async () => {
    addClaude();
    await ui(url, "/api/helper", { app: "Claude", agent: "Explore", task: "Find the router" });
    const v = (await ui(url, "/api/claude-models")).json;
    expect(v.rungs.map((r: any) => r.label)).toEqual(["Claude Fable 5.1", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Mythos 5.1"]);
    expect(v.rungs.at(-1)).toMatchObject({ rated: false, overall: null });
    expect(v.picks.code).toEqual({ low: "Claude Haiku 5.5", medium: "Claude Sonnet 5.5", high: "Claude Opus 5.5", top: "Claude Fable 5.1" });
    expect(v.rules).toEqual(HELPER_DEFAULTS);
    expect(v.today).toEqual([{ family: "sonnet", n: 1, tokens: 0 }]);
    for (const [bad, says] of [
      [5, "claudeHelpers must be an object"],
      [{ on: "yes" }, "claudeHelpers.on must be true or false"],
      [{ topUntil: 120 }, "claudeHelpers.topUntil must be a whole percent from 0 to 100"],
      [{ topPerDay: 2.5 }, "claudeHelpers.topPerDay must be a whole number from 0 to 1,000"],
    ] as const) {
      const r = await ui(url, "/api/settings", { claudeHelpers: bad });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain(says);
    }
    expect((await ui(url, "/api/settings", { claudeHelpers: { topUntil: 70 } })).status).toBe(200);
    expect((await ui(url, "/api/settings", { claudeHelpers: { top: false } })).status).toBe(200);
    expect(settings().claudeHelpers).toEqual({ on: true, top: false, topUntil: 70, topPerDay: 20, starts: "once" });
  });
});

describe("Claude Code's hook and the mod", () => {
  test("the hook hands the call back with Leanfare's model, and only for Claude Code's Agent tool", () => {
    const input = { description: "Find the router", prompt: "Find where the router picks a model", subagent_type: "Explore" };
    expect(helperOutput(input, "haiku")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, model: "haiku" } } });
    const m = new RegExp(HELPER_MATCHER);
    expect(["Agent", "Task"].every((t) => m.test(t))).toBe(true);
    expect(["TaskCreate", "Bash", "mcp__leanfare__plan"].some((t) => m.test(t))).toBe(false);
  });

  const hook = async (env: Record<string, string>, stdin: unknown) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "hook", "helper"], { stdin: new TextEncoder().encode(JSON.stringify(stdin)), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { out, code };
  };

  test("run by Claude Code: Leanfare's pick for a helper comes back in the call; Leanfare not running, nothing comes back", async () => {
    addClaude();
    const call = { session_id: "s-hook-1", tool_name: "Agent", tool_input: { description: "Find the router", prompt: "Find where the router picks a model", subagent_type: "Explore" } };
    const r = await hook({ LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" }, call);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...call.tool_input, model: "sonnet" } } });
    expect(db.query("SELECT app, session, family FROM helpers").all()).toEqual([{ app: "Claude Code", session: "s-hook-1", family: "sonnet" }]);
    // Asked for the model Leanfare would pick anyway: nothing to change.
    expect((await hook({ LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" }, { ...call, tool_input: { ...call.tool_input, model: "sonnet" } })).out).toBe("");
    const off = await hook({ LEANFARE_URL: "http://127.0.0.1:9", LEANFARE_TOKEN: "x" }, call);
    expect(off).toEqual({ out: "", code: 0 });
    expect((await hook({ LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" }, "not a call")).out).toBe("");
  });

  test("Claude Code's hook entry, in the plugin and in the settings Leanfare writes", () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "plugin", "hooks", "hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse.some((h: any) => h.matcher === HELPER_MATCHER && h.hooks.some((x: any) => /hook helper/.test(x.command)))).toBe(true);
    expect(CLAUDE_HOOKS).toContainEqual({ event: "PreToolUse", matcher: HELPER_MATCHER, timeout: 5, what: "helper" });
  });

  test("the mod: names each helper's model before it starts, and says what it used and what the main model used", () => {
    const src = readFileSync(join(import.meta.dir, "..", "mods", "leanfare-level", "hooks", "register.ts"), "utf8");
    expect(src).toContain("on('agent.spawn'");
    expect(src).toContain("on('turn.complete'");
    expect(src).toContain("$.mcp.call(OWN, 'helper', args)"); // 0.15.3: on Leanfare's own server only
    expect(src).not.toContain("'remote-devices'"); // never through the desktop app's link, where each call is a question
    expect(src).toContain("if (e.fork || !(await ownServer($))) return next(e)"); // a fork keeps the main model: it is the same conversation
    expect(src).toContain("task: String(e.prompt ?? '').slice(0, 8000)"); // its words, to pick; Leanfare keeps none of them
    expect(src).toContain("helper($, { turn: { model: u.model, ...tokensOf(u) } })"); // the main model's turn: numbers only
    const columns = (db.query("PRAGMA table_info(helpers)").all() as { name: string }[]).map((c) => c.name);
    expect(columns.some((c) => /task|prompt|words|text/.test(c))).toBe(false);
  });
});
