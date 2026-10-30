// The manager's grades. After the app you work in (Claude Code, Codex...) uses an answer one of Leanfare's
// models gave for a part, it says how good it was: good, partly or wrong (you can too, in the Plan tab).
// Leanfare keeps the grade with the model and the kind of part (reading, drafting, working things out,
// searching), never the words. A model graded too often below good for a kind (at least 3 of its last 20
// grades, under half good, partly counting half) is moved down: plans and the delegate stop picking
// it for that kind, while another model can take it, until you give it another chance in Settings.
import { CODEX_ID, CODEX_LABEL } from "./codex";
import { getModel } from "./data";
import { db } from "./db";
import { now } from "./util";
import { scoreOf, scoreText } from "./score";

export type Verdict = "good" | "partly" | "wrong";
export const VERDICTS: Verdict[] = ["good", "partly", "wrong"];
export const GRADED_KINDS = ["read", "write", "reason", "search"] as const;
export type GradedKind = (typeof GRADED_KINDS)[number];
const SCORE: Record<Verdict, number> = { good: 1, partly: 0.5, wrong: 0 };
export const MIN_GRADES = 3; // fewer say little
export const DOWN_BELOW = 0.5; // under half good: moved down
export const LAST = 20; // the grades that count: a model's last 20 for a kind
export const KIND_WORD: Record<GradedKind, string> = { read: "reading", write: "drafting", reason: "working things out", search: "searching" };

export interface Standing { model: string; label: string; kind: GradedKind; n: number; good: number; partly: number; wrong: number; score: number; down: boolean }

let cache: Map<string, Standing> | null = null; // model|kind -> its standing
const key = (model: string, kind: string) => `${model}|${kind}`;
export const labelOf = (model: string) => (model === CODEX_ID ? CODEX_LABEL : getModel(model)?.label ?? model);
export function forgetGrades() { cache = null; }

function standingsMap(): Map<string, Standing> {
  if (cache) return cache;
  const rows = db.query("SELECT model, kind, verdict FROM grades ORDER BY id DESC").all() as { model: string; kind: GradedKind; verdict: Verdict }[];
  const m = new Map<string, Standing>();
  for (const r of rows) {
    const k = key(r.model, r.kind);
    const s = m.get(k) ?? m.set(k, { model: r.model, label: labelOf(r.model), kind: r.kind, n: 0, good: 0, partly: 0, wrong: 0, score: 0, down: false }).get(k)!;
    if (s.n >= LAST) continue; // only the last 20 count
    s.n++; s[r.verdict]++; s.score += SCORE[r.verdict];
  }
  for (const s of m.values()) { s.score = s.n ? s.score / s.n : 0; s.down = s.n >= MIN_GRADES && s.score < DOWN_BELOW; }
  return (cache = m);
}

export function standing(model: string, kind: GradedKind): Standing {
  return standingsMap().get(key(model, kind)) ?? { model, label: labelOf(model), kind, n: 0, good: 0, partly: 0, wrong: 0, score: 0, down: false };
}
export const movedDown = (model: string, kind: string | null | undefined) => !!kind && !!standingsMap().get(key(model, kind))?.down;
export function standings(): Standing[] {
  return [...standingsMap().values()].sort((a, b) => Number(b.down) - Number(a.down) || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
}

// One grade; a part graded again replaces its earlier grade (id: the earlier one's row, when it is still
// that model's grade for that kind: another chance deletes rows, and SQLite gives their ids out again).
export function addGrade(g: { model: string; kind: GradedKind; effort: string | null; verdict: Verdict; source: string }, replace: number | null = null): number {
  forgetGrades();
  if (replace !== null) {
    const r = db.query("UPDATE grades SET verdict = ?, source = ?, ts = ? WHERE id = ? AND model = ? AND kind = ?").run(g.verdict, g.source, now().toISOString(), replace, g.model, g.kind);
    if (r.changes) return replace;
  }
  const r = db.query("INSERT INTO grades(ts, model, kind, effort, verdict, source) VALUES (?, ?, ?, ?, ?, ?)").run(now().toISOString(), g.model, g.kind, g.effort, g.verdict, g.source);
  // Only the last 20 count, so only they are kept.
  db.query(`DELETE FROM grades WHERE model = ?1 AND kind = ?2 AND id NOT IN (SELECT id FROM grades WHERE model = ?1 AND kind = ?2 ORDER BY id DESC LIMIT ${LAST})`).run(g.model, g.kind);
  return Number(r.lastInsertRowid);
}

// Another chance: the model's grades for that kind are dropped, and it is picked again.
export function giveAnotherChance(model: string, kind: string): number {
  forgetGrades();
  return db.query("DELETE FROM grades WHERE model = ? AND kind = ?").run(model, kind).changes;
}

// "DeepSeek V4 Flash for reading: 75 of 100 (30 to 95, 4 grades): 2 good, 2 partly." (score.ts: good 1, partly half)
export function standingText(s: Standing): string {
  const parts = [s.good ? `${s.good} good` : "", s.partly ? `${s.partly} partly` : "", s.wrong ? `${s.wrong} wrong` : ""].filter(Boolean).join(", ");
  return `${s.label} for ${KIND_WORD[s.kind]}: ${scoreText(scoreOf(s))}: ${parts}${s.down ? ". Moved down: plans and the delegate skip it for this kind while another model can take it (Settings, How the models did for you, gives it another chance)" : s.n < MIN_GRADES ? ` (it moves down below 50, from ${MIN_GRADES} grades on)` : ""}.`;
}
