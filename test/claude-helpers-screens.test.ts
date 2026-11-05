// 0.15, Settings, Claude's own models: the order llmledger's catalogue gives today, each kind's pick, the switches and
// your caps for the strongest one.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getModel, setExtraModels, type Model } from "../src/data";
import { settings } from "../src/settings";
import { ALL_TICKED, boot, reset } from "./app";
import { closeApp, openApp as open, win } from "./dom";

const CLAUDE = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "claude-models.json"), "utf8")).models as Model[]);
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); setExtraModels(CLAUDE.filter((m) => !getModel(m.id)), new Set(["anthropic"])); });
afterEach(async () => { await closeApp(); setExtraModels([], new Set(["anthropic"])); });
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }

async function card() {
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  await waitFor(() => !!doc.querySelector("#claudeModelsSetting .cm-table"));
  return doc;
}

test("the order today, each kind's pick, and the switches", async () => {
  const doc = await card();
  const el = doc.querySelector("#claudeModelsSetting");
  expect(el.querySelector("h3").textContent).toBe("Claude's own models");
  const rows = [...el.querySelectorAll(".cm-table tbody tr")].map((tr: any) => [...tr.querySelectorAll("td")].map((td: any) => td.textContent));
  expect(rows).toEqual([
    ["Claude Fable 5.1", "1503", "$10 / $50"],
    ["Claude Opus 5.5", "1509", "$4 / $20"],
    ["Claude Sonnet 5.5", "1478", "$2 / $10"],
    ["Claude Haiku 5.5", "1425", "$0.1 / $0.5"],
    ["Claude Mythos 5.1", "not rated yet", "$10 / $50"],
  ]);
  expect(el.querySelector(".cm-picks").textContent).toBe("The hardest parts and final checks: Claude Fable 5.1 · High effort: Claude Opus 5.5 · Medium effort: Claude Sonnet 5.5 · Light code: Claude Haiku 5.5 · Light reading: Claude Sonnet 5.5");
  expect(el.querySelector(".fine").textContent).toBe("No helpers today yet.");

  const sw = (label: string) => doc.querySelector(`#claudeModelsSetting [aria-label="${label}"]`);
  expect(sw("Leanfare sets each helper's model").getAttribute("aria-checked")).toBe("true");
  sw("The strongest one for the hardest parts and final checks").click();
  await waitFor(() => settings().claudeHelpers?.top === false);
  expect(settings().claudeHelpers).toEqual({ on: true, top: false, topUntil: 80, topPerDay: 20, starts: "once" });
  // With the strongest turned off, the hardest parts show the next strongest.
  await waitFor(() => !!doc.querySelector(".cm-picks")?.textContent.startsWith("The hardest parts and final checks: Claude Opus 5.5"));
  expect(doc.querySelector(".cm-picks").textContent).toStartWith("The hardest parts and final checks: Claude Opus 5.5");
});

test("your caps for the strongest one: the week's percent and how many a day", async () => {
  const doc = await card();
  const box = (label: string) => doc.querySelector(`#claudeModelsSetting input[aria-label="${label}"]`);
  expect(box("Week used, at most (percent)").value).toBe("80");
  expect(box("Helpers on the strongest model a day, at most").value).toBe("20");
  const set = (el: any, v: string) => { el.value = v; el.dispatchEvent(new win.Event("change", { bubbles: true })); };
  set(box("Week used, at most (percent)"), "65");
  await waitFor(() => settings().claudeHelpers?.topUntil === 65);
  expect(settings().claudeHelpers?.topUntil).toBe(65);
  set(box("Helpers on the strongest model a day, at most"), "500000"); // past 1,000: not saved
  await Bun.sleep(300);
  expect(settings().claudeHelpers?.topPerDay).toBe(20);
  doc.querySelector(`#claudeModelsSetting [aria-label="Leanfare sets each helper's model"]`).click();
  await waitFor(() => settings().claudeHelpers?.on === false);
  expect(settings().claudeHelpers).toEqual({ on: false, top: true, topUntil: 65, topPerDay: 20, starts: "once" });
});

// 0.15.1: Cowork can ask before each helper starts, so you choose how many a plan asks for.
test("Helpers: one per part, one per prompt (the default) or none, saved with one press", async () => {
  const doc = await card();
  const seg = doc.querySelector('#claudeModelsSetting .seg[aria-label="Helpers for a plan\'s parts"]');
  const buttons = () => [...seg.querySelectorAll("button")].map((b: any) => [b.textContent, b.getAttribute("aria-pressed")]);
  expect(buttons()).toEqual([["One per part", "false"], ["One per prompt", "true"], ["None", "false"]]);
  expect(doc.querySelector("#claudeModelsSetting .cm-starts + .note").textContent).toStartWith("Cowork can ask you before each helper starts.");
  [...seg.querySelectorAll("button")].find((b: any) => b.textContent === "None").click();
  await waitFor(() => settings().claudeHelpers?.starts === "never");
  expect(settings().claudeHelpers).toEqual({ on: true, top: true, topUntil: 80, topPerDay: 20, starts: "never" });
  await waitFor(() => doc.querySelector('#claudeModelsSetting .seg[aria-label="Helpers for a plan\'s parts"] button[aria-pressed="true"]')?.textContent === "None");
  expect(doc.querySelector('#claudeModelsSetting .seg[aria-label="Helpers for a plan\'s parts"] button[aria-pressed="true"]').textContent).toBe("None");
});
