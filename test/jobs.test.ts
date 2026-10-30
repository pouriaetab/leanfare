// Jobs (settings.ts, planner.ts, delegate.ts; 0.11, his pick): where each kind of job goes in a plan (to Leanfare, to
// Leanfare only when the Claude plan runs low, or kept with your app), and a cap for paid work per hand off.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runDelegate } from "../src/delegate";
import { makePlan } from "../src/planner";
import { DEFAULTS, JOB_DEFAULTS, saveSettings, validatePatch } from "../src/settings";
import { saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const T = (iso: string) => Date.parse(iso);
const SONNET = "anthropic/claude-sonnet-4-6", DEEPSEEK = "deepseek/deepseek-v4-flash";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  await reset({ ticked: ALL_TICKED, jobs: JOB_DEFAULTS, paidCap: DEFAULTS.paidCap });
  await keys("openai", "google", "deepseek", "anthropic");
});
afterEach(closeApp);
const plan = (task: string) => makePlan({ task, files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
const placeOf = (r: any, kind: string) => r.parts.filter((p: any) => p.kind === kind).map((p: any) => [p.where === "you" ? "you" : "out", p.why]);

describe("where each kind of job goes", () => {
  test("by default: reading and searching to Leanfare, drafting when the plan runs low, working things out with your app", () => {
    expect(DEFAULTS.jobs).toEqual({ read: "leanfare", search: "leanfare", write: "low", reason: "app" });
    expect(DEFAULTS.paidCap).toBe(0.1);
  });
  test("a plan follows them: working things out stays, drafting stays while the plan has plenty and goes out when it runs low", async () => {
    const task = "Write a short guide for the settings screen: work out what each setting does, then draft it.";
    const before = await plan(task);
    expect(placeOf(before, "reason")[0]).toEqual(["you", "your rules keep working things out with Claude Code (Settings, Jobs)"]);
    expect(placeOf(before, "write")[0]).toEqual(["you", "your rules send drafting out only when your plan runs low (Settings, Jobs)"]);
    saveSnap({ at: T("2026-10-21T11:00:00Z"), five: null, week: { used: 74, resets: T("2026-10-25T12:00:00Z") } });
    const after = await plan(task);
    expect(placeOf(after, "write")[0][0]).toBe("out");
    expect(placeOf(after, "reason")[0][0]).toBe("you"); // still yours: your rule
  });
  test("changed in Settings: one kind at a time, checked", async () => {
    expect(validatePatch({ jobs: { reason: "leanfare" } })).toEqual({ patch: { jobs: { ...JOB_DEFAULTS, reason: "leanfare" } } });
    expect(validatePatch({ jobs: { code: "leanfare" } })).toEqual({ error: "jobs can hold read, search, write, reason" });
    expect(validatePatch({ jobs: { read: "maybe" } })).toEqual({ error: "each job goes to leanfare, low or app" });
    expect(validatePatch({ paidCap: "0.25" })).toEqual({ patch: { paidCap: 0.25 } });
    expect(validatePatch({ paidCap: -1 })).toEqual({ error: "paidCap must be a dollar amount from 0 to 100" });
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 100 && !doc.querySelector("#jobsCard"); i++) await Bun.sleep(50);
    const row = [...doc.querySelectorAll("#jobsCard .job-row")].find((r: any) => r.querySelector(".pname").textContent === "Working things out") as any;
    expect([...row.querySelectorAll("button")].map((b: any) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Leanfare", "false"], ["When low", "false"], ["Your app", "true"]]);
    [...row.querySelectorAll("button")][0].click();
    for (let i = 0; i < 100 && (await ui(url, "/api/state")).json.settings.jobs.reason !== "leanfare"; i++) await Bun.sleep(30);
    expect((await ui(url, "/api/state")).json.settings.jobs).toEqual({ ...JOB_DEFAULTS, reason: "leanfare" });
  });
});

describe("a cap for paid work", () => {
  test("a hand off that would cost more on every model that can take it spends nothing, and says so", async () => {
    await reset({ ticked: [SONNET], jobs: JOB_DEFAULTS, paidCap: 0.01 });
    await keys("anthropic");
    const big = { name: "notes.md", text: "A long note about the design.\n".repeat(1200) }; // about 12k tokens: some 4 cents on Sonnet
    await expect(runDelegate({ task: "Summarize it.", files: [big], kind: "read", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal))
      .rejects.toThrow(/^Every model that could take it would cost more than your cap for paid work, \$0\.01 a hand off \(about \$0\.0\d+ here\)\. Raise it in Settings, Jobs, or do it yourself\.$/);
  });
  test("within it, a cheaper model takes it; a check above it is skipped and the receipt says why", async () => {
    await reset({ ticked: [SONNET, DEEPSEEK], jobs: JOB_DEFAULTS, paidCap: 0.01 });
    await keys("anthropic", "deepseek");
    const big = { name: "notes.md", text: "A long note about the design.\n".repeat(1200) };
    const r = await runDelegate({ task: "Summarize it.", files: [big], kind: "read", effort: "high", check: "always", maxOut: 2000 } as any, new AbortController().signal);
    expect(r.model.id).toBe(DEEPSEEK);
    expect(r.receipt).toContain("a check by a stronger model would cost more than your cap for paid work, $0.01 a hand off");
  });
});
