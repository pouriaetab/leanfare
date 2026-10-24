// The task guess and the best value pick.
import { beforeAll, describe, expect, test } from "bun:test";
import { guessTask, pickModel, resolveModel } from "../src/router";
import { getModel, loadCatalog, type Model } from "../src/data";
const FIXTURE = new URL("./fixtures/catalog.json", import.meta.url).pathname;

const ask = (text: string) => [{ role: "user", content: text }];
const none = () => null;
let all: Model[] = [];

beforeAll(() => {
  loadCatalog(FIXTURE);
  all = ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "openai/gpt-5-mini", "google/gemini-3.8-flash", "deepseek/deepseek-v4-flash", "xai/grok-4.20-beta", "mistral/mistral-large-4", "openai/gpt-4o", "openai/gpt-unrated"].map((id) => getModel(id)!);
});

describe("task guess", () => {
  const cases: [string, string][] = [
    ["Why does this throw?\n```python\nprint(x)\n```", "coding"],
    ["My python script has a bug in the json parsing", "coding"],
    ["def add(a, b):\n    return a + b", "coding"],
    ["Solve 3x + 2 = 11 for x", "math"],
    ["What is the derivative and the integral of sin x?", "math"],
    ["Write a short story about a lighthouse keeper", "creative_writing"],
    ["Compose a haiku about rain", "creative_writing"],
    ["Our startup's revenue and profit margin dropped; what pricing changes help?", "business"],
    ["Is this lease clause legal for a tenant?", "legal"],
    ["What are common symptoms and treatment of a sinus infection?", "medicine"],
    ["What is the capital of Australia?", "overall"],
    ["How do I add up the third column of a big CSV file in Python?", "coding"],
    ["What is 15% of 48,200?", "math"],
  ];
  for (const [text, task] of cases) test(`${task}: ${text.slice(0, 40)}`, () => expect(guessTask(ask(text)).task).toBe(task));

  test("plain English that looks like code words is not coding", () => {
    expect(guessTask(ask("Let me know what you think of my plan")).task).toBe("overall");
    expect(guessTask(ask("What's a good method for studying for my class?")).task).toBe("overall");
    expect(guessTask(ask("Plan a 3-4 day trip to Lisbon in 2026")).task).toBe("overall");
    expect(guessTask(ask("Who sang the most songs, Taylor Swift or Adele?")).task).toBe("overall");
    expect(guessTask(ask("How do I get rust off my bike?")).task).toBe("overall");
  });
  test("a long message is a long prompt", () => expect(guessTask(ask("Please summarise this. " + "The meeting covered many points. ".repeat(80))).task).toBe("longer_query"));
  test("the sixth question in a conversation is a long conversation", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => [{ role: "user", content: `And what about point ${i}?` }, { role: "assistant", content: "Here it is." }]).flat().slice(0, 11);
    expect(guessTask(msgs).task).toBe("multi_turn");
  });
  test("every guess says why and names the other possibility", () => {
    const g = guessTask(ask("My python script has a bug"));
    expect(g.why).toContain("python");
    expect(g.alt).toBe("overall");
  });
});

describe("best value pick", () => {
  test("each mode picks differently, and as defined", () => {
    const usable = all.filter((m) => m.ratings.overall !== undefined && !m.retire);
    // overall: best is Gemini 3.8 Flash (1496)
    expect(pickModel(ask("What is the capital of Australia?"), usable, "best", none)!.model.id).toBe("google/gemini-3.8-flash"); // within 15: only Gemini
    expect(pickModel(ask("What is the capital of Australia?"), usable, "balanced", none)!.model.id).toBe("xai/grok-4.20-beta"); // within 40: Gemini, Sonnet, Grok; Grok is cheapest
    expect(pickModel(ask("What is the capital of Australia?"), usable, "save", none)!.model.id).toBe("deepseek/deepseek-v4-flash"); // within 80: DeepSeek is cheapest
  });
  test("the task's own rating is used (coding)", () => {
    const usable = all.filter((m) => m.ratings.overall !== undefined && !m.retire);
    const p = pickModel(ask("Fix the bug in my python function"), usable, "best", none)!;
    expect(p.guess.task).toBe("coding");
    expect(p.model.id).toBe("anthropic/claude-sonnet-4-6"); // best for coding (1490)
  });
  test("the reason names the task, the mode, the model and the numbers", () => {
    const usable = all.filter((m) => m.ratings.overall !== undefined && !m.retire);
    const p = pickModel(ask("What is the capital of Australia?"), usable, "balanced", none)!;
    expect(p.reason).toContain("Everyday questions");
    expect(p.reason).toContain("Balanced");
    expect(p.reason).toContain("Grok 4.20 Beta");
    expect(p.reason).toMatch(/rated 1471, 25 under Gemini 3\.8 Flash/);
  });
  test("never picks a retired model, an unrated one, or one you did not tick", () => {
    const usable = [getModel("openai/gpt-4o")!, getModel("openai/gpt-unrated")!, getModel("anthropic/claude-haiku-4-5")!];
    const p = pickModel(ask("hello"), usable, "save", none)!;
    expect(p.model.id).toBe("anthropic/claude-haiku-4-5");
    for (const c of p.candidates) expect(usable.map((m) => m.id)).toContain(c.model.id);
    expect(p.candidates.map((c) => c.model.id)).not.toContain("openai/gpt-4o");
  });
  test("no rated model at all: no pick (the engine then says so)", () => {
    expect(pickModel(ask("hello"), [getModel("openai/gpt-unrated")!], "balanced", none)).toBeNull();
  });
});

describe("model names", () => {
  test("Leanfare ids, provider ids, llmledger keys and OpenRouter-style names resolve", () => {
    expect(resolveModel("google/gemini-3.8-flash")?.id).toBe("google/gemini-3.8-flash");
    expect(resolveModel("gemini/gemini-3.8-flash")?.id).toBe("google/gemini-3.8-flash");
    expect(resolveModel("gemini-3.8-flash")?.id).toBe("google/gemini-3.8-flash");
    expect(resolveModel("claude-sonnet-4-6")?.id).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveModel("no-such-model")).toBeNull();
  });
});
