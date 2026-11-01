// The share planner (share.ts, 0.13): the parts of each kind expected today, the chance a scarce strong model runs out
// before its reset, and the mode it picks: save strong (keep that model for what it is clearly best at), fastest first
// for someone waiting, spread evenly when some are near their allowance; and Auto's line about it in a hand off.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { forgetAllowances } from "../src/allowance";
import { db } from "../src/db";
import { saveSettings } from "../src/settings";
import { dayLeft, demand, forgetShare, overChance, shareFor } from "../src/share";
import { boot, keys, reset, ui } from "./app";

const NOW = Date.parse("2026-10-21T12:00:00Z"); // the tests' clock: a Wednesday, 05:00 in Pacific summer time
const G = { id: "google/gemini-3.8-flash", provider: "google", label: "Gemini 3.8 Flash" } as any; // about 20 a day on a free key
const L = { id: "google/gemini-3.5-flash-lite", provider: "google", label: "Gemini 3.5 Flash-Lite" } as any; // about 500
const O = { id: "ollama/qwen3.5:9b", provider: "ollama", label: "qwen3.5:9b" } as any; // on this computer: no allowance
// Gemini 3.8 Flash is clearly better at working things out (50 points), not at reading (10).
const ratingFor = (m: any, k: string) => (m.id === G.id ? (k === "reason" ? 1500 : 1460) : 1450);
const noFirst = () => null;
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); forgetAllowances(); forgetShare(); saveSettings({ providers: { google: { on: true, free: true } } }); });
let n = 0;
function handed(kind: string, agoSeconds: number) {
  const ts = new Date(NOW - agoSeconds * 1000 - n++).toISOString();
  db.query("INSERT INTO delegations(ts, month, day, task, kind, effort, files, file_tokens, answer_tokens, status, chance) VALUES (?, ?, ?, 'overall', ?, 'medium', 0, 0, 0, 'ok', 0)").run(ts, ts.slice(0, 7), ts.slice(0, 10), kind);
}
function tried(model: string, agoSeconds: number, first = 1500) {
  const ts = new Date(NOW - agoSeconds * 1000 - n++).toISOString();
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), source: "delegate", provider: model.split("/")[0], model, auto: 1, in_tokens: 100, cached: 0, cache_write: 0, out_tokens: 10, cost: 0, list_cost: 0, price_status: "listed", usage_status: "reported", status: "ok", ms: first + 500, first_ms: first };
  const k = Object.keys(row);
  db.query(`INSERT INTO ledger(${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
}
// 14 days of 10 readings and 12 workings out a day, spread over the hours.
function history() { for (let d = 1; d <= 14; d++) for (let i = 0; i < 22; i++) handed(i < 10 ? "read" : "reason", d * 86_400 - i * 3000); }

describe("what the share planner expects", () => {
  test("P(N > k) for a Poisson count", () => {
    expect(overChance(2, 1)).toBeCloseTo(1 - 2.5 / Math.E, 6);
    expect(overChance(5, 0)).toBe(0);
    expect(overChance(-1, 3)).toBe(1);
  });
  test("parts of each kind on a day like today, from the last 14 days, and the share of the day still to come", () => {
    history();
    forgetShare();
    const d = demand(NOW);
    expect(d.read).toBeCloseTo(10, 0);
    expect(d.reason).toBeCloseTo(12, 0);
    expect(d.write).toBe(0);
    expect(dayLeft("pacific", NOW)).toBeGreaterThan(0.5); // 05:00 in Pacific time: most of the day's parts are to come
  });
});

describe("the mode for a part", () => {
  test("save strong: Gemini 3.8 Flash, with few left and many workings out expected, is kept for them; a reading goes elsewhere", () => {
    history();
    for (let i = 0; i < 15; i++) tried(G.id, 600 * (i + 1)); // 15 of about 20 used today: 5 left
    forgetShare(); forgetAllowances();
    const read = shareFor("read", [G, L], true, ratingFor, noFirst, NOW);
    expect(read.mode).toBe("save");
    expect([...read.leaveOut]).toEqual([G.id]);
    expect(read.why).toMatch(/^Saving Gemini 3\.8 Flash for reason \(5 left, about \d+ expected, \d+% chance to run out\)$/);
    expect(shareFor("reason", [G, L], true, ratingFor, noFirst, NOW).leaveOut.size).toBe(0); // what it is kept for
  });
  test("plenty left and little expected: nothing is saved", () => {
    handed("reason", 86_400);
    forgetShare();
    expect(shareFor("read", [G, L], false, ratingFor, noFirst, NOW)).toMatchObject({ mode: "spread", why: null });
  });
  test("fastest first, for someone waiting: a model much slower to start is left out", () => {
    const first = (m: any) => (m.id === O.id ? 60_000 : 2_000);
    const s = shareFor("read", [L, O], true, ratingFor, first, NOW);
    expect(s).toMatchObject({ mode: "fast", why: "Fastest first: you are waiting on this one" });
    expect([...s.leaveOut]).toEqual([O.id]);
    expect(shareFor("read", [L, O], false, ratingFor, first, NOW).leaveOut.size).toBe(0); // a plan's part in the background
  });
  test("spread evenly: a model with under a quarter of its allowance left is spared while another has over half", () => {
    for (let i = 0; i < 17; i++) tried(G.id, 600 * (i + 1)); // 3 of 20 left
    forgetAllowances();
    const s = shareFor("write", [G, L], false, ratingFor, noFirst, NOW);
    expect(s.mode).toBe("spread");
    expect([...s.leaveOut]).toEqual([G.id]);
  });
});

describe("in a hand off", () => {
  test("Auto spares a free model near its daily allowance while another free one has room, and the receipt says so", async () => {
    await reset({ ticked: [G.id, "groq/openai/gpt-oss-120b"], mode: "best" });
    await keys("google", "groq");
    saveSettings({ providers: { google: { on: true, free: true }, groq: { on: true, free: true } } });
    for (let i = 0; i < 17; i++) tried(G.id, 600 * (i + 1)); // 3 of about 20 left today
    forgetAllowances();
    const r = await ui(url, "/api/delegate", { task: "Draft a two line note about the release.", files: [], kind: "write", effort: "low", check: "never", app: "Claude", max_tokens: 1000 }); // within Groq's free 8,000 tokens a minute
    expect(r.status).toBe(200);
    expect(r.json.model.id).toBe("groq/openai/gpt-oss-120b");
    expect(r.json.receipt).toContain("Spreading the work: some models are near their daily allowance.");
  });
  test("it never sends work to a paid model to spare a free one", async () => {
    await reset({ ticked: [G.id, "deepseek/deepseek-v4-flash"], mode: "best" });
    await keys("google", "deepseek");
    saveSettings({ providers: { google: { on: true, free: true } } });
    for (let i = 0; i < 17; i++) tried(G.id, 600 * (i + 1));
    forgetAllowances();
    const s = shareFor("write", [G, { id: "deepseek/deepseek-v4-flash", provider: "deepseek", label: "DeepSeek V4 Flash" } as any], false, ratingFor, noFirst, NOW);
    expect(s.leaveOut.size).toBe(0);
  });
});
