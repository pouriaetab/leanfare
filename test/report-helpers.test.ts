// 0.15, the report's new columns (report.ts): each prompt's main model with its effort and its own tokens, and Claude's
// helpers by model and kind with theirs. Claude Code's helpers come from its subagents' files; Cowork's and Claude
// Desktop's from the leanfare-level mod, which also says each main turn, and each turn is a prompt there. Numbers only.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { checkDelegate, notePart } from "../src/delegate";
import { checkPlan, makePlan } from "../src/planner";
import { forgetLogs } from "../src/plans";
import { checkReport, PROMPTS_MAX, report } from "../src/report";
import { boot, reset } from "./app";

beforeAll(async () => { await boot(); });
const claudeRoot = () => process.env.CLAUDE_CONFIG_DIR!;
let n = 0;
const user = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({ type: "user", timestamp: ts, cwd: "/Users/you/app", message: { role: "user", content: text }, ...extra });
const asst = (ts: string, usage: Record<string, number>, model = "claude-opus-5-5") => ({ type: "assistant", timestamp: ts, requestId: `rq_${++n}`, message: { id: `mg_${n}`, model, role: "assistant", content: [{ type: "text", text: "words" }], usage } });
const write = (path: string, rows: unknown[]) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };
const hand = (ts: string, f: Record<string, unknown>) => {
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), task: "longer_query", kind: "read", effort: "low", model: "google/gemini-3.8-flash", cost: 0, files: 1, file_tokens: 1000, answer_tokens: 100, status: "ok", chance: 0, ...f };
  const keys = Object.keys(row);
  return Number(db.query(`INSERT INTO delegations(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[])).lastInsertRowid);
};
const helper = (ts: string, f: Record<string, unknown>) => {
  const row = { ts, day: ts.slice(0, 10), app: "Cowork", kind: "read", effort: "low", top: 0, family: "sonnet", model: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 0, cached: 0, output: 0, ...f };
  const keys = Object.keys(row);
  db.query(`INSERT INTO helpers(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
};
const turn = (ts: string, f: Record<string, unknown>) => {
  const row = { ts, day: ts.slice(0, 10), app: "Cowork", model: "claude-opus-5-5", effort: null, input: 0, cached: 0, output: 0, ...f };
  const keys = Object.keys(row);
  db.query(`INSERT INTO app_turns(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
};
const span = (from: string, to: string) => checkReport(new URLSearchParams({ range: "custom", from, to })) as any;

beforeEach(async () => {
  rmSync(claudeRoot(), { recursive: true, force: true });
  forgetLogs();
  await reset();
});

describe("Claude Code", () => {
  test("the main model's own tokens apart from its helpers', each helper with the effort and kind Leanfare picked for it", async () => {
    write(join(claudeRoot(), "projects", "-Users-you-app", "s-rh.jsonl"), [
      user("2026-10-21T10:00:00Z", "Find why the nightly job fails"),
      asst("2026-10-21T10:00:30Z", { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 300 }),
    ]);
    write(join(claudeRoot(), "projects", "-Users-you-app", "s-rh", "subagents", "agent-b1.jsonl"), [
      user("2026-10-21T10:02:00Z", "Read the logs", { isSidechain: true }),
      asst("2026-10-21T10:02:40Z", { input_tokens: 30, cache_creation_input_tokens: 400, cache_read_input_tokens: 9000, output_tokens: 2000 }, "claude-haiku-5-5-20260301"),
    ]);
    write(join(claudeRoot(), "projects", "-Users-you-app", "s-rh", "subagents", "agent-b2.jsonl"), [
      asst("2026-10-21T10:03:10Z", { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 500 }, "claude-haiku-5-5-20260301"),
    ]);
    forgetLogs();
    helper("2026-10-21T10:01:50Z", { app: "Claude Code", session: "s-rh", kind: "read", effort: "low", family: "haiku", model: "anthropic/claude-haiku-5-5" });
    helper("2026-10-21T10:01:55Z", { app: "Claude Code", session: "another-session", kind: "code", effort: "high", family: "haiku", model: "anthropic/claude-haiku-5-5" }); // not this prompt's
    const r = await report(span("2026-10-21T09:00:00Z", "2026-10-21T12:00:00Z"));
    const p = r.prompts.find((x: any) => x.app === "Claude Code")!;
    expect(p.main).toEqual({ fresh: 100 + 2000 + 300, cached: 50000, input: 2100, output: 300 });
    expect(p.helpers).toEqual([{ model: "claude-haiku-5-5-20260301", label: "Claude Haiku 5.5", effort: "low", kind: "read", n: 2, fresh: 30 + 400 + 2000 + 10 + 500, cached: 10000, input: 440, output: 2500 }]);
    expect(p.own).toEqual({ fresh: 2400 + 2940, cached: 60000, input: 2540, output: 2800 }); // the whole prompt: the main model and its helpers
    expect(p.effort).toBe(null); // Claude Code's files do not say it
  });
});

describe("Cowork and Claude Desktop", () => {
  test("each main turn the mod says is a prompt, with the hand offs and helpers made during it; after the last turn, they wait in a group of their own", async () => {
    turn("2026-10-21T11:10:00Z", { effort: "high", input: 5000, cached: 80000, output: 1200 });
    turn("2026-10-21T11:40:00Z", { input: 800, cached: 90000, output: 300 });
    helper("2026-10-21T11:02:00Z", { input: 3000, cached: 20000, output: 500 });
    helper("2026-10-21T11:03:00Z", { input: 1000, output: 100 });
    helper("2026-10-21T11:20:00Z", { kind: "reason", effort: "high", top: 1, family: "fable", model: "anthropic/claude-fable-5-1", label: "Claude Fable 5.1", input: 2000, cached: 10000, output: 900 });
    hand("2026-10-21T11:05:00Z", { app: "Cowork", app_model: "claude-opus-5-5", file_tokens: 20000 });
    hand("2026-10-21T11:25:00Z", { app: "Cowork", app_model: "claude-opus-5-5", kind: "write", app_effort: "medium" });
    hand("2026-10-21T11:26:00Z", { app: "Claude Code", app_model: "claude-opus-5-5" }); // another app's: not in Cowork's turns
    helper("2026-10-21T11:50:00Z", { kind: "read", input: 700, output: 50 }); // its turn has not ended yet
    const r = await report(span("2026-10-21T11:00:00Z", "2026-10-21T12:00:00Z"));
    const cw = r.prompts.filter((x: any) => x.app === "Cowork");
    expect(cw.map((p: any) => [p.ts.slice(11, 16), p.parts.length, p.helpers.length])).toEqual([["11:50", 0, 1], ["11:20", 1, 1], ["11:02", 1, 1]]);
    const [later, second, first] = cw;
    expect(first).toMatchObject({ model: { id: "claude-opus-5-5", label: "Claude Opus 5.5" }, effort: "high", main: { fresh: 6200, cached: 80000, input: 5000, output: 1200 } });
    expect(first.helpers).toEqual([{ model: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", effort: "low", kind: "read", n: 2, fresh: 4600, cached: 20000, input: 4000, output: 600 }]);
    expect(first.own).toEqual({ fresh: 6200 + 4600, cached: 100000, input: 9000, output: 1800 });
    expect(first.parts[0]).toMatchObject({ read: 20000 });
    expect(second).toMatchObject({ effort: "medium", main: { fresh: 1100, cached: 90000, input: 800, output: 300 } }); // the turn did not say it; its hand off did
    expect(second.helpers).toEqual([{ model: "anthropic/claude-fable-5-1", label: "Claude Fable 5.1", effort: "high", kind: "reason", n: 1, fresh: 2900, cached: 10000, input: 2000, output: 900 }]);
    expect(later).toMatchObject({ own: null, main: null, effort: null });
    expect(later.helpers).toEqual([{ model: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", effort: "low", kind: "read", n: 1, fresh: 750, cached: 0, input: 700, output: 50 }]);
    // Each has an id of its own, and the tile counts Cowork's own use as measured now.
    expect(new Set(cw.map((p: any) => p.id)).size).toBe(3);
    expect(r.tiles.own.byApp.find((a: any) => a.app === "Cowork")).toEqual({ app: "Cowork", measured: true, fresh: 6200 + 4600 + 1100 + 2900 });
  });

  test("with no turns said (no mod), hand offs are grouped by time as before, and a helper joins its group", async () => {
    hand("2026-10-21T11:05:00Z", { app: "Claude", app_model: "claude-opus-5-5" });
    helper("2026-10-21T11:06:00Z", { app: "Claude", input: 100, output: 10 });
    hand("2026-10-21T11:30:00Z", { app: "Claude", app_model: "claude-opus-5-5" });
    const r = await report(span("2026-10-21T11:00:00Z", "2026-10-21T12:00:00Z"));
    expect(r.prompts.map((p: any) => [p.ts.slice(11, 16), p.parts.length, p.helpers.map((h: any) => h.n)])).toEqual([["11:30", 1, []], ["11:05", 1, [1]]]);
    expect(r.prompts[1]).toMatchObject({ own: null, main: null });
  });
});

describe("the app's effort and the number of prompts", () => {
  test("plan and delegate take the effort the app runs at, and its hand offs keep it", () => {
    expect(checkDelegate({ task: "Read it", your_model: "claude-opus-5-5", your_effort: "xhigh" })).toMatchObject({ appModel: "claude-opus-5-5", appEffort: "xhigh" });
    expect(checkDelegate({ task: "Read it", your_effort: "turbo" })).toBe("your_effort must be one of low, medium, high, xhigh, max.");
    expect(checkPlan({ task: "Fix the parser", your_effort: "MAX" })).toMatchObject({ yourEffort: "max" });
    expect(checkPlan({ task: "Fix the parser", your_effort: 3 })).toBe("your_effort must be one of low, medium, high, xhigh, max.");
    const id = notePart({ kind: "read", effort: "low", model: "codex/auto", cost: 0, files: 0, fileTokens: 0, task: "t", answer: "a", plan: "p1:1", app: "Cowork", appModel: "claude-opus-5-5", appEffort: "high" });
    expect(db.query("SELECT app, app_model, app_effort FROM delegations WHERE id = ?").get(id)).toEqual({ app: "Cowork", app_model: "claude-opus-5-5", app_effort: "high" });
  });

  test("a plan keeps the effort with the app's model", async () => {
    const p = await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Cowork", split: "rules", yourModel: "claude-opus-5-5", yourEffort: "high", signal: new AbortController().signal });
    expect(p.you).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  });

  test(`more than 200 prompts: up to ${PROMPTS_MAX} come back, and the page shows them a page at a time`, async () => {
    const t0 = Date.parse("2026-10-20T00:00:00Z");
    db.transaction(() => { for (let i = 0; i < 230; i++) hand(new Date(t0 + i * 11 * 60_000).toISOString(), { app: "Claude" }); })();
    const r = await report(span("2026-10-19T00:00:00Z", "2026-10-22T00:00:00Z"));
    expect(r.prompts.length).toBe(230);
    expect(r.more).toBe(0);
  });
});
