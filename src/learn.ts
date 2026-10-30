// Picks that learn from your own history (0.10). Arena's ratings say how good a model is in general; your grades and the
// blind checks say how it does on your work. For each model and kind of work (reading, drafting, working things out),
// its last 20 graded answers move its rating up or down: by up to 60 points, more as the answers add up, so a model
// that keeps doing well for you comes within reach, and one that keeps falling short drops out of it, before the hard
// rule of moving it down (grades.ts). A grade counts good as 1, partly as a half, wrong as 0; 0.7 is par.
// Nothing leaves this computer: the numbers come from Leanfare's own records.
import { db } from "./db";
import { now } from "./util";

export const LEARN = { last: 20, par: 0.7, scale: 120, settle: 6, most: 60 };
const SCORE: Record<string, number> = { good: 1, partly: 0.5, wrong: 0 };
export interface Shift { points: number; n: number; score: number }

let cache: { at: number; map: Map<string, Shift | null> } = { at: 0, map: new Map() };
export const forgetLearned = () => { cache = { at: 0, map: new Map() }; };

// How far your history moves a model's rating for a kind of work, or null with nothing graded.
export function learnedShift(model: string, kind: string | null | undefined): Shift | null {
  if (!kind) return null;
  const t = now().getTime();
  if (t - cache.at > 60_000) cache = { at: t, map: new Map() };
  const key = `${model}|${kind}`;
  if (cache.map.has(key)) return cache.map.get(key)!;
  let rows: { g: string | null; v: string | null }[] = [];
  try {
    // The answer that came back is the model's: the second one's after a failed check (rerun), else the first's.
    rows = db.query(`SELECT grade AS g, verdict AS v FROM delegations WHERE COALESCE(rerun, model) = ? AND kind = ? AND status = 'ok'
      AND (grade IN ('good', 'partly', 'wrong') OR verdict IN ('pass', 'fail')) ORDER BY id DESC LIMIT ?`).all(model, kind, LEARN.last) as any[];
  } catch { return null; }
  const scores = rows.map((r) => (r.g && r.g in SCORE ? SCORE[r.g] : r.v === "pass" ? 1 : 0));
  let s: Shift | null = null;
  if (scores.length) {
    const score = scores.reduce((a, b) => a + b, 0) / scores.length, n = scores.length;
    const points = Math.round(Math.max(-LEARN.most, Math.min(LEARN.most, (score - LEARN.par) * LEARN.scale * (n / (n + LEARN.settle)))));
    s = { points, n, score };
  }
  cache.map.set(key, s);
  return s;
}
