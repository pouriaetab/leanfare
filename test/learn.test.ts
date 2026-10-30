// Picks that learn from your own history (learn.ts, speed.ts, router.ts; 0.10): your grades and the blind checks move a
// model's rating for a kind of work; its time is learned by the size of the input and its recent failures; and a
// balance of time and cost picks the quick one among models equally good and equally cheap.
//
// The fixture, balanced, reading (Arena's longer_query): Gemini 3.8 Flash is the best rated of the three ticked here,
// DeepSeek V4 Flash the cheapest within reach, Grok 4.20 Beta the cheapest below it.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getModel } from "../src/data";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { LEARN, forgetLearned, learnedShift } from "../src/learn";
import { pickModel, rating } from "../src/router";
import { fitLine, forgetSpeeds, secondsFor, speedOf } from "../src/speed";
import { boot, keys, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash", GROK = "xai/grok-4.20-beta";
const m = (id: string) => getModel(id)!;
beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset({ ticked: [GEMINI, DEEPSEEK, GROK] }); forgetLearned(); forgetSpeeds(); });
// A graded hand off: the app's grade, or a blind check's verdict.
function graded(model: string, kind: string, f: { grade?: string; verdict?: string; rerun?: string }) {
  db.query(`INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance, grade, verdict, rerun)
    VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'longer_query', ?, 'low', ?, 0, 1, 100, 10, 'ok', 0, ?, ?, ?)`).run(kind, model, f.grade ?? null, f.verdict ?? null, f.rerun ?? null);
  forgetLearned();
}

describe("your grades move a model's rating for a kind of work", () => {
  test("par is 0.7; the shift grows as the answers add up, and stops at 60 points either way", () => {
    expect(learnedShift(DEEPSEEK, "read")).toBeNull(); // nothing graded
    for (let i = 0; i < 3; i++) graded(DEEPSEEK, "read", { grade: "good" });
    expect(learnedShift(DEEPSEEK, "read")).toEqual({ points: Math.round(0.3 * 120 * (3 / 9)), n: 3, score: 1 });
    for (let i = 0; i < 17; i++) graded(DEEPSEEK, "read", { verdict: "pass" }); // a blind check's pass counts as good
    expect(learnedShift(DEEPSEEK, "read")!.points).toBe(Math.round(0.3 * 120 * (20 / 26)));
    for (let i = 0; i < 20; i++) graded(GROK, "write", { grade: "wrong" });
    expect(learnedShift(GROK, "write")).toEqual({ points: -LEARN.most, n: 20, score: 0 }); // capped
    expect(learnedShift(GROK, "read")).toBeNull(); // another kind
    graded(GEMINI, "read", { grade: "partly" });
    expect(learnedShift(GEMINI, "read")!.score).toBe(0.5);
    graded(GROK, "read", { grade: "good", rerun: DEEPSEEK }); // a second answer after a failed check is the rerun model's
    expect(learnedShift(GROK, "read")).toBeNull();
  });

  test("a model that keeps doing well comes within reach, and is picked; the reason says why", () => {
    const usable = [m(GEMINI), m(DEEPSEEK), m(GROK)];
    const msgs = [{ role: "user", content: "Find the errors in the log." }];
    const guess = { task: "longer_query", why: "the kind it was handed over as (read)", alt: "overall", kind: "read" };
    const without = pickModel(msgs, usable, "best", () => null, undefined, guess)!;
    const best = Math.max(...usable.map((x) => rating(x, "longer_query") ?? 0));
    const gap = best - rating(m(GROK), "longer_query")!;
    expect(gap).toBeGreaterThan(15); // Best quality: within 15 points; Grok is not
    expect(without.candidates.slice(0, without.eligible).map((c) => c.model.id)).not.toContain(GROK);
    const learn = (x: any) => (x.id === GROK ? 60 : 0);
    const withIt = pickModel(msgs, usable, "best", () => null, undefined, guess, "cheapest", undefined, undefined, learn)!;
    expect(withIt.candidates.slice(0, withIt.eligible).map((c) => c.model.id)).toContain(GROK);
    const chosen = withIt.candidates.find((c) => c.model.id === GROK)!;
    expect(chosen.rating).toBe(rating(m(GROK), "longer_query")! + 60);
    expect(withIt.model.id).toBe(GROK); // the cheapest of those now within reach
    expect(withIt.reason).toContain("(+60 from your grades)");
  });

  test("a hand off of a kind: the delegate picks by what your grades say", async () => {
    await keys("google", "deepseek", "xai");
    const first = await runDelegate({ task: "Find the errors.", files: [{ name: "a.log", text: "error: x\n" }], kind: "read", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal);
    for (let i = 0; i < 20; i++) graded(first.model.id, "read", { grade: "wrong" });
    const next = await runDelegate({ task: "Find the errors.", files: [{ name: "a.log", text: "error: x\n" }], kind: "read", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal);
    expect(next.model.id).not.toBe(first.model.id); // its rating for reading fell 60 points: another is picked
  });
});

describe("time, learned by the size of the input and the tries that failed", () => {
  test("a line through the first token's wait against the input's size, when the answers say so clearly", () => {
    expect(fitLine([[1000, 1.5], [2000, 2], [4000, 3], [8000, 5], [16000, 9], [1000, 1.5], [2000, 2], [4000, 3]])).toEqual({ a: expect.closeTo(1, 6), b: expect.closeTo(0.0005, 9) });
    expect(fitLine([[1000, 1], [2000, 2]])).toBeNull(); // too few
    expect(fitLine(Array.from({ length: 10 }, (_, i) => [1000 + i * 100, 1 + i * 0.1] as [number, number]))).toBeNull(); // sizes too alike
    expect(fitLine(Array.from({ length: 10 }, (_, i) => [1000 * (i + 1), 5 - i * 0.2] as [number, number]))).toBeNull(); // it does not rise
  });
  test("a model whose first token comes later for longer inputs: its time grows with the input", () => {
    const add = (inTok: number, firstMs: number, status = "ok", fail: string | null = null) => db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, fail, ms, first_ms, in_tokens, out_tokens)
      VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'delegate', 'google', ?, 'listed', 'reported', ?, ?, ?, ?, ?, 400)`).run(GEMINI, status, fail, firstMs + 400, firstMs, inTok);
    for (const k of [1, 2, 4, 8, 16, 32]) for (let j = 0; j < 2; j++) add(1000 * k, 1000 + 50 * k); // 1 s, and 0.05 s more each thousand tokens
    forgetSpeeds();
    const s = speedOf(m(GEMINI));
    expect(s.latency).toBeCloseTo(1, 3);
    expect(s.perInput! * 1000).toBeCloseTo(0.05, 4);
    expect(secondsFor(m(GEMINI), 400, null, 100_000).seconds).toBeCloseTo(1 + 5 + 0.4, 1); // and 400 tokens at 1,000 a second
    expect(secondsFor(m(GEMINI), 400, null, 0).seconds).toBeCloseTo(1.4, 1);
    // A quarter of its last 20 tries failed busy: each costs its time again, so a quarter more.
    for (let i = 0; i < 5; i++) add(1000, 1000, "error", "busy");
    for (let i = 0; i < 3; i++) add(1000, 1000);
    forgetSpeeds();
    expect(speedOf(m(GEMINI)).fail).toBe(0.25);
    expect(secondsFor(m(GEMINI), 400, null, 0).seconds).toBeCloseTo((speedOf(m(GEMINI)).latency + 0.4) * 1.25, 5);
  });
});

describe("a balance of time and cost", () => {
  test("among models equally good and free, the quick one; cheapest keeps to price, then rating", () => {
    const a = { ...m(GEMINI), id: "x/slow-free", label: "Slow free" }, b = { ...m(GEMINI), id: "x/quick-free", label: "Quick free", ratings: { ...m(GEMINI).ratings, overall: (m(GEMINI).ratings.overall ?? 1400) - 5 } };
    const free = (x: any) => ({ ...x, input: 0, output: 0 });
    const usable = [free(a), free(b)];
    const time = (x: any) => ({ seconds: x.id === "x/slow-free" ? 120 : 3, measured: true });
    const msgs = [{ role: "user", content: "Hi" }];
    expect(pickModel(msgs, usable, "balanced", () => null, undefined, undefined, "cheapest", time)!.model.id).toBe("x/slow-free"); // same price: the better rated
    const p = pickModel(msgs, usable, "balanced", () => null, undefined, undefined, "balanced", time)!;
    expect(p.model.id).toBe("x/quick-free");
    expect(p.reason).toContain("the best balance of time and cost of the 2 within reach");
  });
  test("a paid model much quicker than a free one: the free one still wins unless it is far slower", () => {
    const free = { ...m(GEMINI), id: "x/free", input: 0, output: 0 }, paid = { ...m(GEMINI), id: "x/paid", input: 1, output: 4 };
    const msgs = [{ role: "user", content: "Hi" }];
    const pick = (freeSecs: number) => pickModel(msgs, [free, paid] as any, "balanced", () => null, undefined, undefined, "balanced", (x: any) => ({ seconds: x.id === "x/free" ? freeSecs : 2, measured: true }))!.model.id;
    expect(pick(8)).toBe("x/free"); // 4 times slower, at a tenth of its cost
    expect(pick(60)).toBe("x/paid"); // 30 times slower
  });
});
