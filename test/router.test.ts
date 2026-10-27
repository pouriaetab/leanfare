// The task guess and the best value pick.
import { beforeAll, describe, expect, test } from "bun:test";
import { guessTask, pickModel, resolveModel } from "../src/router";
import { getModel, loadCatalog, type Model } from "../src/data";
import { FIXTURE } from "./app";

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

describe("speed", () => {
  test("a long pasted line is guessed in milliseconds, not seconds", () => {
    const dna = Array.from({ length: 250_000 }, (_, i) => "ACGT"[(i * 7 + (i >> 3)) % 4]).join("");
    let t0 = performance.now();
    guessTask([{ role: "user", content: "Find the start codons in this sequence:\n" + dna }]);
    expect(performance.now() - t0).toBeLessThan(250);
    for (const text of ["a.b(" + "x".repeat(250_000), "SELECT " + "x ".repeat(120_000), "a.".repeat(120_000)]) {
      t0 = performance.now();
      guessTask([{ role: "user", content: text }]);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
});

describe("at the same quality: the cheapest, the fastest, or the cheapest within a time", () => {
  // Balanced, an everyday question: Gemini 3.8 Flash (1496), Claude Sonnet 4.6 (1472) and Grok 4.20 Beta
  // (1471) are within reach; Grok is the cheapest. Here Gemini answers in 2 s, Sonnet in 8, Grok in 12.
  const SECS: Record<string, number> = { "google/gemini-3.8-flash": 2, "anthropic/claude-sonnet-4-6": 8, "xai/grok-4.20-beta": 12 };
  const timeOf = (m: Model) => ({ seconds: SECS[m.id] ?? 30, measured: m.id !== "anthropic/claude-sonnet-4-6" });
  const usable = () => all.filter((m) => m.ratings.overall !== undefined && !m.retire);
  const q = ask("What is the capital of Australia?");

  test("cheapest is as before, and says nothing about time", () => {
    const p = pickModel(q, usable(), "balanced", none, undefined, undefined, "cheapest", timeOf)!;
    expect(p.model.id).toBe("xai/grok-4.20-beta");
    expect(p.reason).not.toContain(" It is ");
    expect(p.cheapest.model.id).toBe("xai/grok-4.20-beta");
    expect(p.fastest!.model.id).toBe("google/gemini-3.8-flash");
    expect(p.candidates[1].seconds).toBeDefined();
  });
  test("fastest takes the quickest of those within reach, whatever it costs, and says how long", () => {
    const p = pickModel(q, usable(), "balanced", none, undefined, undefined, "fastest", timeOf)!;
    expect(p.model.id).toBe("google/gemini-3.8-flash");
    expect(p.reason).toContain("Gemini 3.8 Flash is the best rated for this (1496).");
    expect(p.reason).toContain("It is the fastest of the 3 within reach: about 2 s.");
    expect(p.candidates.slice(0, 3).map((c) => c.model.id)).toEqual(["google/gemini-3.8-flash", "anthropic/claude-sonnet-4-6", "xai/grok-4.20-beta"]); // then by time, for fallback
  });
  test("within N seconds: the cheapest of those expected in time; the slower ones come after, fastest first", () => {
    const p = pickModel(q, usable(), "balanced", none, undefined, undefined, 10, timeOf)!;
    const inTime = p.candidates.filter((c) => c.seconds! <= 10);
    expect(inTime.map((c) => c.model.id).sort()).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3.8-flash"]);
    expect(p.model.id).toBe([...inTime].sort((a, b) => a.estimate! - b.estimate!)[0].model.id);
    expect(p.reason).toContain("It is the cheapest of the 2 expected within 10 s");
    expect(p.candidates[2].model.id).toBe("xai/grok-4.20-beta");
    // A time from no answers yet is said to be a rough guess.
    const sonnet = pickModel(q, usable().filter((m) => m.id !== "google/gemini-3.8-flash"), "balanced", none, undefined, undefined, 10, timeOf)!;
    expect(sonnet.model.id).toBe("anthropic/claude-sonnet-4-6");
    expect(sonnet.reason).toContain("about 8 s (a rough guess).");
  });
  test("when none is expected in time, the fastest, and the reason says so", () => {
    const p = pickModel(q, usable(), "balanced", none, undefined, undefined, 1, timeOf)!;
    expect(p.model.id).toBe("google/gemini-3.8-flash");
    expect(p.reason).toContain("It is the fastest, since none of the 3 within reach is expected within 1 s: about 2 s.");
  });
  test("speed never trades quality: a faster model outside the mode's reach is not picked", () => {
    const fastDeepSeek = (m: Model) => ({ seconds: m.id === "deepseek/deepseek-v4-flash" ? 0.5 : SECS[m.id] ?? 30, measured: true });
    expect(pickModel(q, usable(), "balanced", none, undefined, undefined, "fastest", fastDeepSeek)!.model.id).toBe("google/gemini-3.8-flash"); // DeepSeek is 58 under the best
    expect(pickModel(q, usable(), "save", none, undefined, undefined, "fastest", fastDeepSeek)!.model.id).toBe("deepseek/deepseek-v4-flash"); // within Save more's 80
  });
  test("with no times to go by, every choice falls back to the cheapest", () => {
    const p = pickModel(q, usable(), "balanced", none, undefined, undefined, "fastest")!;
    expect(p.model.id).toBe("xai/grok-4.20-beta");
    expect(p.fastest).toBeNull();
  });
});
