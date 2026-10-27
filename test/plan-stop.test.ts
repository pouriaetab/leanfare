// What a run says it cost after Stop, and Run again after Stop.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { forgetPlans, makePlan, runView, startRun, stopRun } from "../src/planner";
import { draw } from "../src/delegate";
import { ALL_TICKED, boot, fake, keys, ledger, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { fake.hooks.answer = null; fake.hooks.slow = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
afterAll(() => { draw.next = () => Math.random(); fake.hooks.slow = null; });
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const ONE = JSON.stringify({ parts: [{ title: "Pull the errors out of the log", kind: "read", effort: "low", needs: [], size: "small", task: "List every line of the log that reports an error. [usage 40000 2000]" }] });

describe("a run's cost and Stop", () => {
  test("Stop while a part's check runs: the run's cost is what was charged", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (p) => (p.includes("The person works in") ? ONE : p.includes("The answer to check") ? "PASS" : null);
    fake.hooks.slow = (p) => (p.includes("The answer to check") ? 3000 : 0);
    draw.next = () => 0; // this answer is checked
    const plan = await makePlan({ task: "Find out why the nightly job fails", files: [], manager: "Claude Code", signal: new AbortController().signal });
    const before = ledger().length;
    startRun(plan.id, { paid: true });
    await until(() => ledger().slice(before).some((r: any) => r.source === "delegate"));
    stopRun(plan.id);
    await until(() => !runView(plan.id)!.running);
    const v = runView(plan.id)!;
    const charged = ledger().slice(before).reduce((a: number, r: any) => a + (r.cost ?? 0), 0);
    expect(v.cost).toBe(charged);
  });

  test("Run again right after Stop starts a new run", async () => {
    await keys("openai", "google", "deepseek");
    fake.hooks.answer = (p) => (p.includes("The person works in") ? ONE : null);
    fake.hooks.slow = (p) => (p.includes("List every line") ? 1500 : 0);
    const plan = await makePlan({ task: "Find out why the nightly job fails", files: [], manager: "Claude Code", signal: new AbortController().signal });
    const first = startRun(plan.id, { paid: true });
    await until(() => runView(plan.id)!.parts[0].status === "running");
    stopRun(plan.id);
    const again = startRun(plan.id, { paid: true }); // the person presses Run again (or plan_run is called again)
    await until(() => !runView(plan.id)!.running);
    await Bun.sleep(300);
    expect(again).not.toBe(first);
  });
});
