// Free and paid apart, and the free models' daily allowances (allowance.ts, 0.13): a paid only model on a free key is
// never picked, a free model whose allowance for today is used is left out until its reset (Pacific midnight for Google,
// with the clock change counted), a smaller allowance is learned from a rate limit, and a model failing most of its tries
// today, or starting its answers only after minutes, is unsteady and left out while another can take the work.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { allowanceOf, forgetAllowances, lastReset, needsCredit, nextReset, notNowWhy, today, unsteady, usedUp } from "../src/allowance";
import { db } from "../src/db";
import { runChat, usableModels } from "../src/engine";
import { saveSettings } from "../src/settings";
import { setNow } from "../src/util";
import { boot, keys, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash";
const NOW = Date.parse("2026-10-21T12:00:00Z"); // the tests' clock: 05:00 in Pacific summer time
beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset(); forgetAllowances(); });
let n = 0;
function tried(model: string, f: Record<string, unknown> = {}, ago = 0) {
  const ts = new Date(NOW - ago * 1000 - n++).toISOString();
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), source: "delegate", provider: model.split("/")[0], model, auto: 1, in_tokens: 100, cached: 0, cache_write: 0, out_tokens: 10, cost: 0, list_cost: 0, price_status: "listed", usage_status: "reported", status: "ok", ms: 2000, first_ms: 1500, ...f };
  const k = Object.keys(row);
  db.query(`INSERT INTO ledger(${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
}

describe("free and paid apart", () => {
  test("a paid only model on a key marked as a free plan needs credit; with billing (the box unticked) it does not", () => {
    const argon = { id: "google/gemini-4-argon", provider: "google" }, pro = { id: "google/gemini-3.1-pro-preview", provider: "google" }, lite = { id: "google/gemini-3.5-flash-lite", provider: "google" };
    saveSettings({ providers: { google: { on: true, free: true } } });
    expect([needsCredit(argon), needsCredit(pro), needsCredit(lite)]).toEqual([true, true, false]);
    expect(notNowWhy(argon)).toBe("needs credit: your key is on a free plan, which does not include it");
    saveSettings({ providers: { google: { on: true, free: false } } });
    expect(needsCredit(argon)).toBe(false);
  });

  test("the allowances known: Gemini Flash about 20 a day and Flash-Lite about 500 on a free key, Groq 1,000 a model, OpenRouter's free models 50 in all", () => {
    saveSettings({ providers: { google: { on: true, free: true }, groq: { on: true, free: true } } });
    expect(allowanceOf({ id: GEMINI, provider: "google" })).toMatchObject({ perDay: 20, scope: "model", resets: "pacific" });
    expect(allowanceOf({ id: "google/gemini-3.5-flash-lite", provider: "google" })).toMatchObject({ perDay: 500, resets: "pacific" });
    expect(allowanceOf({ id: "groq/openai/gpt-oss-120b", provider: "groq" })).toMatchObject({ perDay: 1000, scope: "model", resets: "utc" });
    expect(allowanceOf({ id: "openrouter/qwen/qwen3-coder:free", provider: "openrouter" })).toMatchObject({ perDay: 50, scope: "provider" });
    expect(allowanceOf({ id: "openrouter/openai/gpt-5-mini", provider: "openrouter" })).toBeNull(); // a paid model there
    saveSettings({ providers: { google: { on: true, free: false } } });
    expect(allowanceOf({ id: GEMINI, provider: "google" })).toBeNull(); // a key with billing: Google's paid limits, not these
  });

  test("Pacific midnight, also on the day the clocks go back (1 Nov 2026 has 25 hours there)", () => {
    expect(new Date(lastReset("pacific", Date.parse("2026-10-21T12:00:00Z"))).toISOString()).toBe("2026-10-21T07:00:00.000Z");
    expect(new Date(lastReset("pacific", Date.parse("2026-11-01T16:00:00Z"))).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(new Date(nextReset("pacific", Date.parse("2026-11-01T16:00:00Z"))).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(new Date(lastReset("pacific", Date.parse("2026-11-01T06:30:00Z"))).toISOString()).toBe("2026-10-31T07:00:00.000Z");
    expect(new Date(lastReset("utc", Date.parse("2026-11-01T16:00:00Z"))).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("the daily allowance", () => {
  test("a free model that used its allowance today is left out until its reset, and Auto picks a model with room left", async () => {
    await reset({ ticked: [GEMINI, DEEPSEEK], mode: "best" });
    await keys("google", "deepseek");
    saveSettings({ providers: { google: { on: true, free: true } } });
    for (let i = 0; i < 19; i++) tried(GEMINI, {}, 60 * (i + 1));
    tried(GEMINI, {}, 25 * 3600); // yesterday's: not counted
    forgetAllowances();
    expect(today({ id: GEMINI, provider: "google" })).toMatchObject({ perDay: 20, used: 19, left: 1, learned: null, resets: "2026-10-22T07:00:00.000Z" });
    expect(usableModels().map((m) => m.id)).toContain(GEMINI);
    tried(GEMINI, {}, 10);
    forgetAllowances();
    expect(usedUp({ id: GEMINI, provider: "google" })).toBe(true);
    expect(usableModels().map((m) => m.id)).toEqual([DEEPSEEK]);
    const r = await runChat([{ role: "user", content: "Hi" }], "auto", new AbortController().signal, () => {});
    expect(r.meta.model.id).toBe(DEEPSEEK);
    setNow("2026-10-22T07:30:00Z"); // after Pacific midnight: a new day's allowance
    forgetAllowances();
    expect(usedUp({ id: GEMINI, provider: "google" })).toBe(false);
  });

  test("a rate limit before the known number teaches a smaller allowance (the fewest answers before one on a day, 3 or more)", () => {
    saveSettings({ providers: { google: { on: true, free: true } } });
    for (let i = 0; i < 12; i++) tried(GEMINI, {}, 2 * 86_400 + 60 * (20 - i)); // two days ago: 12 answers, then a limit
    tried(GEMINI, { status: "error", fail: "limit", error: "429 rate limited" }, 2 * 86_400);
    tried(GEMINI, {}, 60); tried(GEMINI, { status: "error", fail: "limit", error: "429" }, 30); // today: 1 answer, then a limit (a minute's limit, not the day's)
    forgetAllowances();
    expect(today({ id: GEMINI, provider: "google" })).toMatchObject({ perDay: 12, learned: 12, used: 1, left: 11 });
  });

  test("when every model that could take it used its allowance, the answer says so and when it comes back", async () => {
    await reset({ ticked: [GEMINI], mode: "best" });
    await keys("google");
    saveSettings({ providers: { google: { on: true, free: true } } });
    for (let i = 0; i < 20; i++) tried(GEMINI, {}, 60 * (i + 1));
    forgetAllowances();
    const r = await runChat([{ role: "user", content: "Hi" }], "auto", new AbortController().signal, () => {}).catch((e) => e);
    expect(String(r?.message ?? r?.meta?.error ?? "")).toContain("Gemini 3.8 Flash: its free allowance for today is used (20 of about 20), until 07:00 UTC. The work stays with your app until then, or tick another model.");
  });
});

describe("unsteady models", () => {
  test("half or more of its last tries today failed: unsteady, left out while another can take the work, with a note", async () => {
    await reset({ ticked: [GEMINI, DEEPSEEK], mode: "best" });
    await keys("google", "deepseek");
    for (let i = 0; i < 8; i++) tried(GEMINI, i % 4 === 0 ? {} : { status: "error", fail: i % 2 ? "busy" : "limit", error: "busy" }, 600 * (i + 1));
    forgetAllowances();
    expect(unsteady(GEMINI)).toEqual({ why: "6 of its last 8 tries today failed" });
    const r = await runChat([{ role: "user", content: "Hi" }], "auto", new AbortController().signal, () => {});
    expect(r.meta.model.id).toBe(DEEPSEEK);
  });

  test("answers that start after minutes: unsteady; a fast one is not", () => {
    for (let i = 0; i < 5; i++) tried(GEMINI, { first_ms: 194_000, ms: 197_000 }, 900 * (i + 1));
    for (let i = 0; i < 5; i++) tried(DEEPSEEK, { first_ms: 2100 }, 900 * (i + 1));
    forgetAllowances();
    expect(unsteady(GEMINI)).toEqual({ why: "its answers started after about 3 minutes lately" });
    expect(unsteady(DEEPSEEK)).toBeNull();
  });
});
