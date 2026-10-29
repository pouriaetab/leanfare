// Resting (0.10). A model that failed too often lately rests for a while: Auto picks others while one of them can take
// the work, then tries it again. Too often: 3 of its last 6 tries in the last 30 minutes failed with the provider busy,
// a rate limit, no first word in time, the provider out of reach, an error on its side, or an answer cut off. A first
// rest is 30 minutes (5 when most of the failures were rate limits, which clear soon); a rest that follows another
// within 6 hours lasts twice the last one, at most 4 hours. You can end one early (the report: Try it now). A model
// you name yourself is still sent to: you asked for it. Kept: the model, when, and how many tries failed and why.
import { getModel } from "./data";
import { db } from "./db";
import { FAIL_WORD, failOfText, type FailKind } from "./fails";
import { now } from "./util";

export const REST = { last: 6, within: 30 * 60_000, fails: 3, first: 30 * 60_000, limitFirst: 5 * 60_000, most: 4 * 3600_000, again: 6 * 3600_000 };
const COUNTED: FailKind[] = ["busy", "limit", "timeout", "unreachable", "server", "cut"];

export interface Rest { model: string; start: string; until: string; fails: number; tries: number; kinds: Partial<Record<FailKind, number>> }

let cache: { at: number; map: Map<string, Rest> } | null = null;
export const forgetRests = () => { cache = null; };
// The rests going on now, by model (read again at most every 10 seconds, and after each change).
function current(): Map<string, Rest> {
  const t = now().getTime();
  if (cache && t - cache.at < 10_000) return cache.map;
  const map = new Map<string, Rest>();
  try {
    const rows = db.query("SELECT model, start, until, fails, tries, kinds FROM rests WHERE ended IS NULL AND until > ? ORDER BY id").all(new Date(t).toISOString()) as any[];
    for (const r of rows) map.set(r.model, { model: r.model, start: r.start, until: r.until, fails: r.fails, tries: r.tries, kinds: JSON.parse(r.kinds || "{}") });
  } catch { if (cache) return cache.map; } // the database busy: what was known
  cache = { at: t, map };
  return map;
}

// The model's rest now, or null.
export function restOf(model: string): Rest | null {
  const r = current().get(model);
  return r && Date.parse(r.until) > now().getTime() ? r : null;
}
export const resting = (model: string) => restOf(model) !== null;
export const restsNow = (): Rest[] => [...current().values()].filter((r) => Date.parse(r.until) > now().getTime());

// After a try of this model failed (engine.ts record): rest it when its last tries failed too often.
export function noteFailure(model: string) {
  if (resting(model)) return;
  const t = now().getTime();
  let rows: { status: string; fail: string | null; error: string | null }[];
  try {
    rows = db.query("SELECT status, fail, error FROM ledger WHERE model = ? AND ts >= ? AND status != 'stopped' ORDER BY id DESC LIMIT ?")
      .all(model, new Date(t - REST.within).toISOString(), REST.last) as any[];
  } catch { return; }
  const failed = rows.filter((r) => r.status === "error").map((r) => (r.fail ?? failOfText(r.error)) as FailKind).filter((k) => COUNTED.includes(k));
  if (failed.length < REST.fails) return;
  const kinds: Partial<Record<FailKind, number>> = {};
  for (const k of failed) kinds[k] = (kinds[k] ?? 0) + 1;
  // Twice the last rest when this one follows it within 6 hours.
  const prev = db.query("SELECT start, until FROM rests WHERE model = ? AND until >= ? ORDER BY id DESC LIMIT 1").get(model, new Date(t - REST.again).toISOString()) as { start: string; until: string } | null;
  const base = (kinds.limit ?? 0) * 2 > failed.length ? REST.limitFirst : REST.first;
  const length = Math.min(REST.most, prev ? Math.max(base, 2 * (Date.parse(prev.until) - Date.parse(prev.start))) : base);
  try {
    db.query("INSERT INTO rests(model, start, until, fails, tries, kinds) VALUES (?, ?, ?, ?, ?, ?)")
      .run(model, new Date(t).toISOString(), new Date(t + length).toISOString(), failed.length, rows.length, JSON.stringify(kinds));
  } catch (e) { console.error("leanfare: could not note a model's rest:", String(e)); return; }
  forgetRests();
}

// Ends a model's rest now (Try it now). True when it was resting.
export function endRest(model: string): boolean {
  let n = 0;
  try { n = db.query("UPDATE rests SET ended = ? WHERE model = ? AND ended IS NULL AND until > ?").run(now().toISOString(), model, now().toISOString()).changes; } catch {}
  forgetRests();
  return n > 0;
}

// Why, in words: "3 of its last 6 tries failed (2 busy, 1 timed out)".
export function restWhy(r: Rest): string {
  const kinds = (Object.entries(r.kinds) as [FailKind, number][]).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${FAIL_WORD[k]}`).join(", ");
  return `${r.fails} of its last ${r.tries} tries failed (${kinds})`;
}
// For a receipt or a note, where the time of day of the computer may not be the reader's: how long it has left.
export function restText(r: Rest): string {
  const left = Math.max(1, Math.round((Date.parse(r.until) - now().getTime()) / 60_000));
  const name = getModel(r.model)?.label ?? r.model;
  return `${name} is resting for ${left < 90 ? `${left} more minute${left === 1 ? "" : "s"}` : `about ${Math.round(left / 60)} more hours`}: ${restWhy(r)}`;
}
