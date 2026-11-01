// Live tokens (0.12): the model calls running now, and those that ended in the last minute and a half, as numbers
// only: which model, for what (a hand off, its check, a plan's part, the chat, an app through Leanfare's address), and
// its tokens by kind as they come: new input, cached input, thinking and written. Words are counted, never kept.
// Until a provider gives its own counts, input is Leanfare's estimate and thinking and writing are about four
// characters a token (exact: false); its counts, when they come, take their place (exact: true).
// Savings' Live card reads it as a stream (GET /api/live/stream); the live tool and the live card in Claude read it once.
import type { Model } from "./data";
import type { Usage } from "./cost";

export interface LiveCall {
  id: string; source: string; label: string;
  model: { id: string; label: string; provider: string } | null;
  started: number; first: number | null; ended: number | null; // when it began, wrote its first token, ended
  input: number; cached: number; thinking: number; written: number; // tokens
  exact: boolean; // the provider's own counts (else Leanfare's estimate)
}
interface Inner extends LiveCall { thinkChars: number; writeChars: number; usage: Usage | null }

const calls = new Map<string, Inner>();
export const LIVE_KEEP = 90_000; // an ended call stays this long (the lanes show the last 60 seconds)
const MOST_ENDED = 60;
let version = 0; // grows with every change: the stream sends only when something changed
export const liveVersion = () => version;
const touch = () => { version++; };
const tok = (chars: number) => Math.ceil(chars / 4);
const who = (m: Pick<Model, "id" | "label" | "provider"> | null | undefined) => (m ? { id: m.id, label: m.label, provider: m.provider } : null);

export function liveStart(id: string, source: string, label: string, model: Pick<Model, "id" | "label" | "provider"> | null, input: number, at = Date.now()) {
  calls.set(id, { id, source, label, model: who(model), started: at, first: null, ended: null, input: Math.max(0, Math.round(input)), cached: 0, thinking: 0, written: 0, exact: false, thinkChars: 0, writeChars: 0, usage: null });
  prune(at);
  touch();
}
// The model that took it, when Auto passed it on.
export function liveModel(id: string, model: Pick<Model, "id" | "label" | "provider">) {
  const c = calls.get(id);
  if (c && c.model?.id !== model.id) { c.model = who(model); touch(); }
}
// Text as it streams: what it wrote and what it thought, in characters.
export function liveAdd(id: string, written: number, thinking: number, at = Date.now()) {
  const c = calls.get(id);
  if (!c || (!written && !thinking)) return;
  if (c.first === null) c.first = at;
  c.writeChars += written; c.thinkChars += thinking;
  fold(c);
  touch();
}
// The provider's own counts: input, cache and output (thinking is part of output; its share is what was thought).
export function liveUsage(id: string, u: Usage) {
  const c = calls.get(id);
  if (!c) return;
  c.usage = u;
  fold(c);
  touch();
}
function fold(c: Inner) {
  const thought = tok(c.thinkChars), wrote = tok(c.writeChars);
  if (c.usage) {
    c.input = c.usage.uncached + c.usage.cacheWrite + (c.usage.cacheWrite1h ?? 0);
    c.cached = c.usage.cacheRead;
    c.exact = true;
    if (c.usage.output > 0) { c.thinking = Math.min(thought, c.usage.output); c.written = c.usage.output - c.thinking; return; }
  }
  c.thinking = thought; c.written = wrote;
}
export function liveEnd(id: string, at = Date.now()) {
  const c = calls.get(id);
  if (!c || c.ended !== null) return;
  c.ended = at;
  touch();
}

function prune(at: number) {
  const ended = [...calls.values()].filter((c) => c.ended !== null).sort((a, b) => b.ended! - a.ended!);
  ended.forEach((c, i) => { if (at - c.ended! > LIVE_KEEP || i >= MOST_ENDED) calls.delete(c.id); });
}

const plain = ({ thinkChars, writeChars, usage, ...c }: Inner): LiveCall => c;
// What runs now, what ended lately, and the sums: tokens a second now (thinking and writing, of what runs) and the
// tokens of the last minute by kind (each call's tokens counted within the minute, in proportion to its time there).
export function liveView(at = Date.now()) {
  prune(at);
  const all = [...calls.values()];
  const running = all.filter((c) => c.ended === null).sort((a, b) => a.started - b.started);
  const ended = all.filter((c) => c.ended !== null).sort((a, b) => b.ended! - a.ended!);
  const rate = running.reduce((n, c) => (c.first === null ? n : n + (c.thinking + c.written) / Math.max(1, (at - c.first) / 1000)), 0);
  const minute = { input: 0, cached: 0, thinking: 0, written: 0 };
  for (const c of all) {
    const end = c.ended ?? at, span = Math.max(1, end - c.started), within = Math.max(0, end - Math.max(c.started, at - 60_000)) / span;
    if (within <= 0) continue;
    minute.input += c.input * within; minute.cached += c.cached * within; minute.thinking += c.thinking * within; minute.written += c.written * within;
  }
  for (const k of Object.keys(minute) as (keyof typeof minute)[]) minute[k] = Math.round(minute[k]);
  return { at, version, running: running.map(plain), ended: ended.map(plain), rate: Math.round(rate), minute };
}
export type LiveView = ReturnType<typeof liveView>;

// The tests start from nothing.
export function forgetLive() { calls.clear(); touch(); }

// Where each source shows (the Live card, the live tool).
export const LIVE_SOURCE: Record<string, string> = { chat: "Chat", delegate: "Hand off", check: "Check", trial: "Trial", plan: "Plan part", sidebyside: "Side by side", ask: "Ask about prompts", openai: "App (OpenAI address)", anthropic: "App (Anthropic address)" };
