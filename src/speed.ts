// How long an answer takes: measured from Leanfare's own ledger (each answer's time to its first
// token and how fast it then wrote), per model, so a time can be estimated before sending and Auto
// can pick for speed as well as price. A model Leanfare has not timed three times yet gets a
// rough guess by its kind, said as such.
//
// Speed choices (Settings, "Speed"; per request x-leanfare-speed; the delegate's speed):
//   "cheapest"  the cheapest model that is good enough, however long it takes (as before)
//   "fastest"   the fastest model that is good enough, whatever it costs
//   N (seconds) the cheapest good enough model expected to answer within N seconds; if none, the fastest
import type { Model } from "./data";
import { typicalPrice } from "./data";
import { db } from "./db";
import { median } from "./util";

export type SpeedChoice = "cheapest" | "fastest" | number;
export interface Speed { latency: number; perSecond: number; measured: boolean; answers: number }

const FAST_PROVIDERS = new Set(["groq", "cerebras"]); // hardware built for speed

// A rough guess for a model never timed: a first token after about a second (more for a model that
// thinks first, and more the harder it thinks), then 30 to 400 tokens a second by its kind.
export function guessSpeed(m: Model, effort: string | null = null): Speed {
  const thinks = m.skills.includes("reasoning");
  const think = !thinks ? 0 : effort === "high" ? 10 : effort === "low" || effort === "minimal" ? 2 : 4;
  if (m.local) return { latency: 1 + think, perSecond: 30, measured: false, answers: 0 };
  if (FAST_PROVIDERS.has(m.provider)) return { latency: thinks ? think / 4 : 0.4, perSecond: 400, measured: false, answers: 0 };
  const price = typicalPrice(m);
  const perSecond = price === null ? 80 : price <= 1 ? 150 : price <= 5 ? 90 : 60;
  return { latency: thinks ? think : 1.2, perSecond, measured: false, answers: 0 };
}

let cache = { at: 0, map: new Map<string, Speed>() };
// All of them, or one model's after a new answer from it (engine.ts record).
export const forgetSpeeds = (model?: string) => {
  if (!model) { cache = { at: 0, map: new Map() }; return; }
  for (const k of [...cache.map.keys()]) if (k.startsWith(`${model}|`)) cache.map.delete(k);
};

// From the last 50 good answers of this model, at this thinking effort when it has three of those.
export function speedOf(m: Model, effort: string | null = null): Speed {
  if (Date.now() - cache.at > 60_000) cache = { at: Date.now(), map: new Map() };
  const key = `${m.id}|${effort ?? ""}`;
  const hit = cache.map.get(key);
  if (hit) return hit;
  const rows = (effort
    ? db.query("SELECT ms, first_ms AS f, out_tokens AS o FROM ledger WHERE model = ? AND effort = ? AND status = 'ok' AND ms IS NOT NULL ORDER BY id DESC LIMIT 50").all(m.id, effort)
    : db.query("SELECT ms, first_ms AS f, out_tokens AS o FROM ledger WHERE model = ? AND status = 'ok' AND ms IS NOT NULL ORDER BY id DESC LIMIT 50").all(m.id)) as { ms: number; f: number | null; o: number }[];
  if (effort && rows.length < 3) { const any = speedOf(m, null); if (any.measured) { cache.map.set(key, any); return any; } }
  const guess = guessSpeed(m, effort);
  let s = guess;
  if (rows.length >= 3) {
    const firsts = rows.filter((r) => r.f !== null && r.f >= 0).map((r) => r.f! / 1000);
    const rates = rows.filter((r) => r.f !== null && r.o >= 20 && r.ms - r.f! >= 300).map((r) => r.o / ((r.ms - r.f!) / 1000));
    // An answer that was not streamed has no first token time: its whole time stands in for the wait.
    const latency = (firsts.length >= 3 ? median(firsts) : median(rows.map((r) => Math.max(0, r.ms / 1000 - r.o / guess.perSecond)))) ?? guess.latency;
    s = { latency, perSecond: (rates.length >= 3 ? median(rates) : null) ?? guess.perSecond, measured: true, answers: rows.length };
  }
  cache.map.set(key, s);
  return s;
}

// Seconds for an answer of about `outTokens` tokens.
export function secondsFor(m: Model, outTokens: number, effort: string | null = null): { seconds: number; measured: boolean } {
  const s = speedOf(m, effort);
  return { seconds: s.latency + outTokens / Math.max(1, s.perSecond), measured: s.measured };
}

export const parseSpeed = (v: unknown): SpeedChoice | null => {
  if (v === "cheapest" || v === "fastest") return v;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 3600 ? Math.round(n) : null;
};

export { secondsText } from "./util";
export const speedLabel = (c: SpeedChoice) => (c === "cheapest" ? "Cheapest" : c === "fastest" ? "Fastest" : `Within ${c < 90 ? `${c} seconds` : `${Math.round(c / 60)} minutes`}`);
