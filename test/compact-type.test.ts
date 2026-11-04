// Type as Claude Desktop sets it, and a compact Savings (0.13.12): every size is one of six, the in-chat cards use the
// same ones, the report shows one view at a time, and a heading's or a switch's longer words are on hover or under it
// after one press of its i.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { forgetLive } from "../src/live";
import { boot, reset } from "./app";
import { closeApp, openApp, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
// No calls from another test file in Live (it would draw them as they fade), and the hooks get a test's 20 seconds.
beforeEach(async () => {
  await reset();
  forgetLive();
  db.query("INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance, app, app_model, grade) VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'longer_query', 'read', 'low', 'google/gemini-3.8-flash', 0, 1, 20000, 300, 'ok', 0, 'Claude', 'claude-opus-5-5', 'good')").run();
}, 20000);
afterEach(closeApp, 20000);
async function waitFor(ok: () => boolean, ms = 9000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

describe("type as Claude Desktop sets it", () => {
  test("the scale: one title a screen, section titles, text, secondary text, small labels, and chat messages", () => {
    const css = read("ui", "app.css");
    expect(css).toContain("--fs-title: 22px; --fs-head: 15px; --fs-body: 14px; --fs-small: 13px; --fs-tiny: 12px; --fs-chat: 16px;");
    expect(css).toContain("--fw-head: 520; --fw-label: 450;");
    expect(css).toMatch(/body \{[^}]*font: var\(--fs-body\)\/1\.43 var\(--font\);/);
  });

  test("every size in the stylesheet is on the scale, but a chat's headings and code (sized to the message) and a phone's fields", () => {
    const css = read("ui", "app.css");
    const off = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim()).filter((v) => !/^var\(--fs-(title|head|body|small|tiny|chat)\)$/.test(v));
    expect(off.sort()).toEqual(["0.9em", "1.125em", "1.25em", "16px", "1em"]);
    const weights = [...css.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect([...new Set(weights)].sort()).toEqual(["400", "var(--fw-head)", "var(--fw-label)"]);
  });

  test("the cards Leanfare shows inside the apps' chats use the same sizes", () => {
    for (const f of ["reportapp.ts", "planapp.ts", "liveapp.ts"]) {
      const src = read("src", f);
      expect(src).toContain('font: 14px/1.43 system-ui, -apple-system, "Segoe UI", sans-serif');
      const sizes = [...src.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
      expect(sizes.every((x) => [12, 13, 14, 15].includes(x))).toBe(true);
    }
  });
});

describe("Savings, compact", () => {
  test("the report in four views, one at a time; the one picked stays", async () => {
    const doc = await openApp(url, { screen: "savings" });
    await waitFor(() => !!doc.querySelector("#reportCard .rp-views"));
    const tabs = () => [...doc.querySelectorAll("#reportCard .rp-views [role='tab']")] as any[];
    const shown = () => [...doc.querySelectorAll("#reportCard .rp-view")].filter((v: any) => !v.hidden).map((v: any) => v.dataset.view);
    expect(tabs().map((b) => b.textContent)).toEqual(["Overview", "Prompts", "Models", "Quality"]);
    expect(shown()).toEqual(["overview"]);
    expect(doc.querySelector('#reportCard .rp-view[data-view="overview"] .rp-tiles')).not.toBeNull();
    expect(doc.querySelector('#reportCard .rp-view[data-view="prompts"] #rpAsk')).not.toBeNull();
    tabs()[2].click();
    expect(shown()).toEqual(["models"]);
    expect(tabs().map((b) => b.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
    expect(win.localStorage.getItem("leanfare.report:view")).toBe('"models"'); // kept: the report opens on it next time
  }, 30000);

  test("a card's longer words: on its title's hover, and under it after one press of its i", async () => {
    const doc = await openApp(url, { screen: "savings" });
    await waitFor(() => !!doc.querySelector("#reportCard .rp-chart"));
    const head = [...doc.querySelectorAll("#reportCard h3")].find((x: any) => x.textContent.startsWith("Tokens over time")) as any;
    expect(head.title).toContain("What Leanfare's models read so your apps did not");
    const i = head.querySelector(".tip-i");
    expect(i.getAttribute("role")).toBe("button");
    expect(head.nextElementSibling?.classList.contains("tip-pop")).toBe(false);
    i.click();
    expect(head.nextElementSibling.classList.contains("tip-pop")).toBe(true);
    expect(head.nextElementSibling.textContent).toBe(head.title);
    i.click();
    expect(head.nextElementSibling?.classList.contains("tip-pop")).toBe(false);
  }, 20000);
});

describe("Settings, compact", () => {
  test("a switch's line under it waits behind its i; a card's first paragraph too", async () => {
    const doc = await openApp(url, { screen: "settings" });
    await waitFor(() => !!doc.querySelector("#tab-settings .lv-setting .swrow"));
    const row = [...doc.querySelectorAll("#tab-settings .swrow")].find((r: any) => r.textContent.includes("Raise it when my Claude plan runs low")) as any;
    const note = row.querySelector(".sw-text small");
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe("Low: at least 4. Very low: 5. A level set for one chat stays as it was set.");
    row.querySelector(".tip-i").click();
    expect(note.hidden).toBe(false);
    const level = doc.querySelector("#tab-settings .lv-setting");
    const first = level.querySelector(":scope > h3").nextElementSibling;
    expect([first.tagName, first.hidden, first.classList.contains("tip-pop")]).toEqual(["P", true, true]);
    expect(level.querySelector(":scope > h3").title).toContain('say "Leanfare 4" in it');
    // the levels: each a line; what the picked one does, in words; the others, on hover
    const says = [...level.querySelectorAll(".lv-defs li")].map((li: any) => [li.classList.contains("on"), !!li.querySelector(".say"), li.querySelector(".d").title.length > 0]);
    expect(says.every(([, s, t]) => s && t)).toBe(true);
  }, 20000);
});
