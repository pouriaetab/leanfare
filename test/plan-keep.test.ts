// A plan whose parts run is kept while newer plans are made, with its files.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlan, forgetPlans, keptPlan, makePlan, runView, startRun } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { fake.hooks.answer = null; fake.hooks.slow = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

test("twenty new plans while one runs: its next part still gets its files", async () => {
  await keys("openai", "google", "deepseek");
  const dir = mkdtempSync(join(tmpdir(), "r11-"));
  writeFileSync(join(dir, "router.py"), "def pick_MARK_9931(d):\n    return d[0]\n");
  const v = checkPlan({ task: "Reverse engineer this router and build a smaller one", paths: [dir], split: "rules" });
  if (typeof v === "string") throw new Error(v);
  const prompts: string[] = [];
  fake.hooks.answer = (p) => { prompts.push(p); return null; };
  fake.hooks.slow = (p) => (p.includes("List the modules") ? 1500 : 0); // part 1 takes a while
  const plan = await makePlan({ ...v, signal: new AbortController().signal });
  startRun(plan.id, { paid: true });
  await until(() => runView(plan.id)!.parts[0].status === "running");
  for (let i = 0; i < 20; i++) await makePlan({ task: `Other task ${i}`, files: [], manager: null, split: "rules", signal: new AbortController().signal });
  await until(() => !runView(plan.id)!.running);
  const two = prompts.find((p) => p.includes("Explain what the parts this task touches do"));
  rmSync(dir, { recursive: true, force: true });
  expect(two?.includes("MARK_9931")).toBe(true);
});
