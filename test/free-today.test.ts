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
    await waitFor(() => !!doc.querySelector("#freeToday table"));
    const t = doc.querySelector("#freeToday").textContent;
    expect(t).toContain("Gemini 3.8 Flash");
    expect(t).toContain("20 of about 20");
    expect(t).toContain("back at");
  }, 30000);
});
