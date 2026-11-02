// Retiring models (0.13.6): a free model's successor must be free, so it never turns into a paid one; a free model
// retiring needs nothing from you, so it gets no notice; the rest share one line, which × hides until another model
// retires. OpenRouter's free models say "(free)" once.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildOpenRouter, setExtraModels, type Model } from "../src/data";
import { successor } from "../src/retire";
import { saveSettings } from "../src/settings";
import { setNow } from "../src/util";
import { boot, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const model = (over: Partial<Model>): Model => ({
  id: "x/y", provider: "openrouter", apiId: "y", source: "test", maker: "acme", name: "y", label: "Y", input: 1, output: 1, cacheRead: null, cacheWrite: null,
  context: 128_000, skills: [], added: "2026-01-01", retire: null, ratings: {}, ...over,
}) as Model;
// OpenRouter ends a model's free copy while its paid copy goes on (Inkling, 4 Nov 2026).
const FREE = model({ id: "openrouter/acme/inkling:free", apiId: "acme/inkling:free", name: "inkling", label: "Inkling (free)", input: 0, output: 0, free: true, retire: "2026-11-04" });
const PAID = model({ id: "openrouter/acme/inkling", apiId: "acme/inkling", name: "inkling", label: "Inkling", input: 0.2, output: 0.8, added: "2026-02-01" });
const SONNET45 = "anthropic/claude-sonnet-4-5", GPT4O = "openai/gpt-4o"; // retire 2026-11-10 and 2026-10-01 in the test catalogue
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({}); setExtraModels([FREE, PAID], new Set(["openrouter"])); });
afterEach(async () => { setExtraModels([], new Set(["openrouter"])); await closeApp(); });
const retiring = async () => (await ui(url, "/api/state")).json.notices.filter((x: any) => x.kind === "retire");

describe("free stays free", () => {
  test("a free model's successor is free: its paid copy is never picked, and with no free one there is none", () => {
    expect(successor(FREE, "2026-11-02")).toBe(null);
    const next = model({ id: "openrouter/acme/inkling-2:free", apiId: "acme/inkling-2:free", name: "inkling-2", label: "Inkling 2 (free)", input: 0, output: 0, free: true, added: "2026-10-30" });
    setExtraModels([FREE, PAID, next], new Set(["openrouter"]));
    expect(successor(FREE, "2026-11-02")?.id).toBe(next.id);
    expect(successor(model({ ...PAID, id: "openrouter/acme/inkling-old", added: "2025-01-01" }), "2026-11-02")?.id).toBe(PAID.id); // a paid one goes to a paid one, not to the newer free copy
  });
  test("a free model retiring gets no notice; a paid one you use does, on one calm line with its date in words", async () => {
    setNow("2026-11-02T12:00:00Z");
    saveSettings({ ticked: [FREE.id, SONNET45] });
    const ns = await retiring();
    expect(ns).toEqual([{ kind: "retire", level: "info", model: SONNET45, models: [SONNET45], text: "Claude Sonnet 4.5 retires on Nov 10, 2026, in 8 days; Leanfare will then use Claude Sonnet 4.6." }]);
    saveSettings({ ticked: [FREE.id] });
    expect(await retiring()).toEqual([]); // only a free one: nothing to say
  });
});

describe("one line, closed with ×", () => {
  test("two models share one line; × hides it; a model that retires later brings it back with only that one", async () => {
    setNow("2026-10-20T12:00:00Z");
    saveSettings({ ticked: [SONNET45, GPT4O, FREE.id] });
    let ns = await retiring();
    expect(ns.length).toBe(1);
    expect(ns[0]).toMatchObject({ level: "info", models: [GPT4O, SONNET45], text: "Models you use are retiring: GPT-4o retired on Oct 1, 2026 (now GPT-4.1); Claude Sonnet 4.5 on Nov 10, 2026 (then Claude Sonnet 4.6)." });
    expect((await ui(url, "/api/notices/hide", { kind: "retire" })).json.ok).toBe(true);
    expect(await retiring()).toEqual([]);
    const later = model({ id: "openrouter/acme/solo", apiId: "acme/solo", name: "solo", label: "Solo", input: 1, output: 2, retire: "2026-11-15" });
    setExtraModels([FREE, PAID, later], new Set(["openrouter"]));
    saveSettings({ ticked: [SONNET45, GPT4O, later.id] });
    ns = await retiring();
    expect(ns).toEqual([{ kind: "retire", level: "warn", model: later.id, models: [later.id], text: "Solo retires on Nov 15, 2026, in 26 days, and has no replacement yet: pick another model in Settings." }]);
  });
  test("on the page: the line has Settings and ×, and × takes it away", async () => {
    setNow("2026-10-20T12:00:00Z");
    saveSettings({ ticked: [SONNET45] });
    const doc = await openApp(url);
    const line = () => [...doc.querySelectorAll("#notices .notice")].find((x: any) => x.textContent.includes("Claude Sonnet 4.5 retires")) as any;
    for (let i = 0; i < 100 && !line(); i++) await Bun.sleep(30);
    expect([...line().querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Settings", "×"]);
    line().querySelector(".notice-x").click();
    for (let i = 0; i < 100 && line(); i++) await Bun.sleep(30);
    expect(line()).toBeFalsy();
  }, 20000);
});

describe("OpenRouter's free models", () => {
  test("say (free) once, with tidy spaces", () => {
    const ms = buildOpenRouter({ data: [
      { id: "thinkingmachines/inkling-small:free", name: "Thinking Machines: Inkling Small (free)", pricing: { prompt: "0", completion: "0" } },
      { id: "google/gemma-4-26b-a4b-it:free", name: "Google: Gemma 4 26B A4B  (free)", pricing: { prompt: "0", completion: "0" } },
      { id: "thinkingmachines/inkling-small", name: "Thinking Machines: Inkling Small", pricing: { prompt: "0.0000002", completion: "0.0000008" } },
    ] }, { models: [] } as any);
    expect(ms.map((m) => m.label)).toEqual(["Gemma 4 26B A4B (free)", "Inkling Small", "Inkling Small (free)"]);
  });
});
