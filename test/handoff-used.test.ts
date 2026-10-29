// What the outside models used for each hand off, measured (0.10): every call made for a hand off carries its mark in
// the ledger (its answer, a second try, its check, side by side), and the report sums them as read, thinking and
// written, from the providers' own counts. Thinking is what the provider says; else it is estimated from the
// thinking the model sent, or not known. Older hand offs, before the mark, say they were not measured.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { thinkingOf } from "../src/engine";
import { reportLines, usedText } from "../src/mcp";
import { checkReport, report, sumUsed } from "../src/report";
import { draw, sideBySideIdle } from "../src/sidebyside";
import { boot, fake, keys, reset } from "./app";

const DEEPSEEK = "deepseek/deepseek-v4-flash", GEMINI = "google/gemini-3.8-flash", GROK = "xai/grok-4.20-beta";
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n10:02 error: retry failed\n" };
const SAID = "[usage 2000 500] [reasoning 300]"; // every call reports 2,000 read and 500 written, 300 of them thinking
beforeAll(async () => { await boot(); });
beforeEach(async () => {
  await reset({ ticked: [DEEPSEEK, GEMINI, GROK], sideBySide: 5, sideBySideCap: 1 });
  await keys("deepseek", "google", "xai");
  draw.next = () => 1; // no side by side unless a test asks
  fake.hooks.answer = (p) => (p.includes("You check another model's work.") ? "PASS" : p.includes("You compare two answers") ? "SAME. Both list the two errors." : "Errors: disk full (2), retry failed (3).");
});
const handOff = (more: Record<string, unknown> = {}) =>
  runDelegate({ task: `List the errors. ${SAID}`, files: [LOG], kind: "read", effort: "low", check: "never", maxOut: 2000, ...more } as any, new AbortController().signal);
const calls = () => db.query("SELECT source, job, in_tokens, out_tokens, think_tokens, think_source FROM ledger ORDER BY id").all() as any[];
const span = () => checkReport(new URLSearchParams({ range: "custom", from: "2026-10-21T11:00:00Z", to: "2026-10-21T12:01:00Z" })) as any;

describe("every call of a hand off carries its mark", () => {
  test("its answer, its check and side by side: one mark, the hand off's own", async () => {
    draw.next = () => 0; // compared side by side
    const r = await handOff({ check: "always" });
    await sideBySideIdle();
    const job = (db.query("SELECT job FROM delegations WHERE id = ?").get(r.row) as any).job;
    expect(job).toMatch(/^[\w-]{8,}$/);
    expect(calls().map((c) => [c.source, c.job])).toEqual([["delegate", job], ["check", job], ["sidebyside", job], ["sidebyside", job]]);
    // The thinking as the provider said it, inside the output.
    expect(calls().map((c) => [c.in_tokens, c.out_tokens, c.think_tokens, c.think_source])).toEqual(Array(4).fill([2000, 500, 300, "reported"]));
  });

  test("a check that failed the answer: the second try is the same hand off's", async () => {
    fake.hooks.answer = (p) => (p.includes("You check another model's work.") ? "FAIL: it misses the line numbers." : "Errors: disk full (2), retry failed (3).");
    const r = await handOff({ check: "always" });
    expect(r.first).not.toBeNull(); // answered again
    const job = (db.query("SELECT job FROM delegations WHERE id = ?").get(r.row) as any).job;
    expect(calls().map((c) => [c.source, c.job])).toEqual([["delegate", job], ["check", job], ["delegate", job]]);
  });

  test("two hand offs, two marks; a chat in Leanfare has none", async () => {
    await handOff(); await handOff();
    const jobs = calls().map((c) => c.job);
    expect(jobs[0]).not.toBe(jobs[1]);
    expect(jobs.every(Boolean)).toBe(true);
  });
});

describe("the report sums them", () => {
  test("read, thinking and written, for the part, its prompt and the tiles; and by role", async () => {
    draw.next = () => 0;
    await handOff({ check: "always" });
    await sideBySideIdle();
    const r = await report(span());
    const part = r.prompts[0].parts[0];
    // Four calls of 2,000 read and 500 out, 300 of them thinking: written is the output less the thinking.
    expect(part.used).toMatchObject({ read: 8000, thought: 1200, wrote: 800, calls: 4, failed: 0, estimated: false });
    expect(part.used!.byRole).toEqual({ answer: { read: 2000, thought: 300, wrote: 200, calls: 1 }, check: { read: 2000, thought: 300, wrote: 200, calls: 1 }, side: { read: 4000, thought: 600, wrote: 400, calls: 2 } });
    expect(r.prompts[0].used).toMatchObject({ read: 8000, thought: 1200, wrote: 800 });
    expect(r.tiles.outside).toMatchObject({ read: 8000, thought: 1200, wrote: 800, calls: 4, measured: 1, notMeasured: 0 });
    // Kept out is still what the app did not read: the task and files, once.
    expect(part.read).toBeLessThan(200);
  });

  test("a model that does not think: none; one whose thinking is not known makes the sum's thinking not known", async () => {
    await handOff(); // reported: 300 thinking
    await handOff({ task: "List the errors. [usage 1000 100]" }); // no count, and DeepSeek V4 Flash does not think (the catalog)
    expect(calls().map((c) => c.think_source)).toEqual(["reported", "none"]);
    let r = await report(span());
    let [a, b] = r.prompts[0].parts; // one app, within minutes: one prompt, its parts in order
    expect(a.used).toMatchObject({ read: 2000, thought: 300, wrote: 200 });
    expect(b.used).toMatchObject({ read: 1000, thought: 0, wrote: 100 });
    expect(r.prompts[0].used).toMatchObject({ read: 3000, thought: 300, wrote: 300 });
    // A model that thinks, with no count and no thinking text: not known. Written then counts the thinking in, all along.
    db.query("UPDATE ledger SET think_tokens = NULL, think_source = NULL WHERE id = (SELECT MAX(id) FROM ledger)").run();
    r = await report(span());
    [a, b] = r.prompts[0].parts;
    expect(b.used).toMatchObject({ thought: null, wrote: 100 });
    expect(r.prompts[0].used).toMatchObject({ read: 3000, thought: null, wrote: 600 });
    expect(usedText(b.used)).toBe("1k read, 100 written (thinking not split)");
    expect(sumUsed([null, null])).toBeNull();
  });

  test("an older hand off, before the mark: not measured, and said so", async () => {
    db.query(`INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance)
      VALUES ('2026-10-21T11:30:00Z', '2026-10', '2026-10-21', 'longer_query', 'read', 'low', ?, 0, 1, 900, 40, 'ok', 0)`).run(GEMINI);
    await handOff();
    const r = await report(span());
    const parts = r.prompts.flatMap((p) => p.parts);
    expect(parts.map((x) => x.used === null)).toEqual([false, true]);
    expect(r.tiles.outside).toMatchObject({ measured: 1, notMeasured: 1, read: 2000 });
    expect(reportLines(r, "custom")).toContain("What the outside models used (measured): 2k read, 300 thinking, 200 written, in 1 call; 1 older part not measured.");
  });
});

describe("the thinking of one answer", () => {
  const thinker = { skills: ["reasoning"] } as any, plain = { skills: [] } as any;
  const u = (output: number, thinking?: number) => ({ uncached: 10, cacheRead: 0, cacheWrite: 0, output, ...(thinking === undefined ? {} : { thinking }) });
  test("as the provider said; else from its thinking text; a model that does not think, none; else not known", () => {
    expect(thinkingOf(thinker, u(500, 300), 4000)).toEqual({ tokens: 300, source: "reported" });
    expect(thinkingOf(thinker, u(500), 1201)).toEqual({ tokens: 301, source: "text" }); // about four characters a token
    expect(thinkingOf(thinker, u(100), 4000)).toEqual({ tokens: 100, source: "text" }); // never more than the output
    expect(thinkingOf(plain, u(500), 0)).toEqual({ tokens: 0, source: "none" });
    expect(thinkingOf(thinker, u(500), 0)).toEqual({ tokens: null, source: null });
  });
});
