// The time of Leanfare's parts: the parts that wait for yours are timed apart, and run in your app.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { chains, chainSeconds, forgetPlans, makePlan, runView, startRun, type Part } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

test("a part after one of yours is timed apart, from when yours are done, and the run leaves it to you", async () => {
  const part = (n: number, seconds: number | null, needs: number[], where: string) => ({ n, seconds, needs, where } as unknown as Part);
  // Leanfare's 1 (10 s), your 2, then Leanfare's 3 (15 s) and 4 (5 s, after 3): 10 s now, 20 s once yours is done.
  expect(chains([part(1, 10, [], "paid"), part(2, null, [1], "you"), part(3, 15, [2], "paid"), part(4, 5, [3], "free")])).toEqual({ now: 10, after: 20 });
  expect(chainSeconds([part(1, 10, [], "paid"), part(2, 4, [], "free"), part(3, 6, [1, 2], "free")])).toBe(16); // at once where they can: 10, then 6
  expect(chains([part(1, null, [], "you")])).toEqual({ now: null, after: null });
  await keys("openai", "google", "deepseek");
  const plan = await makePlan({ task: "Fix the failing tests in the parser", files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
  // By rules: 1 and 2 read (Leanfare), 3 and 4 decide and change the code (you), 5 reviews after 4.
  expect(plan.parts.map((p) => p.where === "you" ? "you" : "out")).toEqual(["out", "out", "you", "you", "out"]);
  expect(plan.totals).toMatchObject({ out: 3, later: 1 });
  expect(plan.totals.seconds).toBeCloseTo(plan.parts[0].seconds! + plan.parts[1].seconds!, 5);
  expect(plan.totals.after).toBeCloseTo(plan.parts[4].seconds!, 5);
  expect(plan.next).toContain("Part 5 waits for yours");
  startRun(plan.id, { paid: true });
  await until(() => !runView(plan.id)!.running);
  expect(runView(plan.id)!.parts.map((p) => p.status)).toEqual(["done", "done", "yours", "yours", "after_yours"]);
});
