// What a request costs, and what it is likely to cost before it is sent (the estimate).
import type { Prices } from "./data";

// Token counts in one shape, whichever provider reported them.
export interface Usage {
  uncached: number; // input tokens billed at the full input price
  cacheRead: number; // input tokens read from the provider's cache
  cacheWrite: number; // input tokens written to the cache for 5 minutes (Anthropic bills these)
  cacheWrite1h?: number; // input tokens written to the cache for an hour (Anthropic, twice the input price)
  output: number; // answer tokens, thinking included
}

export const ZERO: Usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
export const inputTokens = (u: Usage) => u.uncached + u.cacheRead + u.cacheWrite + (u.cacheWrite1h ?? 0);
export const LONG_CONTEXT = 200_000; // above this many input tokens, some models charge more for the whole request

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// OpenAI's format, also used by Google, OpenRouter, DeepSeek, xAI, Mistral and
// Ollama. prompt_tokens includes the cached ones.
export function fromOpenAIUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  const prompt = n(u.prompt_tokens ?? u.input_tokens);
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens);
  const written = n(u.prompt_tokens_details?.cache_write_tokens);
  const hour = Math.min(written, n(u.prompt_tokens_details?.cache_write_1h_tokens)); // Leanfare's own, for Claude behind this address
  let output = n(u.completion_tokens ?? u.output_tokens);
  // Some providers leave thinking tokens out of completion_tokens but in the
  // total; they are billed as output either way.
  const total = n(u.total_tokens);
  if (total && total - prompt > output) output = total - prompt;
  return { uncached: Math.max(0, prompt - cached - written), cacheRead: cached, cacheWrite: written - hour, cacheWrite1h: hour, output };
}

// Anthropic's format: input_tokens already excludes cache reads and writes.
// Cache writes come split by how long they are kept (cache_creation), or as one total.
export function fromAnthropicUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  const all = n(u.cache_creation_input_tokens);
  const hour = u.cache_creation && typeof u.cache_creation === "object" ? Math.min(all || Infinity, n(u.cache_creation.ephemeral_1h_input_tokens)) : 0;
  return {
    uncached: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: Math.max(0, (all || n(u.cache_creation?.ephemeral_5m_input_tokens) + hour) - hour),
    cacheWrite1h: hour,
    output: n(u.output_tokens),
  };
}

// The cost. Null when the model has no listed price. A request of more than 200k
// input tokens is priced at the model's long context prices when it has them
// (the whole request, as Google and Anthropic charge it). Claude's cache
// writes kept an hour cost twice the input price unless listed otherwise.
export function costOf(p: Prices, u: Usage): number | null {
  if (p.input === null || p.output === null) return null;
  const long = inputTokens(u) > LONG_CONTEXT && p.above200k ? p.above200k : null;
  const input = long?.input ?? p.input;
  const output = long?.output ?? p.output;
  const cacheRead = long?.cacheRead ?? p.cacheRead ?? input; // no separate cache price: cached input costs the full price
  const cacheWrite = long?.cacheWrite ?? p.cacheWrite ?? input;
  const cacheWrite1h = p.cacheWrite1h ?? input * 2;
  return (u.uncached * input + u.cacheRead * cacheRead + u.cacheWrite * cacheWrite + (u.cacheWrite1h ?? 0) * cacheWrite1h + u.output * output) / 1_000_000;
}

// About four characters per token in English text. An estimate, and labelled
// as one wherever it is shown (L1).
export const countTokens = (text: string) => Math.ceil(text.length / 4);

// The words in a message (images and documents are counted separately, below).
export function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("\n");
  return "";
}

// ---- images and documents ---------------------------------------------------
// Providers count an image as a few hundred to about 1,600 tokens (Claude:
// width x height / 750, at most about 1,600; GPT and Gemini less), and a PDF
// page as about 1,500 to 3,000 (its text plus a picture of the page). The
// estimate uses the typical figure; the budget reservation uses the high one.
export const IMAGE_TOKENS = { est: 1600, max: 3000 };
export const PDF_PAGE_TOKENS = { est: 2000, max: 3000 };

const B64 = /^data:([^;,]+);base64,/;

// Pages in a PDF, counted from its page objects (an estimate: no PDF library).
export function pdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const n = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return Math.max(1, n);
}
const pagesCache = new Map<string, number>();
function pagesOfBase64(b64: string): number {
  const k = `${b64.length}:${b64.slice(0, 64)}:${b64.slice(-64)}`;
  let n = pagesCache.get(k);
  if (n === undefined) {
    try { n = pdfPages(Uint8Array.from(Buffer.from(b64, "base64"))); } catch { n = 1; }
    if (pagesCache.size > 200) pagesCache.clear();
    pagesCache.set(k, n);
  }
  return n;
}

export interface Media { images: number; pdfPages: number; pdfs: number; est: number; max: number }

// Images and PDFs in a message, in OpenAI's parts or Anthropic's blocks. A part
// may also be a description without its data ({ type: "image" } or
// { type: "file", pages: 3 }), which the screen sends for estimates.
export function mediaOf(c: unknown, acc: Media = { images: 0, pdfPages: 0, pdfs: 0, est: 0, max: 0 }): Media {
  if (!Array.isArray(c)) return acc;
  for (const p of c as any[]) {
    if (!p || typeof p !== "object") continue;
    const t = p.type;
    if (t === "image_url" || t === "image" || t === "input_image") {
      acc.images++; acc.est += IMAGE_TOKENS.est; acc.max += IMAGE_TOKENS.max;
    } else if (t === "file" || t === "document" || t === "input_file") {
      const data: string = p.file?.file_data ?? p.file_data ?? (p.source?.type === "base64" ? p.source.data : "") ?? "";
      const media = (B64.exec(data)?.[1] ?? p.source?.media_type ?? (/\.pdf$/i.test(p.file?.filename ?? p.filename ?? "") ? "application/pdf" : "")) as string;
      if (p.source?.type === "text" && typeof p.source.data === "string") { const n = Math.ceil(p.source.data.length / 4); acc.est += n; acc.max += Buffer.byteLength(p.source.data); continue; }
      if (media !== "application/pdf" && !(typeof p.pages === "number")) continue;
      const pages = typeof p.pages === "number" && p.pages > 0 ? Math.ceil(p.pages) : data ? pagesOfBase64(data.replace(B64, "")) : 1;
      acc.pdfs++; acc.pdfPages += pages; acc.est += pages * PDF_PAGE_TOKENS.est; acc.max += pages * PDF_PAGE_TOKENS.max;
    } else if (t === "tool_result" && Array.isArray(p.content)) mediaOf(p.content, acc);
  }
  return acc;
}

export function mediaIn(messages: { content: unknown }[]): Media {
  const acc: Media = { images: 0, pdfPages: 0, pdfs: 0, est: 0, max: 0 };
  for (const m of messages) mediaOf(m?.content, acc);
  return acc;
}

// The estimate's input: about four characters a token, a few tokens of framing per message, plus images and documents.
export function promptTokens(messages: { role: string; content: unknown }[], system?: unknown): number {
  let chars = textOfContent(system).length;
  for (const m of messages) chars += textOfContent(m.content).length + 16; // a few tokens of framing per message
  return Math.ceil(chars / 4) + mediaIn(messages).est;
}

// The budget reservation's input: the most tokens a request can be. Everything it sends at one
// token per byte, except images and documents, which count at their high figure
// instead of their size (a 2 MB photo is not 2 million tokens).
export function promptMax(messages: unknown[], system?: unknown, tools?: unknown): number {
  const json = JSON.stringify([messages, system ?? null, tools ?? null], (k, v) => {
    if (typeof v !== "string" || v.length < 200) return v;
    if (B64.test(v)) return "";
    if (k === "data" || k === "file_data") return "";
    return v;
  });
  return Buffer.byteLength(json) + mediaIn(messages as { content: unknown }[]).max;
}
