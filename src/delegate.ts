// Claude's delegate. Claude, or any MCP client, stays the manager and hands a piece of
// work to Leanfare: the task, its kind (read, write, reason), an effort (low, medium, high)
// and the files, which the MCP door reads itself (readfiles.ts), so their text never
// enters the caller's context. Leanfare picks the cheapest model that rates well enough
// for that kind and effort (Auto's Save more, Balanced or Best quality), within the budget,
// and answers briefly with a receipt: the model, the cost, and how many tokens of files
// stayed out of the caller's context.
//
// Checks: every high effort answer, 1 in 4 medium ones and 1 in 10 low ones, picked by
// chance (the caller can ask for always or never), go to a stronger model: one rated above
// the model that answered, the cheapest within 15 points of the best of those. It answers
// PASS or FAIL. A FAIL is asked again one tier up (Save more to Balanced, Balanced to Best
// quality, among models rated above the first; from Best quality, the checker itself).
// Neither the check nor the second try is sent past the budget, and what a task cost counts
// every try the ledger charged. A check stopped in Leanfare still gives back the answer.
//
// Each task is written to the delegations table with the chance it had of being checked,
// so pass rates can be weighted back to every task. No words are kept there or in the
// ledger: only models, verdicts, token counts and costs.
import { parseSpeed, secondsText, type SpeedChoice } from "./speed";
import { TASKS, fitsText, getModel, isRetired, type Model } from "./data";
import { db } from "./db";
import { passedLocal } from "./localpass";
import { mayTake, modelOn, readRisk } from "./platforms";
import { movedDown } from "./grades";
import { fromAnotherCompany, masked } from "./judge";
import { plan, runChat, usableModels, type ChatOptions } from "./engine";
import { DELEGATE_LIMITS, type DelegateFile } from "./readfiles";
import { guessTask, rating, type Guess, type Msg } from "./router";
import { settings, type Mode } from "./settings";
import { UserError } from "./upstream";
import { localDay, localMonth, now, randomId } from "./util";

export type Kind = "read" | "write" | "reason";
export type Effort = "low" | "medium" | "high";
export type CheckPolicy = "auto" | "always" | "never";
export interface DelegateInput {
  task: string; files: DelegateFile[]; kind: Kind | null; effort: Effort; check: CheckPolicy; maxOut: number; speed?: SpeedChoice;
  trial?: boolean; // the trial's questions (trial.ts): ledger rows say "trial", and none count in the delegate's own pass rates
  only?: (m: Model) => boolean; // a limit on every model of the task (the answer, the check, a second try): a plan's free part stays on free models
  model?: string; // a plan's part: the model its table named, asked first (planner.ts runPart)
  plan?: string; // a plan's part: the plan's id and the part's number (id:n), kept with its row
  private?: boolean; // stays on this computer: only models in Ollama and the other model apps here (platforms.ts: mayTake)
  app?: string | null; // the app that asked (the MCP door's client), for the report
  appModel?: string | null; // the model that app runs on, as it says: the prompt's main model
}

export const KINDS: Kind[] = ["read", "write", "reason"];
export const EFFORTS: Effort[] = ["low", "medium", "high"];
export const TIER: Record<Effort, Mode> = { low: "save", medium: "balanced", high: "best" };
const UP: Record<Mode, Mode | null> = { save: "balanced", balanced: "best", best: null };
export const CHANCE: Record<Effort, number> = { low: 0.1, medium: 0.25, high: 1 }; // checked when check is auto
export const DEFAULT_MAX_OUT = 8192;
export const CHECK_MAX_OUT = 4096;

// The chance draws (the tests set fixed numbers).
export const draw = { next: (): number => Math.random() };

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const num = (n: number) => Math.round(n).toLocaleString("en-US");
export const usd = (v: number | null | undefined) => (v === null || v === undefined ? "cost unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const taskLabel = (t: string) => TASKS.find(([id]) => id === t)?.[1] ?? t;

// The request body of POST /api/delegate, checked: the task, or one sentence saying what is wrong.
export function checkDelegate(b: any): DelegateInput | string {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "The request must be a JSON object.";
  if (typeof b.task !== "string" || !b.task.trim()) return "delegate needs a task.";
  if (b.task.length > DELEGATE_LIMITS.task) return `The task is ${num(b.task.length)} characters; the most is ${num(DELEGATE_LIMITS.task)}. Put long text in a file.`;
  const kind = b.kind === undefined || b.kind === null || b.kind === "auto" ? null : b.kind;
  if (kind !== null && !KINDS.includes(kind)) return "kind must be read, write or reason.";
  const effort = b.effort ?? "medium";
  if (!EFFORTS.includes(effort)) return "effort must be low, medium or high.";
  const check = b.check ?? "auto";
  if (!["auto", "always", "never"].includes(check)) return "check must be auto, always or never.";
  let maxOut = DEFAULT_MAX_OUT;
  if (b.max_tokens !== undefined && b.max_tokens !== null) {
    if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > 64000) return "max_tokens must be a whole number from 1 to 64,000.";
    maxOut = b.max_tokens;
  }
  const list = b.files ?? [];
  if (!Array.isArray(list)) return "files must be a list.";
  if (list.length > DELEGATE_LIMITS.count) return `At most ${DELEGATE_LIMITS.count} files go with one task.`;
  const files: DelegateFile[] = [];
  let total = 0;
  for (const f of list) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name.trim() || typeof f.text !== "string") return "Each file needs a name and its text.";
    const name = f.name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 500);
    const size = Buffer.byteLength(f.text);
    if (size > DELEGATE_LIMITS.file) return `${name} is ${mb(size)}; delegate reads at most ${mb(DELEGATE_LIMITS.file)} a file.`;
    total += size;
    if (total > DELEGATE_LIMITS.total) return `These files add up to more than ${mb(DELEGATE_LIMITS.total)}, the most delegate reads at once.`;
    files.push({ name, text: f.text.replace(/\u0000/g, "") });
  }
  let speed: SpeedChoice | undefined;
  if (b.speed !== undefined && b.speed !== null && b.speed !== "") {
    const v = parseSpeed(b.speed);
    if (v === null) return "speed must be cheapest, fastest, or a number of seconds from 1 to 3600.";
    speed = v;
  }
  if (b.private !== undefined && typeof b.private !== "boolean") return "private must be true or false.";
  const app = nameOf(b.app), appModel = nameOf(b.your_model ?? b.yourModel);
  if (appModel === false || app === false) return "app and your_model must be short names, like Claude Code and claude-opus-5-5.";
  return { task: b.task.trim(), files, kind, effort, check, maxOut, ...(speed !== undefined ? { speed } : {}), ...(b.private ? { private: true } : {}), ...(app ? { app } : {}), ...(appModel ? { appModel } : {}) };
}

// A short name an app gives (its own name, the model it runs on): null when none, false when it is not one.
export function nameOf(v: unknown): string | null | false {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return false;
  const s = v.replace(/[\u0000-\u001f]/g, "").trim();
  return s.length > 0 && s.length <= 80 ? s : false;
}

// The rating a task is judged by: the kind says it, or Auto's usual guess decides.
export function taskFor(kind: Kind | null, messages: Msg[]): Guess {
  const g = guessTask(messages);
  const given = (task: string): Guess => ({ task, why: `the kind it was handed over as (${kind})`, alt: "overall" });
  if (kind === "read") return given("longer_query");
  if (kind === "write") return g.task === "coding" || g.task === "creative_writing" ? g : given("instruction_following");
  if (kind === "reason") return g.task === "math" || g.task === "coding" ? g : given("hard_prompts");
  return g;
}

// The files as the model reads them. Lines are numbered unless the task is to write, so an
// answer can point to name:line.
export function filesBlock(files: DelegateFile[], numbered: boolean): string {
  return files.map((f) => {
    const text = f.text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    if (!text) return `[File: ${f.name}, empty]`;
    const lines = text.split("\n");
    const body = numbered ? lines.map((l, i) => `${i + 1}: ${l}`).join("\n") : text;
    return `[File: ${f.name}, ${num(lines.length)} line${lines.length === 1 ? "" : "s"}]\n${body}\n[End of ${f.name}]`;
  }).join("\n\n");
}

export function doerSystem(numbered: boolean, write: boolean, hasFiles: boolean): string {
  return [
    "Another AI assistant handed you this task so that it does not have to do the reading itself. Your answer goes straight back to it, and it pays for every word it reads.",
    "Do only what the task asks, as briefly as the task allows: no greeting, no restating of the task, no offer at the end.",
    "Answer in the form the task asks for: when it asks for names, numbers or text, give those themselves, not where to find them.",
    write ? "Give the finished text or code itself, ready to use." : "",
    // Leanfare's own trial (26 Oct) showed the cheapest models answering "README.md:46" to "which keys...?"
    // when this line said to point to places by line: they took it as the form of every answer.
    numbered && hasFiles ? "The files' lines are numbered: only when the task asks where something is, point to it as name:line." : "",
    hasFiles ? "If the files do not hold what is needed, say so plainly; never guess." : "If you are not sure, say so plainly; never guess.",
  ].filter(Boolean).join(" ");
}

export const CHECKER_SYSTEM = "You check another model's work. You get a task, the files that came with it, and the answer that was given. If the answer is correct and does what the task asks, reply PASS. Otherwise reply FAIL, then one short sentence on what is wrong or missing. Write nothing else.";

// The checker's verdict: PASS or FAIL first (in any case, after any markdown). Failing
// that, the last PASS or FAIL in capitals near the start, since a checker that thinks aloud
// ends on its verdict; "not PASS" counts as a fail. Anything else is unclear.
export function verdictOf(text: string): { verdict: "pass" | "fail" | "unclear"; why: string } {
  const t = text.replace(/[*_`#>"]/g, "").trim();
  const reason = (rest: string) => (rest.replace(/^[\s.:,;!-]+/, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300).replace(/[.!]+$/, "");
  const head = /^(?:verdict\s*:\s*)?(pass|fail)(?:ed|es|s)?\b([\s\S]*)$/i.exec(t);
  if (head) {
    const verdict = head[1].toLowerCase() as "pass" | "fail";
    return { verdict, why: verdict === "fail" ? reason(head[2]) : "" };
  }
  const near = t.slice(0, 600);
  const last = [...near.matchAll(/\b(PASS|FAIL)\b/g)].at(-1);
  if (!last) return { verdict: "unclear", why: "" };
  const at = last.index!;
  if (last[1] === "FAIL") return { verdict: "fail", why: reason(t.slice(at + 4)) };
  if (/\b(not|never|cannot|can't|won't|wouldn't|would not|doesn't|does not|didn't|did not)\s+$/i.test(near.slice(Math.max(0, at - 20), at))) return { verdict: "fail", why: "" };
  return { verdict: "pass", why: "" };
}

// Wilson's interval for a pass rate: it stays inside 0 to 100% and keeps its coverage with
// few checks, where the plain p ± z·se does not. z is the normal quantile for a 90% range.
export function wilson(k: number, n: number, z = 1.6448536269514722): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// The share of every handed over answer that would pass, from the checked ones, each
// weighted by one over its chance of being checked (Hajek's estimator): high effort
// answers are all checked and low ones rarely, so a plain pass rate leans to high effort.
export function weightedPass(rows: { verdict: string; chance: number }[]): number | null {
  let w = 0, wp = 0;
  for (const r of rows) {
    if (!(r.chance > 0) || (r.verdict !== "pass" && r.verdict !== "fail")) continue;
    w += 1 / r.chance;
    if (r.verdict === "pass") wp += 1 / r.chance;
  }
  return w > 0 ? wp / w : null;
}

export interface Who { id: string; label: string }
export interface DelegateCheck { chance: number; picked: boolean; verdict: "pass" | "fail" | "unclear" | "skipped" | null; why: string; checker: Who | null; cost: number | null; other?: boolean } // other: the checker is another company's model
export interface DelegateResult {
  answer: string;
  model: Who;
  cost: number | null; // the answer's cost (the second answer's, after a failed check)
  first: { model: Who; cost: number | null } | null; // the first answer, when a failed check replaced it
  rerunError: string | null; // asking again after a failed check did not work
  swap: string | null; // a plan's part: why another model answered than the one its table named
  row: number | null; // its row in the delegations table, which its grade goes to
  total: number | null; // everything this task cost: the answers and the check
  task: string;
  taskLabel: string;
  kind: Kind | null;
  effort: Effort;
  mode: Mode;
  check: DelegateCheck;
  tokens: { files: number; answer: number };
  cut: boolean; // the answer stopped at its limit
  seconds: number; // how long the whole hand off took, checks included
  receipt: string;
}

const who = (m: { id: string; label: string }): Who => ({ id: m.id, label: m.label });
const add = (...v: (number | null | undefined)[]) => (v.some((x) => x === null) ? null : v.reduce<number>((a, b) => a + (b ?? 0), 0));
// Tokens as Leanfare estimates them everywhere (about four characters each).
const tokensOf = (chars: number) => Math.ceil(chars / 4);

const INSERT = `INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance, checker, verdict, check_cost, rerun, rerun_cost, plan, task_tokens, app, app_model)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// taskTokens: a plan part's own text, which Leanfare wrote from the plan (the part, what the earlier parts
// found, the task it belongs to): the app that asked never read it. A hand off's task the app wrote itself: 0.
function writeRow(row: { task: string; kind: string | null; effort: Effort; model: string | null; cost: number | null; files: number; fileTokens: number; answerTokens: number; status: string; chance: number; checker: string | null; verdict: string | null; checkCost: number | null; rerun: string | null; rerunCost: number | null; plan?: string | null; taskTokens?: number; app?: string | null; appModel?: string | null }): number | null {
  const d = now();
  try {
    const r = db.query(INSERT).run(d.toISOString(), localMonth(d), localDay(d), row.task, row.kind, row.effort, row.model, row.cost, row.files, row.fileTokens, row.answerTokens, row.status, row.chance, row.checker, row.verdict, row.checkCost, row.rerun, row.rerunCost, row.plan ?? null, row.taskTokens ?? 0, row.app ?? null, row.appModel ?? null);
    return Number(r.lastInsertRowid);
  } catch (e) { console.error("leanfare: could not write the delegate's row:", String(e)); return null; } // the answer matters more than the row
}

// A plan part that ran without the delegate (a web search, or Codex on the user's ChatGPT plan), kept with the
// hand offs so Savings shows all of Leanfare's work for an app. No words: its kind, model, sizes and cost.
const KIND_TASK: Record<string, string> = { read: "longer_query", write: "instruction_following", reason: "hard_prompts" };
export function notePart(p: { kind: string; effort: Effort; model: string; cost: number | null; files: number; fileTokens: number; task: string; answer: string; plan: string; app?: string | null; appModel?: string | null }): number | null {
  return writeRow({ task: KIND_TASK[p.kind] ?? "overall", kind: p.kind, effort: p.effort, model: p.model, cost: p.cost, files: p.files, fileTokens: p.fileTokens, answerTokens: tokensOf(p.answer.length),
    status: "ok", chance: 0, checker: null, verdict: null, checkCost: null, rerun: null, rerunCost: null, plan: p.plan, taskTokens: tokensOf(p.task.length), app: p.app ?? null, appModel: p.appModel ?? null });
}

// How the app that asked graded a hand off's answer, kept with its row: the hand off's row when the app
// names it, else that plan part's row, else the last answer of that model for that kind in the last 6 hours
// that has no grade yet.
export function gradeRow(verdict: string, by: { row?: number; plan?: string; model?: string; kind?: string }): boolean {
  try {
    if (by.row !== undefined) return db.query("UPDATE delegations SET grade = ? WHERE id = ? AND status = 'ok'").run(verdict, by.row).changes > 0;
    if (by.plan) return db.query("UPDATE delegations SET grade = ? WHERE id = (SELECT id FROM delegations WHERE plan = ? AND status = 'ok' ORDER BY id DESC LIMIT 1)").run(verdict, by.plan).changes > 0;
    if (by.model && by.kind) {
      const since = new Date(now().getTime() - 6 * 3600_000).toISOString();
      return db.query("UPDATE delegations SET grade = ? WHERE id = (SELECT id FROM delegations WHERE (model = ?2 OR rerun = ?2) AND kind = ?3 AND status = 'ok' AND grade IS NULL AND ts >= ?4 ORDER BY id DESC LIMIT 1)").run(verdict, by.model, by.kind, since).changes > 0;
    }
  } catch (e) { console.error("leanfare: could not keep the grade with its hand off:", String(e)); }
  return false;
}

export function receiptOf(r: Omit<DelegateResult, "receipt">, maxOut: number): string {
  const parts: string[] = [];
  const c = r.check;
  if (r.first && c.checker) parts.push(`Leanfare delegate: ${r.first.model.label} answered first (${usd(r.first.cost)}), ${c.checker.label} failed it (${c.why || "no reason given"}; ${usd(c.cost)}), so ${r.model.label} answered again (${usd(r.cost)}). This is the second answer, not checked again.`);
  else {
    parts.push(`Leanfare delegate: ${r.model.label}, ${usd(r.cost)}.`);
    if (r.swap) parts.push(r.swap);
    // Blind: the checker was not told which model answered (judge.ts).
    const by = `${c.checker?.label}${c.other ? " (another company)" : ""}`;
    if (c.verdict === "pass") parts.push(`Checked blind by ${by}: passed (${usd(c.cost)}).`);
    else if (c.verdict === "unclear") parts.push(`Checked blind by ${by}: no clear verdict (${usd(c.cost)}).`);
    else if (c.verdict === "fail") parts.push(`${c.checker!.label} failed it (${c.why || "no reason given"}; ${usd(c.cost)}), and asking again did not work (${r.rerunError ?? "unknown"}). Check this answer yourself.`);
    else if (c.verdict === "skipped") parts.push(`Not checked: ${c.why}.`);
    else if (c.chance > 0) parts.push(`Not checked this time (Leanfare checks 1 in ${Math.round(1 / c.chance)} ${r.effort} effort answers).`);
  }
  if (r.tokens.files > 0) parts.push(`About ${num(r.tokens.files)} tokens of files stayed out of your context; this answer is about ${num(r.tokens.answer)}.`);
  // A free tier whose terms let its company read or train on what was sent says so (platforms.ts: readRisk).
  const m = getModel(r.model.id);
  const risk = m ? readRisk(m) : null;
  if (risk) parts.push(`${r.model.label} is on a free tier: ${risk}. For anything private, ask Leanfare to keep it on this computer.`);
  parts.push(`It took ${secondsText(r.seconds)}.`);
  if (r.cut) parts.push(`It stopped at its limit of ${num(maxOut)} tokens, so it may be cut short.`);
  return parts.join(" ");
}

// What a hand off would cost and take before it is sent (the trial's estimate): the first answer
// only, as Auto would pick it now. Null when no model is ready.
export async function estimateDelegate(input: DelegateInput, signal: AbortSignal): Promise<{ estimate: number | null; seconds: number | null; model: string | null; error: string | null }> {
  const numbered = input.kind !== "write";
  const block = filesBlock(input.files, numbered);
  const messages: Msg[] = [{ role: "user", content: block ? `${input.task}\n\n${block}` : input.task }];
  try {
    const p = await plan({ source: "chat", asked: `auto-${TIER[input.effort]}`, messages, system: doerSystem(numbered, input.kind === "write", input.files.length > 0),
      maxOut: input.maxOut, signal, dry: true, effort: input.effort, guess: taskFor(input.kind, messages), speed: input.speed, ledgerSource: input.trial ? "trial" : "delegate" });
    return { estimate: p.estimate, seconds: p.seconds, model: p.model.id, error: null };
  } catch (e: any) { return { estimate: null, seconds: null, model: null, error: String(e?.message ?? e) }; }
}

export async function runDelegate(input: DelegateInput, signal: AbortSignal): Promise<DelegateResult> {
  const started = performance.now();
  const numbered = input.kind !== "write";
  const block = filesBlock(input.files, numbered);
  const prompt = block ? `${input.task}\n\n${block}` : input.task;
  const messages: Msg[] = [{ role: "user", content: prompt }];
  const guess = taskFor(input.kind, messages);
  const system = doerSystem(numbered, input.kind === "write", input.files.length > 0);
  const fileTokens = tokensOf(input.files.reduce((n, f) => n + f.text.length, 0));
  const day = localDay();
  // A model whose context holds the request: its text at three characters a token (code
  // packs tighter than prose), plus the answer limit. A model with no known context is let through.
  // need: what the message says; a model in Ollama keeps less room for the answer (data.ts: fitsText).
  const fit = (chars: number, out: number) => ({ need: Math.ceil(chars / 3) + out, ok: (m: Model) => fitsText(m, chars, out) });
  const tooMuch = (need: number) => `None of the models you ticked can take this much text (about ${num(need)} tokens with the answer). Hand over fewer or shorter files, or tick a model with a longer context.`;
  // Rated above the model that answered, for this task.
  const ratedAbove = (doer: Model) => {
    const r0 = rating(doer, guess.task);
    return (m: Model) => { if (m.id === doer.id || isRetired(m, day)) return false; const r = rating(m, guess.task); return r !== null && (r0 === null || r > r0); };
  };
  // What a call was charged: every try of it (a first try asked again included), as the ledger has it.
  const charged = (r: { meta: any; status: string }): number | null => (r.meta?.spent !== undefined ? r.meta.spent : r.meta?.cost ?? (r.status === "ok" ? null : 0));
  const run = async (msgs: Msg[], asked: string, label: string, opts: ChatOptions) => {
    let err: { message: string; status: number } | null = null;
    const r = await runChat(msgs, asked, signal, (e) => { if (e.type === "error") err = { message: e.message, status: e.status }; }, label, opts);
    const error = (err as { message: string; status: number } | null) ?? (r.status === "error" ? { message: String(r.meta?.error ?? "The answer failed."), status: 502 } : null);
    return { ...r, cost: charged(r), error };
  };
  const gone = () => signal.aborted; // the caller went away: there is nobody to answer
  const row = { task: guess.task, kind: input.kind, effort: input.effort, files: input.files.length, fileTokens, plan: input.plan ?? null, taskTokens: input.plan ? tokensOf(input.task.length) : 0, app: input.app ?? null, appModel: input.appModel ?? null };
  const source = input.trial ? "trial" : "delegate";
  const write = (r: Parameters<typeof writeRow>[0]) => (input.trial ? null : writeRow(r));
  const none = { checker: null, verdict: null, checkCost: null, rerun: null, rerunCost: null };

  const doFit = fit(prompt.length + system.length, input.maxOut);
  const limit = input.only;
  // The platforms turned off for plans and the delegate are left out (platforms.ts); not for the test of one
  // named model on this computer, which you asked for by name.
  const on = input.trial && input.model ? () => true : modelOn;
  // A private task stays on this computer; files from your projects go where Settings says (platforms.ts).
  const work = { private: !!input.private, files: input.files.length > 0 };
  const allowed = (m: Model) => mayTake(m, work);
  const kept = (ok: (m: Model) => boolean) => (m: Model) => ok(m) && on(m) && allowed(m) && (!limit || limit(m));
  // A model the manager's grades moved down for this kind is skipped, while another can take it (grades.ts).
  const within = (ok: (m: Model) => boolean) => {
    const base = kept(ok);
    if (!input.kind) return base;
    const graded = (m: Model) => base(m) && !movedDown(m.id, input.kind);
    return usableModels(graded).length ? graded : base;
  };
  // A plan's part runs on the model its table named, so the table is what runs. When that model can no
  // longer take it here, or cannot answer now (busy, rate limited, down), Auto picks another within the same
  // limits (a free part stays free), and the receipt says which and why.
  const asked = `auto-${TIER[input.effort]}`;
  // Nothing may take it: a private task with no model here that can, files with nowhere Settings lets them go, or
  // platforms turned off. Said so, not as too much text.
  if (!usableModels(within(doFit.ok)).length) {
    if (input.private && !usableModels((m) => !!m.local && doFit.ok(m)).length) throw Object.assign(new UserError(409, "This task is to stay on this computer, and none of your models here can take it. Do it yourself, or start Ollama with a model that fits (Settings, Local models).", "private_none"), { spent: 0 });
    if (!input.private && work.files && usableModels((m) => doFit.ok(m) && on(m) && (!limit || limit(m))).length && !usableModels((m) => doFit.ok(m) && on(m) && allowed(m) && (!limit || limit(m))).length)
      throw Object.assign(new UserError(409, `Your projects' files go ${settings().filesTo === "local" ? "only to this computer" : "to no free tier that may be read"} (Settings, Where Leanfare may send work), and no model there can take this. Do it yourself, or change that setting.`, "files_where"), { spent: 0 });
    if (usableModels((m) => doFit.ok(m) && (!limit || limit(m))).length)
      throw Object.assign(new UserError(409, "The models that could take it are on platforms turned off for plans and the delegate (Settings, Where Leanfare may send work). Turn one on there, or do it yourself.", "platform_off"), { spent: 0 });
  }
  const opts: ChatOptions = { system, source, guess, only: within(doFit.ok), onlyWhy: tooMuch(doFit.need), effort: input.effort, maxOut: input.maxOut, speed: input.speed };
  // Reading at low or medium effort goes first to a model on this computer that passed its test here
  // (localpass.ts), when nothing is named and Auto is to be the cheapest: it is free.
  const local = !input.model && !input.trial && input.kind === "read" && input.effort !== "high" && (input.speed ?? settings().speed) === "cheapest" ? passedLocal(within(doFit.ok)) : null;
  const named = input.model ? getModel(input.model) ?? null : local;
  const namedOk = !!named && usableModels(within(doFit.ok)).some((m) => m.id === named.id);
  let swap: string | null = input.model && !namedOk ? `The plan named ${named?.label ?? input.model}, which cannot take it here now, so Auto picked another.` : null;
  let first = await run(messages, namedOk ? named!.id : asked, "Delegate", opts);
  const tried: (number | null)[] = [];
  if (namedOk && first.status !== "ok" && first.status !== "stopped" && !gone()) {
    tried.push(first.cost);
    const why = (first.error?.message ?? "it failed").replace(/\.$/, "");
    const other = await run(messages, asked, "Delegate", { ...opts, only: within((m) => doFit.ok(m) && m.id !== named!.id) });
    if (other.status === "ok") { swap = local ? `${named!.label}, on this computer, could not answer (${why}), so ${other.meta.model.label} answered.` : `The plan named ${named!.label}, which could not answer (${why}), so ${other.meta.model.label} answered.`; first = other; }
    else if (other.status === "stopped") first = other;
  }
  if (first.status !== "ok") {
    write({ ...row, ...none, model: first.meta?.model?.id ?? null, cost: first.cost, answerTokens: 0, status: first.status, chance: 0 });
    // spent: what the call was charged, so whoever runs it can count it (a plan's run does).
    if (first.status === "stopped") throw Object.assign(new UserError(499, gone() ? "Stopped." : "Stopped in Leanfare before it answered.", "stopped"), { spent: first.cost });
    throw Object.assign(new UserError(first.error!.status, first.error!.message, "delegate_failed"), { spent: first.cost });
  }
  const doer = getModel(first.meta.model.id) ?? null; // null only if the price list changed while it ran
  const chance = input.check === "always" ? 1 : input.check === "never" ? 0 : CHANCE[input.effort];
  const picked = chance >= 1 || (chance > 0 && draw.next() < chance);
  const check: DelegateCheck = { chance, picked, verdict: null, why: "", checker: null, cost: null };
  const spent: (number | null)[] = [...tried, first.cost]; // every call made for this task
  let final = first;
  let firstUsed: DelegateResult["first"] = null;
  let rerunError: string | null = null;
  let rerunCost: number | null = null;
  // The caller went away part way: the row keeps what was charged, and there is no answer to give.
  const stopped = () => {
    write({ ...row, model: first.meta.model.id, cost: first.cost, answerTokens: tokensOf(first.text.length), status: "stopped", chance, checker: check.checker?.id ?? null, verdict: null, checkCost: check.cost, rerun: null, rerunCost });
    return Object.assign(new UserError(499, "Stopped.", "stopped"), { spent: add(...spent) });
  };

  if (picked) {
    // Blind: the checker is not told which model answered, and what the answer says of its own model is masked (judge.ts).
    const checkPrompt = `The task:\n${input.task}${block ? `\n\n${block}` : ""}\n\nThe answer to check:\n${masked(first.text)}`;
    const ckFit = fit(checkPrompt.length + CHECKER_SYSTEM.length, CHECK_MAX_OUT);
    // Rated above the model that answered and able to take the check's text; the grades' preference
    // comes last, so a moved-down model still checks when it is the only one that can.
    const above0 = doer ? ratedAbove(doer) : () => false;
    const above = kept(above0);
    // A checker from another company than the model that answered, when one rated above it can take it (judge.ts).
    const judge = fromAnotherCompany(doer ? [doer] : [], within((m) => above0(m) && ckFit.ok(m)));
    const stronger = judge.only;
    if (!usableModels(above).length) {
      check.verdict = "skipped";
      check.why = doer ? `${doer.label} is the best rated model you ticked for this, so there is no stronger one to check it` : "the model that answered is no longer in Leanfare's price list";
    } else if (!usableModels((m) => above(m) && ckFit.ok(m)).length) {
      check.verdict = "skipped";
      check.why = `the models rated above ${doer!.label} cannot take the check's text (about ${num(ckFit.need)} tokens)`;
    } else {
      const c = await run([{ role: "user", content: checkPrompt }], "auto-best", "Delegate check", { system: CHECKER_SYSTEM, source: input.trial ? "trial" : "check", guess, only: stronger, onlyWhy: tooMuch(ckFit.need), maxOut: CHECK_MAX_OUT, optional: true, speed: input.speed });
      check.cost = c.cost;
      spent.push(c.cost);
      if (c.status === "stopped" && gone()) throw stopped();
      if (c.status !== "ok") {
        check.verdict = "skipped";
        check.why = c.status === "stopped" ? "the check was stopped in Leanfare" : `the check could not run (${c.error!.message.replace(/\.$/, "")})`;
      } else {
        const checker = who(c.meta.model);
        const v = verdictOf(c.text);
        check.verdict = v.verdict; check.why = v.why; check.checker = checker; check.other = judge.other;
        if (v.verdict === "fail") {
          // One tier up, among the models rated above the first; from Best quality, the checker
          // itself. Like the check, it never goes past the budget: the first answer is there.
          const up = UP[TIER[input.effort]];
          const note = `\n\nA checker found a problem with an earlier answer to this task: ${(v.why || "it was judged wrong").replace(/[.!]?$/, ".")} Avoid it.`;
          const againFit = fit(prompt.length + note.length + system.length, input.maxOut);
          const again = await run([{ role: "user", content: prompt + note }], up ? `auto-${up}` : checker.id, "Delegate, asked again", { system, source, guess, only: within((m) => above0(m) && againFit.ok(m)), onlyWhy: tooMuch(againFit.need), effort: input.effort, maxOut: input.maxOut, optional: true, speed: input.speed });
          rerunCost = again.cost;
          spent.push(again.cost);
          if (again.status === "stopped" && gone()) throw stopped();
          if (again.status === "ok") { firstUsed = { model: who(first.meta.model), cost: first.cost }; final = again; }
          else rerunError = again.status === "stopped" ? "it was stopped in Leanfare" : again.error!.message.replace(/\.$/, "");
        }
      }
    }
  }

  const model = who(final.meta.model);
  const answerTokens = tokensOf(final.text.length);
  const result: Omit<DelegateResult, "receipt"> = {
    answer: final.text,
    model,
    cost: final.cost,
    first: firstUsed,
    rerunError,
    swap,
    row: null,
    total: add(...spent),
    task: guess.task,
    taskLabel: taskLabel(guess.task),
    kind: input.kind,
    effort: input.effort,
    mode: TIER[input.effort],
    check,
    tokens: { files: fileTokens, answer: answerTokens },
    cut: final.meta.finish === "length",
    seconds: (performance.now() - started) / 1000,
  };
  result.row = write({ ...row, model: first.meta.model.id, cost: first.cost, answerTokens, status: "ok", chance, checker: check.checker?.id ?? null, verdict: picked ? check.verdict : null, checkCost: check.cost, rerun: firstUsed ? model.id : null, rerunCost });
  return { ...result, receipt: receiptOf(result, input.maxOut) };
}

// ---- a hand off that takes longer than an app waits ------------------------------------------------
// An app waits about a minute for a tool's answer (Cowork's link to this computer: 60 seconds). A hand off
// asked with a wait runs on its own: its answer comes back within the wait when it can, and otherwise the
// app gets an id and asks again with it. The last 50 are kept, for 2 hours; switching Leanfare off stops them.
interface Job { id: string; started: number; done: boolean; result: DelegateResult | null; error: { status: number; message: string } | null; ac: AbortController; settled: Promise<void> }
const jobs = new Map<string, Job>();
const KEEP_MS = 2 * 60 * 60_000;
const KEEP_N = 50;

export function startDelegate(input: DelegateInput): Job {
  for (const [id, j] of jobs) if (j.done && Date.now() - j.started > KEEP_MS) jobs.delete(id);
  while (jobs.size >= KEEP_N) jobs.delete(([...jobs.values()].find((j) => j.done) ?? [...jobs.values()][0]).id);
  const ac = new AbortController();
  const job: Job = { id: randomId(), started: Date.now(), done: false, result: null, error: null, ac, settled: Promise.resolve() };
  job.settled = runDelegate(input, ac.signal)
    .then((r) => { job.result = r; }, (e: any) => { job.error = { status: e instanceof UserError ? e.status : 500, message: String(e?.message ?? e) }; })
    .finally(() => { job.done = true; });
  jobs.set(job.id, job);
  return job;
}

// The job after at most this many seconds of waiting for it to end (sooner when the asker goes away).
export async function waitDelegate(id: string, seconds: number, signal?: AbortSignal): Promise<Job | null> {
  const job = jobs.get(id);
  if (!job) return null;
  if (!job.done && seconds > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone: (() => void) | undefined;
    await Promise.race([
      job.settled,
      new Promise<void>((r) => { timer = setTimeout(r, seconds * 1000); }),
      new Promise<void>((r) => { gone = () => r(); signal?.addEventListener("abort", gone, { once: true }); }),
    ]);
    clearTimeout(timer);
    if (gone) signal?.removeEventListener("abort", gone);
  }
  return job;
}

export function stopDelegates(): number {
  let n = 0;
  for (const j of jobs.values()) if (!j.done) { j.ac.abort(); n++; }
  return n;
}

