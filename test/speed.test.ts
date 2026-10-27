// Time as well as price: how long each model takes, measured from Leanfare's own ledger, the
// estimate's time, and Auto picking the cheapest, the fastest, or the cheapest within a time.
//
// The fixture, balanced, an everyday question: Gemini 3.8 Flash (1496), Claude Sonnet 4.6 (1472),
// Grok 4.20 Beta (1471) and Claude Sonnet 4.5 (1456) are within reach; Grok is the cheapest.
// Below, Gemini has answered in under a second and Grok in about half a minute; the Sonnets have
// no answers yet, so theirs is a rough guess of about 8 s.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { getModel } from "../src/data";
import { forgetSpeeds, guessSpeed, parseSpeed, secondsFor, secondsText, speedLabel, speedOf } from "../src/speed";
import { ALL_TICKED, boot, keys, ledger, post, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

// A past answer: its whole time, the time to its first words (null when it was not streamed), its length.
function answered(model: string, ms: number, firstMs: number | null, out: number, o: { effort?: string | null; status?: string } = {}) {
  db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, ms, first_ms, out_tokens, effort)
    VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'chat', ?, ?, 'listed', 'reported', ?, ?, ?, ?, ?)`)
    .run(model.split("/")[0], model, o.status ?? "ok", ms, firstMs, out, o.effort ?? null);
  forgetSpeeds();
}
const m = (id: string) => getModel(id)!;
function seed() {
  for (let i = 0; i < 3; i++) answered("google/gemini-3.8-flash", 700, 300, 400); // 0.3 s, then 1,000 tokens a second
  for (let i = 0; i < 3; i++) answered("xai/grok-4.20-beta", 29_000, 9_000, 400); // 9 s, then 20 tokens a second
}
const chat = (headers: Record<string, string> = {}) => post(`${url}/v1/chat/completions`, { model: "auto", messages: [{ role: "user", content: "What is the capital of Australia?" }] }, headers);

describe("how long a model takes", () => {
  test("measured from its last answers here: the wait for its first words, then how fast it wrote", () => {
    seed();
    expect(speedOf(m("google/gemini-3.8-flash"))).toEqual({ latency: 0.3, perSecond: 1000, measured: true, answers: 3 });
    expect(secondsFor(m("google/gemini-3.8-flash"), 400)).toEqual({ seconds: 0.7, measured: true });
    expect(secondsFor(m("xai/grok-4.20-beta"), 400).seconds).toBeCloseTo(29, 5);
  });
  test("fewer than three answers, or only failed ones: a rough guess, said as such", () => {
    answered("google/gemini-3.8-flash", 700, 300, 400);
    answered("google/gemini-3.8-flash", 700, 300, 400);
    answered("google/gemini-3.8-flash", 100, 50, 400, { status: "error" });
    const s = speedOf(m("google/gemini-3.8-flash"));
    expect(s.measured).toBe(false);
    expect(s).toEqual(guessSpeed(m("google/gemini-3.8-flash")));
  });
  test("answers that were not streamed have no first words time: their whole time stands in", () => {
    for (let i = 0; i < 3; i++) answered("openai/gpt-4.1", 5_000, null, 300);
    const s = speedOf(m("openai/gpt-4.1"));
    expect(s.measured).toBe(true);
    expect(s.perSecond).toBe(guessSpeed(m("openai/gpt-4.1")).perSecond); // no rate to measure
    expect(secondsFor(m("openai/gpt-4.1"), 300).seconds).toBeCloseTo(5, 5); // so the same answer takes the same time
  });
  test("at a thinking effort with three answers of its own, those count; otherwise all of them", () => {
    seed();
    for (let i = 0; i < 3; i++) answered("google/gemini-3.8-flash", 20_300, 20_000, 300, { effort: "high" });
    expect(speedOf(m("google/gemini-3.8-flash"), "high").latency).toBe(20);
    expect(speedOf(m("google/gemini-3.8-flash"), "low").measured).toBe(true); // none at low: all its answers
    expect(speedOf(m("google/gemini-3.8-flash"), "low").answers).toBe(6);
  });
  test("a new answer counts in the next estimate at once", async () => {
    await keys("google");
    for (let i = 0; i < 2; i++) answered("google/gemini-3.8-flash", 700, 300, 400);
    expect(speedOf(m("google/gemini-3.8-flash")).measured).toBe(false); // cached as a guess
    const r = await post(`${url}/v1/chat/completions`, { model: "google/gemini-3.8-flash", messages: [{ role: "user", content: "Hi [usage 100 400]" }] });
    expect(r.status).toBe(200);
    expect(speedOf(m("google/gemini-3.8-flash")).measured).toBe(true);
  });
  test("a rough guess by kind: hardware built for speed is quick, local models are slow to write, thinking waits longer", () => {
    const base = m("google/gemini-3.8-flash");
    expect(guessSpeed({ ...base, provider: "groq" }).perSecond).toBe(400);
    expect(guessSpeed({ ...base, local: true }).perSecond).toBe(30);
    const thinker = { ...base, skills: [...base.skills, "reasoning"] };
    expect(guessSpeed(thinker, "high").latency).toBeGreaterThan(guessSpeed(thinker, "low").latency);
    expect(guessSpeed(thinker).latency).toBeGreaterThan(guessSpeed(base).latency);
  });
  test("the words for a time and a choice", () => {
    expect(secondsText(0.7)).toBe("about a second");
    expect(secondsText(29.4)).toBe("about 29 s");
    expect(secondsText(400)).toBe("about 7 min");
    expect(speedLabel("cheapest")).toBe("Cheapest");
    expect(speedLabel(20)).toBe("Within 20 seconds");
    expect(speedLabel(300)).toBe("Within 5 minutes");
    expect([parseSpeed("fastest"), parseSpeed(" 30 "), parseSpeed(30.4), parseSpeed("0"), parseSpeed("fast"), parseSpeed(5000), parseSpeed(null)]).toEqual(["fastest", 30, 30, null, null, null, null]);
  });
});

describe("Auto picks by your speed, at the same quality", () => {
  test("the cheapest by default; every answer says about how long it should take", async () => {
    await keys("anthropic", "google", "xai");
    seed();
    const r = await chat();
    expect(r.headers.get("x-leanfare-model")).toBe("xai/grok-4.20-beta");
    expect(Number(r.headers.get("x-leanfare-estimate-seconds"))).toBeCloseTo(29, 0);
  });
  test("x-leanfare-speed: fastest takes the quickest, and the reason says how long", async () => {
    await keys("anthropic", "google", "xai");
    seed();
    const r = await chat({ "x-leanfare-speed": "fastest" });
    expect(r.headers.get("x-leanfare-model")).toBe("google/gemini-3.8-flash");
    expect(r.headers.get("x-leanfare-estimate-seconds")).toBe("0.7");
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("It is the fastest of the 4 within reach: about a second.");
  });
  test("x-leanfare-speed in seconds: the cheapest expected within that time", async () => {
    await keys("anthropic", "google", "xai");
    seed();
    expect((await chat({ "x-leanfare-speed": "10" })).headers.get("x-leanfare-model")).toBe("google/gemini-3.8-flash"); // Grok's 29 s is too long; Gemini is cheaper than the Sonnets
    expect((await chat({ "x-leanfare-speed": "60" })).headers.get("x-leanfare-model")).toBe("xai/grok-4.20-beta"); // all in time: the cheapest
    expect((await chat({ "x-leanfare-speed": "soon" })).headers.get("x-leanfare-model")).toBe("xai/grok-4.20-beta"); // not a speed: your setting
    expect(ledger().filter((l) => l.source === "openai").map((l) => l.status)).toEqual(["ok", "ok", "ok"]);
  });
  test("Settings keep your speed: cheapest, fastest, or 1 to 3600 seconds", async () => {
    await keys("anthropic", "google", "xai");
    seed();
    expect((await ui(url, "/api/settings", { speed: "fastest" })).json.settings.speed).toBe("fastest");
    expect((await chat()).headers.get("x-leanfare-model")).toBe("google/gemini-3.8-flash");
    expect((await ui(url, "/api/settings", { speed: "45" })).json.settings.speed).toBe(45);
    const bad = await ui(url, "/api/settings", { speed: "quick" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("speed must be cheapest, fastest, or a number of seconds from 1 to 3600");
    expect((await ui(url, "/api/state")).json.settings.speed).toBe(45);
  });
  test("the estimate shows the time, and the cheapest and fastest at the same quality", async () => {
    await keys("anthropic", "google", "xai");
    seed();
    const body = { messages: [{ role: "user", content: "What is the capital of Australia?" }], model: "auto" };
    const e = (await ui(url, "/api/estimate", body)).json;
    expect(e.plan.model.id).toBe("xai/grok-4.20-beta");
    expect(e.plan.seconds).toBeCloseTo(29, 5);
    expect(e.plan.secondsMeasured).toBe(true);
    expect(e.plan.speed).toBe("cheapest");
    expect(e.plan.choices.cheapest).toMatchObject({ id: "xai/grok-4.20-beta", measured: true });
    expect(e.plan.choices.fastest).toMatchObject({ id: "google/gemini-3.8-flash", seconds: 0.7, measured: true });
    expect(e.plan.choices.fastest.estimate).toBeGreaterThan(e.plan.choices.cheapest.estimate);
    const fast = (await ui(url, "/api/estimate", { ...body, speed: "fastest" })).json;
    expect(fast.plan.model.id).toBe("google/gemini-3.8-flash");
    expect(fast.plan.speed).toBe("fastest");
    // A model you name is that model: no choices to offer.
    const named = (await ui(url, "/api/estimate", { ...body, model: "anthropic/claude-sonnet-4-6" })).json;
    expect(named.plan.choices).toBeNull();
    expect(named.plan.secondsMeasured).toBe(false);
    expect(ledger()).toHaveLength(6); // only the six above: estimates send nothing
  });
  test("the delegate takes a speed too, and its receipt says how long it took", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    seed();
    const r = await ui(url, "/api/delegate", { task: "What is the capital of Australia?", effort: "medium", check: "never", speed: "fastest" });
    expect(r.status).toBe(200);
    expect(r.json.model.id).toBe("google/gemini-3.8-flash");
    expect(r.json.seconds).toBeGreaterThan(0);
    expect(r.json.receipt).toContain(`It took ${secondsText(r.json.seconds)}.`);
    const bad = await ui(url, "/api/delegate", { task: "x", speed: "whenever" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("speed must be cheapest, fastest, or a number of seconds");
  });
});

describe("what one kind of work learns stays with it", () => {
  test("the trial's one word answers and the checks' verdicts do not make chat estimates short", async () => {
    await keys("anthropic", "google", "xai");
    const body = { messages: [{ role: "user", content: "What is the capital of Australia?" }], model: "google/gemini-3.8-flash" };
    const before = (await ui(url, "/api/estimate", body)).json.estimate;
    for (const source of ["trial", "check", "delegate"]) for (let i = 0; i < 6; i++)
      db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, task, price_status, usage_status, status, ms, first_ms, out_tokens)
        VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', ?, 'google', 'google/gemini-3.8-flash', 'overall', 'listed', 'reported', 'ok', 900, 300, 3)`).run(source);
    const { forgetHistoryCache } = await import("../src/engine");
    forgetHistoryCache();
    expect((await ui(url, "/api/estimate", body)).json.estimate).toBe(before);
  });
});

describe("speed within a budget", () => {
  test("when the fastest would pass the budget, Auto takes another model at the same quality before a weaker one", async () => {
    await reset({ ticked: ALL_TICKED, budget: 1, atLimit: "cheapest", speed: "fastest" });
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    seed();
    // Spent so far: just under the budget, so Gemini's reservation (up to its longest answer) does not fit, but Grok's does.
    const { reserveFor } = await import("../src/engine");
    const gemini = reserveFor(m("google/gemini-3.8-flash"), 40, null, 1);
    const grok = reserveFor(m("xai/grok-4.20-beta"), 40, null, 1);
    expect(grok).toBeLessThan(gemini);
    db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, cost) VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'chat', 'openai', 'openai/gpt-5-mini', 'listed', 'reported', 'ok', ?)`).run(1 - (gemini + grok) / 2);
    const { resetBudget } = await import("../src/budget");
    resetBudget();
    const r = await chat();
    expect(r.headers.get("x-leanfare-model")).toBe("xai/grok-4.20-beta"); // not DeepSeek, 58 points under the best
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("so Auto took Grok 4.20 Beta, at the same quality.");
  });
});
