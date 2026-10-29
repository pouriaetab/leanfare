// Free plans (freeplans.ts, 0.10): Groq's and Mistral's free keys next to Google's. Said in Settings, their answers
// count as $0; Mistral's free plan may train on what is sent, said so and kept from your files when Settings says;
// and Groq's free plan takes only work that fits its tokens a minute, the rest going to another model.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { runChat } from "../src/engine";
import { fitsFree, freeCap, onFreePlan } from "../src/freeplans";
import { platformsView, readRisk } from "../src/platforms";
import { saveSettings } from "../src/settings";
import { boot, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const GROQ = "groq/openai/gpt-oss-120b", MISTRAL = "mistral/mistral-large-4", DEEPSEEK = "deepseek/deepseek-v4-flash";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); });
afterEach(closeApp);

describe("a free plan, said in Settings", () => {
  test("its answers count as $0; without it, at the list price", async () => {
    await reset({ ticked: [GROQ] });
    await keys("groq");
    await runChat([{ role: "user", content: "Hi [usage 2000 500]" }], GROQ, new AbortController().signal, () => {});
    saveSettings({ providers: { groq: { on: true, free: true } } });
    await runChat([{ role: "user", content: "Hi [usage 2000 500]" }], GROQ, new AbortController().signal, () => {});
    const rows = db.query("SELECT cost, price_status FROM ledger ORDER BY id").all() as any[];
    expect(rows[0].price_status).toBe("listed");
    expect(rows[0].cost).toBeGreaterThan(0);
    expect(rows[1]).toEqual({ cost: 0, price_status: "free plan" });
  });
  test("only providers with a free plan: Google, Groq and Mistral", () => {
    saveSettings({ providers: { groq: { on: true, free: true }, mistral: { on: true, free: true }, deepseek: { on: true, free: true } as any, google: { on: true, free: true } } });
    expect(["google", "groq", "mistral", "deepseek"].map(onFreePlan)).toEqual([true, true, true, false]);
  });
  test("Mistral's may train on what is sent: said so, and kept from your files when Settings says not to a free tier", () => {
    saveSettings({ providers: { mistral: { on: true, free: true } } });
    expect(readRisk({ provider: "mistral", free: false } as any)).toBe("its company may train on it");
    expect(readRisk({ provider: "groq", free: false } as any)).toBeNull();
    saveSettings({ providers: { mistral: { on: true, free: false } } });
    expect(readRisk({ provider: "mistral", free: false } as any)).toBeNull();
  });
  test("the page has the switch for each", async () => {
    await keys("groq", "mistral", "google");
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 100 && !doc.querySelector(".prov-head"); i++) await Bun.sleep(50);
    for (const name of ["Groq", "Mistral", "Google Gemini"]) {
      const head = [...doc.querySelectorAll(".prov-head")].find((x: any) => x.querySelector(".name")?.textContent === name) as any;
      head.click();
      await Bun.sleep(30);
    }
    for (let i = 0; i < 100 && !doc.body.textContent.includes("My Groq key is on the free plan"); i++) await Bun.sleep(50);
    const text = doc.body.textContent;
    expect(text).toContain("My Groq key is on the free plan (count its answers as $0; work above 8,000 tokens a minute goes to another model)");
    expect(text).toContain("My Mistral key is on the free Experiment plan (count its answers as $0; Mistral may train on what is sent)");
    expect(text).toContain("My Google key is on the free plan (count its answers as $0)");
  });
});

describe("Groq's free plan takes only what fits its tokens a minute", () => {
  test("8,000 tokens a minute, the answer included", () => {
    saveSettings({ providers: { groq: { on: true, free: true } } });
    expect(freeCap({ provider: "groq" })).toBe(8000);
    expect(fitsFree({ provider: "groq" }, 3 * 6000, 2000)).toBe(true);
    expect(fitsFree({ provider: "groq" }, 3 * 6001, 2000)).toBe(false);
    expect(fitsFree({ provider: "deepseek" }, 3 * 100_000, 2000)).toBe(true);
    saveSettings({ providers: { groq: { on: true, free: false } } });
    expect(freeCap({ provider: "groq" })).toBeNull(); // a paid key: its own, larger limits
  });
  test("a hand off too big for it goes to another model; a small one may go there", async () => {
    await reset({ ticked: [GROQ, DEEPSEEK], providers: { groq: { on: true, free: true } } as any });
    await keys("groq", "deepseek");
    const big = { name: "big.log", text: "line of the log\n".repeat(2500) }; // about 13k tokens
    const r1 = await runDelegate({ task: "List the errors.", files: [big], kind: "read", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal);
    expect(r1.model.id).toBe(DEEPSEEK);
    const r2 = await runDelegate({ task: "List the errors.", files: [{ name: "a.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal);
    expect(r2.model.id).toBe(GROQ); // free, and good enough for this
    expect(r2.cost).toBe(0);
  });
  test("Settings' list of platforms says how it is used today", async () => {
    await reset({ ticked: [GROQ] });
    await keys("groq");
    saveSettings({ providers: { groq: { on: true, free: true } } });
    await runChat([{ role: "user", content: "Hi" }], GROQ, new AbortController().signal, () => {});
    const v = await platformsView();
    expect(v.rows.find((r) => r.id === "groq")).toMatchObject({ limit: "Free plan: 1 request through Leanfare today; at most 8k tokens a minute, so bigger work goes to another model.", risk: null });
    void ui;
  });
});
