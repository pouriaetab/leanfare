// The plan's numbers for folders: every file is summed, and the tokens kept are what a hand off can carry.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlan, forgetPlans, makePlan, runView, startRun } from "../src/planner";
import { sizesForPlan } from "../src/readfiles";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("a plan's numbers", () => {
  test("300 files at the top of a folder: all of them are in the plan's sizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "r9a-"));
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `note${String(i).padStart(3, "0")}.md`), "x".repeat(1000));
    const got = sizesForPlan([dir], dir);
    if (typeof got === "string") throw new Error(got);
    const total = got.reduce((a, f) => a + f.size, 0);
    rmSync(dir, { recursive: true, force: true });
    expect(total).toBe(300 * 1000);
  });

  test("the table counts as kept only what one hand off can carry", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "r9b-"));
    mkdirSync(join(dir, "src"));
    for (let i = 0; i < 120; i++) writeFileSync(join(dir, "src", `m${String(i).padStart(3, "0")}.py`), `# module ${i}\n` + "y = 1\n".repeat(10_000)); // about 60 KB each
    const v = checkPlan({ task: "Reverse engineer this project and build a smaller one", paths: [dir], split: "rules" });
    if (typeof v === "string") throw new Error(v);
    fake.hooks.answer = () => null;
    const plan = await makePlan({ ...v, signal: new AbortController().signal });
    const p1 = plan.parts[0];
    startRun(plan.id, { paid: true });
    await until(() => !runView(plan.id)!.running);
    rmSync(dir, { recursive: true, force: true });
    expect(p1.tokens).toBeLessThan(DELEGATE_TOKENS);
  });
});
const DELEGATE_TOKENS = (4 * 1024 * 1024) / 4 + 10_000; // 4 MB at four characters a token, plus the task and answer
