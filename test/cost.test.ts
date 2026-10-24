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

describe("cache writes kept an hour, and long prompts", () => {
  const sonnet = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  test("an hour long cache write costs twice the input price when no price is listed", () => {
    // 1,000 in + 1,000 written for an hour + 100 out: 1000 x 3 + 1000 x 6 + 100 x 15 = $0.0105
    expect(costOf(sonnet, { uncached: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 1000, output: 100 })!.toFixed(8)).toBe("0.01050000");
  });
  test("a listed hour long price wins", () => {
    expect(costOf({ ...sonnet, cacheWrite1h: 5 }, { uncached: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 1_000_000, output: 0 })).toBe(5);
  });
  test("more than 200k input tokens: the whole request at the long context prices, when the model has them", () => {
    const pro = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: null, above200k: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: null } };
    expect(costOf(pro, { uncached: 200_000, cacheRead: 0, cacheWrite: 0, output: 1000 })!.toFixed(6)).toBe("0.412000"); // at 200k: the base prices
    expect(costOf(pro, { uncached: 250_000, cacheRead: 0, cacheWrite: 0, output: 1000 })!.toFixed(6)).toBe("1.018000"); // 250k x 4 + 1k x 18
    expect(costOf({ ...pro, above200k: null }, { uncached: 250_000, cacheRead: 0, cacheWrite: 0, output: 1000 })!.toFixed(6)).toBe("0.512000");
  });
});

describe("token counts in every provider's shape", () => {
  test("OpenAI: prompt_tokens includes the cached ones", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 2000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1500 } })).toEqual({ uncached: 500, cacheRead: 1500, cacheWrite: 0, cacheWrite1h: 0, output: 500 });
  });
  test("DeepSeek: prompt_cache_hit_tokens", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 })).toEqual({ uncached: 40, cacheRead: 60, cacheWrite: 0, cacheWrite1h: 0, output: 10 });
  });
  test("thinking tokens left out of completion_tokens but in the total are billed as output", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 420 })!.output).toBe(320);
  });
  test("Anthropic: input_tokens excludes cache reads and writes", () => {
    expect(fromAnthropicUsage({ input_tokens: 500, cache_read_input_tokens: 1500, cache_creation_input_tokens: 200, output_tokens: 50 })).toEqual({ uncached: 500, cacheRead: 1500, cacheWrite: 200, cacheWrite1h: 0, output: 50 });
  });
  test("Anthropic: cache writes split by how long they are kept", () => {
    expect(fromAnthropicUsage({ input_tokens: 500, cache_creation_input_tokens: 1200, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 1000 }, output_tokens: 50 }))
      .toEqual({ uncached: 500, cacheRead: 0, cacheWrite: 200, cacheWrite1h: 1000, output: 50 });
    // Only the split, no total.
    expect(fromAnthropicUsage({ input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30 }, output_tokens: 1 })!.cacheWrite1h).toBe(30);
  });
  test("Claude behind the OpenAI address keeps the split on the way through", () => {
    expect(fromOpenAIUsage({ prompt_tokens: 2200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200, cache_write_1h_tokens: 1000 } }))
      .toEqual({ uncached: 1000, cacheRead: 0, cacheWrite: 200, cacheWrite1h: 1000, output: 50 });
  });
  test("missing usage gives null", () => {
    expect(fromOpenAIUsage(undefined)).toBeNull();
    expect(fromAnthropicUsage(null)).toBeNull();
  });
});

test("estimates count about four characters per token", () => {
  expect(promptTokens([{ role: "user", content: "x".repeat(4000) }])).toBe(1004);
});
