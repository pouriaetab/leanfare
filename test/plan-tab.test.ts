// The Plan tab while parts run: Stop, a new plan, and typing in the task box.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, keys, outgoing, reset } from "./app";
import { closeApp, openApp as open, win } from "./dom";
import { runView } from "../src/planner";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
const openApp = () => open(url);
const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const press = (doc: any, text: string, within = "body") => [...doc.querySelector(within).querySelectorAll("button")].find((b: any) => b.textContent === text)?.click();
const hasButton = (doc: any, text: string, within = "#planResult") => !!doc.querySelector(within) && [...doc.querySelector(within).querySelectorAll("button")].some((b: any) => b.textContent === text);
const goPlan = async (doc: any) => {
  doc.querySelector('.tabs button[data-tab="plan"]').click();
  await waitFor(() => !!doc.querySelector("#tab-plan textarea"));
};
async function makePlan(doc: any, task: string) {
  doc.querySelector("#tab-plan textarea[aria-label='What do you want to do?']").value = task;
  doc.querySelector("#tab-plan input[aria-label='Split by rules']").checked = true;
  const before = doc.querySelector("#planResult");
  doc.querySelector("#planGo").click();
  await waitFor(() => !!doc.querySelector("#planResult") && doc.querySelector("#planResult") !== before && doc.querySelector("#planResult").textContent.includes(task.slice(0, 20)));
}
const runIds = () => [...new Set(outgoing.filter((u) => u.includes("/api/plan/run?id=")).map((u) => decodeURIComponent(u.split("id=")[1])))];

beforeEach(async () => { await reset({ ticked: ALL_TICKED }); await keys("openai", "google", "deepseek"); outgoing.length = 0; });

describe("the Plan tab while parts run", () => {
  test("after Stop, the page never says the parts are done", async () => {
    const doc = await openApp();
    await goPlan(doc);
    await makePlan(doc, "Fix the failing tests in the parser [slow 2500]");
    press(doc, "Run Leanfare's parts", "#planResult");
    await waitFor(() => hasButton(doc, "Stop"));
    await Bun.sleep(300);
    press(doc, "Stop", "#planResult");
    const seen = new Set<string>(); // every toast shown, as they come and go
    const look = () => { for (const t of toasts(doc).split(" | ")) if (t) seen.add(t.replace(/✕$/, "").trim()); return false; };
    await waitFor(() => (look(), seen.has("Stopped.")));
    await waitFor(() => (look(), seen.has("Leanfare's parts are done.")), 10000);
    expect(seen.has("Stopped.")).toBe(true);
    expect(seen.has("Leanfare's parts are done.")).toBe(false);
  }, 30000);

  test("a new plan made while one runs stops the old run", async () => {
    const doc = await openApp();
    await goPlan(doc);
    await makePlan(doc, "Fix the failing tests in the parser [slow 5000]");
    press(doc, "Run Leanfare's parts", "#planResult");
    await waitFor(() => hasButton(doc, "Stop"));
    await waitFor(() => runIds().length > 0, 4000); // the first poll names the run
    const first = runIds()[0];
    await makePlan(doc, "Write the release notes for the parser");
    await Bun.sleep(500);
    const old = runView(first);
    const stopOnPage = hasButton(doc, "Stop");
    expect(old?.running && !stopOnPage).toBe(false);
  }, 30000);

  test("typing in the task box while parts run: the box keeps its focus", async () => {
    const doc = await openApp();
    await goPlan(doc);
    await makePlan(doc, "Fix the failing tests in the parser [slow 4000]");
    press(doc, "Run Leanfare's parts", "#planResult");
    await waitFor(() => hasButton(doc, "Stop"));
    const ta = doc.querySelector("#tab-plan textarea[aria-label='What do you want to do?']");
    ta.focus();
    const focusedBefore = doc.activeElement === ta;
    await Bun.sleep(1800); // one poll
    expect(focusedBefore).toBe(true);
    expect(doc.activeElement === ta).toBe(true);
  }, 30000);
});
