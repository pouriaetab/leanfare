// The Savings plans card: the estimate's note, a month picked, and a plan outside this month.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_TICKED, boot, reset, ui } from "./app";
import { closeApp, openApp as open, win } from "./dom";
import { forgetLogs } from "../src/plans";
import { forgetFound, hooks } from "../src/found";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
const openApp = () => open(url);
const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const line = (id: string, model: string, usage: Record<string, number>) => JSON.stringify({ type: "assistant", timestamp: "2026-10-20T10:00:00Z", requestId: "r" + id, message: { id: "m" + id, model, usage } });
const logs = (...lines: string[]) => {
  const d = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "p");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "s.jsonl"), lines.join("\n") + "\n");
  forgetLogs();
};
const goSavings = async (doc: any) => {
  doc.querySelector('.tabs button[data-tab="savings"]').click();
  await waitFor(() => !!doc.querySelector("#plansCard") && !doc.querySelector("#plansCard").textContent.includes("Reading"));
};
const goSettings = async (doc: any) => {
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  await waitFor(() => !!doc.querySelector("input[aria-label='Claude plan name']"));
};
const real = hooks.spotlight;
beforeEach(async () => {
  rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
  rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
  forgetLogs(); forgetFound();
  await reset({ ticked: ALL_TICKED });
});
afterEach(() => { hooks.spotlight = real; rmSync(join(process.env.HOME!, "Applications"), { recursive: true, force: true }); rmSync(join(process.env.HOME!, ".grok"), { recursive: true, force: true }); forgetFound(); });

describe("the Savings plans card", () => {
  test("with the value at API prices on, the card's note says it is an estimate", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 100_000 }));
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 100 } } });
    const doc = await openApp();
    await goSavings(doc);
    await goSettings(doc);
    const showIt = [...doc.querySelectorAll("label.check")].find((l: any) => l.textContent.includes("cost per use, at API prices"))!.querySelector("input");
    showIt.checked = true;
    showIt.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => toasts(doc).includes("also shows what your plan use would cost"));
    await goSavings(doc);
    await waitFor(() => doc.querySelector("#plansCard").textContent.includes("If this were pay per use"));
    const card = doc.querySelector("#plansCard").textContent;
    const server = (await ui(url, "/api/plans")).json.note;
    expect(card).toContain("an estimate at the providers' list prices");
  }, 30000);

  test("September picked: its tokens are called September's", async () => {
    const d = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "p");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-09-20T10:00:00Z", requestId: "r1", message: { id: "m1", model: "claude-sonnet-4-6", usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + "\n");
    forgetLogs();
    const doc = await openApp();
    await goSavings(doc);
    const pick = doc.querySelector("#tab-savings select[aria-label='Month']");
    pick.value = "2026-09";
    pick.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => !!doc.querySelector("#plansCard")?.textContent.includes("1.0M"));
    const t = doc.querySelector("#plansCard").textContent;
    expect(t).not.toContain("tokens this month");
  }, 30000);

  test("plans outside this month, an app found, Grok: nothing reads null, undefined or NaN", async () => {
    mkdirSync(join(process.env.HOME!, "Applications", "Perplexity.app"), { recursive: true });
    hooks.spotlight = () => ({ added: Date.parse("2026-03-02T10:00:00Z"), used: Date.parse("2026-10-20T09:00:00Z") });
    mkdirSync(join(process.env.HOME!, ".grok"), { recursive: true });
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 10 }));
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 100, since: "2026-11" }, perplexity: { name: "Perplexity Pro", price: 20, until: "2026-08" }, grok: { name: "SuperGrok", price: 30 } } });
    forgetFound();
    const doc = await openApp();
    await goSavings(doc);
    const t = doc.querySelector("#plansCard").textContent;
    expect(bad(doc)).toBe(false);
  }, 30000);
});
