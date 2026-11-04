// Savings, compact (0.13.10; named and flat from 0.13.11): the sections sit in groups that open and close and keep how
// you left them, a closed one says its gist on its title line, and Free capacity lists several models to a row.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveSettings } from "../src/settings";
import { boot, keys, reset } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 9000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const KEYS = ["live", "free", "report", "month", "pay", "trial"];
const NAMES = ["Live activity", "Free capacity", "Usage report", "Monthly overview", "API spend", "Model trial"];

describe("Savings, compact", () => {
  test("named groups; the first four open at first, API spend and Model trial closed; each says its gist", async () => {
    const doc = await openApp(url, { screen: "savings" });
    const fold = (k: string) => doc.querySelector(`#tab-savings details.fold[data-fold="${k}"]`);
    await waitFor(() => !!fold("trial"));
    expect([...doc.querySelectorAll("#tab-savings details.fold")].map((d: any) => d.getAttribute("data-fold"))).toEqual(KEYS);
    expect(KEYS.map((k) => fold(k).querySelector(".fold-title").textContent)).toEqual(NAMES);
    expect(KEYS.map((k) => !!fold(k).open)).toEqual([true, true, true, true, false, false]);
    expect(fold("live").querySelector("#liveCard")).not.toBeNull();
    expect(fold("free").querySelector("#freeToday")).not.toBeNull();
    expect(fold("live").querySelector(".fold-gist").textContent).toBe("nothing running");
    // The month group says which month it shows (the current one unless another is picked), and API spend too.
    const month = new Date(2026, 9, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    expect(fold("month").querySelector(".fold-gist").textContent).toStartWith(`${month} · 0 tasks`);
    expect(fold("pay").querySelector(".fold-gist").textContent).toBe(`${month} · $0 · 0 answers`);
  }, 20000);

  test("Free capacity's title line says how many models are in use today", async () => {
    await keys("google", "groq");
    saveSettings({ providers: { google: { on: true, free: true }, groq: { on: true, free: true } }, ticked: ["google/gemini-3.8-flash", "groq/openai/gpt-oss-120b"] });
    const doc = await openApp(url, { screen: "savings" });
    const gist = () => doc.querySelector('#tab-savings details.fold[data-fold="free"] > summary .fold-gist')?.textContent ?? "";
    await waitFor(() => gist() !== "");
    expect(gist()).toBe("none of 2 models used yet today");
  }, 20000);

  test("a group keeps how you left it", async () => {
    const doc = await openApp(url, { screen: "savings" });
    const fold = (k: string) => doc.querySelector(`#tab-savings details.fold[data-fold="${k}"]`);
    await waitFor(() => !!fold("pay"));
    const pay = fold("pay"), free = fold("free");
    pay.open = true; pay.dispatchEvent(new doc.defaultView.Event("toggle"));
    free.open = false; free.dispatchEvent(new doc.defaultView.Event("toggle"));
    doc.querySelector('.tabs button[data-tab="chat"]').click();
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!fold("pay") && fold("pay") !== pay);
    expect(!!fold("pay").open).toBe(true);
    expect(!!fold("free").open).toBe(false);
  }, 20000);

  test("Free capacity: several models to a row, each on one small line", () => {
    const css = readFileSync(join(import.meta.dir, "..", "ui", "app.css"), "utf8");
    expect(css).toMatch(/\.ft-list \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(280px, 1fr\)\)[^}]*\}/);
    expect(css).toMatch(/\.ft-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 32px auto auto;[^}]*font-size: var\(--fs-tiny\);[^}]*\}/);
    expect(css).not.toMatch(/\.ft-tile/);
  });
});
