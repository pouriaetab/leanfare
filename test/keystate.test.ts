// A key a provider refuses, and a key that expires (0.13.1): a refusal (401, or Google's 400 "API key expired") is noted
// and that provider's models are left out, Auto passes the request to a model of another provider, the receipt and the
// page say the key may have expired, with one press to make a new one; a new key, an answer, or a check that finds the
// key working again clears it. OpenRouter says when its key expires: the page says so from 7 days before, and after
// that day its models are left out.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runDelegate } from "../src/delegate";
import { runChat, usableModels } from "../src/engine";
import { keepKeysFresh, keyNotices, keyRefusal, keyState, keyUnusable, KEYS_EVERY, noteRefused } from "../src/keystate";
import { now } from "../src/util";
import { boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp, win } from "./dom";
import { KEYS } from "./fake";

const GEMINI = "google/gemini-3.8-flash", CLAUDE = "anthropic/claude-sonnet-4-6";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ ticked: [GEMINI, CLAUDE], mode: "save" });
  await keys("google", "anthropic");
});
afterEach(async () => { process.env.LEANFARE_KEY_CHECKS = "off"; await closeApp(); });
const chat = () => runChat([{ role: "user", content: "Hi [usage 100 10]" }], "auto", new AbortController().signal, () => {});
const DAY = 86_400_000;
async function waitFor(ok: () => boolean, ms = 3000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("a key the provider refuses", () => {
  test("Auto passes the request to a model of another provider, says why, and leaves that provider's models out from then on", async () => {
    fake.hooks.revoked.add("google");
    const r = await chat();
    expect([r.status, r.meta.model.id]).toEqual(["ok", CLAUDE]);
    expect(r.meta.notes).toContain("Gemini 3.8 Flash could not be used: Google Gemini refused your key, which may have expired, so Auto passed the request to its next pick.");
    expect(keyState("google").refused?.status).toBe(401);
    expect(usableModels().map((m) => m.id)).toEqual([CLAUDE]);
    fake.seen.length = 0;
    const again = await chat();
    expect(again.meta.model.id).toBe(CLAUDE);
    expect(fake.seen.some((s) => s.provider === "google")).toBe(false); // not asked again
  });
  test("a model you named says the key may have expired and where to make a new one", async () => {
    fake.hooks.revoked.add("google");
    const r = await runChat([{ role: "user", content: "Hi" }], GEMINI, new AbortController().signal, () => {});
    expect(r.status).toBe("error");
    expect(r.meta.error).toBe("Google Gemini rejected the key: wrong key for this provider. Keys can expire: make a new Google Gemini key in Leanfare's page (Settings, Google Gemini).");
  });
  test("a hand off's receipt says so; the page shows it with its provider; a new key clears it", async () => {
    noteRefused("google", 401);
    const d = await runDelegate({ task: "Say hi [usage 100 10]", files: [], kind: "write", effort: "low", check: "never", maxOut: 1000 } as any, new AbortController().signal);
    expect(d.model.id).toBe(CLAUDE);
    expect(d.receipt).toContain("Google Gemini refused your key, so its models were left out. Keys can expire: make a new one in Leanfare's page.");
    const st = (await ui(url, "/api/state")).json;
    const n = st.notices.find((x: any) => x.kind === "key");
    expect(n).toMatchObject({ level: "error", provider: "google" });
    expect(n.text).toMatch(/^Google Gemini refused your key \(401\) on Oct 21, 2026, so Leanfare leaves its models out\. Keys can expire, and yours may have: make a new one\.$/);
    expect(st.providers.find((p: any) => p.id === "google").keyTrouble.refused.status).toBe(401);
    const saved = await ui(url, "/api/keys", { provider: "google", key: KEYS.google });
    expect(saved.json.ok).toBe(true);
    expect(keyState("google").refused).toBeFalsy();
    expect(saved.json.state.notices.some((x: any) => x.kind === "key")).toBe(false);
  });
  test("Check again: still refused, it stays and says so; working again, it is cleared", async () => {
    noteRefused("google", 401);
    fake.hooks.revoked.add("google");
    let r = await ui(url, "/api/keys/recheck", { provider: "google" });
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toContain("Google Gemini rejected the key");
    expect(keyUnusable("google")).toBe(true);
    fake.hooks.revoked.delete("google");
    r = await ui(url, "/api/keys/recheck", { provider: "google" });
    expect(r.json).toMatchObject({ ok: true, message: "Google Gemini takes your key again." });
    expect(keyUnusable("google")).toBe(false);
    expect((await ui(url, "/api/keys/recheck", { provider: "nobody" })).status).toBe(400);
  });
  test("checked again by itself after 30 minutes, in the background; an answer from the provider clears it too", async () => {
    process.env.LEANFARE_KEY_CHECKS = "on";
    noteRefused("google", 401);
    keepKeysFresh(now().getTime() + KEYS_EVERY.recheck - 60_000); // not yet
    await Bun.sleep(100);
    expect(keyUnusable("google")).toBe(true);
    keepKeysFresh(now().getTime() + KEYS_EVERY.recheck + 60_000);
    await waitFor(() => !keyUnusable("google"));
    expect(keyUnusable("google")).toBe(false);
    noteRefused("google", 401);
    const r = await runChat([{ role: "user", content: "Hi" }], GEMINI, new AbortController().signal, () => {}); // named: asked anyway
    expect(r.status).toBe("ok");
    expect(keyUnusable("google")).toBe(false);
  });
  test("what counts as the key refused: 401, and a 400 or 403 whose words are about the key; not one about a model or the request", async () => {
    expect(keyRefusal(401, "OpenAI rejected the key: Incorrect API key provided")).toBe(true);
    expect(keyRefusal(400, "Google Gemini rejected the key: API key expired. Please renew the API key.")).toBe(true);
    expect(keyRefusal(400, "Google Gemini rejected the key: API_KEY_INVALID")).toBe(true);
    expect(keyRefusal(403, "Groq rejected the key: Invalid API Key")).toBe(true);
    expect(keyRefusal(403, "OpenAI rejected the key: Project does not have access to model gpt-5")).toBe(false);
    expect(keyRefusal(400, "Google Gemini rejected the key: Invalid value at 'contents'.")).toBe(false);
    expect(keyRefusal(429, "invalid api key")).toBe(false);
    fake.hooks.refuse = (_b, provider) => (provider === "google" ? { status: 403, message: "Permission denied: this model is not available in your region." } : null);
    await chat();
    expect(keyState("google").refused).toBeFalsy();
  });
});

describe("a key that expires", () => {
  test("OpenRouter says when: read as the key is saved, said from 7 days before, and after that day its models are left out", async () => {
    const t = now().getTime();
    const in5 = new Date(t + 5 * DAY).toISOString();
    fake.oauth.expiresAt = in5;
    const r = await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter });
    expect(r.json.ok).toBe(true);
    expect(keyState("openrouter").expires).toBe(in5);
    const n = r.json.state.notices.find((x: any) => x.provider === "openrouter");
    expect(n).toMatchObject({ kind: "expires", level: "warn", text: "Your OpenRouter key expires on Oct 26, 2026, in 5 days. Make a new one before then." });
    expect(r.json.state.providers.find((p: any) => p.id === "openrouter").keyTrouble).toEqual({ refused: null, expires: in5 });
    expect(keyNotices(t - 3 * DAY).some((x) => x.provider === "openrouter")).toBe(false); // 8 days before: nothing yet
    expect(keyUnusable("openrouter", t + 6 * DAY)).toBe(true);
    expect(keyNotices(t + 6 * DAY).find((x) => x.provider === "openrouter")).toEqual({ kind: "key", level: "error", provider: "openrouter", text: "Your OpenRouter key expired on Oct 26, 2026, so Leanfare leaves its models out. Make a new one to use OpenRouter again." });
    // A key with no end date: nothing to say.
    fake.oauth.expiresAt = null;
    await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter });
    expect(keyState("openrouter").expires).toBe(null);
    expect(keyNotices(t + 400 * DAY).some((x) => x.provider === "openrouter")).toBe(false);
  });
  test("read again once a day, in the background: a key given an end date later is noticed", async () => {
    process.env.LEANFARE_KEY_CHECKS = "on";
    await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter });
    const in3 = new Date(now().getTime() + 3 * DAY).toISOString();
    fake.oauth.expiresAt = in3;
    keepKeysFresh(now().getTime() + 60_000); // read a minute ago: not yet
    await Bun.sleep(100);
    expect(keyState("openrouter").expires).toBe(null);
    keepKeysFresh(now().getTime() + KEYS_EVERY.read + 60_000);
    await waitFor(() => keyState("openrouter").expires === in3);
    expect(keyState("openrouter").expires).toBe(in3);
  });
});

describe("on the page", () => {
  test("the notices: Make a new key opens the key's page and the box for it, Check again asks again, OpenRouter signs in again", async () => {
    await keys("openrouter");
    noteRefused("google", 401);
    fake.oauth.expiresAt = new Date(now().getTime() + 2 * DAY).toISOString();
    await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter });
    const doc = await openApp(url);
    const notices = [...doc.querySelectorAll("#notices .notice")];
    const google = notices.find((x: any) => x.textContent.includes("Google Gemini refused your key"))!;
    const or = notices.find((x: any) => x.textContent.includes("Your OpenRouter key expires"))!;
    expect([...google.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Make a new key", "Check again"]);
    expect([...or.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Sign in again"]);
    const opened: string[] = [];
    win.open = (u: string) => { opened.push(u); return null; };
    google.querySelector("button").click();
    expect(opened).toEqual(["https://aistudio.google.com/apikey"]);
    expect(doc.querySelector("#tab-settings").classList.contains("on")).toBe(true);
    const input = doc.querySelector('input[data-keep="google"]');
    expect(input).toBeTruthy();
    expect(doc.activeElement).toBe(input);
    expect(input.closest(".prov").querySelector(".chip").textContent).toBe("Key refused");
    expect(input.closest(".prov").textContent).toContain("Google Gemini refused this key on Oct 21, 2026 (401), so its models are left out.");
    google.querySelectorAll("button")[1].click(); // Check again: the key works again here
    await waitFor(() => !doc.querySelector("#notices").textContent.includes("Google Gemini refused your key"));
    expect(doc.querySelector("#notices").textContent).not.toContain("Google Gemini refused your key");
  }, 20000);
});
