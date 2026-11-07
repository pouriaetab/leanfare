// 0.15.4: a plan takes the Leanfare row's choices: a speed for the models of its parts, quality high (each part one
// effort step up) and Claude only (every part on Claude's own models, the plan naming the model for each).
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { checkPlan, CLAUDE_ONLY_WHY } from "../src/planner";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
const PARTS = [
  { title: "Read the logs", kind: "read", effort: "low", files: ["a.log"], task: "Find the errors." },
  { title: "Draft the notes", kind: "write", effort: "medium", files: ["b.md"], task: "Draft release notes." },
];
const FILES = [{ name: "a.log", size: 4000 }, { name: "b.md", size: 3000 }];
const plan = (extra: Record<string, unknown>) => ui(url, "/api/plan", { task: "Read the logs, then draft the notes", files: FILES, manager: "Claude", split: "rules", parts: PARTS, ...extra });

describe("the row's choices in a plan", () => {
  test("checked: speed, quality and only", () => {
    const base = { task: "x" };
    expect(checkPlan({ ...base, speed: "warp" })).toBe("speed must be cheapest, balanced, fastest, or a number of seconds from 1 to 3600.");
    expect(checkPlan({ ...base, quality: "max" })).toBe("quality must be standard or high.");
    expect(checkPlan({ ...base, only: "openai" })).toBe("only must be any or claude.");
    expect(checkPlan({ ...base, speed: "fastest", quality: "high", only: "claude" })).toMatchObject({ speed: "fastest", effortUp: true, claudeOnly: true });
    const plain = checkPlan(base) as any;
    expect([plain.speed, plain.effortUp, plain.claudeOnly]).toEqual([undefined, undefined, undefined]);
  });

  test("Claude only: every part stays on Claude's own models, each with the model to run it on", async () => {
    await keys("google", "deepseek");
    const r = await plan({ only: "claude" });
    expect(r.status).toBe(200);
    expect(r.json.parts.map((p: any) => p.where)).toEqual(["you", "you"]);
    for (const p of r.json.parts) { expect(p.why).toBe(CLAUDE_ONLY_WHY); expect(p.use).toBeTruthy(); }
    const any = await plan({});
    expect(any.json.parts.some((p: any) => p.where !== "you")).toBe(true); // without it, Leanfare hands parts out
  });

  test("quality high: each part one effort step up; a speed is taken", async () => {
    await keys("google", "deepseek");
    const r = await plan({ quality: "high", speed: "fastest" });
    expect(r.status).toBe(200);
    expect(r.json.parts.map((p: any) => p.effort)).toEqual(["medium", "high"]);
    const std = await plan({ speed: "cheapest" });
    expect(std.json.parts.map((p: any) => p.effort)).toEqual(["low", "medium"]);
  });
});
