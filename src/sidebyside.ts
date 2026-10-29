// Side by side (0.9). On a sample of hand offs, the best rated model you ticked for the task answers it too, and a
// judge from a third company compares the two answers blind: it is not told which model wrote which, what each says
// of its own model is masked (judge.ts), and they come in a random order. So Leanfare learns how close each model's
// work is to the top model's, for each kind of work, and the report can say it. It runs after the answer has gone
// back to the app, so a hand off never waits for it, and it is never sent past your budget, nor past its own
// monthly limit (Settings, Side by side). Kept: which models, the kind, the verdict and the costs, never the words.
import { CODEX_ID, CODEX_LABEL } from "./codex";
import { costOf, ZERO } from "./cost";
import { getModel, isRetired, type Model } from "./data";
import { db } from "./db";
import { runChat, usableModels } from "./engine";
import { companyOf, masked } from "./judge";
import { rating, type Guess, type Msg } from "./router";
import { settings } from "./settings";
import { localDay, localMonth, now } from "./util";

export const EVERY = [0, 5, 10, 20] as const; // one hand off in this many is compared (0: off)
export const JUDGE_MAX_OUT = 4096;
export const JUDGE_SYSTEM = "You compare two answers to the same task, written by two AI models whose names are hidden. You get the task, the files that came with it, and answers A and B. Judge only whether each answer is correct and does what the task asks: a shorter answer that does it is as good as a longer one, and the order says nothing. Reply A if A is better, B if B is better, or SAME if they are about as good. Then one short sentence on why. Write nothing else.";
export const draw = { next: (): number => Math.random() }; // the sample (tests set it)
const KINDS = new Set(["read", "write", "reason"]);

export type SideVerdict = "same" | "better" | "worse" | "unclear" | "failed";

// The judge's verdict: A, B or SAME first (after any markdown or "Verdict:"); failing that, "Answer A" or "Answer B"
// near the start. Anything else is unclear.
export function sideVerdictOf(text: string): "A" | "B" | "same" | null {
  const t = text.replace(/[*_`#>"]/g, "").trim();
  const head = /^(?:verdict\s*:\s*)?(?:answer\s+)?(A|B|SAME|TIE|EQUAL)\b/i.exec(t);
  if (head) { const v = head[1].toUpperCase(); return v === "A" || v === "B" ? v : "same"; }
  const near = /\banswer\s+(A|B)\s+is\s+better\b/i.exec(t.slice(0, 400));
  return near ? (near[1].toUpperCase() as "A" | "B") : null;
}

export interface SideInput {
  handoff: number; kind: string; effort: string; guess: Guess; messages: Msg[]; system: string; maxOut: number;
  task: string; block: string; doer: Model; answer: string; allowed: (m: Model) => boolean;
}

const running = new Set<{ ac: AbortController; done: Promise<void> }>();
let held = 0; // what the comparisons still running are expected to cost: counted against the month's limit until they end
export const sideBySideRunning = () => running.size;
export const sideBySideHeld = () => held;
// Every comparison running now, ended (the tests wait for them).
export async function sideBySideIdle() { while (running.size) await Promise.all([...running].map((r) => r.done)); }
export function stopSideBySide(): number { let n = 0; for (const r of running) { r.ac.abort(); n++; } return n; }

// What side by side cost this month: the top models' answers and the judges.
export function sideSpent(month = localMonth()): number {
  return (db.query("SELECT COALESCE(SUM(COALESCE(top_cost, 0) + COALESCE(judge_cost, 0)), 0) AS v FROM comparisons WHERE month = ?").get(month) as any).v;
}

const fits = (m: Model, chars: number, out: number) => m.context === null || Math.ceil(chars / 3) + out <= m.context;
const estimate = (m: Model, chars: number, out: number) => costOf(m, { ...ZERO, uncached: Math.ceil(chars / 3), output: out }) ?? 0;

// Which hand offs are compared, and with which models: the top model (rated above the one that answered, the best
// you ticked for the task) and a judge of a third company. Null when this one is not compared, with no cost.
export function sideBySidePick(x: SideInput): { top: Model; judge: Model; cost: number } | null {
  const s = settings();
  if (!s.sideBySide || !KINDS.has(x.kind) || !(draw.next() < 1 / s.sideBySide)) return null;
  const day = localDay();
  const task = x.guess.task;
  const r0 = rating(x.doer, task);
  const chars = x.messages.reduce((n, m) => n + String(m.content).length, 0) + x.system.length;
  const ready = (m: Model) => m.id !== x.doer.id && m.id !== CODEX_ID && !isRetired(m, day) && x.allowed(m);
  const best = (ms: Model[]) => ms.sort((a, b) => (rating(b, task) ?? 0) - (rating(a, task) ?? 0))[0] ?? null;
  const above = (m: Model) => { const r = rating(m, task); return r !== null && (r0 === null || r > r0); }; // an unrated model (most local ones): any rated one
  const top = best(usableModels((m) => ready(m) && fits(m, chars, x.maxOut) && above(m)));
  if (!top) return null; // the model that answered is the best you ticked for this
  const outGuess = Math.min(x.maxOut, Math.ceil(x.answer.length / 3) * 2);
  const judgeChars = chars + x.answer.length + outGuess * 3 + JUDGE_SYSTEM.length;
  const third = (m: Model) => { const c = companyOf(m); return c === null || (c !== companyOf(x.doer) && c !== companyOf(top)); };
  const judge = best(usableModels((m) => ready(m) && m.id !== top.id && third(m) && fits(m, judgeChars, JUDGE_MAX_OUT)));
  if (!judge) return null; // no model of a third company can judge it
  // Its own limit for the month, before it is sent: what the top model's answer and the judge would cost.
  const cost = estimate(top, chars, outGuess) + estimate(judge, judgeChars, 300);
  if (sideSpent() + held + cost > s.sideBySideCap) return null;
  return { top, judge, cost };
}

// Compares one hand off's answer with the top model's, in the background. Returns the comparison's promise, or null
// when this hand off is not compared.
export function startSideBySide(x: SideInput): Promise<void> | null {
  const pick = sideBySidePick(x);
  if (!pick) return null;
  const ac = new AbortController();
  const job = { ac, done: Promise.resolve() };
  held += pick.cost;
  job.done = compare(x, pick.top, pick.judge, ac.signal).catch((e) => console.error("leanfare: side by side failed:", String(e?.message ?? e))).finally(() => { running.delete(job); held = Math.max(0, held - pick.cost); });
  running.add(job);
  return job.done;
}

async function compare(x: SideInput, top: Model, judge: Model, signal: AbortSignal) {
  const charged = (r: { meta: any; status: string }): number | null => (r.meta?.spent !== undefined ? r.meta.spent : r.meta?.cost ?? (r.status === "ok" ? null : 0));
  const write = (verdict: SideVerdict, first: string | null, topCost: number | null, judgeCost: number | null, judgeId: string | null) => {
    const d = now();
    db.query("INSERT INTO comparisons(ts, month, day, handoff, kind, effort, model, top_model, judge, shown_first, verdict, top_cost, judge_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.toISOString(), localMonth(d), localDay(d), x.handoff, x.kind, x.effort, x.doer.id, top.id, judgeId, first, verdict, topCost, judgeCost);
  };
  const t = await runChat(x.messages, top.id, signal, () => {}, "Side by side", { system: x.system, source: "sidebyside", guess: x.guess, only: (m) => m.id === top.id, maxOut: x.maxOut, optional: true });
  if (t.status !== "ok") { write("failed", null, charged(t), null, null); return; }
  // A random order, so the judge cannot favour the first answer or the second.
  const modelFirst = draw.next() < 0.5;
  const [a, b] = modelFirst ? [x.answer, t.text] : [t.text, x.answer];
  const prompt = `The task:\n${x.task}${x.block ? `\n\n${x.block}` : ""}\n\nAnswer A:\n${masked(a)}\n\nAnswer B:\n${masked(b)}`;
  const j = await runChat([{ role: "user", content: prompt }], judge.id, signal, () => {}, "Side by side, judged", { system: JUDGE_SYSTEM, source: "sidebyside", guess: x.guess, only: (m) => m.id === judge.id, maxOut: JUDGE_MAX_OUT, optional: true });
  const first = modelFirst ? "model" : "top";
  if (j.status !== "ok") { write("failed", first, charged(t), charged(j), judge.id); return; }
  const v = sideVerdictOf(j.text);
  const verdict: SideVerdict = v === null ? "unclear" : v === "same" ? "same" : (v === "A") === modelFirst ? "better" : "worse";
  write(verdict, first, charged(t), charged(j), judge.id);
}

// ---- what side by side found -------------------------------------------------------------------------
export interface SideStanding { model: string; label: string; kind: string; n: number; same: number; better: number; worse: number; tops: string[]; judges: string[] }
const labelOf = (id: string) => (id === CODEX_ID ? CODEX_LABEL : getModel(id)?.label ?? (id.split("/").slice(1).join("/") || id));

// Each model's comparisons for each kind of work (the last 50): as good as the top model, better, or worse.
export function sideStandings(): SideStanding[] {
  const rows = db.query("SELECT model, kind, top_model AS top, judge, verdict FROM comparisons WHERE verdict IN ('same', 'better', 'worse') ORDER BY id DESC").all() as any[];
  const m = new Map<string, SideStanding>();
  for (const r of rows) {
    const k = `${r.model}|${r.kind}`;
    const s = m.get(k) ?? m.set(k, { model: r.model, label: labelOf(r.model), kind: r.kind, n: 0, same: 0, better: 0, worse: 0, tops: [], judges: [] }).get(k)!;
    if (s.n >= 50) continue;
    s.n++; s[r.verdict as "same" | "better" | "worse"]++;
    if (!s.tops.includes(labelOf(r.top))) s.tops.push(labelOf(r.top));
    if (r.judge && !s.judges.includes(labelOf(r.judge))) s.judges.push(labelOf(r.judge));
  }
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
}

const KIND_WORD: Record<string, string> = { read: "reading", write: "drafting", reason: "working things out" };
export function sideText(s: SideStanding): string {
  return `${s.label} for ${KIND_WORD[s.kind] ?? s.kind}: as good as the top model in ${s.same + s.better} of ${s.n}${s.better ? ` (better in ${s.better})` : ""}, against ${s.tops.join(", ")}, judged blind by ${s.judges.join(", ")}.`;
}

// This month's comparisons, for Savings and the spend tool.
export function sideMonth(month = localMonth()) {
  const r = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(verdict IN ('same', 'better')), 0) AS good, COALESCE(SUM(verdict = 'worse'), 0) AS worse,
    COALESCE(SUM(COALESCE(top_cost, 0) + COALESCE(judge_cost, 0)), 0) AS cost FROM comparisons WHERE month = ? AND verdict IN ('same', 'better', 'worse')`).get(month) as any;
  return { compared: r.n as number, asGood: r.good as number, worse: r.worse as number, cost: sideSpent(month) };
}
