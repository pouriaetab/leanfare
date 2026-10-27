// The plan: a task split into parts before anything starts, each with where it runs and on which
// model. A table, not prose (26 Oct: "just spread out a table ... on the stages of the plan, on what
// models to use"): the part, its kind, where it runs, the model, about how long, the tokens it keeps
// out of the person's plan (or takes from it), and what it costs on pay per use.
//
// The app the person works in (Claude Code, Codex, Cursor...) stays the manager: its model spends the
// person's subscription, which no other app may use, so the parts that change the project or need
// that app's tools stay with it. The parts that read, draft or work something out can go to
// Leanfare, which runs them on the cheapest model that rates well enough (local and free ones first,
// as Auto does), inside the budget.
//
// The split: a model the person ticked (Auto, Balanced, rated for hard prompts) answers with the
// parts as JSON. With no model ready, or an answer that does not read as parts, Leanfare splits by
// rules. Where each part runs and on which model, Leanfare decides itself, from the kind and effort
// of each part, Auto's ratings and prices, the times models took here, and how much of the person's
// plan is left: near a limit, more parts go out.
//
// No words are kept: the ledger has the split's model, tokens and cost, as for any answer.
import { TIER, taskFor, type Effort, type Kind } from "./delegate";
import type { Model } from "./data";
import { chargeOf, plan as route, runChat, usableModels } from "./engine";
import { windowsNow } from "./plans";
import { guessTask, type Msg } from "./router";
import { UserError } from "./upstream";
import { secondsText } from "./util";

export type PartKind = "read" | "write" | "reason" | "code" | "search" | "act";
export type Size = "none" | "small" | "medium" | "large";
export type Where = "you" | "local" | "free" | "paid";
export const PART_KINDS: PartKind[] = ["read", "write", "reason", "code", "search", "act"];
const SIZES: Size[] = ["none", "small", "medium", "large"];
const EFFORTS: Effort[] = ["low", "medium", "high"];
// About how many tokens a part reads when no file says it: a page, a few files, a folder.
export const SIZE_TOKENS: Record<Size, number> = { none: 500, small: 3_000, medium: 30_000, large: 150_000 };
const OUT_YOU = 2_000; // what a part the app does itself writes, about
export const MAX_PARTS = 8;
export const MAX_TASK = 20_000; // characters

export interface PlanFile { name: string; size: number } // bytes
export interface Part {
  n: number;
  title: string;
  kind: PartKind;
  effort: Effort;
  needs: number[]; // the parts whose results it uses; the others can run at once
  task: string; // what to hand over, for a model that has not seen the conversation
  files: string[]; // the files it reads, as named
  size: Size;
  where: Where; // you: the app you work in; local, free, paid: Leanfare, on that kind of model
  model: { id: string; label: string } | null; // Leanfare's pick; null when it stays with you
  seconds: number | null; // about how long Leanfare's model takes; null when it stays with you
  tokens: number; // about how many it reads and writes
  cost: number | null; // on pay per use; 0 on a local or free model; null when it stays with you, or not known
  why: string;
}
export interface PlanResult {
  task: string;
  manager: string; // the app the person works in, as said ("Claude Code"), or "you"
  parts: Part[];
  totals: { parts: number; out: number; kept: number; used: number; seconds: number | null; cost: number | null };
  split: { by: "model" | "rules"; model: { id: string; label: string } | null; cost: number | null; note: string | null };
  limits: { five: number | null; week: number | null } | null; // the person's plan windows, when known (percent used)
  table: string; // the table as markdown
  next: string; // what to do now
}

// ---- the split ------------------------------------------------------------------------------------

export const SPLIT_SYSTEM = [
  "You split a task into parts so that different AI models can do them. Reply with JSON only, no other text, in this shape:",
  '{"parts":[{"title":"...","kind":"read","effort":"low","needs":[],"size":"large","files":[],"task":"..."}]}',
  "Rules:",
  "- 2 to 8 parts, in the order they are done. Fewer is better: do not split what one model does well in one go.",
  "- title: at most 8 words, starting with a verb.",
  "- kind: read (find, pull out or summarize from files or text), write (draft text or code from a clear description), reason (work something out: a design, a cause, a plan, a comparison), code (change the project's files, run commands or tests: only the person's own coding app can), search (look things up on the web), act (anything else that needs the person's own tools or accounts).",
  "- effort: low, medium or high: how good the model must be for that part.",
  "- needs: the numbers (from 1) of the earlier parts whose results this part uses. Parts that need nothing can run at the same time.",
  "- size: how much it must read: none, small (a page), medium (a few files), large (a whole folder or a long document).",
  "- files: which of the given files it reads, named exactly as given; none if no files were given.",
  "- task: what to hand over for that part, written for a model that has not seen this conversation: the goal, what to look at, and the form of the answer.",
].join("\n");

const plainText = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

// The parts in a model's answer: the first JSON object in it, checked part by part. Null when it
// holds no usable parts.
export function readSplit(text: string, files: PlanFile[]): Omit<Part, "where" | "model" | "seconds" | "tokens" | "cost" | "why">[] | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let j: any = null;
  // The widest {...} that parses: models sometimes add a line after the JSON.
  for (let end = text.lastIndexOf("}"); end > start && j === null; end = text.lastIndexOf("}", end - 1)) {
    try { j = JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  const list = Array.isArray(j?.parts) ? j.parts : Array.isArray(j) ? j : null;
  if (!list || !list.length) return null;
  const names = new Map(files.map((f) => [f.name, f.name]));
  const out: Omit<Part, "where" | "model" | "seconds" | "tokens" | "cost" | "why">[] = [];
  for (const raw of list.slice(0, MAX_PARTS)) {
    if (!raw || typeof raw !== "object") continue;
    const title = plainText(raw.title, 80);
    const task = typeof raw.task === "string" ? raw.task.trim().slice(0, 4000) : "";
    if (!title && !task) continue;
    const n = out.length + 1;
    const kind: PartKind = PART_KINDS.includes(raw.kind) ? raw.kind : "reason";
    const effort: Effort = EFFORTS.includes(raw.effort) ? raw.effort : "medium";
    const size: Size = SIZES.includes(raw.size) ? raw.size : "small";
    const needs = Array.isArray(raw.needs) ? [...new Set(raw.needs.map(Number).filter((x: number) => Number.isInteger(x) && x >= 1 && x < n))] as number[] : [];
    const fl = Array.isArray(raw.files) ? [...new Set(raw.files.filter((f: unknown) => typeof f === "string" && names.has(f)))] as string[] : [];
    out.push({ n, title: title || task.slice(0, 60), kind, effort, needs: needs.sort((a, b) => a - b), task: task || title, files: fl, size });
  }
  return out.length ? out : null;
}

// With no model to split it, a split by rules, from what the task looks like.
const BUILDS = /\b(build|implement|add|fix|refactor|port|migrate|rewrite|reverse[- ]engineer|clone|debug|optimi[sz]e|integrate)\b/i;
const RESEARCH = /\b(research|compare|find out|look up|survey|review the (market|options)|what are the best|sources?|competitors?)\b/i;
export function rulesSplit(task: string, files: PlanFile[]): Omit<Part, "where" | "model" | "seconds" | "tokens" | "cost" | "why">[] {
  const coding = guessTask([{ role: "user", content: task }]).task === "coding";
  const all = files.map((f) => f.name);
  const big: Size = files.length ? "medium" : "large";
  const p = (n: number, title: string, kind: PartKind, effort: Effort, needs: number[], size: Size, what: string, fl: string[] = []) =>
    ({ n, title, kind, effort, needs, size, files: fl, task: `${what}\n\nThe whole task, for context: ${task}` });
  if (coding || BUILDS.test(task)) return [
    p(1, "Map the code: its parts and how they fit", "read", "low", [], big, "List the modules, the entry points and how they call each other, one line each.", all),
    p(2, "Read the parts that matter closely", "read", "medium", [1], "medium", "Explain what the parts this task touches do and how, with file:line for each claim.", all),
    p(3, "Decide the design and the steps", "reason", "high", [2], "small", "Decide how to do the task: the design, the steps in order, and what could go wrong."),
    p(4, "Make the changes and run the tests", "code", "high", [3], "medium", "Make the changes the design calls for, then run the tests."),
    p(5, "Review the changes", "reason", "medium", [4], "medium", "Review the changes for bugs and missed cases; list each with file:line."),
  ];
  if (RESEARCH.test(task)) return [
    p(1, "Gather the sources", "search", "medium", [], "none", "Find the most relevant, current sources and list them with links."),
    p(2, "Pull out the facts", "read", "low", [1], big, "Pull out the facts the task needs from the sources, each with where it came from.", all),
    p(3, "Outline the answer", "reason", "medium", [2], "small", "Outline the answer: the points in order, each with its facts."),
    p(4, "Write it", "write", "medium", [3], "small", "Write the answer from the outline, briefly."),
    p(5, "Check it against the sources", "reason", "high", [4], "medium", "Check every claim against the sources; list any that do not hold."),
  ];
  return [
    p(1, "Work out the approach", "reason", "medium", [], files.length ? "medium" : "small", "Work out how to do this: the steps, in order.", all),
    p(2, "Do it", "write", "medium", [1], "small", "Do the task, following the approach."),
    p(3, "Check the result", "reason", "high", [2], "small", "Check the result against the task; list anything wrong or missing."),
  ];
}

// ---- where each part runs ----------------------------------------------------------------------------

const DELEGATE_KIND: Partial<Record<PartKind, Kind>> = { read: "read", write: "write", reason: "reason" };
const LABEL_KIND: Record<PartKind, string> = { read: "read", write: "write", reason: "reason", code: "code", search: "search", act: "act" };
const NEAR = 85; // percent of a window used: from here on, more parts go out

export function whereOf(m: Model, cost: number | null): Where {
  if (m.local) return "local";
  return cost === 0 || chargeOf(m, 1).cost === 0 ? "free" : "paid";
}

function partTokens(part: { size: Size; files: string[]; task: string }, files: PlanFile[]): number {
  const fromFiles = part.files.reduce((n, name) => n + Math.ceil((files.find((f) => f.name === name)?.size ?? 0) / 4), 0);
  return (fromFiles > 0 ? fromFiles : SIZE_TOKENS[part.size]) + Math.ceil(part.task.length / 4);
}

// Where one part runs. Leanfare's estimate runs as a dry plan: the same pick Auto would make now,
// nothing sent and nothing reserved.
async function place(part: Omit<Part, "where" | "model" | "seconds" | "tokens" | "cost" | "why">, files: PlanFile[], near: string | null, manager: string, signal: AbortSignal): Promise<Part> {
  const tokens = partTokens(part, files);
  const stay = (why: string): Part => ({ ...part, where: "you", model: null, seconds: null, tokens: tokens + OUT_YOU, cost: null, why });
  if (part.kind === "code") return stay(`it changes the project, which only ${manager} can do`);
  if (part.kind === "act") return stay(`it needs ${manager}'s own tools`);
  const big = (part.effort === "high" && (part.kind === "reason" || part.kind === "write"));
  if (big && !near) return stay(`high effort judgement: your strongest model, in your plan`);
  const filler = "x".repeat(Math.max(0, tokens - Math.ceil(part.task.length / 4)) * 4); // the reading, by its size only
  const messages: Msg[] = [{ role: "user", content: `${part.task}\n\n${filler}` }];
  const only = part.kind === "search" ? (m: Model) => m.provider === "perplexity" : undefined; // a model that searches the web
  if (part.kind === "search" && !usableModels(only).length) return stay("it searches the web, and no model you ticked in Leanfare does");
  const kind = DELEGATE_KIND[part.kind] ?? null;
  try {
    const p = await route({ source: "chat", asked: `auto-${TIER[part.effort]}`, messages, maxOut: null, signal, dry: true, effort: part.effort,
      guess: part.kind === "search" ? { task: "overall", why: "a web search", alt: null } : taskFor(kind, messages), only, ledgerSource: "delegate" });
    const where = whereOf(p.model, p.estimate);
    const why = near && big ? `your plan is near its limit (${near}), so this goes out too` : where === "local" ? "reading and drafting go out: on this computer, $0"
      : where === "free" ? "reading and drafting go out: a free model" : `the cheapest model rated well enough at ${part.effort} effort`;
    return { ...part, where, model: { id: p.model.id, label: p.model.label }, seconds: p.seconds, tokens: tokens + 1_000, cost: p.estimate, why };
  } catch (e: any) {
    if (e?.status === 499) throw e;
    return stay(e instanceof UserError ? `Leanfare has no model for it now (${e.message.replace(/\.$/, "").slice(0, 120)})` : "Leanfare has no model for it now");
  }
}

// How long the parts Leanfare runs take, done at once where they can be: the longest chain of needs.
export function chainSeconds(parts: Part[]): number | null {
  const done = new Map<number, number>();
  let any = false;
  for (const p of parts) {
    const before = Math.max(0, ...p.needs.map((n) => done.get(n) ?? 0));
    if (p.seconds !== null) any = true;
    done.set(p.n, before + (p.seconds ?? 0));
  }
  return any ? Math.max(...done.values()) : null;
}

// ---- the table -----------------------------------------------------------------------------------

export const tokText = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const usd = (v: number | null) => (v === null ? "not known" : v === 0 ? "$0" : v < 0.01 ? "under $0.01" : `$${v.toFixed(2)}`);
const RUNS: Record<Where, string> = { you: "you", local: "Leanfare, on this computer", free: "Leanfare, free model", paid: "Leanfare, pay per use" };
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

export function tableOf(r: Omit<PlanResult, "table" | "next">): string {
  const rows = r.parts.map((p) => [
    String(p.n), p.title, `${LABEL_KIND[p.kind]}, ${p.effort}`, p.where === "you" ? r.manager === "you" ? "you" : `you (${r.manager})` : RUNS[p.where],
    p.model?.label ?? "your model", p.seconds === null ? "" : secondsText(p.seconds).replace(/^about /, "~"),
    p.where === "you" ? `~${tokText(p.tokens)} of your plan` : `~${tokText(p.tokens)} kept`, p.where === "you" ? "in your plan" : usd(p.cost),
    p.needs.length ? `after ${p.needs.join(", ")}` : "now",
  ].map(cell).join(" | "));
  const t = r.totals;
  return [
    "| # | Part | Kind | Runs on | Model | Time | Tokens | Cost | When |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((x) => `| ${x} |`),
    "",
    `${t.out} of ${t.parts} parts go to Leanfare, keeping about ${tokText(t.kept)} tokens out of your plan${t.used ? `; about ${tokText(t.used)} stay in it` : ""}. ${t.seconds !== null ? `Leanfare's parts take ${secondsText(t.seconds)} done at once where they can. ` : ""}Pay per use: ${usd(t.cost)}.`,
  ].join("\n");
}

function nextOf(r: Omit<PlanResult, "table" | "next">): string {
  const out = r.parts.filter((p) => p.where !== "you");
  const mine = r.parts.filter((p) => p.where === "you");
  const now = out.filter((p) => !p.needs.length).map((p) => p.n);
  const list = (ns: number[]) => (ns.length === 1 ? `part ${ns[0]}` : `parts ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);
  const s: string[] = [];
  if (now.length) s.push(`Run ${list(now)} now with delegate${now.length > 1 ? ", all in the same turn (they do not wait for each other)" : ""}: each part's task, kind and effort as in the table, with its files.`);
  const later = out.filter((p) => p.needs.length);
  if (later.length) s.push(`Then ${list(later.map((p) => p.n))}, each once the parts it needs are back, with their answers in its task.`);
  if (out.some((p) => p.kind === "search")) s.push("A search part goes to ask with the model in the table.");
  if (mine.length) s.push(`Do ${list(mine.map((p) => p.n))} yourself.`);
  return s.join(" ");
}

// ---- the plan ------------------------------------------------------------------------------------

export interface PlanInput { task: string; files: PlanFile[]; manager: string | null; split?: "auto" | "rules"; signal: AbortSignal }

// The request body of POST /api/plan, checked: the input, or one sentence saying what is wrong.
export function checkPlan(b: any): Omit<PlanInput, "signal"> | string {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "The request must be a JSON object.";
  if (typeof b.task !== "string" || !b.task.trim()) return "plan needs a task.";
  if (b.task.length > MAX_TASK) return `The task is ${b.task.length.toLocaleString("en-US")} characters; the most is ${MAX_TASK.toLocaleString("en-US")}. Name the files instead of pasting them.`;
  const list = b.files ?? [];
  if (!Array.isArray(list) || list.length > 200) return "files must be a list of at most 200 files, each with a name and its size in bytes.";
  const files: PlanFile[] = [];
  for (const f of list) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name.trim() || !Number.isFinite(f.size) || f.size < 0) return "Each file needs a name and its size in bytes.";
    files.push({ name: plainText(f.name, 500), size: Math.min(Math.round(f.size), 1e10) });
  }
  const manager = typeof b.manager === "string" && b.manager.trim() ? plainText(b.manager, 60) : null;
  const split = b.split === "rules" ? "rules" : "auto";
  return { task: b.task.trim(), files, manager, split };
}

export async function makePlan(input: PlanInput): Promise<PlanResult> {
  const manager = input.manager ?? "you";
  let parts: Omit<Part, "where" | "model" | "seconds" | "tokens" | "cost" | "why">[] | null = null;
  const split: PlanResult["split"] = { by: "rules", model: null, cost: null, note: null };
  if (input.split !== "rules") {
    const fileList = input.files.length ? `\n\nFiles (${input.files.length}):\n${input.files.slice(0, 200).map((f) => `- ${f.name} (${tokText(Math.ceil(f.size / 4))} tokens)`).join("\n")}` : "";
    const ask: Msg[] = [{ role: "user", content: `The task: ${input.task}${fileList}\n\nThe person works in ${manager === "you" ? "their own AI app" : manager}.` }];
    const r = await runChat(ask, "auto-balanced", input.signal, () => {}, "Plan", { system: SPLIT_SYSTEM, source: "plan", guess: { task: "hard_prompts", why: "splitting a task into parts", alt: "overall" }, maxOut: 3000, effort: "low" });
    if (r.status === "stopped") throw new UserError(499, "Stopped.", "stopped");
    split.cost = r.meta?.spent ?? r.meta?.cost ?? null;
    if (r.status === "ok") {
      split.model = r.meta?.model ? { id: r.meta.model.id, label: r.meta.model.label } : null;
      parts = readSplit(r.text, input.files);
      if (parts) split.by = "model";
      else split.note = `${split.model?.label ?? "The model"}'s answer did not read as parts, so Leanfare split it by rules.`;
    } else split.note = `No model could split it (${String(r.meta?.error ?? "it failed").replace(/\.$/, "")}), so Leanfare split it by rules.`;
  }
  parts ??= rulesSplit(input.task, input.files);

  const limits = windowsNow("claude", null);
  const known = limits.five !== null || limits.week !== null;
  const nearText = [limits.five !== null && limits.five >= NEAR ? `the 5 hours at ${Math.round(limits.five)}%` : "", limits.week !== null && limits.week >= NEAR ? `the week at ${Math.round(limits.week)}%` : ""].filter(Boolean).join(", ") || null;
  const placed: Part[] = [];
  for (const p of parts) placed.push(await place(p, input.files, nearText, manager, input.signal));
  const out = placed.filter((p) => p.where !== "you");
  const costs = out.map((p) => p.cost);
  const totals = {
    parts: placed.length, out: out.length,
    kept: out.reduce((n, p) => n + p.tokens, 0), used: placed.filter((p) => p.where === "you").reduce((n, p) => n + p.tokens, 0),
    seconds: chainSeconds(out.length ? placed : []),
    cost: costs.some((c) => c === null) ? null : costs.reduce<number>((a, b) => a + (b ?? 0), 0),
  };
  const base = { task: input.task, manager, parts: placed, totals, split, limits: known ? limits : null };
  return { ...base, table: tableOf(base), next: nextOf(base) };
}

