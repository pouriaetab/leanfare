// Side by side (sidebyside.ts): now and then the top model answers a hand off too, and a judge of a third company
// compares the two answers blind (names hidden and masked, in a random order), after the answer went back. Kept:
// models, kind, verdict and costs, never the words; never past its monthly limit or the budget.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { saveSettings, validatePatch } from "../src/settings";
import { JUDGE_SYSTEM, draw, sideBySideHeld, sideBySideIdle, sideBySideRunning, sideMonth, sideStandings, sideText, sideVerdictOf } from "../src/sidebyside";
import { boot, fake, keys, reset, ui } from "./app";

const DEEPSEEK = "deepseek/deepseek-v4-flash", GEMINI = "google/gemini-3.8-flash", GROK = "xai/grok-4.20-beta";
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n10:02 error: retry failed\n" };
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ ticked: [DEEPSEEK, GEMINI, GROK], sideBySide: 5, sideBySideCap: 1 });
  await keys("deepseek", "google", "xai");
  draw.next = () => 0; // compared, and the answer that came back is shown first
  fake.hooks.answer = (_p, provider) => (provider === "xai" ? "SAME. Both list the two errors." : provider === "google" ? "As Gemini, I found: disk full; retry failed." : "Errors: disk full (2), retry failed (3).");
});
const handOff = (more: Record<string, unknown> = {}) =>
  runDelegate({ task: "List the errors.", files: [LOG], kind: "read", effort: "low", check: "never", maxOut: 2000, ...more } as any, new AbortController().signal);
const rows = () => db.query("SELECT handoff, kind, model, top_model, judge, shown_first, verdict, top_cost, judge_cost FROM comparisons ORDER BY id").all() as any[];
const sources = () => (db.query("SELECT source FROM ledger ORDER BY id").all() as any[]).map((r) => r.source);
const judged = () => fake.seen.filter((s) => JSON.stringify(s.body ?? "").includes("You compare two answers"));

describe("a hand off picked for side by side", () => {
  test("the top model answers too, and a judge of a third company compares them blind, after the answer went back", async () => {
    fake.hooks.slow = (_p, provider) => (provider === "google" ? 400 : 0);
    const r = await handOff();
    expect(r.model.id).toBe(DEEPSEEK); // the cheapest good enough model answered, and its answer came back at once
    expect(sideBySideRunning()).toBe(1); // while the top model is still answering
    await sideBySideIdle();
    // The top: the best rated model you ticked for it (Gemini). The judge: neither DeepSeek's company nor Google's.
    expect(rows()).toEqual([expect.objectContaining({ handoff: r.row, kind: "read", model: DEEPSEEK, top_model: GEMINI, judge: GROK, shown_first: "model", verdict: "same" })]);
    expect(sources()).toEqual(["delegate", "sidebyside", "sidebyside"]);
    const body = JSON.stringify(judged().at(-1)!.body);
    expect(body).toContain(JSON.stringify(JUDGE_SYSTEM).slice(1, -1));
    expect(body).toContain("Answer A:\\nErrors: disk full (2), retry failed (3).\\n\\nAnswer B:\\nAs [a model], I found: disk full; retry failed.");
    expect(body).not.toContain("Gemini");
    expect(body).not.toContain("DeepSeek");
  });

  test("the order is random, and the verdict is from the answer's side: the judge preferred the top model's", async () => {
    const seq = [0, 0.9]; // compared; then the top model's answer is shown first
    draw.next = () => seq.shift() ?? 0;
    fake.hooks.answer = (_p, provider) => (provider === "xai" ? "A. It names the lines." : provider === "google" ? "disk full (line 2), retry failed (line 3)" : "disk full, retry failed");
    await handOff();
    await sideBySideIdle();
    expect(rows()[0]).toMatchObject({ shown_first: "top", verdict: "worse" });
    expect(sideMonth()).toMatchObject({ compared: 1, asGood: 0, worse: 1 });
  });

  test("what it found, for each model and kind of work", async () => {
    await handOff(); await sideBySideIdle();
    await handOff(); await sideBySideIdle();
    const st = sideStandings();
    expect(st).toEqual([expect.objectContaining({ model: DEEPSEEK, kind: "read", n: 2, same: 2, better: 0, worse: 0 })]);
    expect(sideText(st[0])).toBe("DeepSeek V4 Flash for reading: as good as the top model in 2 of 2, against Gemini 3.8 Flash, judged blind by Grok 4.20 Beta.");
    const g = await ui(url, "/api/grades");
    expect(g.json.side[0].text).toBe(sideText(st[0]));
    expect(g.json.sideMonth).toMatchObject({ compared: 2, asGood: 2, worse: 0 });
    expect(g.json.sideMonth.cost).toBeGreaterThan(0);
  });
});

describe("not compared, at no cost", () => {
  const none = async (more: Record<string, unknown> = {}) => { await handOff(more); await sideBySideIdle(); expect(rows()).toEqual([]); expect(sources()).not.toContain("sidebyside"); };
  test("when it is off, or this one was not drawn", async () => {
    await reset({ ticked: [DEEPSEEK, GEMINI, GROK], sideBySide: 0 }); await keys("deepseek", "google", "xai");
    await none();
    await reset({ ticked: [DEEPSEEK, GEMINI, GROK], sideBySide: 10 }); await keys("deepseek", "google", "xai");
    draw.next = () => 0.5; // over 1 in 10
    await none();
  });
  test("a private task, a search, or a model that is already the best you ticked", async () => {
    await reset({ ticked: [DEEPSEEK, GEMINI, GROK, "ollama/llama3.2:latest"], sideBySide: 5 }); await keys("deepseek", "google", "xai");
    await ui(url, "/api/refresh", { what: "ollama" });
    await none({ private: true }); // it stays on this computer: no other model sees it
    await none({ kind: "search" });
    await reset({ ticked: [GEMINI, DEEPSEEK], sideBySide: 5 }); await keys("deepseek", "google");
    await none({ effort: "high" }); // Gemini answers: nothing is rated above it
  });
  test("with no judge of a third company", async () => {
    await reset({ ticked: [DEEPSEEK, GEMINI], sideBySide: 5 }); await keys("deepseek", "google");
    await none();
  });
  test("while one is running, what it will cost counts against the month's limit", async () => {
    fake.hooks.slow = (_p, provider) => (provider === "google" ? 300 : 0);
    await handOff();
    const held = sideBySideHeld();
    expect(held).toBeGreaterThan(0);
    saveSettings({ sideBySideCap: held * 1.5 }); // room for one more only if the running one is not counted
    await handOff();
    expect(sideBySideRunning()).toBe(1);
    await sideBySideIdle();
    expect(rows()).toHaveLength(1);
    expect(sideBySideHeld()).toBe(0);
  });

  test("past its limit for the month", async () => {
    await reset({ ticked: [DEEPSEEK, GEMINI, GROK], sideBySide: 5, sideBySideCap: 0 }); await keys("deepseek", "google", "xai");
    await none();
  });
});

describe("the judge's verdict and the settings", () => {
  test("A, B or SAME first, or which answer is better near the start", () => {
    expect(sideVerdictOf("A. It is shorter.")).toBe("A");
    expect(sideVerdictOf("**B**\nB names the lines.")).toBe("B");
    expect(sideVerdictOf("Verdict: SAME")).toBe("same");
    expect(sideVerdictOf("Tie: both are right.")).toBe("same");
    expect(sideVerdictOf("Both are close, but Answer B is better because it cites lines.")).toBe("B");
    expect(sideVerdictOf("I cannot tell.")).toBeNull();
  });
  test("how often, and the limit a month", () => {
    expect(validatePatch({ sideBySide: 20, sideBySideCap: "2.5" })).toEqual({ patch: { sideBySide: 20, sideBySideCap: 2.5 } });
    expect(validatePatch({ sideBySide: 7 })).toEqual({ error: "sideBySide must be 0 (off), 5, 10 or 20" });
    expect(validatePatch({ sideBySideCap: -1 })).toEqual({ error: "sideBySideCap must be a dollar amount from 0 to 1,000" });
    expect(validatePatch({ sideBySideCap: "" })).toEqual({ error: "sideBySideCap must be a dollar amount from 0 to 1,000" });
  });
});
