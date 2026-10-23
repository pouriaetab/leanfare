// What a request costs, and what it is likely to cost before it is sent (the estimate).
import type { Prices } from "./data";

// Token counts in one shape, whichever provider reported them.
export interface Usage {
  uncached: number; // input tokens billed at the full input price
  cacheRead: number; // input tokens read from the provider's cache
  cacheWrite: number; // input tokens written to the cache (Anthropic bills these)
  output: number; // answer tokens, thinking included
}

export const ZERO: Usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
export const inputTokens = (u: Usage) => u.uncached + u.cacheRead + u.cacheWrite;

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// OpenAI's format, also used by Google, OpenRouter, DeepSeek, xAI, Mistral and
// Ollama. prompt_tokens includes the cached ones.
export function fromOpenAIUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  const prompt = n(u.prompt_tokens ?? u.input_tokens);
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens);
  const written = n(u.prompt_tokens_details?.cache_write_tokens);
  let output = n(u.completion_tokens ?? u.output_tokens);
  // Some providers leave thinking tokens out of completion_tokens but in the
  // total; they are billed as output either way.
  const total = n(u.total_tokens);
  if (total && total - prompt > output) output = total - prompt;
  return { uncached: Math.max(0, prompt - cached - written), cacheRead: cached, cacheWrite: written, output };
}

// Anthropic's format: input_tokens already excludes cache reads and writes.
export function fromAnthropicUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  return {
    uncached: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    output: n(u.output_tokens),
  };
}

// D4. Null when the model has no listed price.
export function costOf(p: Prices, u: Usage): number | null {
  if (p.input === null || p.output === null) return null;
  const cacheRead = p.cacheRead ?? p.input; // no separate cache price: cached input costs the full price
  const cacheWrite = p.cacheWrite ?? p.input;
  return (u.uncached * p.input + u.cacheRead * cacheRead + u.cacheWrite * cacheWrite + u.output * p.output) / 1_000_000;
}

// About four characters per token in English text. An estimate, and labelled
// as one wherever it is shown (L1).
export const countTokens = (text: string) => Math.ceil(text.length / 4);

export function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : p?.type === "image_url" || p?.type === "image" ? " ".repeat(3000) : "")).join("\n");
  return "";
}

export function promptTokens(messages: { role: string; content: unknown }[], system?: unknown): number {
  let chars = textOfContent(system).length;
  for (const m of messages) chars += textOfContent(m.content).length + 16; // a few tokens of framing per message
  return Math.ceil(chars / 4);
}
