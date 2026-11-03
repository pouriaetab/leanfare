// How the free models have done for you, together, by kind of work (0.13.8). One free model rarely gets enough grades
// of its own to be moved down (grades.ts: 3 of its last 20), so the grades of every model that costs you nothing (a
// free tier, a free copy, a model on this computer) are also counted together, by kind, over the last 30 days:
//  - working things out at medium or high effort goes to a free model only once your grades say the free models do it
//    well: 60 of 100 or more from at least 5 grades. Low effort ones still go, which is how they earn it; at level 5,
//    All it can, they take it until their record says otherwise;
//  - no kind goes to them while their record for it is under half good, from 5 grades on.
// Held back, the work goes to a paid model you ticked, or to your ChatGPT plan through Codex, else your app keeps it.
// Grades older than 30 days drop out, so the free models get another go a month after a bad run.
import { getModel } from "./data";
import { db } from "./db";
import { DOWN_BELOW, KIND_WORD, type GradedKind } from "./grades";
import { scoreOf, scoreText } from "./score";
import { freeToYou } from "./share";
import { now } from "./util";

export const FREE_MIN = 5; // the free models' grades for a kind count from 5 on
export const FREE_EARN = 0.6; // working things out at medium or high effort: 60 of 100 or more
export const FREE_DAYS = 30;

export interface FreeRecord { kind: GradedKind; n: number; good: number; partly: number; wrong: number; score: number }

export function freeRecord(kind: GradedKind, at = now().getTime()): FreeRecord {
  const since = new Date(at - FREE_DAYS * 86_400_000).toISOString();
  const rows = db.query("SELECT model, verdict FROM grades WHERE kind = ? AND ts >= ?").all(kind, since) as { model: string; verdict: string }[];
  const r: FreeRecord = { kind, n: 0, good: 0, partly: 0, wrong: 0, score: 0 };
  for (const g of rows) {
    const m = getModel(g.model);
    if (!m || !freeToYou(m)) continue;
    if (g.verdict === "good") r.good++;
    else if (g.verdict === "partly") r.partly++;
    else if (g.verdict === "wrong") r.wrong++;
    else continue;
    r.n++;
  }
  r.score = r.n ? (r.good + r.partly / 2) / r.n : 0;
  return r;
}

// Why the free models sit out this kind of work at this effort, or null when they may take it.
export function freeHeld(kind: string | null | undefined, effort: string | null | undefined, level: number | null = null, at = now().getTime()): string | null {
  if (!kind || !Object.hasOwn(KIND_WORD, kind)) return null;
  const r = freeRecord(kind as GradedKind, at);
  const so = r.n ? scoreText(scoreOf(r)) : "no grades yet";
  if (r.n >= FREE_MIN && r.score < DOWN_BELOW) return `free models have scored ${so} at ${KIND_WORD[kind as GradedKind]} for you, under half good`;
  if (kind === "reason" && effort !== "low" && level !== 5 && !(r.n >= FREE_MIN && r.score >= FREE_EARN))
    return `free models take working things out at ${effort === "high" ? "high" : "medium"} effort once your grades say they do it well (60 of 100 from ${FREE_MIN} grades); so far ${so}`;
  return null;
}
