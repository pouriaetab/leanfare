// Steady (0.13.7): a small balance is not no credit (OpenRouter: "You requested up to 12288 tokens, but can only afford
// 8805"): the same model is asked again within what it covers. A receipt never says a provider's paid models were left
// out when one of them answered. Free models today shows only the models your keys can use now, and a long name stays
// in its tile. With nothing running, Live shows the last hand off and the month's work.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forgetAllowances } from "../src/allowance";
import { getModel } from "../src/data";
import { leftOutLines, runDelegate } from "../src/delegate";
import { AFFORD_MIN, runChat } from "../src/engine";
import { noCredit, noteAway, noteNoCredit } from "../src/keystate";
import { noteRefusal } from "../src/quota";
import { forgetLive } from "../src/live";
import { saveSettings } from "../src/settings";
import { forgetShare } from "../src/share";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";
import { KEYS } from "./fake";

const LARGE = "openrouter/acme/acme-large", CLAUDE = "anthropic/claude-sonnet-4-6", GEMINI = "google/gemini-3.8-flash";
const POOR = (n: number) => ({ status: 402, message: `This request requires more credits, or fewer max_tokens. You requested up to 12288 tokens, but can only afford ${n}. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account` });
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ mode: "save" });
  await keys("anthropic");
  expect((await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter })).json.ok).toBe(true);
  saveSettings({ ticked: [LARGE, CLAUDE] });
});
afterEach(closeApp);
const chat = (model: string, maxOut = 12_000) => runChat([{ role: "user", content: "Hi [usage 100 10]" }], model, new AbortController().signal, () => {}, "Chat", { maxOut });
const asked = () => fake.seen.filter((s) => s.provider === "openrouter" && s.method === "POST" && s.path.endsWith("/chat/completions"));

describe("a small balance is not no credit", () => {
  test("asked again within what the balance covers: it answers, says so, and OpenRouter stays in", async () => {
    fake.hooks.refuse = (b, p) => (p === "openrouter" && Number(b?.max_tokens ?? 0) > 8805 ? POOR(8805) : null);
    fake.seen.length = 0;
    const r = await chat(LARGE);
    expect(r.status).toBe("ok");
    expect(asked().map((s) => s.body.max_tokens)).toEqual([asked()[0].body.max_tokens, Math.floor(8805 * 0.97)]);
    expect(r.meta.notes).toContain(`${getModel(LARGE)!.label}: OpenRouter's balance covers an answer of up to 8,540 tokens, so Leanfare asked within that.`);
    expect(noCredit("openrouter")).toBe(null);
  });
  test(`a balance that covers less than ${AFFORD_MIN} tokens counts as no credit, as before`, async () => {
    fake.hooks.refuse = (_b, p) => (p === "openrouter" ? POOR(300) : null);
    const r = await chat(LARGE);
    expect(r.status).toBe("error");
    expect(r.meta.error).toContain("OpenRouter says the account has no credit left");
    expect(noCredit("openrouter")?.status).toBe(402);
  });
});

describe("the receipt", () => {
  test("never says a provider's paid models were left out when one of them answered", () => {
    noteNoCredit("openrouter", 402);
    const ticked = [getModel(LARGE)!, getModel(CLAUDE)!];
    expect(leftOutLines(ticked, getModel(LARGE)!)).toEqual([]); // the paid answer came from OpenRouter
    expect(leftOutLines(ticked, getModel(CLAUDE)!)).toEqual(["OpenRouter has no credit left, so its paid models were left out. Add credit there, or Leanfare keeps going on your other models."]);
  });
});

describe("Free models today", () => {
  test("only the models your keys can use now: not one with no quota for your key, nor one of a provider turning requests away", async () => {
    await reset({ ticked: ALL_TICKED });
    forgetAllowances(); forgetShare();
    await keys("google");
    saveSettings({ providers: { google: { on: true, free: true } } });
    const ids = async () => (await ui(url, "/api/share")).json.pools.map((p: any) => p.id);
    expect(await ids()).toContain(GEMINI);
    noteRefusal(GEMINI, "google", "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.8-flash", "limit");
    expect(await ids()).not.toContain(GEMINI);
    await reset({ ticked: ALL_TICKED });
    await keys("google");
    saveSettings({ providers: { google: { on: true, free: true } } });
    noteAway("google", 403, true);
    expect((await ids()).some((id: string) => id.startsWith("google/"))).toBe(false);
  });
  test("a long name is cut inside its line, never drawn over the next column", () => {
    const css = readFileSync(join(import.meta.dir, "..", "ui", "app.css"), "utf8");
    expect(css).toMatch(/\.ft-row \{[^}]*grid-template-columns: minmax\(0, 240px\)[^}]*\}/);
    expect(css).toMatch(/\.ft-name \{[^}]*text-overflow: ellipsis[^}]*\}/);
  });
});

describe("Live, with nothing running", () => {
  test("shows the last hand off and the month's work", async () => {
    await keys("deepseek");
    saveSettings({ ticked: ["deepseek/deepseek-v4-flash"] });
    await runDelegate({ task: "Say hi [usage 100 10]", files: [], kind: "write", effort: "low", check: "never", maxOut: 1000 } as any, new AbortController().signal);
    forgetLive(); // a minute later: the call is no longer live
    const doc = await openApp(url, { screen: "savings" });
    const idle = () => doc.querySelector("#liveCard .lv-idle");
    for (let i = 0; i < 200 && !idle(); i++) await Bun.sleep(30);
    expect(idle().textContent).toContain("Last hand off");
    expect(idle().textContent).toContain("DeepSeek V4 Flash");
    expect(idle().textContent).toContain("This month: 1 task,");
  }, 20000);
});
