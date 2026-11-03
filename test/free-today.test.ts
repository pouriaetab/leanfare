// The Live view one press away (0.13): while anything runs, the running pill at the top opens Savings on the Live card.
// And Free models today on Savings: each ticked model with a daily allowance, its day so far and when it comes back.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { forgetAllowances } from "../src/allowance";
import { db } from "../src/db";
import { draw } from "../src/delegate";
import { forgetLive } from "../src/live";
import { saveSettings } from "../src/settings";
import { forgetShare } from "../src/share";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp as open } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); forgetLive(); forgetAllowances(); forgetShare(); draw.next = () => 0.5; });
afterEach(closeApp);
async function waitFor(ok: () => boolean | Promise<boolean>, ms = 9000) { for (let i = 0; i < ms / 50 && !(await ok()); i++) await Bun.sleep(50); }

describe("the Live view, one press away", () => {
  test("while a hand off runs, the pill at the top says so and opens Savings on the Live card", async () => {
    await keys("deepseek");
    const doc = await open(url);
    const run = ui(url, "/api/delegate", { task: "Find the errors. [slow 9000] [usage 2000 500]", files: [{ name: "app.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "low", check: "never", app: "Claude" });
    await waitFor(() => !!doc.querySelector("#runningPill .live-link") && !doc.querySelector("#runningPill").hidden, 15000); // the page reads the state every 4 seconds
    expect(doc.querySelector("#runningPill .live-link").textContent).toBe("1 running · Live");
    doc.querySelector("#runningPill .live-link").click();
    await waitFor(() => !!doc.querySelector("#tab-savings.on #liveCard"));
    expect(doc.querySelector("#tab-savings").classList.contains("on")).toBe(true);
    await run;
  }, 40000);
});

describe("Free models today", () => {
  test("each ticked model with a daily allowance: used today, when it comes back, and the expected parts", async () => {
    await keys("google");
    saveSettings({ providers: { google: { on: true, free: true } } });
    const ts = (ago: number) => new Date(Date.parse("2026-10-21T12:00:00Z") - ago * 1000).toISOString();
    for (let i = 0; i < 20; i++) {
      const t = ts(600 * (i + 1));
      db.query("INSERT INTO ledger(ts, month, day, source, provider, model, auto, in_tokens, cached, cache_write, out_tokens, cost, list_cost, price_status, usage_status, status, ms, first_ms) VALUES (?, ?, ?, 'delegate', 'google', 'google/gemini-3.8-flash', 1, 100, 0, 0, 10, 0, 0, 'listed', 'reported', 'ok', 2000, 1500)").run(t, t.slice(0, 7), t.slice(0, 10));
    }
    forgetAllowances();
    const v = (await ui(url, "/api/share")).json;
    expect(v.pools).toEqual([expect.objectContaining({ id: "google/gemini-3.8-flash", perDay: 20, used: 20, left: 0, resets: "2026-10-22T07:00:00.000Z" })]);
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#freeToday .ft-row"));
    const tile = doc.querySelector("#freeToday .ft-row");
    expect(tile.querySelector(".ft-name").textContent).toBe("Gemini 3.8 Flash");
    expect(tile.querySelector(".ft-count").textContent).toBe("20/20");
    expect(tile.querySelector(".ft-sub").textContent).toStartWith("used up · back at");
    expect(tile.getAttribute("title")).toContain("20 used of its free limit of about 20 a day. It resets at midnight Pacific");
    expect(doc.querySelector("#freeToday .ft-sum").textContent).toBe("1 in use");
  }, 30000);
});

// Compact (0.13.2; one line a model from 0.13.10): the five most used show at first, "+N more in use" adds the rest that
// were used, Show all adds the ones not used yet, and nothing used is one quiet line.
describe("Free models today, compact", () => {
  test("nothing used yet: one line; the used ones one line each, the most used first; Show all adds the idle ones, dimmed", async () => {
    const GEM = "google/gemini-3.8-flash", OSS = "groq/openai/gpt-oss-120b";
    await keys("google", "groq");
    saveSettings({ providers: { google: { on: true, free: true }, groq: { on: true, free: true } }, ticked: [GEM, OSS] });
    forgetAllowances();
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#freeToday .ft-sum"));
    expect(doc.querySelector("#freeToday .ft-sum").textContent).toBe("none used yet");
    expect(doc.querySelector("#freeToday").textContent).toContain("None used yet today. Each limit is a day's, and resets by itself.");
    expect(doc.querySelectorAll("#freeToday .ft-row").length).toBe(0);
    const ts = new Date(Date.parse("2026-10-21T12:00:00Z") - 60_000).toISOString();
    const answer = (provider: string, model: string) => db.query("INSERT INTO ledger(ts, month, day, source, provider, model, auto, in_tokens, cached, cache_write, out_tokens, cost, list_cost, price_status, usage_status, status, ms, first_ms) VALUES (?, ?, ?, 'delegate', ?, ?, 1, 100, 0, 0, 10, 0, 0, 'listed', 'reported', 'ok', 2000, 1500)").run(ts, ts.slice(0, 7), ts.slice(0, 10), provider, model);
    for (let i = 0; i < 3; i++) answer("groq", OSS);
    forgetAllowances();
    const names = () => [...doc.querySelectorAll("#freeToday .ft-name")].map((x: any) => x.textContent);
    doc.querySelector('.tabs button[data-tab="chat"]').click();
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => doc.querySelectorAll("#freeToday .ft-row").length > 0);
    expect(names()).toEqual(["GPT-OSS 120B"]); // only the used one
    expect(doc.querySelector("#freeToday .ft-count").textContent).toBe("3/1,000");
    expect(doc.querySelector("#freeToday .ft-sub").textContent).toStartWith("a day · resets");
    expect(doc.querySelector("#freeToday .ft-sum").textContent).toBe("1 in use");
    ([...doc.querySelectorAll("#freeToday .ft-link")].find((b: any) => b.textContent === "Show all 2") as any).click();
    expect(doc.querySelectorAll("#freeToday .ft-row").length).toBe(2);
    expect(doc.querySelectorAll("#freeToday .ft-row.idle").length).toBe(1); // Gemini, not used yet, dimmed and last
    expect(doc.querySelectorAll("#freeToday .ft-row")[1].classList.contains("idle")).toBe(true);
    for (let i = 0; i < 5; i++) answer("google", GEM);
    forgetAllowances(); forgetShare();
    doc.querySelector('.tabs button[data-tab="chat"]').click();
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => doc.querySelectorAll("#freeToday .ft-row.idle").length === 0 && doc.querySelectorAll("#freeToday .ft-row").length === 2);
    expect(doc.querySelector("#freeToday .ft-name").textContent).toBe("Gemini 3.8 Flash"); // the most used first
    expect(doc.querySelectorAll("#freeToday .ft-link").length).toBe(0); // both in use: Show all or less would change nothing
    expect(doc.querySelectorAll("#freeToday .ft-row").length).toBe(2);
    expect(doc.querySelector("#freeToday .ft-sum").textContent).toBe("2 in use");
  }, 40000);
});
