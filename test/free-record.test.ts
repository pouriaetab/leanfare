// Free models and the work they do well (0.13.8): their grades together, by kind, decide what they take. Working things
// out at medium or high effort waits until they earn it; a kind they score under half at waits; a paid model takes it,
// else the app keeps it, and the receipt or the plan says why.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runDelegate } from "../src/delegate";
import { freeHeld, freeRecord } from "../src/freerecord";
import { addGrade, type GradedKind, type Verdict } from "../src/grades";
import { makePlan } from "../src/planner";
import { saveSettings } from "../src/settings";
import { boot, keys, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash";
beforeAll(async () => { await boot(); });
beforeEach(async () => {
  await reset({ mode: "save" });
  await keys("google", "deepseek");
  saveSettings({ providers: { google: { on: true, free: true } }, ticked: [GEMINI, DEEPSEEK] });
});
const grade = (model: string, kind: GradedKind, verdicts: Verdict[]) => { for (const verdict of verdicts) addGrade({ model, kind, effort: "medium", verdict, source: "test" }); };
const hand = (kind: string, effort: string) => runDelegate({ task: "Work out why the job fails [usage 100 10]", files: [], kind, effort, check: "never", maxOut: 1000 } as any, new AbortController().signal);

describe("the free models' record", () => {
  test("counts only the models that cost you nothing, by kind", () => {
    grade(GEMINI, "reason", ["good", "wrong", "partly"]);
    grade(DEEPSEEK, "reason", ["wrong", "wrong"]);
    const r = freeRecord("reason");
    expect([r.n, r.good, r.partly, r.wrong, r.score]).toEqual([3, 1, 1, 1, 0.5]);
  });
  test("working things out at medium or high effort waits until they earn it; low effort, reading and level 5 do not", () => {
    expect(freeHeld("reason", "medium")).toBe("free models take working things out at medium effort once your grades say they do it well (60 of 100 from 5 grades); so far no grades yet");
    expect(freeHeld("reason", "low")).toBe(null);
    expect(freeHeld("read", "medium")).toBe(null);
    expect(freeHeld("reason", "medium", 5)).toBe(null);
    grade(GEMINI, "reason", ["good", "good", "good", "partly", "good"]); // 90 of 100 from 5
    expect(freeHeld("reason", "high")).toBe(null);
  });
  test("a kind they score under half at waits, at any effort and level", () => {
    grade(GEMINI, "read", ["wrong", "wrong", "partly", "good", "wrong"]); // 30 of 100
    expect(freeHeld("read", "low", 5)).toStartWith("free models have scored 30 of 100");
    expect(freeHeld("read", "low", 5)).toEndWith("at reading for you, under half good");
  });
});

describe("the delegate", () => {
  test("a paid model takes what the free models sit out, and the receipt says why", async () => {
    const r = await hand("reason", "medium");
    expect(r.model.id).toBe(DEEPSEEK);
    expect(r.receipt).toContain("Free models take working things out at medium effort once your grades say they do it well (60 of 100 from 5 grades); so far no grades yet, so DeepSeek V4 Flash took it.");
  });
  test("low effort still goes to a free model", async () => {
    saveSettings({ ticked: [GEMINI] });
    expect((await hand("reason", "low")).model.id).toBe(GEMINI);
  });
  test("with no paid model, the app keeps it", async () => {
    saveSettings({ ticked: [GEMINI] });
    await expect(hand("reason", "medium")).rejects.toThrow("Keep this one yourself: free models take working things out at medium effort");
  });
});

describe("a plan", () => {
  test("a part of a kind the free models score under half at stays with you, saying why", async () => {
    saveSettings({ ticked: [GEMINI] });
    grade(GEMINI, "read", ["wrong", "wrong", "partly", "good", "wrong"]);
    const r = await makePlan({ task: "Reverse engineer the parser", files: [{ name: "src/", size: 200_000 }], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    const reads = r.parts.filter((p: any) => p.kind === "read");
    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) { expect(p.where).toBe("you"); expect(p.why).toContain("under half good"); }
  });
});
