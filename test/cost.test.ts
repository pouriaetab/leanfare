// What an answer costs, checked against known answers.
import { describe, expect, test } from "bun:test";
import { costOf, fromAnthropicUsage, fromOpenAIUsage, promptTokens } from "../src/cost";

const sonnet46 = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haiku45 = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const gpt5mini = { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: null };
const plain = (inTok: number, out: number, cached = 0) => ({ uncached: inTok - cached, cacheRead: cached, cacheWrite: 0, output: out });

describe("known answers", () => {
  test("Claude Sonnet 4.6, 2,000 in, 500 out", () => expect(costOf(sonnet46, plain(2000, 500))!.toFixed(8)).toBe("0.01350000"));
  test("Claude Haiku 4.5, 2,000 in, 500 out", () => expect(costOf(haiku45, plain(2000, 500))!.toFixed(8)).toBe("0.00450000"));
  test("GPT-5 mini, 2,000 in, 500 out", () => expect(costOf(gpt5mini, plain(2000, 500))!.toFixed(8)).toBe("0.00150000"));
  test("Claude Sonnet 4.6, 1,500 of 2,000 cached, 500 out", () => expect(costOf(sonnet46, plain(2000, 500, 1500))!.toFixed(8)).toBe("0.00945000"));
});

describe("cost rules", () => {
  test("cache writes use the cache write price", () => {
    expect(costOf(sonnet46, { uncached: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 })).toBe(3.75);
  });
  test("no cache price listed: cached input costs the full input price", () => {
    expect(costOf({ input: 2, output: 8, cacheRead: null, cacheWrite: null }, plain(1000, 0, 1000))!.toFixed(8)).toBe("0.00200000");
  });
  test("no listed price gives null, never a made-up number", () => {
    expect(costOf({ input: null, output: null, cacheRead: null, cacheWrite: null }, plain(10, 10))).toBeNull();
  });
});

describe("token counts in every provider's shape", () => {
  test("OpenAI: prompt_tokens includes the cached ones", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 2000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1500 } })).toEqual({ uncached: 500, cacheRead: 1500, cacheWrite: 0, output: 500 });
  });
  test("DeepSeek: prompt_cache_hit_tokens", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 })).toEqual({ uncached: 40, cacheRead: 60, cacheWrite: 0, output: 10 });
  });
  test("thinking tokens left out of completion_tokens but in the total are billed as output", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 420 })!.output).toBe(320);
  });
  test("Anthropic: input_tokens excludes cache reads and writes", () => {
    expect(fromAnthropicUsage({ input_tokens: 500, cache_read_input_tokens: 1500, cache_creation_input_tokens: 200, output_tokens: 50 })).toEqual({ uncached: 500, cacheRead: 1500, cacheWrite: 200, output: 50 });
  });
  test("missing usage gives null", () => {
    expect(fromOpenAIUsage(undefined)).toBeNull();
    expect(fromAnthropicUsage(null)).toBeNull();
  });
});

test("estimates count about four characters per token", () => {
  expect(promptTokens([{ role: "user", content: "x".repeat(4000) }])).toBe(1004);
});
