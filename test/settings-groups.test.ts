// Settings in groups that open and close (0.13): every card sits in a group, the everyday groups are open and the rest
// closed, a group is remembered as you leave it, and a card's longer explanations fold behind a Details line.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { boot, reset } from "./app";
import { closeApp, openApp as open, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); try { win?.localStorage?.clear(); } catch {} });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const groups = (doc: any) => [...doc.querySelectorAll("#tab-settings details.group")].map((d: any) => `${d.querySelector("summary").textContent}${d.open ? " (open)" : ""}`);

describe("Settings in groups", () => {
  test("the groups, the everyday ones open, and every card inside one", async () => {
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => doc.querySelectorAll("#tab-settings details.group").length > 5);
    expect(groups(doc)).toEqual([
      "Models and keys (open)", "Models on this computer",
      "Your apps and AI plans (open)", "How much Leanfare does (open)", "Budget and plans", "How models are picked", "Quality checks", "What is kept", "More",
    ]);
    const all = doc.querySelectorAll("#tab-settings .setting").length;
    const inside = doc.querySelectorAll("#tab-settings details.group .setting").length;
    expect(inside).toBe(all);
    expect(doc.querySelectorAll("#tab-settings .section-title").length).toBe(0); // the groups' names are the only headings
    const apps = doc.querySelector('#tab-settings details.group[data-group="apps"]');
    expect(apps.querySelector("#appsSetting")).not.toBeNull();
    expect(apps.querySelector("#codexCard")).not.toBeNull();
    expect(doc.querySelector('#tab-settings details.group[data-group="money"] #budgetSetting')).not.toBeNull();
  }, 20000);

  test("a group opened stays open after the page redraws, and long explanations fold behind Details", async () => {
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector('#tab-settings details.group[data-group="money"]'));
    const money = () => doc.querySelector('#tab-settings details.group[data-group="money"]');
    expect(money().open).toBe(false);
    money().open = true; money().dispatchEvent(new win.Event("toggle"));
    doc.querySelector('.tabs button[data-tab="chat"]').click();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!money()?.open);
    expect(money().open).toBe(true);
    const budget = doc.querySelector("#budgetSetting");
    const folded = budget.querySelector(":scope > details.more");
    expect(folded).not.toBeNull();
    expect(folded.textContent).toContain("Before each request goes out, Leanfare reserves the most it can cost");
  }, 20000);
});
