// 0.12, the review loop: every answer Leanfare brings back is reviewed by the app, graded, and fixed before the app
// answers. The grade by a hand off's number alone, a fix one tier up by another model (with what was wrong), a fix the
// app made itself, the limits of a fix, and Claude Code's two review hooks (the hand offs a session got, and a grade
// asked for once before Claude finishes).
//
// The fixture's models for a short task: low effort (Save more) picks DeepSeek V4 Flash, medium (Balanced) Grok 4.20
// Beta, high (Best quality) Gemini 3.8 Flash.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { paths } from "../src/config";
import { db } from "../src/db";
import { draw, forgetRequests, KEEP_REQUESTS } from "../src/delegate";
import { reviewLine } from "../src/mcp";
import { handoffsIn, noteHandoffs, reviewFile, stopDecision } from "../src/reviewhook";
import { setSwitch } from "../src/switch";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => { draw.next = () => Math.random(); setSwitch(true); });
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  draw.next = () => 0.5;
  setSwitch(true);
  try { rmSync(reviewFile(), { force: true }); } catch {}
});

const ALL_KEYS = ["openai", "anthropic", "google", "deepseek", "xai", "mistral"];
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n10:02 retry\n10:03 error: disk full again\n" };
const delegate = (body: unknown) => ui(url, "/api/delegate", body);
const grade = (body: unknown) => ui(url, "/api/grades", body);
const row = (id: number) => db.query("SELECT * FROM delegations WHERE id = ?").get(id) as any;
const sent = (provider: string) => fake.seen.filter((s) => s.provider === provider && (s.path.endsWith("/chat/completions") || s.path.endsWith("/v1/messages")));

describe("the review line each answer comes back with", () => {
  test("asks the app to review it, grade it by its number, and fix it before it answers; off in Settings, the line of before", () => {
    const j = { row: 75, kind: "read", model: { id: "google/gemini-3.5-flash-lite" } };
    expect(reviewLine(j)).toBe('(Review it before you use it: check it against the task. Then grade hand off 75: good, partly or wrong. If it is partly or wrong, fix it before you answer: yourself (grade with fix "myself"), or grade with fix "leanfare" and why, and Leanfare asks again one tier up and sends back a new answer to review.)');
    expect(reviewLine({ ...j, review: false })).toBe("(Once you have used it: grade, with model google/gemini-3.5-flash-lite, kind read and handoff 75.)");
    expect(reviewLine({ ...j, row: null })).toBe("(Once you have used it: grade, with model google/gemini-3.5-flash-lite, kind read.)");
    expect(reviewLine({ ...j, row: null, kind: null })).toBe("");
  });

  test("the delegate's answer says whether Settings asks for the review", async () => {
    await keys(...ALL_KEYS);
    const on = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never", wait: 5 });
    expect(on.json.review).toBe(true);
    await ui(url, "/api/settings", { review: false });
    const off = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never", wait: 5 });
    expect(off.json.review).toBe(false);
    expect((await ui(url, "/api/settings", { review: "yes" })).status).toBe(400);
  });
});

describe("a grade by the hand off's number", () => {
  test("finds the hand off's model and kind, and keeps the grade with it", async () => {
    await keys(...ALL_KEYS);
    const d = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never" });
    const g = await grade({ handoff: d.json.row, verdict: "good" });
    expect(g.status).toBe(200);
    expect(g.json.standing).toMatchObject({ model: "deepseek/deepseek-v4-flash", kind: "read", good: 1 });
    expect(g.json.fix).toBeNull();
    expect(row(d.json.row)).toMatchObject({ grade: "good", fixed: null });
    expect((await grade({ handoff: 9999, verdict: "good" })).status).toBe(404);
  });
});

describe("a fix one tier up", () => {
  test("graded wrong with fix leanfare: another model one tier up answers, told what was wrong; the rows say which fixed which", async () => {
    await keys(...ALL_KEYS);
    const d = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(d.json.model.id).toBe("deepseek/deepseek-v4-flash");
    const g = await grade({ handoff: d.json.row, verdict: "wrong", fix: "leanfare", why: "it missed the second error", wait: 10 });
    expect(g.status).toBe(200);
    const f = g.json.fix;
    expect(f).toMatchObject({ running: false, fixOf: d.json.row, effort: "medium", review: true });
    expect(f.model.id).toBe("xai/grok-4.20-beta"); // Balanced, one tier above Save more
    expect(f.answer).toBe("Hello from grok-4.20-beta.");
    expect(f.row).toBeGreaterThan(d.json.row);
    const asked = JSON.stringify(sent("xai").at(-1)!.body);
    expect(asked).toContain("The app that asked graded an earlier answer to this task wrong: it missed the second error. Answer the task again, and avoid that.");
    expect(asked).toContain("10:03 error: disk full again"); // the same files, from memory
    expect(row(d.json.row)).toMatchObject({ grade: "wrong", fixed: "leanfare" });
    expect(row(f.row)).toMatchObject({ fix_of: d.json.row, model: "xai/grok-4.20-beta", ask_tokens: 0, grade: null });
    // The fix is a hand off like any other: graded by its number too.
    expect((await grade({ handoff: f.row, verdict: "good" })).json.standing).toMatchObject({ model: "xai/grok-4.20-beta", good: 1 });
  });

  test("at high effort it stays high and asks another model than the one that answered", async () => {
    await keys(...ALL_KEYS);
    const d = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "high", check: "never" });
    expect(d.json.model.id).toBe("google/gemini-3.8-flash");
    const f = (await grade({ handoff: d.json.row, verdict: "partly", fix: "leanfare", why: "too short", wait: 10 })).json.fix;
    expect(f.effort).toBe("high");
    expect(f.model.id).not.toBe("google/gemini-3.8-flash");
  });

  test("fixed by the app itself: kept as fixed, nothing asked", async () => {
    await keys(...ALL_KEYS);
    const d = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never" });
    const before = fake.seen.length;
    const g = await grade({ handoff: d.json.row, verdict: "partly", fix: "myself" });
    expect(g.json.fix).toBeNull();
    expect(fake.seen.length).toBe(before);
    expect(row(d.json.row)).toMatchObject({ grade: "partly", fixed: "myself" });
  });

  test("its limits: a good answer needs no fix, a request no longer held, a fix of a fix of a fix, Leanfare switched off", async () => {
    await keys(...ALL_KEYS);
    const d = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect((await grade({ handoff: d.json.row, verdict: "good", fix: "leanfare" })).status).toBe(400);
    expect((await grade({ handoff: d.json.row, verdict: "wrong", fix: "redo" })).status).toBe(400);
    // Fixes of fixes: at most two deep.
    const f1 = (await grade({ handoff: d.json.row, verdict: "wrong", fix: "leanfare", wait: 10 })).json.fix;
    const f2 = (await grade({ handoff: f1.row, verdict: "wrong", fix: "leanfare", wait: 10 })).json.fix;
    expect(f2.fixOf).toBe(f1.row);
    const f3 = (await grade({ handoff: f2.row, verdict: "wrong", fix: "leanfare", wait: 10 })).json.fix;
    expect(f3.error).toBe(`Hand off ${f2.row} is already a fix of a fix, and Leanfare asks again at most 2 times. Fix it yourself.`);
    // Switched off: the grade is kept, nothing is asked.
    setSwitch(false);
    const off = (await grade({ handoff: d.json.row, verdict: "wrong", fix: "leanfare", wait: 10 })).json.fix;
    expect(off.error).toBe("Leanfare is switched off, so it did not ask again. Fix it yourself.");
    setSwitch(true);
    // Forgotten (a restart, two hours, or the 20 newer ones): said plainly.
    forgetRequests();
    const gone = (await grade({ handoff: d.json.row, verdict: "wrong", fix: "leanfare", wait: 10 })).json.fix;
    expect(gone.error).toBe(`Leanfare no longer holds hand off ${d.json.row}'s request (it keeps the last ${KEEP_REQUESTS}, for 2 hours, in memory only), so it did not ask again. Fix it yourself, or call delegate again with the task and what was wrong.`);
    expect(row(d.json.row).grade).toBe("wrong");
  });

  test("a row number used again (after rows were deleted) never finds another hand off's request", async () => {
    await keys(...ALL_KEYS);
    const d = await delegate({ task: "Find every error.", files: [LOG], kind: "read", effort: "low", check: "never" });
    db.exec("DELETE FROM delegations");
    db.query("INSERT INTO delegations(id, ts, month, day, task, kind, effort, model, status, job) VALUES (?, '2026-10-21T12:00:00Z', '2026-10', '2026-10-21', 'longer_query', 'read', 'low', 'deepseek/deepseek-v4-flash', 'ok', 'another')").run(d.json.row);
    const g = (await grade({ handoff: d.json.row, verdict: "wrong", fix: "leanfare", wait: 10 })).json.fix;
    expect(g.error).toStartWith(`Leanfare no longer holds hand off ${d.json.row}'s request`);
  });
});

describe("Claude Code's review hooks", () => {
  const T = 1_800_000_000_000;
  const open = () => new Database(paths.db, { readonly: true });
  const insert = (fields: Record<string, unknown>) => {
    const f = { ts: "2026-10-21T12:00:00Z", month: "2026-10", day: "2026-10-21", task: "longer_query", kind: "read", effort: "low", model: "google/gemini-3.5-flash-lite", status: "ok", ...fields };
    return Number(db.query(`INSERT INTO delegations(${Object.keys(f).join(", ")}) VALUES (${Object.keys(f).map(() => "?").join(", ")})`).run(...(Object.values(f) as any[])).lastInsertRowid);
  };

  test("the hand off hook reads the numbers from a tool's result, structured or in its text, and a plan's id from what was asked or from the plan tool's result", () => {
    expect(handoffsIn({ tool_name: "mcp__leanfare__delegate", tool_response: { content: [{ type: "text", text: "Hello" }], structuredContent: { handoff: 75, fix_of: 74 } } })).toEqual({ handoffs: [75], plan: null });
    expect(handoffsIn({ tool_name: "mcp__leanfare__delegate", tool_response: [{ type: "text", text: "(Review it before you use it: ... Then grade hand off 76: good, partly or wrong.)" }] }).handoffs).toEqual([76]);
    expect(handoffsIn({ tool_name: "mcp__leanfare__delegate", tool_response: JSON.stringify({ structuredContent: { handoff: 77 } }) }).handoffs).toEqual([77]);
    expect(handoffsIn({ tool_name: "mcp__leanfare__plan_status", tool_input: { id: "6tS-2Dd2q72z" }, tool_response: "| 1 | Read | done |" })).toEqual({ handoffs: [], plan: "6tS-2Dd2q72z" });
    expect(handoffsIn({ tool_name: "mcp__leanfare__delegate", tool_input: { id: "6tS-2Dd2q72z" }, tool_response: "Still working" }).plan).toBeNull(); // a delegate's id is a job, not a plan
    // The plan tool starts Leanfare's parts itself (0.13): its plan's id comes from its result, structured or in its text.
    expect(handoffsIn({ tool_name: "mcp__leanfare__plan", tool_input: { task: "Fix the job" }, tool_response: { content: [{ type: "text", text: "| 1 | Read | done |" }], structuredContent: { id: "6tS-2Dd2q72z", parts: [] } } })).toEqual({ handoffs: [], plan: "6tS-2Dd2q72z" });
    expect(handoffsIn({ tool_name: "mcp__leanfare__plan", tool_input: { task: "Fix the job" }, tool_response: [{ type: "text", text: "Leanfare started part 1 by itself. The plan's id: 6tS-2Dd2q72z." }] }).plan).toBe("6tS-2Dd2q72z");
    expect(handoffsIn({ tool_name: "mcp__leanfare__plan", tool_input: { task: "Fix the job", id: "zzzz-not-it" }, tool_response: "Nothing goes to Leanfare." }).plan).toBeNull();
    expect(handoffsIn({}).handoffs).toEqual([]);
  });

  test("the stop hook asks once for the hand offs of this session with no grade, and lets Claude finish after", () => {
    const a = insert({}), b = insert({ model: "deepseek/deepseek-v4-flash", kind: null, task: "hard_prompts" }), c = insert({ grade: "good" });
    noteHandoffs({ session_id: "s-1", tool_name: "mcp__leanfare__delegate", tool_response: { structuredContent: { handoff: a } } }, T);
    noteHandoffs({ session_id: "s-1", tool_name: "mcp__leanfare__delegate", tool_response: { structuredContent: { handoff: b } } }, T);
    noteHandoffs({ session_id: "s-1", tool_name: "mcp__leanfare__delegate", tool_response: { structuredContent: { handoff: c } } }, T);
    noteHandoffs({ session_id: "s-2", tool_name: "mcp__leanfare__delegate", tool_response: { structuredContent: { handoff: 999 } } }, T);
    const d = stopDecision({ session_id: "s-1", stop_hook_active: false }, T + 1000, open);
    expect(d).toEqual({ decision: "block", reason: `Leanfare: before you finish, review what Leanfare brought back. Hand off ${a} (gemini-3.5-flash-lite, read), hand off ${b} (deepseek-v4-flash, reason) have no grade yet. Check each against its task, grade each with Leanfare's grade tool (good, partly or wrong, with its handoff number), and fix anything partly or wrong before your final answer: yourself (fix "myself"), or with fix "leanfare" and why. Leanfare asks this once.` });
    expect(stopDecision({ session_id: "s-1", stop_hook_active: false }, T + 2000, open)).toBeNull(); // asked once
    // A new hand off later in the session is asked about at its own turn's end.
    const e = insert({});
    noteHandoffs({ session_id: "s-1", tool_name: "mcp__leanfare__delegate", tool_response: { structuredContent: { handoff: e } } }, T + 3000);
    expect(stopDecision({ session_id: "s-1", stop_hook_active: true }, T + 4000, open)).toBeNull(); // already doing what a stop hook asked
    expect(stopDecision({ session_id: "s-1" }, T + 5000, open)!.reason).toContain(`Hand off ${e} (gemini-3.5-flash-lite, read) has no grade yet. Check it against its task, grade it`);
    expect(stopDecision({ session_id: "s-3" }, T + 5000, open)).toBeNull(); // nothing from Leanfare in that session
    expect(stopDecision({ session_id: "bad id\twith tab" }, T + 5000, open)).toBeNull();
  });

  test("a plan's parts count, a graded hand off does not, and it asks nothing when Settings turns it off or after two days", () => {
    const p1 = insert({ plan: "6tS-2Dd2q72z:1" }), p2 = insert({ plan: "6tS-2Dd2q72z:2", grade: "partly" }), other = insert({ plan: "6tS-2Dd2q72zX:1" });
    noteHandoffs({ session_id: "s-9", tool_name: "mcp__leanfare__plan_status", tool_input: { id: "6tS-2Dd2q72z" }, tool_response: "parts" }, T);
    const d = stopDecision({ session_id: "s-9" }, T + 1000, open)!;
    expect(d.reason).toContain(`Hand off ${p1} (gemini-3.5-flash-lite, read) has no grade yet.`);
    expect(d.reason).not.toContain(`hand off ${p2} `);
    expect(d.reason).not.toContain(`hand off ${other} `);
    const q = insert({});
    noteHandoffs({ session_id: "s-10", tool_name: "mcp__leanfare__delegate", tool_response: { structuredContent: { handoff: q } } }, T);
    expect(stopDecision({ session_id: "s-10" }, T + 3 * 86_400_000, open)).toBeNull(); // two days on: forgotten
    db.query("INSERT INTO settings(k, v) VALUES('settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify({ reviewHook: false }));
    expect(stopDecision({ session_id: "s-10" }, T + 1000, open)).toBeNull();
  });
});
