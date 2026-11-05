// Claude's own models (0.15), for the parts a Claude app keeps and runs on a helper (a subagent): the newest of each
// family Anthropic offers (Haiku, Sonnet, Opus, Fable and any family that comes later), as llmledger's catalogue
// lists them today. A new family or version takes its place the day llmledger lists it, a retired one drops out,
// and the order comes from the votes (Arena's ratings) and the prices, never from a list kept here.
//
// The pick for a part, by its effort, as Auto picks (router.ts): the cheapest rated within 80 points of the best for
// a low effort part, 40 for medium, 15 for high. The hardest parts and the final check take the strongest: of the
// ones the votes cannot tell apart from the best (within 15 points), the biggest (the dearest), so Fable before Opus
// while their ratings are that close. Your rules (Settings, Claude's own models) hold the strongest back: only while
// the week is under a cap, at most so many a day, and not for an hour after a helper on it ended with nothing (a
// limit Claude did not name: Claude tells no tool how much of one model is left, only the 5 hours and the week).
import { allModels, isRetired, type Model } from "./data";
import { db } from "./db";
import { HELPER_DEFAULTS, MODES, settings, type ClaudeHelpers } from "./settings";
import { lastSnap } from "./statusline";
import { localDay, now } from "./util";

export interface ClaudeRung { id: string; family: string; alias: string; version: number[]; label: string; input: number | null; output: number | null; rated: boolean; added: string | null; model: Model }

// claude-opus-5-5, claude-3-5-haiku, claude-fable-5-1: the family is the word, the version the numbers around it; a
// date at the end (a snapshot: claude-haiku-4-5-20251001) is the same model.
export function familyOf(id: string): { family: string; version: number[] } | null {
  const m = /^(?:anthropic\/)?claude-(.+)$/.exec(id);
  if (!m) return null;
  const bits = m[1].split(/[-.]/).filter((b) => !/^\d{8}$/.test(b));
  const words = bits.filter((b) => /^[a-z]+$/.test(b));
  if (words.length !== 1 || ["instant"].includes(words[0])) return null;
  const version = bits.filter((b) => /^\d+$/.test(b)).map(Number);
  return { family: words[0], version };
}
const newer = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return false; };

// The newest of each family, rated or not (an unrated one is shown, never picked until Arena rates it).
export function claudeRungs(day = localDay(), models: Model[] = allModels()): ClaudeRung[] {
  const best = new Map<string, ClaudeRung>();
  for (const m of models) {
    if (m.provider !== "anthropic" || m.local || m.free || isRetired(m, day)) continue;
    const f = familyOf(m.id);
    if (!f || !f.version.length) continue;
    const rung: ClaudeRung = { id: m.id, family: f.family, alias: f.family, version: f.version, label: m.label, input: m.input ?? null, output: m.output ?? null, rated: Object.keys(m.ratings ?? {}).length > 0, added: m.added, model: m };
    const had = best.get(f.family);
    if (!had || newer(f.version, had.version)) best.set(f.family, rung);
  }
  // Strongest first, the way the hardest parts pick: the ones the votes cannot tell from the best (within 15 points of
  // it overall) by size, the biggest first; then the rest by rating; an unrated one last.
  const score = (r: ClaudeRung) => (r.rated ? (r.model.ratings.overall ?? Math.max(...Object.values(r.model.ratings))) : -Infinity);
  const all = [...best.values()];
  const top = Math.max(...all.map(score));
  const band = (r: ClaudeRung) => (r.rated && score(r) >= top - MODES.best.margin ? 1 : 0);
  return all.sort((a, b) => band(b) - band(a) || (band(a) ? price(b) - price(a) : 0) || score(b) - score(a) || (b.output ?? 0) - (a.output ?? 0));
}

// What a part is judged by: Arena's task for its kind (as the delegate guesses it), overall when unknown.
export const TASK_OF: Record<string, string> = { read: "longer_query", search: "longer_query", write: "instruction_following", reason: "hard_prompts", code: "coding", act: "overall" };
const ratingOf = (r: ClaudeRung, task: string): number | null => (r.rated ? r.model.ratings[task] ?? r.model.ratings.overall ?? null : null);
function price(r: ClaudeRung) { return (r.input ?? 0) + 4 * (r.output ?? 0); } // a part's tokens are mostly read, then written

export interface ClaudePick { rung: ClaudeRung; why: string; top: boolean; held: string | null }

// The Claude model for a part: effort low, medium or high; top for the hardest parts and the final check.
export function pickClaude(kind: string, effort: "low" | "medium" | "high", top = false, rungs = claudeRungs()): ClaudePick | null {
  const task = TASK_OF[kind] ?? "overall";
  const rated = rungs.map((r) => ({ r, s: ratingOf(r, task) })).filter((x): x is { r: ClaudeRung; s: number } => x.s !== null);
  if (!rated.length) return null;
  const best = Math.max(...rated.map((x) => x.s));
  const within = (margin: number) => rated.filter((x) => x.s >= best - margin);
  const cheapest = (xs: typeof rated) => [...xs].sort((a, b) => price(a.r) - price(b.r) || b.s - a.s)[0];
  const margin = MODES[effort === "low" ? "save" : effort === "medium" ? "balanced" : "best"].margin;
  const usual = cheapest(within(margin));
  if (!top) return { rung: usual.r, why: `the cheapest of Claude's models rated within ${margin} points of the best for ${task.replace(/_/g, " ")}`, top: false, held: null };
  // The strongest: the votes cannot tell these from the best, so the biggest of them.
  const strongest = [...within(MODES.best.margin)].sort((a, b) => price(b.r) - price(a.r) || b.s - a.s)[0];
  const held = topHeld(strongest.r);
  if (held) {
    const next = cheapest(within(MODES.best.margin).filter((x) => x.r.family !== strongest.r.family)) ?? usual;
    return { rung: next.r, why: `${strongest.r.label} is held back (${held}), so the next strongest`, top: true, held };
  }
  return { rung: strongest.r, why: `the strongest of Claude's models for ${task.replace(/_/g, " ")}: the votes cannot tell it from the best, and it is the biggest`, top: true, held: null };
}

// ---- your rules for the strongest one --------------------------------------------------------------------------
export const helperRules = (): ClaudeHelpers => ({ ...HELPER_DEFAULTS, ...(settings().claudeHelpers ?? {}) });

const resting = new Map<string, number>(); // family -> until (epoch ms): a helper on it ended with nothing
export const REST_MS = 60 * 60_000;
export const restFamily = (family: string, at = now().getTime()) => resting.set(family, at + REST_MS);
export const forgetRests = () => resting.clear();

// Why the strongest model is held back now, or null.
export function topHeld(r: ClaudeRung, at = now().getTime()): string | null {
  const rules = helperRules();
  if (!rules.top) return "you turned it off for helpers";
  const until = resting.get(r.family);
  if (until && until > at) return `a helper on it ended with nothing at ${new Date(until - REST_MS).toTimeString().slice(0, 5)}, so not for an hour`;
  const s = lastSnap();
  const week = s?.week && (s.week.resets === null || s.week.resets > at) ? s.week.used : null;
  if (week !== null && week >= rules.topUntil) return `your Claude plan's week is ${Math.round(week)}% used, at or over your ${rules.topUntil}%`;
  const today = usedToday(r.family);
  if (today >= rules.topPerDay) return `${today} helpers ran on it today, your most a day`;
  return null;
}
export function usedToday(family: string, day = localDay()): number {
  try { return (db.query("SELECT COUNT(*) AS n FROM helpers WHERE day = ? AND family = ?").get(day, family) as { n: number }).n; } catch { return 0; }
}
