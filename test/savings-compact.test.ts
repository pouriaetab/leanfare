// Savings, compact (0.13.10): the sections sit in groups that open and close and keep how you left them, a closed one
// says its gist on its title line, and Free models today has one line a model.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boot, reset } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 9000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const KEYS = ["now", "report", "month", "pay", "trial"];

describe("Savings, compact", () => {
  test("Now, Report and the month open at first; Pay per use and the trial closed; each says its gist", async () => {
    const doc = await openApp(url, { screen: "savings" });
    const fold = (k: string) => doc.querySelector(`#tab-savings details.fold[data-fold="${k}"]`);
    await waitFor(() => !!fold("trial"));
    expect([...doc.querySelectorAll("#tab-savings details.fold")].map((d: any) => d.getAttribute("data-fold"))).toEqual(KEYS);
    expect(KEYS.map((k) => !!fold(k).open)).toEqual([true, true, true, false, false]);
    expect(fold("now").querySelector("#liveCard")).not.toBeNull();
    expect(fold("now").querySelector("#freeToday")).not.toBeNull();
    expect(fold("now").querySelector(".fold-gist").textContent).toContain("nothing running");
    expect(fold("pay").querySelector(".fold-gist").textContent).toBe("what your keys and credits spent: $0, 0 answers");
  }, 20000);

  test("a group keeps how you left it", async () => {
    const doc = await openApp(url, { screen: "savings" });
    const fold = (k: string) => doc.querySelector(`#tab-savings details.fold[data-fold="${k}"]`);
    await waitFor(() => !!fold("pay"));
    const pay = fold("pay"), now = fold("now");
    pay.open = true; pay.dispatchEvent(new doc.defaultView.Event("toggle"));
    now.open = false; now.dispatchEvent(new doc.defaultView.Event("toggle"));
    doc.querySelector('.tabs button[data-tab="chat"]').click();
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!fold("pay") && fold("pay") !== pay);
    expect(!!fold("pay").open).toBe(true);
    expect(!!fold("now").open).toBe(false);
  }, 20000);

  test("Free models today is one line a model: the name, a thin bar, the count and when it resets", () => {
    const css = readFileSync(join(import.meta.dir, "..", "ui", "app.css"), "utf8");
    expect(css).toMatch(/\.ft-row \{[^}]*grid-template-columns: minmax\(0, 240px\) 72px 72px minmax\(0, 1fr\)[^}]*\}/);
    expect(css).not.toMatch(/\.ft-tile/);
  });
});
