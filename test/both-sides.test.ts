// Both sides of a hand off (report.ts, 0.10): what the outside model used (measured), what the app would have used doing
// the part alone (an estimate, from the outside model's numbers), what handing it off cost the app, and the saving. And
// quality three ways: the outside answer, the whole result together, and the app alone where sampled.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { gradeTogether, runDelegate } from "../src/delegate";
import { reportLines } from "../src/mcp";
import { aloneGrade, bothOf, checkReport, report } from "../src/report";
import { draw, sideBySideIdle } from "../src/sidebyside";
import { boot, fake, keys, reset, ui } from "./app";

const DEEPSEEK = "deepseek/deepseek-v4-flash", GEMINI = "google/gemini-3.8-flash", GROK = "xai/grok-4.20-beta", SONNET = "anthropic/claude-sonnet-4-6";
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n10:02 error: retry failed\n" };
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ ticked: [DEEPSEEK, GEMINI, GROK], sideBySide: 5, sideBySideCap: 1 });
  await keys("deepseek", "google", "xai");
  draw.next = () => 1; // no side by side unless a test asks
});
const handOff = (more: Record<string, unknown> = {}) =>
  runDelegate({ task: "List the errors. [usage 2000 500] [reasoning 300]", files: [LOG], kind: "read", effort: "low", check: "never", maxOut: 2000, app: "Claude Code", appModel: "claude-sonnet-4-6", ...more } as any, new AbortController().signal);
const span = () => checkReport(new URLSearchParams({ range: "custom", from: "2026-10-21T11:00:00Z", to: "2026-10-21T12:01:00Z" })) as any;

describe("the app's side, estimated", () => {
  test("alone: what the outside model read, thought and wrote; spent: the task, the answer and the receipt; saved: the difference", () => {
    const used = { read: 9000, thought: 1000, wrote: 400, calls: 1, failed: 0, estimated: false, byRole: {} };
    expect(bothOf({ read: 8000, back: 400, used, ask: 50, reply: 100 })).toEqual({
      alone: { mid: 9400, low: Math.round(0.7 * 8000 + 0.5 * 1400), high: Math.round(1.3 * 8000 + 2 * 1400) },
      spent: 550, saved: { mid: 8850, low: 6300 - 550, high: 13200 - 550 }, how: "outside" });
    // Its thinking not known: the range leaves room for as much again as it wrote; a task or receipt not kept: a typical size.
    const b = bothOf({ read: 8000, back: 400, used: { ...used, thought: null }, ask: null, reply: null });
    expect([b.alone.mid, b.alone.high, b.spent]).toEqual([8400, 10400 + 800 + 400, 80 + 400 + 120]);
  });
  test("the app alone's grade, from a sample: as good, the same; better, good; not as good, one step down", () => {
    expect([aloneGrade("good", "same"), aloneGrade("partly", "same"), aloneGrade(null, "worse"), aloneGrade("good", "better"), aloneGrade("partly", "better"), aloneGrade(null, "same")])
      .toEqual(["good", "partly", "good", "partly", "wrong", null]);
  });
});

describe("in the report", () => {
  test("a hand off keeps the task the app wrote and the receipt it read back; the report sums both sides", async () => {
    const r = await handOff();
    const row = db.query("SELECT ask_tokens, reply_tokens FROM delegations WHERE id = ?").get(r.row) as any;
    expect(row.ask_tokens).toBe(Math.ceil("List the errors. [usage 2000 500] [reasoning 300]".length / 4));
    expect(row.reply_tokens).toBe(Math.ceil(r.receipt.length / 4));
    const rep = await report(span());
    const p = rep.prompts[0], x = p.parts[0];
    expect(x.both.alone.mid).toBe(x.read + 300 + x.back); // the files and task it read, the thinking as measured, the answer
    expect(x.both.spent).toBe(row.ask_tokens + x.back + row.reply_tokens);
    expect(p.both).toEqual({ alone: x.both.alone, spent: x.both.spent, saved: x.both.saved });
    expect(rep.tiles.both).toMatchObject({ app: "Claude Code", spent: x.both.spent, saved: x.both.saved });
    expect(reportLines(rep, "custom")).toContain(`Saved for Claude Code (an estimate): about `);
  });

  test("the whole result, graded by the app (its last hand off) or by you (a hand off of that prompt)", async () => {
    await handOff(); const second = await handOff();
    expect(gradeTogether("partly", { app: "Claude Code", by: "app" })).toBe(true);
    expect(db.query("SELECT id FROM delegations WHERE together IS NOT NULL").all()).toEqual([{ id: second.row }]);
    expect(gradeTogether("good", { app: "Codex", by: "app" })).toBe(false); // no hand off of that app
    let rep = await report(span());
    expect(rep.prompts[0]).toMatchObject({ together: "partly", togetherBy: "app" });
    expect(rep.tiles.three.together).toEqual({ graded: 1, good: 0 });
    expect((await ui(url, "/api/grades/together", { verdict: "good", handoff: second.row })).json).toEqual({ ok: true });
    rep = await report(span());
    expect(rep.prompts[0]).toMatchObject({ together: "good", togetherBy: "you" });
    expect((await ui(url, "/api/grades/together", { verdict: "great" })).status).toBe(400);
  });

  test("the app alone, sampled: side by side runs the app's own model when you have it, judged blind; its tokens measured", async () => {
    await reset({ ticked: [DEEPSEEK, GEMINI, GROK, SONNET], sideBySide: 5, sideBySideCap: 1 });
    await keys("deepseek", "google", "xai", "anthropic");
    draw.next = () => 0; // compared
    fake.hooks.answer = (p) => (p.includes("You compare two answers") ? "SAME. Both list the two errors." : "Errors: disk full (2), retry failed (3).");
    const r = await handOff();
    await sideBySideIdle();
    expect(db.query("SELECT top_model, app_alone, verdict FROM comparisons").all()).toEqual([{ top_model: SONNET, app_alone: 1, verdict: "same" }]);
    db.query("UPDATE delegations SET grade = 'good' WHERE id = ?").run(r.row);
    const rep = await report(span());
    const x = rep.prompts[0].parts[0];
    expect(x.alone).toMatchObject({ model: SONNET, label: "Claude Sonnet 4.6", verdict: "same", grade: "good" });
    expect(x.alone!.used).toBe(2500); // its own call: 2,000 read and 500 written, as reported
    expect(rep.prompts[0].alone).toEqual({ grade: "good", samples: 1 });
    expect(rep.tiles.three.alone).toEqual({ sampled: 1, graded: 1, good: 1 });
  });

  test("an app whose model you do not have: side by side keeps to the best model you ticked, and the app alone stays not known", async () => {
    draw.next = () => 0;
    fake.hooks.answer = (p) => (p.includes("You compare two answers") ? "SAME. Both fine." : "Errors: disk full (2), retry failed (3).");
    await handOff();
    await sideBySideIdle();
    expect(db.query("SELECT top_model, app_alone FROM comparisons").all()).toEqual([{ top_model: GEMINI, app_alone: 0 }]);
    const rep = await report(span());
    expect(rep.prompts[0].parts[0].alone).toBeNull();
    expect(rep.prompts[0].alone).toBeNull();
  });
});
