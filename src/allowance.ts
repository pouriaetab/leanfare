// Free and paid apart, and each free model's daily allowance (0.13).
//
// A free key lets each model answer a number of requests a day. Some providers publish it: Groq, 1,000 a day for each of
// its free models; OpenRouter, 50 a day across its free models (":free"). Google does not: developers see about 20 a day
// for Gemini 3.x Flash and about 500 for 3.x Flash-Lite on a free key (as of Sep 2026). Leanfare counts what it sent
// today, learns a smaller allowance when a model is refused as rate limited before reaching it, and leaves a model whose
// allowance is used up out of Auto, plans and checks until its reset (midnight Pacific for Google, midnight UTC for the
// others), so the work goes to a free model with room left.
//
// Some models are paid only: Google's free tier has none of Gemini 4 (Argon) and the Pro models. On a key you marked as
// a free plan they are never picked and say "needs credit", until you untick the free plan box (the key has billing).
//
// And a model that has been failing most of its tries today, or that has started its answers only after minutes, is
// "unsteady": it is left out while another model can take the work, as a resting one is (rest.ts).
// Numbers only: what is read is the ledger's count of tries, their outcome and their first word's time. No words.
import { db } from "./db";
import { failOfText } from "./fails";
import { onFreePlan } from "./freeplans";
import { now } from "./util";

export type Reset = "pacific" | "utc";
export interface Allowance { perDay: number; scope: "model" | "provider"; resets: Reset; source: string }
interface Rule { provider: string; match: RegExp; allowance: Allowance; freeOnly: boolean }

// The numbers, as published or seen on 31 Oct 2026. freeOnly: it holds only while the key is marked as a free plan.
const RULES: Rule[] = [
  { provider: "google", match: /flash-lite/i, freeOnly: true, allowance: { perDay: 500, scope: "model", resets: "pacific", source: "about 500 a day for Gemini 3.x Flash-Lite on a free key, as developers report it (Google does not publish it)" } },
  { provider: "google", match: /\bgemini-3(\.\d+)?-flash\b(?!-lite)/i, freeOnly: true, allowance: { perDay: 20, scope: "model", resets: "pacific", source: "about 20 a day for Gemini 3.x Flash on a free key, as developers report it (Google does not publish it)" } },
  { provider: "groq", match: /./, freeOnly: true, allowance: { perDay: 1000, scope: "model", resets: "utc", source: "Groq's free plan: 1,000 requests a day for each model" } },
  { provider: "openrouter", match: /:free$/i, freeOnly: false, allowance: { perDay: 50, scope: "provider", resets: "utc", source: "OpenRouter: 50 requests a day across its free models (1,000 once $10 of credit was bought)" } },
];
// Paid only on a free key, by provider: Google's free tier has no Gemini 4, no Pro model and no image or video model.
const PAID_ONLY: Record<string, RegExp> = {
  google: /\bgemini-4\b|\bgemini-\d+(\.\d+)?-pro\b|-pro-preview|imagen|image|veo|omni|nano-banana/i,
};

type M = { id: string; provider: string; apiId?: string };
const name = (m: M) => `${m.apiId ?? ""} ${m.id}`.toLowerCase();

// A paid only model on a key marked as a free plan: never picked, and shown as needing credit.
export const needsCredit = (m: M): boolean => !!PAID_ONLY[m.provider]?.test(name(m)) && onFreePlan(m.provider);

// The daily allowance that holds for this model now, or null for none known.
export function allowanceOf(m: M): Allowance | null {
  const r = RULES.find((x) => x.provider === m.provider && x.match.test(name(m)) && (!x.freeOnly || onFreePlan(m.provider)));
  return r ? r.allowance : null;
}

// The last midnight before t, in UTC or Pacific time. Pacific midnight is 07:00 or 08:00 UTC (summer or winter time):
// the one of the two that the time zone database calls 00:00 of that day, so a day of 23 or 25 hours (when the clocks
// change) counts right. The day and the time are asked for apart, since a date written by the system can differ between computers.
const PACIFIC = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const pacificOf = (t: number) => Object.fromEntries(PACIFIC.formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)])) as Record<string, number>;
export function lastReset(resets: Reset, t: number): number {
  const d = new Date(t);
  if (resets === "utc") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const p = pacificOf(t);
  for (const h of [7, 8]) {
    const c = Date.UTC(p.year, p.month - 1, p.day, h);
    const q = pacificOf(c);
    if (c <= t && q.day === p.day && q.hour % 24 === 0 && q.minute === 0) return c;
  }
  return t - ((p.hour % 24) * 3600 + p.minute * 60) * 1000 - (t % 60_000); // not reached with the time zone database
}
export const nextReset = (resets: Reset, t: number): number => lastReset(resets, lastReset(resets, t) + 36 * 3_600_000);

interface Row { ts: string; status: string; fail: string | null; error: string | null; first: number | null; model: string }
const TTL = 30_000;
const cache = new Map<string, { at: number; rows: Row[] }>();
export const forgetAllowances = () => cache.clear();
// The ledger's tries of a model (or of a provider's free models) over the last 7 days, oldest first; read again at most
// every 30 seconds.
function rowsOf(key: string, scope: "model" | "provider", t: number): Row[] {
  const c = cache.get(`${scope}:${key}`);
  if (c && t - c.at < TTL) return c.rows;
  let rows: Row[] = [];
  try {
    const since = new Date(t - 7 * 86_400_000).toISOString();
    rows = (scope === "model"
      ? db.query("SELECT ts, status, fail, error, first_ms AS first, model FROM ledger WHERE model = ? AND ts >= ? AND status != 'stopped' ORDER BY id").all(key, since)
      : db.query("SELECT ts, status, fail, error, first_ms AS first, model FROM ledger WHERE provider = ? AND ts >= ? AND status != 'stopped' ORDER BY id").all(key, since)) as Row[];
  } catch { return c?.rows ?? []; } // the database busy: what was known
  cache.set(`${scope}:${key}`, { at: t, rows });
  return rows;
}
const limited = (r: Row) => r.status === "error" && (r.fail ?? failOfText(r.error)) === "limit";
const answered = (r: Row) => r.status === "ok";

export interface Today { allowance: Allowance; perDay: number; learned: number | null; used: number; left: number; resets: string }
// Today's count against the allowance. learned: the fewest answers before a rate limit on a day of the last 7 (at
// least 3, so a minute's limit or a busy provider does not count as the day's), when it is below the known number.
export function today(m: M, t = now().getTime()): Today | null {
  const a = allowanceOf(m);
  if (!a) return null;
  const all = rowsOf(a.scope === "model" ? m.id : m.provider, a.scope, t);
  const mine = a.scope === "provider" ? all.filter((r) => /:free$/i.test(r.model)) : all;
  const start = lastReset(a.resets, t);
  const days = new Map<number, Row[]>();
  for (const r of mine) { const day = lastReset(a.resets, Date.parse(r.ts)); (days.get(day) ?? days.set(day, []).get(day)!).push(r); }
  let learned: number | null = null;
  for (const rows of days.values()) {
    const i = rows.findIndex(limited);
    if (i < 0) continue;
    const before = rows.slice(0, i).filter(answered).length;
    if (before >= 3 && before < a.perDay && (learned === null || before < learned)) learned = before;
  }
  const used = (days.get(start) ?? []).filter(answered).length;
  const perDay = learned ?? a.perDay;
  return { allowance: a, perDay, learned, used, left: Math.max(0, perDay - used), resets: new Date(nextReset(a.resets, t)).toISOString() };
}
// Its allowance is used up for today: left out until its reset.
export const usedUp = (m: M, t = now().getTime()): boolean => { const d = today(m, t); return !!d && d.left <= 0; };

// Unsteady today: at least 6 tries in the last 24 hours and half or more of them failed (busy, rate limited, no first
// word in time, out of reach, an error on its side, cut off), or its last 10 answers started after more than 2 minutes in
// the middle one. Left out while another model can take the work.
export const UNSTEADY = { within: 86_400_000, tries: 6, failShare: 0.5, answers: 10, firstMs: 120_000 };
const COUNTED = new Set(["busy", "limit", "timeout", "unreachable", "server", "cut"]);
export function unsteady(id: string, t = now().getTime()): { why: string } | null {
  const rows = rowsOf(id, "model", t).filter((r) => Date.parse(r.ts) >= t - UNSTEADY.within);
  const tries = rows.slice(-12);
  const failed = tries.filter((r) => r.status === "error" && COUNTED.has(r.fail ?? failOfText(r.error) ?? "")).length;
  if (tries.length >= UNSTEADY.tries && failed / tries.length >= UNSTEADY.failShare) return { why: `${failed} of its last ${tries.length} tries today failed` };
  const firsts = rows.filter((r) => answered(r) && typeof r.first === "number").slice(-UNSTEADY.answers).map((r) => r.first as number).sort((a, b) => a - b);
  if (firsts.length >= 3) {
    const mid = firsts.length % 2 ? firsts[firsts.length >> 1] : (firsts[(firsts.length >> 1) - 1] + firsts[firsts.length >> 1]) / 2;
    if (mid > UNSTEADY.firstMs) return { why: `its answers started after about ${Math.round(mid / 60_000)} minutes lately` };
  }
  return null;
}

// For the screens and the models tool: why a ticked model is not used now, or null.
export function notNowWhy(m: M & { label?: string }, t = now().getTime()): string | null {
  if (needsCredit(m)) return "needs credit: your key is on a free plan, which does not include it";
  const d = today(m, t);
  if (d && d.left <= 0) return `its free allowance for today is used (${d.used} of about ${d.perDay}), until ${new Date(d.resets).toISOString().slice(11, 16)} UTC`;
  return null;
}

// The middle first word time of a model's last 10 answers this week, in ms (the share planner's fastest first), or null.
export function firstMedian(id: string, t = now().getTime()): number | null {
  const f = rowsOf(id, "model", t).filter((r) => answered(r) && typeof r.first === "number").slice(-10).map((r) => r.first as number).sort((a, b) => a - b);
  if (f.length < 3) return null;
  return f.length % 2 ? f[f.length >> 1] : (f[(f.length >> 1) - 1] + f[f.length >> 1]) / 2;
}
