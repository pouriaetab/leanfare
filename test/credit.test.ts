// No credit left (0.13.3): a provider that answers 402, or says its balance is too low, has its paid models left out and
// the work passes to the next model; its free models (OpenRouter's ":free") keep working. OpenRouter's balance is read
// again every 30 minutes, the others are tried again after 6 hours; an answer from a paid model, or Check again with
// credit, brings them back. The receipt and the page say so, with Add credit and Check again.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getModel } from "../src/data";
import { runDelegate } from "../src/delegate";
import { runChat, usableModels } from "../src/engine";
import { creditRefusal, keepKeysFresh, KEYS_EVERY, noCredit, noteNoCredit } from "../src/keystate";
import { saveSettings } from "../src/settings";
import { now } from "../src/util";
import { boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";
import { KEYS } from "./fake";

const LARGE = "openrouter/acme/acme-large", FREE = "openrouter/acme/acme-small:free", CLAUDE = "anthropic/claude-sonnet-4-6", DEEP = "deepseek/deepseek-v4-flash";
const BROKE = { status: 402, message: "This request requires more credits, or fewer max_tokens. You requested up to 11192 tokens, but can only afford 3886. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account" };
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ mode: "save" });
  await keys("anthropic");
  expect((await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter })).json.ok).toBe(true); // its own model list, free ones too
  saveSettings({ ticked: [LARGE, CLAUDE] });
  fake.hooks.refuse = (body, provider) => (provider === "openrouter" && !String(body?.model ?? "").endsWith(":free") ? BROKE : null);
});
afterEach(async () => { process.env.LEANFARE_KEY_CHECKS = "off"; await closeApp(); });
const chat = (model = "auto") => runChat([{ role: "user", content: "Hi [usage 100 10]" }], model, new AbortController().signal, () => {});
async function waitFor(ok: () => boolean, ms = 3000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("no credit left", () => {
  test("Auto's first pick has no credit: the request passes to another provider's model, the notes say why, and that provider's paid models stay out", async () => {
    await keys("deepseek");
    saveSettings({ ticked: [DEEP, CLAUDE] });
    fake.hooks.refuse = (_b, provider) => (provider === "deepseek" ? { status: 402, message: "Insufficient Balance" } : null);
    const r = await chat();
    expect([r.status, r.meta.model.id]).toEqual(["ok", CLAUDE]);
    expect(r.meta.notes).toContain(`${getModel(DEEP)!.label} could not be used: DeepSeek has no credit left, so Auto passed the request to its next pick.`);
    expect(noCredit("deepseek")?.status).toBe(402);
    expect(usableModels().map((m) => m.id)).toEqual([CLAUDE]);
    fake.seen.length = 0;
    expect((await chat()).meta.model.id).toBe(CLAUDE);
    expect(fake.seen.some((s) => s.provider === "deepseek")).toBe(false); // not asked again
  });
  test("OpenRouter with no credit: its paid models are left out, its free ones stay in", async () => {
    saveSettings({ ticked: [LARGE, FREE, CLAUDE] });
    expect(usableModels().map((m) => m.id).sort()).toEqual([CLAUDE, FREE, LARGE].sort());
    noteNoCredit("openrouter", 402);
    expect(usableModels().map((m) => m.id).sort()).toEqual([CLAUDE, FREE].sort()); // a free model needs no credit
    expect((await chat(FREE)).status).toBe("ok");
  });
  test("a model you named says it has no credit, and how to go on; an answer from a paid model of it brings them back", async () => {
    const r = await chat(LARGE);
    expect(r.status).toBe("error");
    expect(r.meta.error).toContain("OpenRouter says the account has no credit left: This request requires more credits");
    expect(r.meta.error).toEndWith("Leanfare leaves OpenRouter's paid models out until it has credit again: add credit there, or pick another model.");
    fake.hooks.refuse = null; // credit added
    expect((await chat(LARGE)).status).toBe("ok");
    expect(noCredit("openrouter")).toBe(null);
  });
  test("what counts: 402, and a 400 or 403 that says the balance or credit is too low; not one about the request", () => {
    expect(creditRefusal(402, "DeepSeek says the account has no credit left: Insufficient Balance")).toBe(true);
    expect(creditRefusal(400, "Anthropic answered 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")).toBe(true);
    expect(creditRefusal(403, "Someone answered 403: insufficient funds on this account")).toBe(true);
    expect(creditRefusal(400, "Google Gemini answered 400: Invalid value at 'contents'.")).toBe(false);
    expect(creditRefusal(429, "You exceeded your current quota, please check your plan and billing details.")).toBe(false); // a limit, handled as one
  });
});

describe("back when there is credit", () => {
  test("OpenRouter's balance is read again every 30 minutes, in the background; with credit its paid models are back", async () => {
    process.env.LEANFARE_KEY_CHECKS = "on";
    noteNoCredit("openrouter", 402);
    fake.oauth.balance = 0;
    fake.seen.length = 0; // saving the key read the balance once already
    const t = now().getTime();
    keepKeysFresh(t + KEYS_EVERY.recheck - 60_000); // not yet
    await Bun.sleep(100);
    expect(fake.seen.some((s) => s.path.endsWith("/credits"))).toBe(false);
    keepKeysFresh(t + KEYS_EVERY.recheck + 60_000);
    await waitFor(() => fake.seen.some((s) => s.path.endsWith("/credits")));
    await Bun.sleep(100);
    expect(noCredit("openrouter")).not.toBe(null); // still none
    fake.oauth.balance = 5;
    keepKeysFresh(t + 2 * KEYS_EVERY.recheck + 120_000);
    await waitFor(() => noCredit("openrouter") === null);
    expect(noCredit("openrouter")).toBe(null);
    expect(usableModels().map((m) => m.id)).toContain(LARGE);
  });
  test("Check again: with no credit it stays out and says so; with credit it is back at once", async () => {
    noteNoCredit("openrouter", 402);
    fake.oauth.balance = 0;
    let r = await ui(url, "/api/keys/recheck", { provider: "openrouter" });
    expect(r.json).toMatchObject({ ok: false, message: "OpenRouter still has no credit, so its paid models stay out; its free models keep working." });
    fake.oauth.balance = 5;
    r = await ui(url, "/api/keys/recheck", { provider: "openrouter" });
    expect(r.json).toMatchObject({ ok: true, message: "OpenRouter has $5.00 of credit: its paid models are back." });
    expect(noCredit("openrouter")).toBe(null);
  });
  test("a provider with no balance to read is tried again after 6 hours", async () => {
    await keys("deepseek");
    saveSettings({ ticked: [DEEP, CLAUDE] });
    fake.hooks.refuse = (_b, provider) => (provider === "deepseek" ? { status: 402, message: "Insufficient Balance" } : null);
    const r = await chat();
    expect(r.meta.model.id).toBe(CLAUDE);
    expect(noCredit("deepseek")?.status).toBe(402);
    const t = now().getTime();
    expect(noCredit("deepseek", t + KEYS_EVERY.credit - 60_000)).not.toBe(null);
    expect(noCredit("deepseek", t + KEYS_EVERY.credit + 60_000)).toBe(null);
  });
});

describe("said where you look", () => {
  test("the hand off's receipt, and the page's notice with Add credit and Check again", async () => {
    noteNoCredit("openrouter", 402);
    const d = await runDelegate({ task: "Say hi [usage 100 10]", files: [], kind: "write", effort: "low", check: "never", maxOut: 1000 } as any, new AbortController().signal);
    expect(d.model.id).toBe(CLAUDE);
    expect(d.receipt).toContain("OpenRouter has no credit left, so its paid models were left out. Add credit there, or Leanfare keeps going on your other models.");
    const st = (await ui(url, "/api/state")).json;
    expect(st.notices.find((x: any) => x.kind === "credit")).toEqual({ kind: "credit", level: "warn", provider: "openrouter", url: "https://openrouter.ai/settings/credits",
      text: "OpenRouter has no credit left, so Leanfare leaves its paid models out (its free models keep working). Add credit there, or Leanfare keeps going on your other models." });
    expect(st.providers.find((p: any) => p.id === "openrouter").keyTrouble.noCredit).toMatchObject({ status: 402 });
    const doc = await openApp(url);
    const notice = [...doc.querySelectorAll("#notices .notice")].find((x: any) => x.textContent.includes("OpenRouter has no credit left")) as any;
    expect([...notice.querySelectorAll("a, button")].map((b: any) => b.textContent)).toEqual(["Add credit", "Check again"]);
    expect(notice.querySelector("a").getAttribute("href")).toBe("https://openrouter.ai/settings/credits");
  }, 20000);
});
