// The manager's grades on the screens: the Plan tab grades a part's answer (Good, Partly, Wrong) and says who
// graded it; Settings lists how the models did for you and gives a moved down model another chance.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { addGrade, movedDown, standings } from "../src/grades";
import { forgetPlans, gradePart } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, outgoing, reset } from "./app";
import { closeApp, openApp as open } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { forgetPlans(); await reset({ ticked: ALL_TICKED }); await keys("openai", "google", "deepseek"); outgoing.length = 0; });
afterEach(() => { fake.hooks.answer = null; closeApp(); });
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const buttons = (doc: any, within: string) => (doc.querySelector(within) ? [...doc.querySelector(within).querySelectorAll("button")] : []) as any[];
const press = (doc: any, text: string, within: string) => buttons(doc, within).find((b) => b.textContent === text)?.click();
const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
const runIds = () => [...new Set(outgoing.filter((u) => u.includes("/api/plan/run?id=")).map((u) => decodeURIComponent(u.split("id=")[1])))];

describe("the Plan tab", () => {
  test("a part's answer: who graded it, and Good, Partly or Wrong from you (a grade again replaces it)", async () => {
    // Two parts: reading answers at once; drafting takes a while, so the plan still runs (and the page polls)
    // when the app you work in grades the first.
    fake.hooks.answer = (p) => (p.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Read the logs", kind: "read", effort: "low", needs: [], size: "small", task: "Find the errors in the logs." },
      { title: "Sum them up", kind: "write", effort: "low", needs: [1], size: "small", task: "Write two lines on the errors. [slow 4000]" },
    ] }) : null);
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="plan"]').click();
    await waitFor(() => !!doc.querySelector("#tab-plan textarea"));
    doc.querySelector("#tab-plan textarea[aria-label='What do you want to do?']").value = "Find out why the nightly job fails";
    doc.querySelector("#tab-plan input[aria-label='Split by rules']").checked = false;
    doc.querySelector("#planGo").click();
    await waitFor(() => !!doc.querySelector("#planResult"));
    press(doc, "Run Leanfare's parts", "#planResult");
    await waitFor(() => buttons(doc, "#planResult .grade-row").length === 3, 10000);
    const row = () => doc.querySelector("#planResult .grade-row");
    expect(row().textContent).toContain("How good was it?");
    expect(buttons(doc, "#planResult .grade-row").map((b) => b.textContent)).toEqual(["Good", "Partly", "Wrong"]);
    // The app you work in grades it (its grade tool): the next look at the plan says so.
    await waitFor(() => runIds().length > 0, 4000);
    gradePart(runIds()[0], 1, "good", "manager");
    await waitFor(() => !!row()?.textContent.includes("Claude Code graded it good."), 4000);
    expect(row().textContent).toContain("Claude Code graded it good.");
    // You grade it again: yours replaces it.
    press(doc, "Partly", "#planResult .grade-row");
    await waitFor(() => !!row()?.textContent.includes("You graded it partly."));
    expect(row().textContent).toContain("You graded it partly.");
    expect(buttons(doc, "#planResult .grade-row").find((b) => b.textContent === "Partly").getAttribute("aria-pressed")).toBe("true");
    expect(toasts(doc)).toContain("for reading: 1 partly of its last 1");
    expect(standings().map((s) => [s.kind, s.n, s.partly])).toEqual([["read", 1, 1]]);
  }, 30000);
});

describe("Settings: how the models did for you", () => {
  const card = (doc: any) => doc.querySelector("#gradesCard");
  const goSettings = async (doc: any, until: string) => {
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!card(doc)?.textContent.includes(until));
  };
  test("no grades yet", async () => {
    const doc = await open(url);
    await goSettings(doc, "No grades yet.");
    expect(card(doc).textContent).toContain("Leanfare keeps only the grade, never the words.");
    expect(card(doc).textContent).toContain("No grades yet.");
  }, 20000);
  test("each model and kind with its grades; a moved down one gets another chance", async () => {
    for (let i = 0; i < 3; i++) addGrade({ model: "openai/gpt-5-mini", kind: "write", effort: "low", verdict: "wrong", source: "manager" });
    addGrade({ model: "deepseek/deepseek-v4-flash", kind: "read", effort: "low", verdict: "good", source: "you" });
    const doc = await open(url);
    await goSettings(doc, "GPT-5 mini · drafting");
    const rows = [...card(doc).querySelectorAll(".lrow")] as any[];
    expect(rows.map((r) => r.querySelector(".nm").textContent)).toEqual(["GPT-5 mini · drafting", "DeepSeek V4 Flash · reading"]); // the moved down first
    expect(rows[0].textContent).toContain("0 good, 0 partly, 3 wrong");
    expect(rows[0].textContent).toContain("moved down");
    expect(rows[1].textContent).toContain("1 good, 0 partly, 0 wrong");
    expect(buttons(doc, "#gradesCard").map((b) => b.textContent)).toEqual(["Give it another chance"]);
    press(doc, "Give it another chance", "#gradesCard");
    await waitFor(() => !card(doc)?.textContent.includes("GPT-5 mini"));
    expect(card(doc).textContent).not.toContain("GPT-5 mini");
    expect(movedDown("openai/gpt-5-mini", "write")).toBe(false);
    expect(toasts(doc)).toContain("GPT-5 mini is picked again for drafting.");
  }, 20000);
});
