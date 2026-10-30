// How long an answer takes: measured from Leanfare's own ledger (each answer's time to its first
// token and how fast it then wrote), per model, so a time can be estimated before sending and Auto
// can pick for speed as well as price. A model Leanfare has not timed three times yet gets a
// rough guess by its kind, said as such.
//
// From 0.10 the time is learned from more of each model's answers here: how its first token comes later as the input
// grows (a straight line fitted to its last 100 answers, when they say so clearly), and how often its tries failed
// lately (a failed try costs its time again).
//
// Speed choices (Settings, "Speed"; per request x-leanfare-speed; the delegate's speed):
//   "cheapest"  the cheapest model that is good enough, however long it takes (as before)
//   "balanced"  time and cost weighed alike among the models good enough (0.10)
//   "fastest"   the fastest model that is good enough, whatever it costs
//   N (seconds) the cheapest good enough model expected to answer within N seconds; if none, the fastest
import type { Model } from "./data";
import { typicalPrice } from "./data";
import { db } from "./db";
import { failOfText } from "./fails";
import { median } from "./util";

export type SpeedChoice = "cheapest" | "balanced" | "fastest" | number;
// latency: seconds to the first token for a short input; perInput: seconds more for each input token (0: not seen);
// perSecond: tokens a second once it writes; fail: the share of its last tries that failed (busy, limits, time).
export interface Speed { latency: number; perSecond: number; measured: boolean; answers: number; perInput?: number; fail?: number }

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
    ? db.query("SELECT ms, first_ms AS f, out_tokens AS o, in_tokens AS i FROM ledger WHERE model = ? AND effort = ? AND status = 'ok' AND ms IS NOT NULL ORDER BY id DESC LIMIT 100").all(m.id, effort)
    : db.query("SELECT ms, first_ms AS f, out_tokens AS o, in_tokens AS i FROM ledger WHERE model = ? AND status = 'ok' AND ms IS NOT NULL ORDER BY id DESC LIMIT 100").all(m.id)) as { ms: number; f: number | null; o: number; i: number }[];
  if (effort && rows.length < 3) { const any = speedOf(m, null); if (any.measured) { cache.map.set(key, any); return any; } }
  const guess = guessSpeed(m, effort);
  let s = guess;
  if (rows.length >= 3) {
    const recent = rows.slice(0, 50);
    const firsts = recent.filter((r) => r.f !== null && r.f >= 0).map((r) => r.f! / 1000);
    const rates = recent.filter((r) => r.f !== null && r.o >= 20 && r.ms - r.f! >= 300).map((r) => r.o / ((r.ms - r.f!) / 1000));
    // An answer that was not streamed has no first token time: its whole time stands in for the wait.
    let latency = (firsts.length >= 3 ? median(firsts) : median(recent.map((r) => Math.max(0, r.ms / 1000 - r.o / guess.perSecond)))) ?? guess.latency;
    // The first token comes later for a longer input: a line through its answers, when they cover inputs of clearly
    // different sizes and the line rises; else the middle wait, as before.
    const line = fitLine(rows.filter((r) => r.f !== null && r.f >= 0 && r.i > 0).map((r) => [r.i, r.f! / 1000] as [number, number]));
    let perInput = 0;
    if (line) { latency = line.a; perInput = line.b; }
    s = { latency, perSecond: (rates.length >= 3 ? median(rates) : null) ?? guess.perSecond, measured: true, answers: rows.length, perInput, fail: failShare(m.id) };
  }
  cache.map.set(key, s);
  return s;
}

// A straight line y = a + b x through points (least squares), when there are at least 8, their x spread at least four
// times from the smallest to the largest, and it rises with a start of zero or more. Null otherwise.
export function fitLine(pts: [number, number][]): { a: number; b: number } | null {
  if (pts.length < 8) return null;
  const xs = pts.map((p) => p[0]);
  if (Math.min(...xs) <= 0 || Math.max(...xs) / Math.min(...xs) < 4) return null;
  const n = pts.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  if (sxx <= 0) return null;
  const b = sxy / sxx, a = my - b * mx;
  return b > 0 && a >= 0 ? { a, b } : null;
}
// Of a model's last 20 tries, the share that failed with the provider busy, rate limited, timed out, out of reach, an
// error on its side or cut off: each costs its time again.
function failShare(model: string): number {
  try {
    const rows = db.query("SELECT status, fail, error FROM ledger WHERE model = ? AND status != 'stopped' ORDER BY id DESC LIMIT 20").all(model) as { status: string; fail: string | null; error: string | null }[];
    if (rows.length < 5) return 0;
    return rows.filter((r) => r.status === "error" && !["refused", "other"].includes(r.fail ?? failOfText(r.error))).length / rows.length;
  } catch { return 0; }
}

// Seconds for an answer of about `outTokens` tokens, to an input of about `inTokens`: the first token (later for a
// longer input), the writing, and a share more for the tries that fail.
export function secondsFor(m: Model, outTokens: number, effort: string | null = null, inTokens = 0): { seconds: number; measured: boolean } {
  const s = speedOf(m, effort);
  const once = s.latency + (s.perInput ?? 0) * inTokens + outTokens / Math.max(1, s.perSecond);
  return { seconds: once * (1 + Math.min(0.5, s.fail ?? 0)), measured: s.measured };
}

export const parseSpeed = (v: unknown): SpeedChoice | null => {
  if (v === "cheapest" || v === "fastest" || v === "balanced") return v;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 3600 ? Math.round(n) : null;
};

export { secondsText } from "./util";
export const speedLabel = (c: SpeedChoice) => (c === "cheapest" ? "Cheapest" : c === "fastest" ? "Fastest" : c === "balanced" ? "Balanced" : `Within ${c < 90 ? `${c} seconds` : `${Math.round(c / 60)} minutes`}`);
