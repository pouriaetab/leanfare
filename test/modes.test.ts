// Plan modes (modes.ts, 0.11): how much of your Claude plan is left and how fast you use it set how hard Leanfare
// pushes work out of it: plenty, low (70% used, or running out before it resets at this week's pace), very low (90%).
// Nothing is stopped: what Claude is told, when big reads are reminded, and where a plan's parts go.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePlan } from "../src/planner";
import { planMode, runsOutAt } from "../src/modes";
import { readReminder, readsFile } from "../src/readhook";
import { hookLine, saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const T = (iso: string) => Date.parse(iso); // the test clock: 2026-10-21T12:00:00Z, a Wednesday
const WEEK_RESETS = T("2026-10-25T12:00:00Z"); // Sunday
const snap = (at: string, week: number, five: number | null = null) => saveSnap({ at: T(at), five: five === null ? null : { used: five, resets: T("2026-10-21T15:00:00Z") }, week: { used: week, resets: WEEK_RESETS } });
const dir = mkdtempSync(join(tmpdir(), "leanfare-modes-"));
let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); closeApp(); });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  rmSync(readsFile(), { force: true });
  await reset({ ticked: ALL_TICKED });
});

describe("the mode", () => {
  test("plenty, low at 70% used, very low at 90%; not known without numbers", () => {
    expect(planMode()).toMatchObject({ mode: "plenty", why: "your Claude plan's use is not known yet" });
    snap("2026-10-21T11:00:00Z", 50);
    expect(planMode()).toMatchObject({ mode: "plenty", why: "your Claude plan has plenty left: the week 50% used" });
    snap("2026-10-21T11:10:00Z", 74);
    expect(planMode()).toMatchObject({ mode: "low", why: "your Claude plan is running low: the week 74% used" });
    snap("2026-10-21T11:20:00Z", 75, 92);
    expect(planMode()).toMatchObject({ mode: "very low", why: "your Claude plan is very low: the 5 hours 92% used, the week 75% used" });
  });
  test("running out before it resets, at this week's pace: low, with the day it runs out", () => {
    snap("2026-10-19T12:00:00Z", 10); // Monday
    snap("2026-10-21T11:00:00Z", 60); // Wednesday: 50 points in 47 hours, so 100% on Thursday evening, before Sunday's reset
    const v = planMode();
    expect(v.mode).toBe("low");
    expect(new Date(v.runsOut!).toISOString().slice(0, 16)).toBe("2026-10-23T00:36"); // 40 points more at 50 in 47 hours: 37.6 hours after Wednesday 11:00
    const day = (t: number) => new Date(t).toLocaleDateString("en-US", { weekday: "long" }); // on this computer's clock
    expect(v.why).toBe(`at this week's pace your Claude plan runs out on ${day(v.runsOut!)}, before it resets on ${day(WEEK_RESETS)} (the week 60% used)`);
  });
  test("a pace from readings less than 6 hours apart, or one that lasts to the reset, says nothing", () => {
    const at = T("2026-10-21T12:00:00Z");
    const s = (h: number, used: number) => ({ at: at - h * 3600_000, five: null, week: { used, resets: WEEK_RESETS } });
    expect(runsOutAt(s(0, 40), at, [s(2, 20), s(0, 40)])).toBeNull(); // 2 hours of readings
    expect(runsOutAt(s(0, 30), at, [s(48, 10), s(0, 30)])).toBeNull(); // lasts to Sunday
    expect(runsOutAt(s(0, 30), at, [])).toBeNull();
  });
});

describe("what the mode changes", () => {
  test("what Claude is told as each prompt goes", () => {
    snap("2026-10-21T11:00:00Z", 74);
    expect(hookLine()).toBe("Leanfare: your Claude plan is running low: the week 74% used. Hand all reading, searching and drafting you will not change yourself to Leanfare's delegate, and plan tasks with several parts with Leanfare's plan; keep changes to files and your final answers.");
  });
  test("reminders before big reads come sooner", () => {
    const log = join(dir, "app.log");
    writeFileSync(log, "x".repeat(25 * 1024));
    const read = (s: string) => ({ session_id: s, cwd: dir, tool_name: "Read", tool_input: { file_path: log } });
    expect(readReminder(read("a"))).toBeNull(); // plenty: from 40 KB
    snap("2026-10-21T11:00:00Z", 74);
    expect(readReminder(read("b"))).not.toBeNull(); // low: from 20 KB
  });
  test("a plan's high effort part goes out too when the plan is low", async () => {
    await keys("openai", "google", "deepseek");
    const task = "Decide the database design for the new reporting feature: compare the options and the costs, then pick one.";
    const before = await makePlan({ task, files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    snap("2026-10-21T11:00:00Z", 74);
    const after = await makePlan({ task, files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    const high = (r: any) => r.parts.filter((p: any) => p.effort === "high" && (p.kind === "reason" || p.kind === "write"));
    expect(high(before).every((p: any) => p.where === "you")).toBe(true);
    expect(high(after).some((p: any) => p.where !== "you")).toBe(true);
    expect(high(after).find((p: any) => p.where !== "you").why).toContain("the week at 74%");
  });
  test("the spend tool and Settings say the mode", async () => {
    snap("2026-10-21T11:00:00Z", 74);
    const v = (await ui(url, "/api/platforms")).json;
    expect(v.mode).toMatchObject({ mode: "low", why: "your Claude plan is running low: the week 74% used" });
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 100 && !doc.querySelector("#platformsSetting .mode-line"); i++) await Bun.sleep(50);
    expect(doc.querySelector("#platformsSetting .mode-line").textContent).toBe("Mode: lowYour Claude plan is running low: the week 74% used. Claude is told to hand off all reading, searching and drafting it will not change, and plans send more parts out.");
  });
});
