// The report (report.ts): each prompt with the work it handed off, the tiles, the chart's points, by model and by
// kind, and the filters. Claude Code's own use comes from its files (numbers only): a prompt runs until the next of
// its session, its new tokens are what it did not read again from its cache. Other apps' use is not known: their
// hand offs are grouped by time.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { forgetLogs } from "../src/plans";
import { bucketOf, checkReport, rangeOf, report, sessionOf, startsOf } from "../src/report";
import { boot, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
const claudeRoot = () => process.env.CLAUDE_CONFIG_DIR!;
const SECRET = "SECRET-PROMPT-WORDS";
const user = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({ type: "user", timestamp: ts, cwd: "/Users/you/app", message: { role: "user", content: text }, ...extra });
const tool = (ts: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SECRET }] } });
let n = 0;
const asst = (ts: string, usage: Record<string, number>, model = "claude-opus-5-5") => ({ type: "assistant", timestamp: ts, requestId: `req_${++n}`, message: { id: `msg_${n}`, model, role: "assistant", content: [{ type: "text", text: SECRET }], usage } });
function session(name: string, rows: unknown[]) {
  const path = join(claudeRoot(), "projects", "-Users-you-app", `${name}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const hand = (ts: string, f: Record<string, unknown>) => {
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), task: "longer_query", kind: "read", effort: "low", model: "google/gemini-3.8-flash", cost: 0, files: 1, file_tokens: 0, answer_tokens: 0,
    status: "ok", chance: 0, verdict: null, checker: null, plan: null, task_tokens: 0, app: null, app_model: null, grade: null, ms: null, ...f };
  const keys = Object.keys(row);
  return Number(db.query(`INSERT INTO delegations(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[])).lastInsertRowid);
};
const day = (q: Record<string, string> = {}) => checkReport(new URLSearchParams({ range: "custom", from: "2026-10-21T09:00:00Z", to: "2026-10-21T12:00:00Z", ...q })) as any;

beforeEach(async () => {
  rmSync(claudeRoot(), { recursive: true, force: true });
  forgetLogs();
  await reset();
  // Claude Code: two prompts in one session; a tool's result and Claude Code's own note are not prompts.
  session("s-report", [
    user("2026-10-21T10:00:00Z", `Find why the nightly job fails ${SECRET}`), // 50 characters: 13 tokens
    asst("2026-10-21T10:00:30Z", { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 300 }),
    tool("2026-10-21T10:01:00Z"),
    asst("2026-10-21T10:01:30Z", { input_tokens: 50, cache_read_input_tokens: 52000, output_tokens: 200 }),
    user("2026-10-21T10:20:00Z", "a note of Claude Code's own", { isMeta: true }),
    user("2026-10-21T10:30:00Z", "Now write the fix"),
    asst("2026-10-21T10:30:20Z", { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 55000, output_tokens: 800 }),
  ]);
  const a = hand("2026-10-21T10:05:00Z", { app: "Claude Code", app_model: "claude-opus-5-5", file_tokens: 40000, answer_tokens: 500, grade: "good", ms: 7000 });
  db.query("INSERT INTO comparisons(ts, month, day, handoff, kind, model, top_model, judge, shown_first, verdict, top_cost, judge_cost) VALUES ('2026-10-21T10:06:00Z', '2026-10', '2026-10-21', ?, 'read', 'google/gemini-3.8-flash', 'xai/grok-4.20-beta', 'deepseek/deepseek-v4-flash', 'model', 'same', 0.01, 0.002)").run(a);
  hand("2026-10-21T10:06:00Z", { app: "Claude Code", app_model: "claude-opus-5-5", kind: "write", model: "deepseek/deepseek-v4-flash", cost: 0.002, file_tokens: 6000, answer_tokens: 1100, verdict: "pass", checker: "xai/grok-4.20-beta", chance: 1 });
  hand("2026-10-21T11:00:00Z", { app: "Claude", app_model: "claude-opus-5-5", file_tokens: 20000, answer_tokens: 300, grade: "partly" });
  hand("2026-10-21T11:05:00Z", { app: "Claude", app_model: "claude-opus-5-5", kind: "reason", file_tokens: 1000, answer_tokens: 200 });
  hand("2026-10-21T11:30:00Z", { app: "Claude", app_model: "claude-opus-5-5", file_tokens: 3000, answer_tokens: 100, verdict: "fail", checker: "xai/grok-4.20-beta" });
});

describe("each prompt", () => {
  test("Claude Code's from its own files: until the next prompt of its session, new tokens apart from re-reads, with its hand offs", async () => {
    const r = await report(day());
    expect(r.prompts.map((p: any) => [p.ts.slice(11, 16), p.app, p.parts.length])).toEqual([["11:30", "Claude", 1], ["11:00", "Claude", 2], ["10:30", "Claude Code", 0], ["10:00", "Claude Code", 2]]);
    const p = r.prompts[3];
    expect(p).toMatchObject({ thread: "s-report", project: "app", model: { id: "claude-opus-5-5", label: "Claude Opus 5.5" }, prompt: 13, kept: 46000, back: 1600, grade: "good" });
    expect(p.own).toEqual({ fresh: 100 + 2000 + 300 + 50 + 200, cached: 102000, input: 2150, output: 500 });
    expect(p.saved).toBeCloseTo(46000 / (46000 + 2650), 9);
    expect(p.parts[0]).toMatchObject({ label: "Gemini 3.8 Flash", where: "free", read: 40000, back: 500, ms: 7000, grade: "good", gradedBy: "app", side: "same" });
    expect(p.parts[0].cost).toBeCloseTo(0.012, 9); // the side by side that judged it counts with it
    expect(p.parts[1]).toMatchObject({ label: "DeepSeek V4 Flash", where: "paid", grade: "good", gradedBy: "check", check: "pass", checker: "Grok 4.20 Beta" });
    expect(JSON.stringify(r)).not.toContain(SECRET); // numbers only, never words
  });

  test("Claude Code's subagents run on the same plan: their tokens count with the prompt, the main model stays the session's", async () => {
    const path = join(claudeRoot(), "projects", "-Users-you-app", "s-report", "subagents", "agent-a1.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      user("2026-10-21T10:02:00Z", `Read the logs ${SECRET}`, { isSidechain: true }), // the task Claude Code gave it: not a prompt of yours
      asst("2026-10-21T10:02:40Z", { input_tokens: 30, cache_creation_input_tokens: 400, cache_read_input_tokens: 9000, output_tokens: 2000 }, "claude-haiku-5-5"),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    forgetLogs();
    const r = await report(day());
    expect(r.prompts.filter((p: any) => p.app === "Claude Code").map((p: any) => p.ts.slice(11, 16))).toEqual(["10:30", "10:00"]);
    const p = r.prompts[3];
    expect(p.own).toEqual({ fresh: 2650 + 30 + 400 + 2000, cached: 102000 + 9000, input: 2150 + 430, output: 2500 });
    expect(p.model).toEqual({ id: "claude-opus-5-5", label: "Claude Opus 5.5" });
    expect(r.series.find((s: any) => s.at.slice(11, 16) === "10:00")!.used).toBe(2650 + 2430);
    expect(sessionOf("/x/projects/-Users-you-app/s-report/subagents/agent-a1.jsonl")).toBe("s-report");
    expect(sessionOf("C:\\Users\\you\\.claude\\projects\\app\\s-2.jsonl")).toBe("s-2");
  });

  test("another app's: its hand offs grouped by time, its own use not known", async () => {
    const r = await report(day());
    expect(r.prompts[1]).toMatchObject({ app: "Claude", model: { label: "Claude Opus 5.5" }, own: null, saved: null, prompt: null, kept: 21000, grade: "partly" });
    expect(r.prompts[0]).toMatchObject({ app: "Claude", kept: 3000, grade: "wrong" }); // 25 minutes later: a prompt of its own
  });
});

describe("the tiles, the chart and the breakdowns", () => {
  test("kept out, its share where the apps' use is known, the apps' own use, the cost and the quality", async () => {
    const r = await report(day());
    expect(r.tiles.kept.tokens).toBe(46000 + 21000 + 3000);
    expect(r.tiles.kept.share).toBeCloseTo(46000 / (46000 + 2650 + 1310), 9); // only Claude Code's prompts are measured
    expect(r.tiles.own).toMatchObject({ fresh: 2650 + 1310, measured: 2, notKnown: 2 });
    expect(r.tiles.own.byApp).toEqual([{ app: "Claude", measured: false, fresh: 0 }, { app: "Claude Code", measured: true, fresh: 3960 }]);
    expect(r.tiles.cost).toMatchObject({ parts: 5, prompts: 4 });
    expect(r.tiles.cost.freeShare).toBeCloseTo(4 / 5, 9);
    expect(r.tiles.quality).toMatchObject({ good: 2, partly: 1, wrong: 1, graded: 4, goodShare: 0.5, blind: 3, judge: "Grok 4.20 Beta" }); // two checks and a side by side
  });

  test("tokens over time: kept by Leanfare's models against the apps' new tokens, in points as long as the span asks", async () => {
    const r = await report(day()); // 3 hours: points of 15 minutes
    expect(r.step).toBe(900_000);
    expect(r.series).toHaveLength(12);
    expect(r.series.filter((s: any) => s.kept || s.used).map((s: any) => [s.at.slice(11, 16), s.kept, s.used])).toEqual([["10:00", 46000, 2650], ["10:30", 0, 1310], ["11:00", 21000, 0], ["11:30", 3000, 0]]);
    const today = await report(checkReport(new URLSearchParams({ range: "today" })) as any); // 12 hours: an hour each
    expect(today.step).toBe(3600_000);
    expect(today.series.filter((s: any) => s.kept || s.used).map((s: any) => [s.at.slice(11, 16), s.kept, s.used])).toEqual([["10:00", 46000, 3960], ["11:00", 24000, 0]]);
  });

  test("by model and by kind of work, with the best model where two or more answers were graded", async () => {
    const r = await report(day());
    expect(r.byModel.map((m: any) => [m.label, m.read, m.parts, m.graded, m.goodShare])).toEqual([["Gemini 3.8 Flash", 64000, 4, 3, 1 / 3], ["DeepSeek V4 Flash", 6000, 1, 1, 1]]);
    expect(r.byKind[0]).toMatchObject({ kind: "read", parts: 3, good: 1, partly: 1, wrong: 1, best: { label: "Gemini 3.8 Flash" } });
  });
});

describe("the filters", () => {
  test("by app, by thread, by provider, model or kind of the hand offs, and what can be picked", async () => {
    expect((await report(day({ app: "Claude" }))).prompts.map((p: any) => p.app)).toEqual(["Claude", "Claude"]);
    expect((await report(day({ thread: "s-report" }))).prompts.map((p: any) => p.ts.slice(11, 16))).toEqual(["10:30", "10:00"]);
    const ds = await report(day({ provider: "deepseek" }));
    expect(ds.prompts.map((p: any) => [p.ts.slice(11, 16), p.parts.map((x: any) => x.label)])).toEqual([["10:00", ["DeepSeek V4 Flash"]]]);
    expect(ds.tiles.kept.tokens).toBe(6000);
    expect((await report(day({ kind: "reason" }))).prompts.map((p: any) => p.kept)).toEqual([1000]);
    const r = await report(day());
    expect(r.options).toMatchObject({ apps: ["Claude", "Claude Code"], providers: ["deepseek", "google"], kinds: ["read", "reason", "write"] });
    expect(r.options.threads).toEqual([{ id: "s-report", project: "app", first: "2026-10-21T10:00:00.000Z", prompts: 2 }]);
  });

  test("the points start by this computer's clock: a day at its midnight, an hour on its hour", async () => {
    const was = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const days = startsOf(Date.parse("2026-10-29T15:00:00Z"), Date.parse("2026-11-03T15:00:00Z"), 86_400_000);
      expect(days.map((t) => new Date(t).toISOString())).toEqual([ // the clocks go back on 1 November: that day has 25 hours
        "2026-10-29T07:00:00.000Z", "2026-10-30T07:00:00.000Z", "2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z", "2026-11-03T08:00:00.000Z"]);
      const r = await report(checkReport(new URLSearchParams({ range: "custom", from: "2026-10-20T07:00:00Z", to: "2026-10-22T07:00:00Z" })) as any); // two days of Los Angeles: an hour a point
      expect(r.series[0].at).toBe("2026-10-20T07:00:00.000Z");
      const week = await report(checkReport(new URLSearchParams({ range: "custom", from: "2026-10-15T07:00:00Z", to: "2026-10-22T07:00:00Z" })) as any); // a week: a day a point, from local midnight
      expect(week.series.map((s: any) => s.at.slice(11, 16))).toEqual(Array(7).fill("07:00"));
      expect(week.series.find((s: any) => s.at.startsWith("2026-10-21"))!.kept).toBe(46000 + 21000 + 3000); // 3 to 4:30 AM on the 21st, Los Angeles time
      process.env.TZ = "Asia/Kolkata"; // half an hour off UTC
      expect(startsOf(Date.parse("2026-10-21T09:10:00Z"), Date.parse("2026-10-21T12:00:00Z"), 3600_000).map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(["08:30", "09:30", "10:30", "11:30"]);
    } finally { process.env.TZ = was; }
    expect(new Date(Date.parse("2026-10-21T12:00:00Z")).getHours()).toBe(12);
  });

  test("ranges by this computer's clock, the points' length, and what the page may ask", async () => {
    const at = Date.parse("2026-10-21T12:00:00Z");
    expect(rangeOf("today", at)).toEqual({ from: Date.parse("2026-10-21T00:00:00Z"), to: at }); // the tests run in UTC
    expect(rangeOf("7d", at).from).toBe(at - 7 * 86_400_000);
    expect([bucketOf(3600_000), bucketOf(86_400_000), bucketOf(7 * 86_400_000), bucketOf(365 * 86_400_000)]).toEqual([900_000, 3600_000, 86_400_000, 7 * 86_400_000]);
    expect(checkReport(new URLSearchParams({ range: "week" }))).toBe("range must be 1h, 6h, today, 7d, 30d, year or custom.");
    expect(checkReport(new URLSearchParams({ range: "custom", from: "2026-10-21" }))).toBe("A custom range needs from and to, dates with from before to.");
    const g = await ui(url, "/api/report?range=custom&from=2026-10-21T09:00:00Z&to=2026-10-21T12:00:00Z&app=Claude");
    expect(g.status).toBe(200);
    expect(g.json.prompts).toHaveLength(2);
    expect((await ui(url, "/api/report?range=week")).status).toBe(400);
  });
});
