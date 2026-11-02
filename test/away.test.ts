// Turned away (0.13.4): a provider that refuses a request for a reason that is neither the key nor credit. Groq answers
// 403 "Access denied. Please check your network settings." to some networks. Auto passes the work on at once, past that
// provider's other models, and its models are left out (at once when its words point at the network, else only once its
// free model list is turned away too), checked again every 30 minutes; an answer, or Check again, brings them back. A
// 403 about one model leaves that model out; one about the request is passed on and not remembered.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provider } from "../src/config";
import { getModel } from "../src/data";
import { runDelegate } from "../src/delegate";
import { runChat, usableModels } from "../src/engine";
import { keepKeysFresh, KEYS_EVERY, keyState, noteAway, providerAway, turnedAway } from "../src/keystate";
import { noQuota } from "../src/quota";
import { saveSettings } from "../src/settings";
import { plainError } from "../src/upstream";
import { now } from "../src/util";
import { boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const MINI = "openai/gpt-5-mini", GPT41 = "openai/gpt-4.1", CLAUDE = "anthropic/claude-sonnet-4-6";
const NETWORK = "OpenAI turned the request away (403): Access denied. Please check your network settings. It points at your network or location, not your key: a VPN or a proxy can cause it.";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ mode: "save" });
  await keys("openai", "anthropic");
  saveSettings({ ticked: [MINI, GPT41, CLAUDE] }); // Auto's picks: GPT-5 mini, GPT-4.1, then Claude
});
afterEach(async () => { process.env.LEANFARE_KEY_CHECKS = "off"; await closeApp(); });
const chat = (model = "auto") => runChat([{ role: "user", content: "Hi [usage 100 10]" }], model, new AbortController().signal, () => {});
const asked = (p: string) => fake.seen.filter((s) => s.provider === p && s.method === "POST").length;
async function waitFor(ok: () => boolean, ms = 3000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("a provider that turns the request away", () => {
  test("Groq's 403 about the network: Auto passes the request on, past that provider's other models, and leaves them out from then on", async () => {
    fake.hooks.blocked.add("openai");
    const r = await chat();
    expect([r.status, r.meta.model.id]).toEqual(["ok", CLAUDE]);
    expect(r.meta.notes).toContain(`${getModel(MINI)!.label} could not be used: OpenAI turned the request away (403), so Auto passed the request to its next pick.`);
    expect(asked("openai")).toBe(1); // GPT-4.1 was skipped, not asked
    expect(providerAway("openai")).toMatchObject({ status: 403, place: true });
    expect(keyState("openai").refused).toBeFalsy(); // not the key
    expect(usableModels().map((m) => m.id)).toEqual([CLAUDE]);
    fake.seen.length = 0;
    expect((await chat()).meta.model.id).toBe(CLAUDE);
    expect(asked("openai")).toBe(0); // not asked again
  });
  test("a model you named says what happened, and that it is not the key; an answer brings the provider back", async () => {
    fake.hooks.blocked.add("openai");
    const r = await chat(MINI);
    expect(r.status).toBe("error");
    expect(r.meta.error).toBe(`${NETWORK} Leanfare leaves OpenAI's models out of Auto for now and checks again every 30 minutes.`);
    fake.hooks.blocked.clear();
    expect((await chat(MINI)).status).toBe("ok"); // named: asked anyway
    expect(providerAway("openai")).toBe(null);
  });
  test("a 403 that does not point at the network leaves the provider out only when its model list is turned away too", async () => {
    fake.hooks.refuse = (_b, p) => (p === "openai" ? { status: 403, message: "Forbidden" } : null); // the request only
    let r = await chat();
    expect(r.meta.model.id).toBe(CLAUDE);
    expect(fake.seen.some((s) => s.provider === "openai" && s.method === "GET" && s.path.endsWith("/models"))).toBe(true); // checked, for free
    expect(providerAway("openai")).toBe(null); // its list works: that 403 was about the request
    expect(usableModels().map((m) => m.id)).toContain(MINI);
    fake.hooks.refuse = null;
    fake.hooks.blockedSays = "Forbidden";
    fake.hooks.blocked.add("openai"); // everything, the list too
    r = await chat();
    expect(r.meta.model.id).toBe(CLAUDE);
    expect(providerAway("openai")).toMatchObject({ status: 403, place: false });
  });
  test("a 403 about one model leaves out that model only; one about the request is passed on and not remembered", async () => {
    fake.hooks.refuse = (b, p) => (p === "openai" && b?.model === getModel(MINI)!.apiId ? { status: 403, message: `Project proj_abc does not have access to model ${getModel(MINI)!.apiId}` } : null);
    let r = await chat();
    expect(r.meta.model.id).toBe(GPT41); // the same provider's next model: only that one model was turned away
    expect(noQuota(MINI)?.why).toBe("denied");
    expect(providerAway("openai")).toBe(null);
    expect(usableModels().map((m) => m.id)).toEqual([GPT41, CLAUDE]);
    await reset({ mode: "save" });
    await keys("openai", "anthropic");
    saveSettings({ ticked: [MINI, GPT41, CLAUDE] });
    fake.hooks.refuse = (_b, p) => (p === "openai" ? { status: 403, message: "Your input was flagged by moderation." } : null);
    r = await chat();
    expect(r.meta.model.id).toBe(CLAUDE);
    expect(asked("openai")).toBe(2); // each model asked: a flag is about the request
    expect([noQuota(MINI), noQuota(GPT41), providerAway("openai")]).toEqual([null, null, null]);
  });
  test("what counts, and how it is said", () => {
    expect(turnedAway(403, "Access denied. Please check your network settings.")).toBe("provider");
    expect(turnedAway(400, "User location is not supported for the API use.")).toBe("provider");
    expect(turnedAway(403, "Country, region, or territory not supported")).toBe("provider");
    expect(turnedAway(451, "Unavailable For Legal Reasons")).toBe("provider");
    expect(turnedAway(403, "Project proj_abc does not have access to model gpt-5")).toBe("model");
    expect(turnedAway(403, "Your input was flagged by moderation.")).toBe("request");
    expect(turnedAway(403, "Invalid API Key")).toBe(null); // the key (keystate.ts)
    expect(turnedAway(403, "insufficient funds on this account")).toBe(null); // credit
    expect(turnedAway(400, "Invalid value at 'contents'.")).toBe(null); // the request: an error, as before
    expect(turnedAway(429, "Access denied")).toBe(null); // a limit
    const groq = provider("groq")!;
    expect(plainError(groq, 403, JSON.stringify({ error: { message: "Access denied. Please check your network settings." } }), null)).toBe("Groq turned the request away (403): Access denied. Please check your network settings. It points at your network or location, not your key: a VPN or a proxy can cause it.");
    expect(plainError(groq, 403, JSON.stringify({ error: { message: "Invalid API Key" } }), null)).toBe("Groq rejected the key: Invalid API Key");
    expect(plainError(groq, 403, JSON.stringify({ error: { message: "Forbidden" } }), null)).toBe("Groq turned the request away (403): Forbidden");
  });
});

describe("back when it answers again", () => {
  test("checked again every 30 minutes, in the background, with the free model list", async () => {
    process.env.LEANFARE_KEY_CHECKS = "on";
    fake.hooks.blocked.add("openai");
    noteAway("openai", 403, true);
    const t = now().getTime(), lists = () => fake.seen.filter((s) => s.provider === "openai" && s.path.endsWith("/models")).length;
    keepKeysFresh(t + KEYS_EVERY.recheck - 60_000); // not yet
    await Bun.sleep(100);
    expect(lists()).toBe(0);
    keepKeysFresh(t + KEYS_EVERY.recheck + 60_000);
    await waitFor(() => lists() === 1);
    await Bun.sleep(100);
    expect(providerAway("openai")).not.toBe(null); // still turned away
    fake.hooks.blocked.clear();
    keepKeysFresh(t + 2 * KEYS_EVERY.recheck + 120_000);
    await waitFor(() => providerAway("openai") === null);
    expect(providerAway("openai")).toBe(null);
    expect(usableModels().map((m) => m.id)).toContain(MINI);
  });
  test("Check again: still turned away, it stays and says why; answering, its models are back", async () => {
    fake.hooks.blocked.add("openai");
    noteAway("openai", 403, true);
    let r = await ui(url, "/api/keys/recheck", { provider: "openai" });
    expect(r.json).toMatchObject({ ok: false, message: NETWORK });
    expect(providerAway("openai")).not.toBe(null);
    fake.hooks.blocked.clear();
    r = await ui(url, "/api/keys/recheck", { provider: "openai" });
    expect(r.json).toMatchObject({ ok: true, message: "OpenAI answers again: its models are back." });
    expect(providerAway("openai")).toBe(null);
  });
});

describe("said where you look", () => {
  test("the hand off's receipt, the page's notice with Check again, and the provider's card", async () => {
    noteAway("openai", 403, true);
    const d = await runDelegate({ task: "Say hi [usage 100 10]", files: [], kind: "write", effort: "low", check: "never", maxOut: 1000 } as any, new AbortController().signal);
    expect(d.model.id).toBe(CLAUDE);
    expect(d.receipt).toContain("OpenAI is turning requests away, so its models were left out. Leanfare checks again every 30 minutes.");
    const st = (await ui(url, "/api/state")).json;
    expect(st.notices.find((x: any) => x.kind === "away")).toEqual({ kind: "away", level: "info", provider: "openai",
      text: "OpenAI blocks requests from your network (403), so Leanfare uses your other models and checks OpenAI again every 30 minutes by itself. Your key is fine." });
    expect(st.providers.find((p: any) => p.id === "openai").keyTrouble.away).toMatchObject({ status: 403, place: true });
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 100 && !doc.querySelector(".prov-head"); i++) await Bun.sleep(50);
    const notice = [...doc.querySelectorAll("#notices .notice")].find((x: any) => x.textContent.includes("OpenAI blocks requests from your network")) as any;
    expect([...notice.querySelectorAll("a, button")].map((b: any) => b.textContent)).toEqual(["Check again", "×"]);
    const head = [...doc.querySelectorAll(".prov-head")].find((x: any) => x.querySelector(".name")?.textContent === "OpenAI") as any;
    expect(head.querySelector(".chip").textContent).toBe("Turned away");
    head.click();
    await waitFor(() => doc.body.textContent.includes("OpenAI has blocked requests from your network since"));
    expect(doc.body.textContent).toContain("OpenAI has blocked requests from your network since Oct 21, 2026 (403), so its models are left out. Leanfare checks again every 30 minutes by itself; your key is fine.");
  }, 20000);
});
