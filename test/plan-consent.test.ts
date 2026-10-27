// A plan's paid parts run only with a yes, or while they fit in the cap; a free part stays on free
// models, its check too.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlan, forgetPlans, makePlan, paidOf, runView, startRun } from "../src/planner";
import { draw } from "../src/delegate";
import { buildOpenRouter, setExtraModels, store } from "../src/data";
import { saveSettings, settings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, ledger, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
afterAll(() => { draw.next = () => Math.random(); store.openrouter = []; setExtraModels([], new Set()); });
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const signal = () => new AbortController().signal;
const FREE = "openrouter/deepseek/deepseek-v4-flash:free";

describe("a plan's paid parts need a yes, or room in the cap", () => {
  test("a part on a free model stays free: its check runs on free models too, with no yes asked", async () => {
    await keys("openai", "google", "deepseek", "anthropic", "xai", "mistral", "openrouter");
    // An OpenRouter ":free" model, rated as its maker's model (data.ts buildOpenRouter).
    store.openrouter = buildOpenRouter({ data: [{ id: "deepseek/deepseek-v4-flash:free", name: "DeepSeek: V4 Flash (free)", pricing: { prompt: "0", completion: "0" }, context_length: 163840, created: 1790000000, architecture: { output_modalities: ["text"] } }] }, store.catalog);
    setExtraModels([], new Set()); // re-index
    saveSettings({ ticked: [...ALL_TICKED, FREE] });
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Pull the errors out of the log", kind: "read", effort: "low", needs: [], size: "small", task: "List every line of the log that reports an error." },
    ] }) : prompt.includes("The answer to check") ? "PASS" : null);
    const plan = await makePlan({ task: "Find out why the nightly job fails", files: [], manager: "Claude Code", signal: signal() });
    expect(plan.parts[0]).toMatchObject({ where: "free", cost: 0 });
    expect(paidOf(plan).parts).toEqual([]); // so no yes is asked
    draw.next = () => 0; // the 1 in 10 check of a low effort answer comes up (1 in 4 medium, every high)
    const before = ledger().length;
    startRun(plan.id); // no yes, cap 0
    await until(() => !runView(plan.id)!.running);
    const v = runView(plan.id)!;
    const rows = ledger().slice(before).map((r: any) => ({ source: r.source, model: r.model, cost: r.cost }));
    expect(rows.filter((r) => r.cost > 0)).toEqual([]); // nothing paid without a yes
  });

  test("a paid part within the cap runs unchecked, so the run spends no more than the cap", async () => {
    await keys("openai", "google", "deepseek", "anthropic", "xai", "mistral");
    const dir = mkdtempSync(join(tmpdir(), "r1b-"));
    writeFileSync(join(dir, "app.log"), "2026-10-26 10:02 INFO all good, nothing to see here\n".repeat(7_500)); // about 400 KB
    const v0 = checkPlan({ task: "Find out why the nightly job fails", paths: [join(dir, "app.log")] });
    if (typeof v0 === "string") throw new Error(v0);
    const name = v0.files[0].name;
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Pull the errors out of the log", kind: "read", effort: "low", needs: [], size: "large", files: [name], task: "List every line of the log that reports an error." },
    ] }) : prompt.includes("The answer to check") ? "PASS" : null);
    const plan = await makePlan({ ...v0, signal: signal() });
    const est = paidOf(plan).estimate!;
    saveSettings({ planAuto: Math.ceil(est * 100) / 100 }); // the cap: the estimate, rounded up to the cent
    draw.next = () => 0;
    const before = ledger().length;
    startRun(plan.id); // no yes: the estimate is within the cap
    await until(() => !runView(plan.id)!.running);
    const rows = ledger().slice(before);
    const spent = rows.reduce((a: number, r: any) => a + (r.cost ?? 0), 0);
    rmSync(dir, { recursive: true, force: true });
    expect(spent).toBeLessThanOrEqual(settings().planAuto);
  });

  test("a free model whose context is too small: the plan says paid up front, and the run waits for the yes", async () => {
    await keys("openai", "google", "deepseek", "anthropic", "xai", "mistral", "openrouter");
    store.openrouter = buildOpenRouter({ data: [{ id: "deepseek/deepseek-v4-flash:free", name: "DeepSeek: V4 Flash (free)", pricing: { prompt: "0", completion: "0" }, context_length: 163840, created: 1790000000, architecture: { output_modalities: ["text"] } }] }, store.catalog);
    setExtraModels([], new Set());
    saveSettings({ ticked: [...ALL_TICKED, FREE] });
    const dir = mkdtempSync(join(tmpdir(), "r1c-"));
    writeFileSync(join(dir, "app.log"), "2026-10-26 10:02 INFO all good, nothing to see here\n".repeat(10_000)); // about 530 KB
    const v0 = checkPlan({ task: "Find out why the nightly job fails", paths: [join(dir, "app.log")] });
    if (typeof v0 === "string") throw new Error(v0);
    const name = v0.files[0].name;
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Pull the errors out of the log", kind: "read", effort: "low", needs: [], size: "large", files: [name], task: "List every line of the log that reports an error." },
    ] }) : null);
    const plan = await makePlan({ ...v0, signal: signal() });
    expect(plan.parts[0].where).toBe("paid"); // fixed: the free model cannot take it all, so the plan says paid up front
    draw.next = () => 0.99; // not checked: only the answer itself
    const before = ledger().length;
    startRun(plan.id); // no yes
    await until(() => !runView(plan.id)!.running);
    const rows = ledger().slice(before).map((r: any) => `${r.source} ${r.model} ${r.cost}`);
    rmSync(dir, { recursive: true, force: true });
    expect(ledger().slice(before).filter((r: any) => r.cost > 0)).toEqual([]);
    expect(runView(plan.id)!.parts[0].status).toBe("asks"); // and the run waits for the yes
  });
});
