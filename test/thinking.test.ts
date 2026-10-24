// Thinking: the effort setting in each provider's shape, and the thinking text
// shown on the chat screen, whichever way a provider sends it.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { refreshOpenRouter } from "../src/data";
import { ALL_TICKED, boot, fake, keys, ledger, post, readSSE, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const chatScreen = (body: unknown) => fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
const lastSent = () => [...fake.seen].reverse().find((s) => s.path.endsWith("/chat/completions") || s.path.endsWith("/v1/messages"))!.body;
const ask = async (model: string, effort?: string, content = "Plan my week [usage 100 10]") => readSSE(await chatScreen({ model, effort, messages: [{ role: "user", content }] }));
const doneOf = (events: any[]) => events.find((e) => e.type === "done")?.result;

describe("the effort setting", () => {
  test("OpenAI, Gemini and Grok get reasoning_effort, only at levels the model lists", async () => {
    await keys("openai", "google", "xai");
    await ask("openai/gpt-5-mini", "high");
    expect(lastSent().reasoning_effort).toBe("high");
    await ask("google/gemini-3.8-flash", "low");
    expect(lastSent().reasoning_effort).toBe("low");
    await ask("xai/grok-4.20-beta", "medium"); // Grok here lists only low and high
    expect(lastSent().reasoning_effort).toBeUndefined();
    await ask("openai/gpt-4.1", "high"); // not a thinking model
    expect(lastSent().reasoning_effort).toBeUndefined();
    await ask("openai/gpt-5-mini", "auto");
    expect(lastSent().reasoning_effort).toBeUndefined();
  });

  test("providers that decide for themselves get nothing, and nothing is claimed", async () => {
    await keys("deepseek");
    const { events } = await ask("deepseek/deepseek-v4-flash", "high");
    expect(lastSent().reasoning_effort).toBeUndefined();
    expect(events.find((e) => e.type === "done").result.effort).toBeNull();
    expect(ledger()[0].effort).toBeNull();
  });

  test("OpenRouter gets its own reasoning shape", async () => {
    await reset({ ticked: ["openrouter/acme/acme-large"], providers: { openrouter: { on: true } } });
    await keys("openrouter");
    await refreshOpenRouter();
    await ask("openrouter/acme/acme-large", "medium");
    expect(lastSent().reasoning).toEqual({ effort: "medium" });
  });

  test("newer Claude models think adaptively at the effort asked, with room to think", async () => {
    await keys("anthropic");
    await ask("anthropic/claude-sonnet-4-6", "high");
    const b = lastSent();
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.output_config).toEqual({ effort: "high" });
    expect(b.max_tokens).toBe(32000);
    expect(b.temperature).toBeUndefined();
  });

  test("older Claude models get a thinking budget inside their answer limit", async () => {
    await keys("anthropic");
    await ask("anthropic/claude-sonnet-4-5", "medium");
    expect(lastSent().thinking).toEqual({ type: "enabled", budget_tokens: 6000 });
    expect(lastSent().max_tokens).toBe(16000);
    // With a budget on, Leanfare's own answer limit holds and the thinking budget fits under it.
    await reset({ ticked: ALL_TICKED, budget: 5 });
    await keys("anthropic");
    await ask("anthropic/claude-sonnet-4-5", "high");
    expect(lastSent().max_tokens).toBe(4096);
    expect(lastSent().thinking).toEqual({ type: "enabled", budget_tokens: 3072 });
  });

  test("an app on the OpenAI address can ask Claude to think with reasoning_effort", async () => {
    await keys("anthropic");
    await post(`${url}/v1/chat/completions`, { model: "anthropic/claude-sonnet-4-6", reasoning_effort: "low", temperature: 0.2, messages: [{ role: "user", content: "Hi" }] });
    const b = lastSent();
    expect(b.output_config).toEqual({ effort: "low" });
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.temperature).toBeUndefined();
  });

  test("the effort sent is in the answer, the ledger and the setting", async () => {
    await keys("openai");
    const { events } = await ask("openai/gpt-5-mini", "low");
    expect(doneOf(events).effort).toBe("low");
    expect(ledger()[0].effort).toBe("low");
    expect((await ui(url, "/api/settings", { effort: "extreme" })).status).toBe(400);
    expect((await ui(url, "/api/settings", { effort: "high" })).json.settings.effort).toBe("high");
    await ask("openai/gpt-5-mini"); // no effort in the request: the setting applies
    expect(lastSent().reasoning_effort).toBe("high");
  });
});

describe("thinking text", () => {
  test.each([
    ["deepseek", "deepseek/deepseek-v4-flash"],
    ["mistral", "mistral/mistral-large-4"],
    ["anthropic", "anthropic/claude-haiku-4-5"],
  ])("%s: the thinking is shown apart from the answer", async (id, model) => {
    await keys(id);
    const { events } = await ask(model, undefined, "Think it over [think] [usage 100 10]");
    expect(events.filter((e) => e.type === "thinking").map((e) => e.text).join("")).toBe("Let me think.");
    const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(text.startsWith("Hello from")).toBe(true);
    expect(doneOf(events).thinking).toBe("Let me think.");
  });

  test("OpenRouter's reasoning field is read too", async () => {
    await reset({ ticked: ["openrouter/acme/acme-large"], providers: { openrouter: { on: true } } });
    await keys("openrouter");
    await refreshOpenRouter();
    const { events } = await ask("openrouter/acme/acme-large", undefined, "Think it over [think]");
    expect(doneOf(events).thinking).toBe("Let me think.");
  });

  test("Claude's whole (not streamed) answer carries its thinking as reasoning_content", async () => {
    await keys("anthropic");
    const r = await post(`${url}/v1/chat/completions`, { model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: "Think [think]" }] });
    const j = await r.json();
    expect(j.choices[0].message).toMatchObject({ content: "Hello from claude-haiku-4-5.", reasoning_content: "Let me think." });
  });
});
