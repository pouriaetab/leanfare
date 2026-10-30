// Models a key has no quota for (quota.ts, 0.11): Google's free tier answers every request for Gemini 4 Argon with 429
// and "limit: 0". Such a model is left out of Auto, plans, checks and side by side, until a new key, Try again, or two
// weeks; a model you name is still asked; the report and Settings say why.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { runChat, usableModels } from "../src/engine";
import { modelStats } from "../src/modelstats";
import { NO_QUOTA, clearNoQuota, noQuota, noQuotaText, noteRefusal } from "../src/quota";
import { setNow } from "../src/util";
import { boot, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";
import { KEYS } from "./fake";

// The test catalogue has one Google model: it stands for Gemini 4 Argon here.
const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash", GROK = "xai/grok-4.20-beta";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); });
afterEach(closeApp);
let n = 0;
// A try as the ledger keeps it, at the test clock's time less some seconds.
function tried(model: string, f: Record<string, unknown> = {}, ago = 0) {
  const ts = new Date(Date.parse("2026-10-21T12:00:00Z") - ago * 1000 - n++).toISOString();
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), source: "delegate", provider: model.split("/")[0], model, auto: 1, in_tokens: 100, cached: 0, cache_write: 0, out_tokens: 0, cost: 0, list_cost: 0, price_status: "listed", usage_status: "reported", status: "error", ms: 300, ...f };
  const k = Object.keys(row);
  db.query(`INSERT INTO ledger(${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
}
const DAY = 86_400;

describe("when a key has no quota for a model", () => {
  test("the provider says its limit is 0: left out after that one try; Auto picks another; a model you name is still asked", async () => {
    await reset({ ticked: [GEMINI, DEEPSEEK], mode: "best" });
    await keys("google", "deepseek");
    const first = await runChat([{ role: "user", content: "Hi [quota0@google]" }], "auto", new AbortController().signal, () => {});
    expect([first.status, first.meta.model.id]).toEqual(["ok", DEEPSEEK]); // Gemini answered 429, so Auto passed it on
    expect(noQuota(GEMINI)).toMatchObject({ model: GEMINI, provider: "google", why: "said", tries: 1 });
    expect(usableModels().map((m) => m.id)).toEqual([DEEPSEEK]);
    expect(noQuotaText(noQuota(GEMINI)!, "Google Gemini")).toBe("Gemini 3.8 Flash is left out: your Google Gemini key has no quota for it (Google Gemini said its limit is 0)");
    const next = await runChat([{ role: "user", content: "Hi again [quota0@google]" }], "auto", new AbortController().signal, () => {});
    expect(next.meta.model.id).toBe(DEEPSEEK); // not asked first any more
    expect((db.query("SELECT model, status FROM ledger WHERE model = ?").all(GEMINI) as any[]).length).toBe(1);
    const named = await runChat([{ role: "user", content: "Hi" }], GEMINI, new AbortController().signal, () => {});
    expect([named.status, named.meta.model.id]).toEqual(["ok", GEMINI]);
  });
  test("every try refused as rate limited, 4 or more on 2 or more days, none answered: left out; fewer, one day, or one answer: not", () => {
    for (let i = 0; i < 3; i++) tried(GEMINI, { fail: "limit" }, i * DAY);
    noteRefusal(GEMINI, "google", "fake failure 429", "limit");
    expect(noQuota(GEMINI)).toBeNull(); // 3 tries
    for (let i = 0; i < 6; i++) tried(GROK, { fail: "limit" }, i * 60);
    noteRefusal(GROK, "xai", "fake failure 429", "limit");
    expect(noQuota(GROK)).toBeNull(); // all in one day: a busy spell, not a missing quota (it rests instead)
    tried(GEMINI, { fail: "limit" }, 3 * DAY);
    tried(GEMINI, { status: "ok", out_tokens: 40 }, 4 * DAY); // it answered once in 30 days
    noteRefusal(GEMINI, "google", "fake failure 429", "limit");
    expect(noQuota(GEMINI)).toBeNull();
    db.exec(`DELETE FROM ledger WHERE model = '${GEMINI}' AND status = 'ok'`);
    noteRefusal(GEMINI, "google", null, null); // the kind from its words is not a rate limit
    expect(noQuota(GEMINI)).toBeNull();
    noteRefusal(GEMINI, "google", "Google Gemini says too many requests or the plan's limit is reached: x.", null);
    expect(noQuota(GEMINI)).toMatchObject({ why: "refused", tries: 4 });
    expect(noQuotaText(noQuota(GEMINI)!, "Google Gemini")).toBe("Gemini 3.8 Flash is left out: your Google Gemini key has no quota for it: all 4 tries in 30 days were refused as rate limited, and none answered");
    noteRefusal(DEEPSEEK, "ollama", "limit: 0", "limit"); // never a model on this computer
  });
  test("Try again clears it, from the page's address; so does a new key for its provider; and two weeks later it gets one more try", async () => {
    noteRefusal(GEMINI, "google", "limit: 0", "limit");
    expect((await ui(url, "/api/quota/clear", { model: GEMINI })).json.cleared).toBe(true);
    expect(noQuota(GEMINI)).toBeNull();
    expect((await ui(url, "/api/quota/clear", {})).status).toBe(400);
    noteRefusal(GEMINI, "google", "limit: 0", "limit");
    expect((await ui(url, "/api/keys", { provider: "google", key: KEYS.google })).json.ok).toBe(true); // a key saved again for Google
    expect(noQuota(GEMINI)).toBeNull();
    noteRefusal(GEMINI, "google", "limit: 0", "limit");
    expect(clearNoQuota({ provider: "deepseek" })).toBe(0);
    setNow(new Date(Date.parse("2026-10-21T12:00:00Z") + NO_QUOTA.keep + 1000).toISOString());
    expect(noQuota(GEMINI)).toBeNull();
  });
  test("every model you ticked for it left out: the error says which, and what to do", async () => {
    await reset({ ticked: [GEMINI] });
    await keys("google");
    noteRefusal(GEMINI, "google", "limit: 0", "limit");
    const r = await runChat([{ role: "user", content: "Hi" }], "auto", new AbortController().signal, () => {});
    expect(r.status).toBe("error");
    expect(r.meta.error).toBe("Gemini 3.8 Flash is left out: your Google Gemini key has no quota for it (Google Gemini said its limit is 0). Tick another model, or press Try again next to it in Settings.");
  });
  test("a plan's part named for it goes to Auto, and the receipt says why", async () => {
    await reset({ ticked: [GEMINI, DEEPSEEK] });
    await keys("google", "deepseek");
    noteRefusal(GEMINI, "google", "limit: 0", "limit");
    const r = await runDelegate({ task: "Say hello.", files: [], kind: "write", effort: "low", check: "never", maxOut: 2000, model: GEMINI, plan: "abc:1" } as any, new AbortController().signal);
    expect(r.model.id).toBe(DEEPSEEK);
    expect(r.receipt).toContain("The plan named Gemini 3.8 Flash, but your Google Gemini key has no quota for it (Google Gemini said its limit is 0), so Auto picked another.");
  });
});

describe("where it shows", () => {
  test("the report lists it first, with why and Try again; Settings says it under the model", async () => {
    await reset({ ticked: [GEMINI, DEEPSEEK] });
    await keys("google", "deepseek");
    tried(DEEPSEEK, { status: "ok", out_tokens: 300, ms: 9000, first_ms: 1500 }, 100);
    for (let i = 0; i < 4; i++) tried(GEMINI, { fail: "limit" }, i * DAY);
    noteRefusal(GEMINI, "google", null, "limit");
    const rows = modelStats({ from: Date.parse("2026-10-10T00:00:00Z"), to: Date.parse("2026-10-21T12:00:01Z") });
    expect(rows.map((m) => [m.id, !!m.noQuota])).toEqual([[GEMINI, true], [DEEPSEEK, false]]);
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#reportCard .sp-table tr.noquota"); i++) await Bun.sleep(50);
    const row = doc.querySelector("#reportCard .sp-table tr.noquota");
    expect(row.querySelector("td.now").textContent).toBe("left outYour Google Gemini key has no quota for it: all 4 tries in 30 days were refused as rate limited, and none answered. Auto leaves it out until you try it again or add another key.Try again");
    row.querySelector("td.now button").click();
    for (let i = 0; i < 100 && noQuota(GEMINI); i++) await Bun.sleep(30);
    expect(noQuota(GEMINI)).toBeNull();
    noteRefusal(GEMINI, "google", "limit: 0", "limit");
    const page = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 100 && !page.querySelector(".prov-head"); i++) await Bun.sleep(50);
    ([...page.querySelectorAll(".prov-head")].find((x: any) => x.querySelector(".name")?.textContent === "Google Gemini") as any).click();
    for (let i = 0; i < 100 && !page.querySelector(".mrow.noquota"); i++) await Bun.sleep(50);
    const mrow = page.querySelector(".mrow.noquota");
    expect(mrow.textContent).toContain("left out: your Google Gemini key has no quota for it (Google Gemini said its limit is 0)");
    mrow.querySelector("button").click();
    for (let i = 0; i < 100 && noQuota(GEMINI); i++) await Bun.sleep(30);
    expect(noQuota(GEMINI)).toBeNull();
  });
});
