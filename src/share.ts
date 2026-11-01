// The share planner (0.13): how the free models' daily allowances are shared out between the kinds of work.
//
// Leanfare learns how many parts of each kind (reading, drafting, working out, searching) the person hands over on a day,
// from its own records: numbers only, the kinds and the times. For each scarce strong model (a daily allowance of 100 or
// less, like Gemini 3.x Flash's 20) it works out the chance that, at today's pace, the parts it is clearly best for would
// use up what it has left before its reset. Above 20%, it keeps that model for those parts (save strong), and easy parts
// go to the plentiful models. When every model has plenty left, it spreads the work over them so none hits its wall
// first (spread evenly), and for a hand off someone is waiting on it takes the fastest good enough model (fastest first).
// The mode and the reason go in a line of the receipt; the report compares what it expected with what came.
//
// The numbers: a Poisson rate for each kind, the last 14 days weighted toward the recent ones (half the weight after 7
// days) and toward the same weekday; the share of a day's parts still to come at this hour, from the person's own hours;
// and P(N > left) for the parts a model is best for.
import { lastReset, today, type Allowance } from "./allowance";
import type { Model } from "./data";
import { db } from "./db";
import { onFreePlan } from "./freeplans";
import { standing, type GradedKind } from "./grades";
import { now } from "./util";

export type ShareMode = "save" | "spread" | "fast";
export const KINDS: GradedKind[] = ["read", "write", "reason", "search"];
export const SHARE = { scarce: 100, risk: 0.2, days: 14, halfLife: 7, clearlyGrades: 15, clearlyRating: 30, low: 0.25, high: 0.5, slower: 3 };
// The Arena task each kind of work is rated by (as delegate.ts guesses it).
export const TASK_OF: Record<GradedKind, string> = { read: "longer_query", write: "instruction_following", reason: "hard_prompts", search: "overall" };
export type RatingFor = (m: Model, kind: GradedKind) => number | null;

type Row = { ts: string; kind: string | null };
let cache: { at: number; rows: Row[] } | null = null;
export const forgetShare = () => { cache = null; };
// The hand offs of the last 28 days: their kind and time only.
function rows(t: number): Row[] {
  if (cache && t - cache.at < 60_000) return cache.rows;
  let r: Row[] = [];
  try { r = db.query("SELECT ts, kind FROM delegations WHERE ts >= ? AND kind IS NOT NULL").all(new Date(t - 28 * 86_400_000).toISOString()) as Row[]; } catch { return cache?.rows ?? []; }
  cache = { at: t, rows: r };
  return r;
}

// Parts of each kind on a day like today: recent days weigh more (half after 7 days), and the same weekday's share of
// the week (from the last 4 weeks) scales it.
export function demand(t = now().getTime()): Record<string, number> {
  const all = rows(t);
  const out: Record<string, number> = {};
  const wd = new Date(t).getUTCDay();
  for (const k of KINDS) {
    const mine = all.filter((r) => r.kind === k);
    let num = 0, den = 0;
    for (let d = 1; d <= SHARE.days; d++) {
      const w = Math.pow(0.5, (d - 1) / SHARE.halfLife);
      const from = t - d * 86_400_000, to = from + 86_400_000;
      num += w * mine.filter((r) => { const x = Date.parse(r.ts); return x >= from && x < to; }).length;
      den += w;
    }
    const rate = den ? num / den : 0;
    const same = mine.filter((r) => new Date(r.ts).getUTCDay() === wd).length / 4, perDay = mine.length / 28;
    const factor = perDay > 0 && mine.length >= 14 ? Math.min(2, Math.max(0.5, same / perDay)) : 1;
    out[k] = rate * factor;
  }
  return out;
}

// The share of a day's parts still to come at this hour, from the person's own hours of the last 28 days (UTC hours,
// with the day counted from the pool's reset). With fewer than 20 parts, the hours left of the day, evenly.
export function dayLeft(resets: Allowance["resets"], t = now().getTime()): number {
  const start = lastReset(resets, t), into = (t - start) / 3_600_000;
  const all = rows(t);
  if (all.length < 20) return Math.max(0, Math.min(1, 1 - into / 24));
  const hours = all.map((r) => { const x = Date.parse(r.ts); return ((x - lastReset(resets, x)) / 3_600_000) % 24; });
  return hours.filter((h) => h >= into).length / hours.length;
}

// P(N > k) for a Poisson count with mean lambda.
export function overChance(k: number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (k < 0) return 1;
  let term = Math.exp(-lambda), cdf = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; cdf += term; }
  return Math.max(0, 1 - cdf);
}

// Clearly better at a kind: by your grades when both have 3 or more (15 points of 100), else by their Arena rating for it
// (30 points).
function clearlyBetter(a: Model, b: Model, k: GradedKind, ratingFor: RatingFor): boolean {
  const sa = standing(a.id, k), sb = standing(b.id, k);
  if (sa.n >= 3 && sb.n >= 3) return (sa.score - sb.score) * 100 >= SHARE.clearlyGrades;
  const ra = ratingFor(a, k), rb = ratingFor(b, k);
  return ra !== null && (rb === null || ra - rb >= SHARE.clearlyRating);
}
const bestKinds = (m: Model, others: Model[], ratingFor: RatingFor) => (others.length ? KINDS.filter((k) => others.every((o) => clearlyBetter(m, o, k, ratingFor))) : []);

export interface Share { mode: ShareMode; leaveOut: Set<string>; why: string | null }
// Free to you: on this computer, a free model, or a key marked as a free plan. The planner moves work only between these:
// it never sends work to a paid model to spare a free one.
export const freeToYou = (m: Model): boolean => !!m.local || !!(m as any).free || onFreePlan(m.provider) || /:free$/i.test(m.id);
// For a part of this kind: the mode, the models to leave out now, and the line that says why. candidates: the models
// that could take it now; interactive: someone waits on the answer (a hand off from a chat, not a plan's background part).
export function shareFor(kind: GradedKind | null, candidates: Model[], interactive: boolean, ratingFor: RatingFor, firstOf: (m: Model) => number | null, t = now().getTime()): Share {
  const none: Share = { mode: "spread", leaveOut: new Set(), why: null };
  if (!kind || candidates.length < 2) return none;
  const keepsFree = (leave: Set<string>) => candidates.some((m) => !leave.has(m.id) && freeToYou(m)); // a free model still takes it
  const info = candidates.map((m) => ({ m, d: today(m, t) }));
  const scarce = info.filter((x) => x.d && x.d.perDay <= SHARE.scarce);
  const need = demand(t);
  // Save strong: a scarce model that would run out of what it has left before its reset, at today's pace, keeps it for
  // the kinds it is clearly best at, when this part is not one of them.
  const leave = new Set<string>(), saved: string[] = [];
  for (const { m, d } of scarce) {
    const others = candidates.filter((o) => o.id !== m.id && !scarce.some((s) => s.m.id === o.id));
    if (!others.length) continue;
    const best = bestKinds(m, others, ratingFor);
    if (!best.length || best.includes(kind)) continue;
    const lambda = best.reduce((n, k) => n + (need[k] ?? 0), 0) * dayLeft(d!.allowance.resets, t);
    const risk = overChance(d!.left, lambda);
    if (risk > SHARE.risk) { leave.add(m.id); saved.push(`${m.label} for ${best.join(" and ")} (${d!.left} left, about ${Math.round(lambda)} expected, ${Math.round(risk * 100)}% chance to run out)`); }
  }
  if (leave.size && keepsFree(leave)) return { mode: "save", leaveOut: leave, why: `Saving ${saved.join("; ")}` };
  // Fastest first, for someone waiting: leave out a model much slower to start than the fastest of the others.
  if (interactive) {
    const firsts = candidates.map((m) => ({ m, f: firstOf(m) })).filter((x) => x.f !== null) as { m: Model; f: number }[];
    if (firsts.length >= 2) {
      const fastest = Math.min(...firsts.map((x) => x.f));
      const slow = firsts.filter((x) => x.f > fastest * SHARE.slower && x.f > 5_000).map((x) => x.m.id);
      if (slow.length && slow.length < candidates.length && keepsFree(new Set(slow))) return { mode: "fast", leaveOut: new Set(slow), why: "Fastest first: you are waiting on this one" };
    }
  }
  // Spread evenly: a model with under a quarter of its allowance left is left out while another has over half.
  const low = info.filter((x) => x.d && x.d.left / x.d.perDay < SHARE.low).map((x) => x.m.id);
  const roomy = info.some((x) => !x.d || x.d.left / x.d.perDay > SHARE.high);
  if (low.length && roomy && low.length < candidates.length && keepsFree(new Set(low))) return { mode: "spread", leaveOut: new Set(low), why: "Spreading the work: some models are near their daily allowance" };
  return none;
}

// For the report: each free model with an allowance, its day so far, the kinds it is best at, and what today's pace
// expects of it.
export function shareView(models: Model[], ratingFor: RatingFor, t = now().getTime()) {
  const need = demand(t);
  return {
    demand: Object.fromEntries(KINDS.map((k) => [k, Math.round((need[k] ?? 0) * 10) / 10])),
    pools: models.map((m) => ({ m, d: today(m, t) })).filter((x) => x.d).map(({ m, d }) => ({
      id: m.id, label: m.label, perDay: d!.perDay, used: d!.used, left: d!.left, resets: d!.resets, learned: d!.learned,
      best: bestKinds(m, models.filter((o) => o.id !== m.id), ratingFor),
    })),
  };
}
