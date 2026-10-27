// The months picked for a plan in Settings survive a background redraw.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { ALL_TICKED, boot, reset, ui } from "./app";
import { closeApp, openApp as open, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const set = (el: any, v: string) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };

test("the months picked for a plan survive a background redraw of Settings, as its name and price do", async () => {
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  await waitFor(() => !!doc.querySelector("input[aria-label='Claude plan name']"));
  set(doc.querySelector("input[aria-label='Claude plan name']"), "Claude Max 20x");
  set(doc.querySelector("input[aria-label='Claude plan price a month']"), "200");
  const since = doc.querySelector("select[aria-label='Claude plan since']");
  since.value = "2026-07";
  since.dispatchEvent(new win.Event("change", { bubbles: true }));
  doc.activeElement?.blur?.();
  const first = doc.querySelector("select[aria-label='Claude plan since']");
  await ui(url, "/api/settings", { updateCheck: false }); // anything that changes the state the page polls (another window, another app)
  await waitFor(() => doc.querySelector("select[aria-label='Claude plan since']") !== first, 6000); // the next poll redraws Settings
  const redrawn = doc.querySelector("select[aria-label='Claude plan since']") !== first;
  const name = doc.querySelector("input[aria-label='Claude plan name']").value;
  const month = doc.querySelector("select[aria-label='Claude plan since']").value;
  [...doc.querySelectorAll(".plan-row button")].find((b: any) => b.textContent === "Save")!.click();
  await Bun.sleep(600);
  const saved = (await ui(url, "/api/state")).json.settings.plans.claude;
  expect(month).toBe("2026-07");
}, 30000);
