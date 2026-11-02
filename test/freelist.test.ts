// Free models, ready to connect (freelist.ts, 0.13): the reviewed list with what each gives free and does with what is
// sent, one press to connect (the key, the free plan box, the free models ticked), the providers models.dev lists with
// free models shown apart as not reviewed, and the rows under the ChatGPT row.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { forgetRegistry } from "../src/providers";
import { settings } from "../src/settings";
import { boot, reset, ui } from "./app";
import { closeApp, openApp as open, win } from "./dom";
import { KEYS } from "./fake";

let url = "";
const m = (input: number | null, output: number | null) => ({ input, output, cacheRead: null, cacheWrite: null, context: 128000 });
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset();
  // A small models.dev list: Cloudflare (its address has the account in it), a provider with free models, a coding
  // plan's endpoint, and a built in one.
  writeFileSync(join(DATA_DIR, "models-dev.json"), JSON.stringify({ at: new Date().toISOString(), providers: {
    "cloudflare-workers-ai": { name: "Cloudflare Workers AI", env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"], api: null, doc: "https://developers.cloudflare.com/workers-ai/models/", models: { "@cf/openai/gpt-oss-120b": m(0.35, 0.75) } },
    chutes: { name: "Chutes", env: ["CHUTES_API_KEY"], api: "https://llm.chutes.ai/v1", doc: "https://chutes.ai", models: { "a:free": m(0, 0), "b:free": m(0, 0), c: m(1, 2) } },
    "zai-coding-plan": { name: "Z.AI Coding Plan", env: ["ZHIPU_API_KEY"], api: "https://api.z.ai/api/coding/paas/v4", doc: null, models: { "glm-5": m(0, 0) } },
    openrouter: { name: "OpenRouter", env: ["OPENROUTER_API_KEY"], api: "https://openrouter.ai/api/v1", doc: null, models: { "x:free": m(0, 0) } },
  } }));
  forgetRegistry();
});
afterEach(closeApp);
afterAll(() => { rmSync(join(DATA_DIR, "models-dev.json"), { force: true }); forgetRegistry(); }); // the next files read models.dev as they did
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }

describe("the list", () => {
  test("the reviewed providers, connected or not, and those found with free models but not reviewed", async () => {
    const r = await ui(url, "/api/free");
    expect(r.json.list.map((e: any) => `${e.name}: ${e.how}`)).toEqual(["Google Gemini: key", "Groq: key", "OpenRouter: signin", "Mistral: key", "Cloudflare Workers AI: account"]);
    expect(r.json.list.every((e: any) => e.connected === false)).toBe(true);
    expect(r.json.list.find((e: any) => e.id === "groq")).toMatchObject({ free: "gpt-oss-120b and more, 1,000 requests a day each, very fast", data: "Groq does not train on what you send", keyUrl: "https://console.groq.com/keys" });
    expect(r.json.found).toEqual([{ id: "chutes", name: "Chutes", free: 2, doc: "https://chutes.ai" }]); // not the coding plan, not a built in one
  });

  test("Connect with a key: the key is saved, the key is marked as a free plan, and its free models are ticked", async () => {
    const r = await ui(url, "/api/free/connect", { id: "groq", key: KEYS.groq });
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toMatch(/^Groq is connected/);
    expect(settings().providers.groq).toMatchObject({ on: true, free: true });
    expect(settings().ticked).toContain("groq/openai/gpt-oss-120b");
    expect((await ui(url, "/api/free")).json.list.find((e: any) => e.id === "groq").connected).toBe(true);
  });

  test("Cloudflare asks for its account ID too, and says where to find it", async () => {
    const r = await ui(url, "/api/free/connect", { id: "cloudflare-workers-ai", key: "cf-token-123456789", account: "not-an-id" });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("The account ID is 32 letters and digits");
  });
});

describe("on the screen", () => {
  test("the free rows sit under the ChatGPT row; Connect opens the key's page and a box for the key", async () => {
    const doc = await open(url);
    const opened: string[] = [];
    win.open = (u: string) => { opened.push(u); return null; };
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector("#free-groq"));
    const card = doc.querySelector("#workersSetting");
    expect(card.querySelector("#codexCard").compareDocumentPosition(card.querySelector("#free-groq")) & 4).toBe(4);
    expect(card.textContent).toContain("Free models: you make the free account, Leanfare does the rest.");
    expect(card.textContent).toContain("1 more with free models, not reviewed by Leanfare");
    ([...doc.querySelector("#free-groq").querySelectorAll("button")].find((b: any) => b.textContent === "Connect") as any).click();
    await waitFor(() => !!doc.querySelector("#free-groq .free-form"));
    expect(opened).toEqual(["https://console.groq.com/keys"]);
    const box = doc.querySelector('#free-groq input[aria-label="Groq key"]');
    box.value = KEYS.groq;
    ([...doc.querySelector("#free-groq").querySelectorAll("button")].find((b: any) => b.textContent === "Save") as any).click();
    await waitFor(() => !!doc.querySelector("#free-groq")?.textContent.includes("· connected"));
    expect(settings().providers.groq).toMatchObject({ free: true });
  }, 20000);
});
