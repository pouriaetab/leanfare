// 0.12, Settings: the level's knob (turned with the keys, or by picking what a number does), each app's dots, and the
// switches for the level and the review.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { settings } from "../src/settings";
import { ALL_TICKED, boot, reset } from "./app";
import { closeApp, openApp as open, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }

async function settingsPage() {
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  await waitFor(() => !!doc.querySelector(".lvknob"));
  return doc;
}
const knob = (doc: any) => doc.querySelector(".lvknob");
const byLabel = (doc: any, label: string) => doc.querySelector(`[aria-label="${label}"]`);

test("the knob shows the level with its name, and turns with the arrow keys and the number keys", async () => {
  const doc = await settingsPage();
  expect(knob(doc).getAttribute("role")).toBe("slider");
  expect(knob(doc).getAttribute("aria-valuenow")).toBe("2");
  expect(knob(doc).getAttribute("aria-valuetext")).toBe("2, Light");
  expect(knob(doc).textContent).toContain("Light");
  expect(doc.querySelector(".lv-defs li.on").textContent).toStartWith("2Light. Only big reads");
  knob(doc).dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await waitFor(() => settings().level === 3 && knob(doc)?.getAttribute("aria-valuenow") === "3");
  expect(settings().level).toBe(3);
  expect(knob(doc).getAttribute("aria-valuetext")).toBe("3, More");
  knob(doc).dispatchEvent(new win.KeyboardEvent("keydown", { key: "5", bubbles: true }));
  await waitFor(() => settings().level === 5);
  expect(settings().level).toBe(5);
  knob(doc).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await waitFor(() => settings().level === 1);
  expect(settings().level).toBe(1);
}, 30000);

test("picking what a number does sets it; each app keeps its own level with the dots, and goes back to the default", async () => {
  const doc = await settingsPage();
  byLabel(doc, "Level 4, Most").click();
  await waitFor(() => settings().level === 4);
  expect(settings().level).toBe(4);
  await waitFor(() => !!byLabel(doc, "Codex: 5, All it can"));
  byLabel(doc, "Codex: 5, All it can").click();
  await waitFor(() => settings().levels?.codex === 5);
  expect(settings().levels).toEqual({ codex: 5 });
  await waitFor(() => !!byLabel(doc, "Codex: use the default level"));
  const row = byLabel(doc, "Codex: use the default level").closest(".lv-app");
  expect(row.textContent).toContain("5 · All it can");
  byLabel(doc, "Codex: use the default level").click();
  await waitFor(() => !settings().levels?.codex);
  expect(settings().levels).toEqual({});
  await waitFor(() => !byLabel(doc, "Codex: use the default level"));
  expect([...doc.querySelectorAll(".lv-app")].find((r: any) => r.textContent.startsWith("Codex"))!.textContent).toContain("default (4)");
}, 30000);

test("the switches: raise when low, ask at each new chat, and the two for the review", async () => {
  const doc = await settingsPage();
  const sw = (label: string) => byLabel(doc, label);
  expect(sw("Raise it when my Claude plan runs low").getAttribute("aria-checked")).toBe("true");
  sw("Raise it when my Claude plan runs low").click();
  await waitFor(() => settings().raiseWhenLow === false);
  expect(settings().raiseWhenLow).toBe(false);
  await waitFor(() => sw("Raise it when my Claude plan runs low")?.getAttribute("aria-checked") === "false");
  sw("Ask me at the start of each new chat").click();
  await waitFor(() => settings().askEachChat === true);
  expect(settings().askEachChat).toBe(true);
  sw("Ask the app to review, grade and fix each answer").click();
  await waitFor(() => settings().review === false);
  expect(settings().review).toBe(false);
  await waitFor(() => !!sw("Claude Code grades every hand off before it finishes"));
  sw("Claude Code grades every hand off before it finishes").click();
  await waitFor(() => settings().reviewHook === false);
  expect(settings().reviewHook).toBe(false);
}, 30000);
