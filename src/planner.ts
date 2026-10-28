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
// What a run may spend is what the plan said: a part placed on a local or free model runs only on
// local or free models (its check too), and paid parts run only after the person's yes, or while
// what they spent stays within the cap set in Settings (then with no check, which the estimate does
// not hold). The monthly budget holds either way.
//
// No words are kept: the ledger has the split's model, tokens and cost, as for any answer.
import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import { CODEX_ID, CODEX_LABEL, codexFor, runCodex } from "./codex";
import { DEFAULT_MAX_OUT, TIER, gradeRow, notePart, runDelegate, taskFor, type Effort, type Kind } from "./delegate";
import { LOCAL_CONTEXT, allModels, fitsText, localNeed, type Model } from "./data";
import { chargeOf, plan as route, runChat, usableModels } from "./engine";
import { addGrade, movedDown, standing, standingText, type GradedKind, type Verdict } from "./grades";
import { gb, suggestLocal } from "./local";
import { passedLocal } from "./localpass";
import { planView, windowsNow } from "./plans";
import { DELEGATE_LIMITS, readForDelegate, sizesForPlan, PLAN_FILES } from "./readfiles";
import { guessTask, pickModel, type Msg } from "./router";
import { settings } from "./settings";
import { UserError } from "./upstream";
import { now, randomId, secondsText } from "./util";

export type PartKind = "read" | "write" | "reason" | "code" | "search" | "act";
export type Size = "none" | "small" | "medium" | "large";
export type Where = "you" | "local" | "free" | "paid" | "codex"; // codex: Leanfare runs it through Codex, on your ChatGPT plan (codex.ts)
export const PART_KINDS: PartKind[] = ["read", "write", "reason", "code", "search", "act"];
const SIZES: Size[] = ["none", "small", "medium", "large"];
const EFFORTS: Effort[] = ["low", "medium", "high"];
// About how many tokens a part reads when no file says it: a page, a few files, a folder.
export const SIZE_TOKENS: Record<Size, number> = { none: 500, small: 3_000, medium: 30_000, large: 150_000 };
const OUT_YOU = 2_000; // what a part the app does itself writes, about
const OUT_LEANFARE = 1_000; // what a part Leanfare runs answers, about
export const MAX_PARTS = 8;
export const MAX_TASK = 20_000; // characters
// An app waits about a minute for a tool's answer (Cowork's link to this computer: 60 seconds), so a model
// that has not split the task by then is let go, and the rules split it. LEANFARE_SPLIT_SECONDS for tests.
export const splitSeconds = () => { const n = Number(process.env.LEANFARE_SPLIT_SECONDS); return n > 0 ? n : 40; };
const LISTED = 200; // files named one by one to the split model; past it, the folders they are in
const CONTEXT = "The whole task, for context:";

export interface PlanFile { name: string; size: number; path?: string } // size: bytes; path: where it is, when Leanfare itself measured it
export interface Part {
  n: number;
  title: string;
  kind: PartKind;
  effort: Effort;
  needs: number[]; // the parts whose results it uses; the others can run at once
  task: string; // what to hand over, for a model that has not seen the conversation
  files: string[]; // the files it reads, as named
  size: Size;
  where: Where; // you: the app you work in; local, free, paid: Leanfare, on that kind of model; codex: Leanfare, through Codex
  model: { id: string; label: string } | null; // Leanfare's pick; null when it stays with you
  use: { id: string; label: string; alias: string | null } | null; // for a part that stays with you: the model to pick for it in your app (alias: Claude Code's name for it)
  seconds: number | null; // about how long Leanfare's model takes; null when it stays with you
  tokens: number; // about how many it reads and writes
  cost: number | null; // on pay per use; 0 on a local or free model; null when it stays with you, or not known
  why: string;
}
type Split = Omit<Part, "where" | "model" | "use" | "seconds" | "tokens" | "cost" | "why">;
export interface PlanResult {
  id: string; // kept here (the last 20), so it can run
  task: string;
  manager: string; // the app the person works in, as said ("Claude Code"), or "you"
  parts: Part[];
  totals: { parts: number; out: number; later: number; kept: number; used: number; seconds: number | null; after: number | null; cost: number | null }; // later: Leanfare's parts that wait for yours; seconds: the time of the others, after: of the ones after yours
  split: { by: "model" | "rules"; model: { id: string; label: string } | null; cost: number | null; note: string | null };
  limits: { five: number | null; week: number | null } | null; // the person's plan windows, when known (percent used)
  local?: { name: string; size: number; like: string; rating: number; fit: string } | null; // a local model to download that would run reading and drafting free
  codex?: string | null; // why Codex took no part, when it is turned on in Settings and could not
  table: string; // the table as markdown
  next: string; // what to do now
}

// ---- the files, as the split model sees them -------------------------------------------------------
// Up to 200 files are named one by one. Past that, the split model sees the folders they are in (one
// level below the folder they all share), and a part that reads a folder reads every file in it.
export interface Shown { name: string; size: number; members: string[] }
export function splitView(files: PlanFile[]): Shown[] {
  if (files.length <= LISTED) return files.map((f) => ({ name: f.name, size: f.size, members: [f.name] }));
  const segs = files.map((f) => f.name.split("/"));
  let common = 0; // folders every file is in
  while (segs.every((s) => s.length > common + 1 && s[common] === segs[0][common])) common++;
  const base = segs[0].slice(0, common).join("/");
  const groups = new Map<string, Shown>();
  segs.forEach((s, i) => {
    const key = s.length > common + 1 ? `${[...s.slice(0, common + 1)].join("/")}/` : `${base ? base + "/" : ""}(files at the top)`;
    const g = groups.get(key) ?? groups.set(key, { name: key, size: 0, members: [] }).get(key)!;
    g.size += files[i].size; g.members.push(files[i].name);
  });
  let list = [...groups.values()].sort((a, b) => b.size - a.size);
  if (list.length > LISTED) { // still too many: the largest, and the rest together
    const rest = list.slice(LISTED - 1);
    list = [...list.slice(0, LISTED - 1), { name: "(everything else)", size: rest.reduce((n, g) => n + g.size, 0), members: rest.flatMap((g) => g.members) }];
  }
  return list.map((g) => ({ ...g, name: g.members.length > 1 ? `${g.name} (${g.members.length.toLocaleString("en-US")} files)` : g.members[0] }));
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
  "- files: which of the given files or folders it reads, named exactly as given; none if none were given.",
  "- task: what to hand over for that part, written for a model that has not seen this conversation: the goal, what to look at, and the form of the answer.",
  "- To understand code or documents, read them: search is for facts on the web (news, prices, documentation), not for reading a codebase. When what must be read is not among the files given and not in the person's own project (another project's code, say), the first part gets it (kind act: clone or download it), and the reading parts come after it.",
  "- A task that changes code ends with a part that reviews the change (kind reason).",
].join("\n");

const plainText = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

// The parts in a model's answer: the first JSON object in it, checked part by part. Null when it
// holds no usable parts. The model numbers the parts as it wrote them; a part that is left out does
// not move the others' needs.
export function readSplit(text: string, given: (PlanFile | Shown | string)[]): Split[] | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let j: any = null;
  // The widest {...} that parses: models sometimes add a line after the JSON.
  for (let end = text.lastIndexOf("}"); end > start && j === null; end = text.lastIndexOf("}", end - 1)) {
    try { j = JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  const list = Array.isArray(j?.parts) ? j.parts : Array.isArray(j) ? j : null;
  if (!list || !list.length) return null;
  const names = new Set(given.map((f) => (typeof f === "string" ? f : f.name)));
  const out: Split[] = [];
  const renumbered = new Map<number, number>(); // the model's number -> the part's number here
  list.forEach((raw: any, i: number) => {
    if (out.length >= MAX_PARTS || !raw || typeof raw !== "object") return;
    const title = plainText(raw.title, 80);
    const task = typeof raw.task === "string" ? raw.task.trim().slice(0, 4000) : "";
    if (!title && !task) return;
    const n = out.length + 1;
    renumbered.set(i + 1, n);
    const kind: PartKind = PART_KINDS.includes(raw.kind) ? raw.kind : "reason";
    const effort: Effort = EFFORTS.includes(raw.effort) ? raw.effort : "medium";
    const size: Size = SIZES.includes(raw.size) ? raw.size : "small";
    const needs: number[] = Array.isArray(raw.needs) ? [...new Set<number>(raw.needs.map(Number).map((x: number) => renumbered.get(x)).filter((x: number | undefined): x is number => x !== undefined && x < n))] : [];
    const fl = Array.isArray(raw.files) ? [...new Set(raw.files.filter((f: unknown) => typeof f === "string" && names.has(f)))] as string[] : [];
    out.push({ n, title: title || task.slice(0, 60), kind, effort, needs: needs.sort((a, b) => a - b), task: task || title, files: fl, size });
  });
  return out.length ? out : null;
}

// With no model to split it, a split by rules, from what the task looks like.
const BUILDS = /\b(build|implement|add|fix|refactor|port|migrate|rewrite|reverse[- ]engineer|clone|debug|optimi[sz]e|integrate)\b/i;
const RESEARCH = /\b(research|compare|find out|look up|survey|review the (market|options)|what are the best|sources?|competitors?)\b/i;
export function rulesSplit(task: string, files: (PlanFile | Shown)[]): Split[] {
  const coding = guessTask([{ role: "user", content: task }]).task === "coding";
  const all = files.map((f) => f.name);
  const big: Size = files.length ? "medium" : "large";
  const p = (n: number, title: string, kind: PartKind, effort: Effort, needs: number[], size: Size, what: string, fl: string[] = []) =>
    ({ n, title, kind, effort, needs, size, files: fl, task: `${what}\n\n${CONTEXT} ${task}` });
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

// A part that names a folder (past 200 files) reads every file in it.
function expand(parts: Split[], shown: Shown[]): Split[] {
  const by = new Map(shown.map((s) => [s.name, s.members]));
  return parts.map((p) => ({ ...p, files: [...new Set(p.files.flatMap((n) => by.get(n) ?? [n]))] }));
}

// The files a part names, the ones whose path holds the task's words first (for a router task,
// router.py before the rest), each group in the plan's order: when one hand off cannot take them
// all, it takes the ones that matter most.
const PLAIN = new Set(["this", "that", "these", "those", "with", "from", "into", "what", "which", "when", "where", "there", "their", "them", "then", "than",
  "make", "build", "smaller", "bigger", "find", "file", "files", "code", "each", "every", "list", "line", "lines", "part", "parts", "task", "about", "have",
  "does", "work", "using", "used", "more", "most", "less", "only", "also", "just", "like", "your", "please", "should", "could", "would", "write", "read"]);
export function byRelevance(names: string[], text: string): string[] {
  const words = [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !PLAIN.has(w)))];
  if (!words.length || names.length < 2) return names;
  const paths = names.map((n) => n.replace(/\\/g, "/"));
  // The folder they all share says nothing about which one matters.
  let common = paths[0].slice(0, paths[0].lastIndexOf("/") + 1);
  for (const n of paths) while (common && !n.startsWith(common)) common = common.slice(0, common.slice(0, -1).lastIndexOf("/") + 1);
  const score = (n: string) => { const rest = n.slice(common.length).toLowerCase(); return words.reduce((a, w) => a + (rest.includes(w) ? 1 : 0), 0); };
  return names.map((n, i) => ({ n, i, s: score(paths[i]) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.n);
}

// ---- where each part runs ----------------------------------------------------------------------------

export const DELEGATE_KIND: Partial<Record<PartKind, Kind>> = { read: "read", write: "write", reason: "reason" };
const LABEL_KIND: Record<PartKind, string> = { read: "read", write: "write", reason: "reason", code: "code", search: "search", act: "act" };
const NEAR = 85; // percent of a window used: from here on, more parts go out
export const isFree = (m: Model) => !!m.local || chargeOf(m, 1).cost === 0;

export function whereOf(m: Model, cost: number | null): Where {
  if (m.local) return "local";
  return cost === 0 || chargeOf(m, 1).cost === 0 ? "free" : "paid";
}

// The files one hand off takes, in the plan's order: at most 50, 2 MB each, 4 MB in all.
export function handOff<T extends { size: number }>(list: T[]): T[] {
  const out: T[] = [];
  let total = 0;
  for (const f of list) {
    if (out.length >= DELEGATE_LIMITS.count || f.size > DELEGATE_LIMITS.file || total + f.size > DELEGATE_LIMITS.total) continue;
    out.push(f); total += f.size;
  }
  return out;
}

// What a part reads: its files that one hand off takes, or its size when it names none.
function reading(part: { size: Size; files: string[]; task: string }, files: PlanFile[]): { tokens: number; named: number; taken: number } {
  const byName = new Map(files.map((f) => [f.name, f]));
  const named = part.files.map((n) => byName.get(n)).filter((f): f is PlanFile => !!f);
  const taken = handOff(named);
  const fromFiles = taken.reduce((n, f) => n + Math.ceil(f.size / 4), 0);
  return { tokens: (named.length ? fromFiles : SIZE_TOKENS[part.size]) + Math.ceil(part.task.length / 4), named: named.length, taken: taken.length };
}

// Where one part runs. Leanfare's estimate runs as a dry plan: the same pick Auto would make now,
// among the models whose context holds the part, nothing sent and nothing reserved.
// ---- the model for a part that stays with you ------------------------------------------------------
// The app you work in offers its maker's models (Claude Code: Anthropic's; Codex: OpenAI's), all on your
// plan, where a dearer model uses more of it. So the plan names one, by the rule Auto follows: the
// cheapest of them rated well enough for the part's kind at its effort (high: within 15 points of the
// best, medium: 40, low: 80). For Claude Code that is Opus for the hardest judgement, Sonnet for most
// code, Haiku for light work, as the ratings and prices stand.
const MAKERS: [RegExp, string[]][] = [[/claude/i, ["anthropic"]], [/codex|chatgpt|openai/i, ["openai"]], [/gemini/i, ["google"]], [/grok/i, ["xai"]],
  [/cursor|windsurf|vs ?code|copilot/i, ["anthropic", "openai", "google"]]];
export const makersOf = (manager: string): string[] => MAKERS.find(([re]) => re.test(manager))?.[1] ?? [];
const CLAUDE_ALIAS = /^Claude (Opus|Sonnet|Haiku|Fable)\b/; // Claude Code's names for its models: opus, sonnet, haiku, fable
export function modelInYourApp(part: { kind: PartKind; effort: Effort; task: string }, manager: string): Part["use"] {
  const makers = makersOf(manager);
  if (!makers.length) return null;
  const pool = allModels().filter((m) => makers.includes(m.provider) && !m.local && !m.free);
  const messages: Msg[] = [{ role: "user", content: part.task.slice(0, 4000) }];
  const guess = part.kind === "code" ? { task: "coding", why: "it changes code", alt: "overall" }
    : part.kind === "search" || part.kind === "act" ? { task: "overall", why: `a ${part.kind} part`, alt: null } : taskFor(DELEGATE_KIND[part.kind] ?? null, messages);
  const p = pickModel(messages, pool, TIER[part.effort], () => null, undefined, guess);
  if (!p) return null;
  const alias = CLAUDE_ALIAS.exec(p.model.label)?.[1]?.toLowerCase() ?? null;
  return { id: p.model.id, label: p.model.label, alias };
}

// A part on Codex: its time is a rough guess (Codex is a whole agent: half a minute to start, then it reads).
const onCodex = (part: Split, r: { tokens: number }, why: string): Part => ({ ...part, where: "codex", model: { id: CODEX_ID, label: CODEX_LABEL }, use: null, seconds: Math.round(30 + r.tokens / 400), tokens: r.tokens + OUT_LEANFARE, cost: 0, why });

async function place(part: Split, files: PlanFile[], near: string | null, manager: string, signal: AbortSignal, codex = false): Promise<Part> {
  const r = reading(part, files);
  const stay = (why: string): Part => ({ ...part, where: "you", model: null, use: modelInYourApp(part, manager), seconds: null, tokens: r.tokens + OUT_YOU, cost: null, why });
  // Reading, drafting and working out can run on your ChatGPT plan through Codex, before anything paid.
  // Codex moved down by the manager's grades for this kind takes only a part no model can take.
  const codexCan = codex && !!DELEGATE_KIND[part.kind];
  const viaCodex = codexCan && !movedDown(CODEX_ID, part.kind);
  if (part.kind === "code") return stay(`it changes the project, which only ${manager} can do`);
  if (part.kind === "act") return stay(`it needs ${manager}'s own tools`);
  const big = (part.effort === "high" && (part.kind === "reason" || part.kind === "write"));
  if (big && !near) return stay(`high effort judgement: your strongest model, in your plan`);
  const need = Math.ceil((r.tokens * 4) / 3) + DEFAULT_MAX_OUT; // as delegate counts it: three characters a token, and the answer
  const fits = (m: Model) => fitsText(m, r.tokens * 4, DEFAULT_MAX_OUT);
  const kindOk = part.kind === "search" ? (m: Model) => m.provider === "perplexity" && fits(m) : fits; // a search goes to a model that searches the web
  // A model the manager's grades moved down for this kind is skipped, while another can take the part.
  const graded = (m: Model) => kindOk(m) && !movedDown(m.id, part.kind);
  const only = usableModels(graded).length ? graded : kindOk;
  if (part.kind === "search" && !usableModels((m) => m.provider === "perplexity").length) return stay(`it searches the web, which ${manager === "you" ? "your app" : manager} can do; no model you ticked in Leanfare does (tick Perplexity Sonar to send searches out)`);
  const messages: Msg[] = [{ role: "user", content: part.task }];
  const kind = DELEGATE_KIND[part.kind] ?? null;
  const some = r.taken < r.named ? `; Leanfare hands over ${r.taken} of its ${r.named} files (one hand off takes at most ${DELEGATE_LIMITS.count} files, ${DELEGATE_LIMITS.total / 1048576} MB)`
    : part.kind === "read" && !r.named ? "; no files named, so it works from what the model knows: name the files or folder it reads" : "";
  // Reading at low or medium effort goes first to a model on this computer that passed its test here (localpass.ts):
  // it is free. One that cannot take the part leaves it to Auto.
  const local = part.kind === "read" && part.effort !== "high" && settings().speed === "cheapest" ? passedLocal(only) : null;
  if (local) {
    try {
      const p = await route({ source: "chat", asked: local.id, messages, tokens: r.tokens, maxOut: null, signal, dry: true, effort: part.effort, guess: taskFor(kind, messages), ledgerSource: "delegate" });
      return { ...part, where: "local", model: { id: local.id, label: local.label }, use: null, seconds: p.seconds, tokens: r.tokens + OUT_LEANFARE, cost: 0, why: `reading goes first to ${local.label}, which passed this computer's reading test: on this computer, $0${some}` };
    } catch (e: any) { if (e?.status === 499) throw e; }
  }
  try {
    const p = await route({ source: "chat", asked: `auto-${TIER[part.effort]}`, messages, tokens: r.tokens, maxOut: null, signal, dry: true, effort: part.effort,
      guess: part.kind === "search" ? { task: "overall", why: "a web search", alt: null } : taskFor(kind, messages), only, onlyWhy: `none of the models you ticked can take this much text (about ${tokText(need)} tokens with the answer)`, ledgerSource: "delegate" });
    const where = whereOf(p.model, p.estimate);
    if (where === "paid" && viaCodex) return onCodex(part, r, `your ChatGPT plan through Codex, not pay per use${near && big ? ` (your plan is near its limit: ${near})` : ""}; Codex reads ${r.named ? "the files itself" : "what the task says"}, read only`);
    const why = (near && big ? `your plan is near its limit (${near}), so this goes out too` : where === "local" ? "reading and drafting go out: on this computer, $0"
      : where === "free" ? "reading and drafting go out: a free model" : `the cheapest model rated well enough at ${part.effort} effort`) + some;
    return { ...part, where, model: { id: p.model.id, label: p.model.label }, use: null, seconds: p.seconds, tokens: r.tokens + OUT_LEANFARE, cost: p.estimate, why };
  } catch (e: any) {
    if (e?.status === 499) throw e;
    if (codexCan) return onCodex(part, r, "your ChatGPT plan through Codex: no model you ticked in Leanfare could take it");
    return stay(e instanceof UserError ? `Leanfare has no model for it now (${e.message.replace(/\.$/, "").slice(0, 160)})` : "Leanfare has no model for it now");
  }
}

// The parts Leanfare runs that wait for one of the person's parts, directly or through other parts.
export function afterYours(parts: Pick<Part, "n" | "needs" | "where">[]): Set<number> {
  const where = new Map(parts.map((p) => [p.n, p.where]));
  const out = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    for (const p of parts) if (p.where !== "you" && !out.has(p.n) && p.needs.some((n) => where.get(n) === "you" || out.has(n))) { out.add(p.n); grew = true; }
  }
  return out;
}

// How long the parts Leanfare runs take, done at once where they can be: the longest chain of needs.
// now: the parts that can start now; after: the parts that wait for yours, counted from when yours
// are done. The parts left to the person are not timed: their time is theirs.
export function chains(parts: Part[]): { now: number | null; after: number | null } {
  const later = afterYours(parts);
  const done = new Map<number, number>();
  let now: number | null = null, after: number | null = null;
  for (const p of parts) {
    if (p.where === "you") continue;
    const w = later.has(p.n);
    // A part after yours starts when yours are done: the parts that do not wait for yours count as done by then.
    const start = Math.max(0, ...p.needs.filter((n) => later.has(n) === w).map((n) => done.get(n) ?? 0));
    done.set(p.n, start + (p.seconds ?? 0));
    if (p.seconds === null) continue;
    if (w) after = Math.max(after ?? 0, done.get(p.n)!); else now = Math.max(now ?? 0, done.get(p.n)!);
  }
  return { now, after };
}
export const chainSeconds = (parts: Part[]) => chains(parts).now;

// ---- the table -----------------------------------------------------------------------------------

export const tokText = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
// The share of the task's tokens that Leanfare's parts keep out of the plan, as " (97% of this task)": never
// 100% while some stay in, never 0% when some go out.
export const keptShare = (t: { kept: number; used: number }) =>
  t.kept > 0 ? ` (${t.used ? `${Math.max(1, Math.min(99, Math.round((t.kept / (t.kept + t.used)) * 100)))}%` : "all"} of this task)` : "";
const usd = (v: number | null) => (v === null ? "not known" : v === 0 ? "$0" : v < 0.01 ? "under $0.01" : `$${v.toFixed(2)}`);
const RUNS: Record<Where, string> = { you: "you", local: "Leanfare, on this computer", free: "Leanfare, free model", paid: "Leanfare, pay per use", codex: "Leanfare, through Codex" };
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

// How long Leanfare's parts take: the ones that start now, and the ones after yours (from when yours are done).
export function timeLine(t: { seconds: number | null; after: number | null }): string {
  const now = t.seconds !== null ? `Leanfare's parts take ${secondsText(t.seconds)}, done at once where they can` : "";
  const after = t.after !== null ? `${now ? "; the ones after yours" : "Leanfare's parts wait for yours, then"} take ${secondsText(t.after)}${now ? " once yours are done" : ""}` : "";
  return now || after ? `${now}${after}. ` : "";
}

export function tableOf(r: Omit<PlanResult, "table" | "next" | "id">): string {
  const rows = r.parts.map((p) => [
    String(p.n), p.title, `${LABEL_KIND[p.kind]}, ${p.effort}`, p.where === "you" ? r.manager === "you" ? "you" : `you (${r.manager})` : RUNS[p.where],
    p.model?.label ?? p.use?.label ?? "your model", p.seconds === null ? "" : secondsText(p.seconds).replace(/^about /, "~"),
    p.where === "you" ? `~${tokText(p.tokens)} of your plan` : `~${tokText(p.tokens)} kept`, p.where === "you" ? "in your plan" : p.where === "codex" ? "in your ChatGPT plan" : usd(p.cost),
    p.needs.length ? `after ${p.needs.join(", ")}` : "now",
  ].map(cell).join(" | "));
  const t = r.totals;
  return [
    "| # | Part | Kind | Runs on | Model | Time | Tokens | Cost | When |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((x) => `| ${x} |`),
    "",
    `${t.out} of ${t.parts} parts go to Leanfare, keeping about ${tokText(t.kept)} tokens out of your plan${keptShare(t)}${t.used ? `; about ${tokText(t.used)} stay in it` : ""}. ${timeLine(t)}Pay per use: ${usd(t.cost)}.${t.out ? "" : ` ${nothingOut(r.parts)}`}${r.codex ? ` Codex took no part: ${r.codex}.` : ""}${r.local ? ` ${localLine(r.local)}` : ""}`,
  ].join("\n");
}

// A local model that would take the reading and drafting free: to download, on a yes.
export const localLine = (l: NonNullable<PlanResult["local"]>) => `A local model fits this computer: ${l.name} (${gb(l.size)}), rated like ${l.like}, free to run. Download it in Settings, Local models (in your app: local_model).`;

// When every part stays with the person: what would send some out.
export function nothingOut(parts: Pick<Part, "kind" | "where" | "files">[]): string {
  const hints = [
    parts.some((p) => p.kind === "search" && p.where === "you") ? "tick Perplexity Sonar in Leanfare and the searches go out" : "",
    parts.every((p) => !p.files.length) ? "name the files or folder it is about and the reading goes out" : "",
  ].filter(Boolean);
  return `Nothing goes to Leanfare: ${hints.length ? hints.join("; ") : "every part changes the project or needs the hardest judgement"}.`;
}

function nextOf(r: Omit<PlanResult, "table" | "next" | "id">): string {
  const viaCodex = r.parts.filter((p) => p.where === "codex");
  const out = r.parts.filter((p) => p.where !== "you" && p.where !== "codex"); // what delegate can run
  const mine = r.parts.filter((p) => p.where === "you");
  const now = out.filter((p) => !p.needs.length).map((p) => p.n);
  const list = (ns: number[]) => (ns.length === 1 ? `part ${ns[0]}` : `parts ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);
  const s: string[] = [];
  if (viaCodex.length) s.push(`${list(viaCodex.map((p) => p.n)).replace(/^p/, "P")} run${viaCodex.length === 1 ? "s" : ""} on Codex with your ChatGPT plan: start ${viaCodex.length === 1 ? "it" : "them"} with plan_run (delegate cannot run ${viaCodex.length === 1 ? "it" : "them"}).`);
  if (now.length) s.push(`Run ${list(now)} now with delegate${now.length > 1 ? ", all in the same turn (they do not wait for each other)" : ""}: each part's task, kind and effort as in the table, with its files (at most ${DELEGATE_LIMITS.count} to one delegate call).`);
  const yoursFirst = afterYours(r.parts);
  const later = out.filter((p) => p.needs.length && !yoursFirst.has(p.n));
  if (later.length) s.push(`Then ${list(later.map((p) => p.n))}, each once the parts it needs are back, with their answers in its task.`);
  if (out.some((p) => p.kind === "search")) s.push("A search part goes to ask with the model in the table.");
  if (mine.length) {
    const on = mine.map((p) => `part ${p.n} on ${p.use?.label ?? "your strongest model"}`);
    // Claude Code runs a part on another model with a subagent (its Agent tool takes model: opus, sonnet, haiku or fable).
    const how = mine.some((p) => p.use?.alias) && /claude/i.test(r.manager) ? " For a part on another model than the one you run on, use a subagent with that model (model: opus, sonnet or haiku)." : "";
    s.push(`Do these yourself: ${on.join(", ")}.${how}`);
  }
  if (yoursFirst.size) s.push(`${list([...yoursFirst]).replace(/^p/, "P")} wait${yoursFirst.size === 1 ? "s" : ""} for yours: once yours are done, run ${yoursFirst.size === 1 ? "it" : "them"} with delegate, with the answers ${yoursFirst.size === 1 ? "it needs" : "they need"} in the task (plan_run does not run ${yoursFirst.size === 1 ? "it" : "them"}).`);
  return s.join(" ");
}

// ---- the plan ------------------------------------------------------------------------------------

export interface PlanInput { task: string; files: PlanFile[]; manager: string | null; split?: "auto" | "rules"; signal: AbortSignal }
const FULL_PATH = /^(~|\/|[A-Za-z]:[\\/]|\\\\)/; // ~/..., /..., C:\..., \\server

// The request body of POST /api/plan, checked: the input, or one sentence saying what is wrong.
// trusted: the MCP door (it holds the control token), which measured the files itself and may say
// where each is; the page can only name paths, which Leanfare measures here.
export function checkPlan(b: any, trusted = false): Omit<PlanInput, "signal"> | string {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "The request must be a JSON object.";
  if (typeof b.task !== "string" || !b.task.trim()) return "plan needs a task.";
  if (b.task.length > MAX_TASK) return `The task is ${b.task.length.toLocaleString("en-US")} characters; the most is ${MAX_TASK.toLocaleString("en-US")}. Name the files instead of pasting them.`;
  const most = trusted ? PLAN_FILES.walk : LISTED;
  const list = b.files ?? [];
  if (!Array.isArray(list) || list.length > most) return `files must be a list of at most ${most.toLocaleString("en-US")} files, each with a name and its size in bytes.`;
  const files: PlanFile[] = [];
  for (const f of list) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name.trim() || !Number.isFinite(f.size) || f.size < 0) return "Each file needs a name and its size in bytes.";
    const one: PlanFile = { name: plainText(f.name, 500), size: Math.min(Math.round(f.size), 1e12) };
    if (trusted && typeof f.path === "string" && FULL_PATH.test(f.path)) one.path = f.path;
    files.push(one);
  }
  // The Plan tab names files and folders by their paths: Leanfare measures them itself (never opens them here).
  if (b.paths !== undefined && b.paths !== null) {
    if (!Array.isArray(b.paths) || b.paths.some((x: unknown) => typeof x !== "string")) return "paths must be a list of file or folder paths.";
    const bad = (b.paths as string[]).find((x) => x.trim() && !FULL_PATH.test(x.trim()));
    if (bad) return `${bad.trim()} is not a full path. Give full paths, like ~/code/project.`;
    const got = sizesForPlan((b.paths as string[]).map((x) => x.trim()).filter(Boolean), homedir());
    if (typeof got === "string") return got;
    files.push(...got);
  }
  const manager = typeof b.manager === "string" && b.manager.trim() ? plainText(b.manager, 60) : null;
  const split = b.split === "rules" ? "rules" : "auto";
  return { task: b.task.trim(), files, manager, split };
}

// The plan whose limits count: Codex spends a ChatGPT plan, the others a Claude plan when they are Claude's.
async function limitsFor(manager: string): Promise<{ five: number | null; week: number | null }> {
  if (/codex|chatgpt/i.test(manager)) { try { return windowsNow("chatgpt", await planView("chatgpt")); } catch { return { five: null, week: null }; } }
  if (/claude|^you$/i.test(manager)) return windowsNow("claude", null);
  return { five: null, week: null };
}

export async function makePlan(input: PlanInput): Promise<PlanResult> {
  const manager = input.manager ?? "you";
  const shown = splitView(input.files);
  let parts: Split[] | null = null;
  const split: PlanResult["split"] = { by: "rules", model: null, cost: null, note: null };
  if (input.split !== "rules") {
    const fileList = shown.length ? `\n\nFiles (${input.files.length.toLocaleString("en-US")}${shown.length < input.files.length ? `, shown by folder` : ""}):\n${shown.map((f) => `- ${f.name} (${tokText(Math.ceil(f.size / 4))} tokens)`).join("\n")}` : "";
    const ask: Msg[] = [{ role: "user", content: `The task: ${input.task}${fileList}\n\nThe person works in ${manager === "you" ? "their own AI app" : manager}.` }];
    const wait = splitSeconds();
    const box = new AbortController(); // the caller's Stop, or the time running out
    const stop = () => box.abort();
    input.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, wait * 1000);
    let r: Awaited<ReturnType<typeof runChat>>;
    try { r = await runChat(ask, "auto-balanced", box.signal, () => {}, "Plan", { system: SPLIT_SYSTEM, source: "plan", guess: { task: "hard_prompts", why: "splitting a task into parts", alt: "overall" }, maxOut: 3000, effort: "low" }); }
    finally { clearTimeout(timer); input.signal?.removeEventListener("abort", stop); }
    if (r.status === "stopped" && input.signal?.aborted) throw new UserError(499, "Stopped.", "stopped");
    split.cost = r.meta?.spent ?? r.meta?.cost ?? null;
    if (r.status === "stopped") split.note = `The model took more than ${wait} second${wait === 1 ? "" : "s"} to split it, so Leanfare split it by rules.`;
    else if (r.status === "ok") {
      split.model = r.meta?.model ? { id: r.meta.model.id, label: r.meta.model.label } : null;
      parts = readSplit(r.text, shown);
      if (parts) split.by = "model";
      else split.note = `${split.model?.label ?? "The model"}'s answer did not read as parts, so Leanfare split it by rules.`;
    } else split.note = `No model could split it (${String(r.meta?.error ?? "it failed").replace(/\.$/, "")}), so Leanfare split it by rules.`;
  }
  parts = expand(parts ?? rulesSplit(input.task, shown), shown).map((p) => ({ ...p, files: byRelevance(p.files, `${input.task} ${p.task}`) }));

  const limits = await limitsFor(manager);
  const codex = await codexFor(manager);
  const known = limits.five !== null || limits.week !== null;
  const nearText = [limits.five !== null && limits.five >= NEAR ? `the 5 hours at ${Math.round(limits.five)}%` : "", limits.week !== null && limits.week >= NEAR ? `the week at ${Math.round(limits.week)}%` : ""].filter(Boolean).join(", ") || null;
  const placed: Part[] = [];
  for (const p of parts) placed.push(await place(p, input.files, nearText, manager, input.signal, codex.ok));
  // A part that waits for one of yours is handed over by your app once yours are done, with delegate,
  // which cannot run it on Codex: such a part is placed as if Codex were off.
  const later = afterYours(placed);
  for (let i = 0; i < placed.length; i++) if (placed[i].where === "codex" && later.has(placed[i].n)) placed[i] = await place(parts[i], input.files, nearText, manager, input.signal, false);
  const out = placed.filter((p) => p.where !== "you");
  const costs = out.map((p) => p.cost);
  const time = chains(placed);
  const totals = {
    parts: placed.length, out: out.length, later: afterYours(placed).size,
    kept: out.reduce((n, p) => n + p.tokens, 0), used: placed.filter((p) => p.where === "you").reduce((n, p) => n + p.tokens, 0),
    seconds: time.now, after: time.after,
    cost: costs.some((c) => c === null) ? null : costs.reduce<number>((a, b) => a + (b ?? 0), 0),
  };
  // A part that goes to pay per use, or stays with you only because Leanfare had no model for it, could
  // run free on this computer, if a local model can take it (its context: at most 16k tokens, with room
  // for the delegate's answer): the plan names a local model to download, when one fits.
  const read = (p: Part) => p.tokens - (p.where === "you" ? OUT_YOU : OUT_LEANFARE);
  const localTakes = (p: Part) => localNeed(read(p) * 4, DEFAULT_MAX_OUT) <= LOCAL_CONTEXT;
  const wantsLocal = placed.some((p) => DELEGATE_KIND[p.kind] && localTakes(p) && (p.where === "paid" || (p.where === "you" && p.why.startsWith("Leanfare has no model"))));
  const sg = wantsLocal ? suggestLocal().suggestion : null;
  const local = sg ? { name: sg.name, size: sg.size, like: sg.like, rating: sg.rating, fit: sg.fit } : null;
  const base = { task: input.task, manager, parts: placed, totals, split, limits: known ? limits : null, local, codex: codex.why };
  const result: PlanResult = { id: randomId(), ...base, table: tableOf(base), next: nextOf(base) };
  keep(result, new Map(input.files.filter((f) => f.path).map((f) => [f.name, { path: f.path!, size: f.size }])));
  return result;
}

// ---- running a plan ---------------------------------------------------------------------------------
// The parts Leanfare runs, run at once where they can, each as soon as the parts it needs are back,
// with their answers handed on in its task. The parts that stay with the person are theirs, and so is a
// part that needs one of those (after_yours: they hand it over once theirs is done); a part that needs
// one that failed waits (blocked) for the next run. Each part goes through the
// delegate; a search part goes to the model the plan named.

// after_yours: it waits for one of the person's parts (directly or through others), so it is theirs to hand over once theirs is done.
export type RunStatus = "waiting" | "running" | "done" | "failed" | "stopped" | "yours" | "after_yours" | "blocked" | "asks";
export interface RunPart { n: number; title: string; status: RunStatus; answer: string | null; receipt: string | null; model: string | null; modelId?: string | null; cost: number | null; seconds: number | null; error: string | null; verdict?: Verdict | null; gradedBy?: "you" | "manager" | null }
export interface RunView { id: string; started: string; running: boolean; parts: RunPart[]; cost: number | null; asks: { parts: number[]; estimate: number | null; cap: number } | null }

// What a plan's paid parts would cost.
export function paidOf(plan: PlanResult): { parts: number[]; estimate: number | null } {
  const paid = plan.parts.filter((p) => p.where === "paid");
  const costs = paid.map((p) => p.cost);
  return { parts: paid.map((p) => p.n), estimate: costs.some((c) => c === null) ? null : costs.reduce<number>((a, b) => a + (b ?? 0), 0) };
}

const KEEP = 20;
const kept = new Map<string, PlanResult>();
const wherePaths = new Map<string, Map<string, { path: string; size: number }>>(); // a plan's files, by name, when Leanfare knows where they are
// grades: part n -> its grade's row, so grading a part again replaces its grade
const runs = new Map<string, { view: RunView; ac: AbortController; tick: () => void; yes: { on: boolean }; grades: Map<number, number> }>();
export const keptPlan = (id: string) => kept.get(id) ?? null;
export const forgetPlans = () => { for (const r of runs.values()) r.ac.abort(); kept.clear(); runs.clear(); wherePaths.clear(); };
const HANDED = 20_000; // characters of an earlier part's answer handed on
const running = (id: string) => !!runs.get(id)?.view.running;

// The last 20 plans are kept, and any plan whose parts are running (it is never dropped mid run).
function keep(plan: PlanResult, paths: Map<string, { path: string; size: number }>) {
  kept.set(plan.id, plan);
  wherePaths.set(plan.id, paths);
  for (const id of [...kept.keys()]) {
    if (kept.size <= KEEP) break;
    if (id === plan.id || running(id)) continue;
    kept.delete(id); wherePaths.delete(id); runs.delete(id);
  }
}

export function runView(id: string): RunView | null { return runs.get(id)?.view ?? null; }

// The deepest folder that holds every one of these files; null for none, or when only the top folder does.
export function commonFolder(paths: string[]): string | null {
  if (!paths.length) return null;
  let common = dirname(paths[0]);
  for (const x of paths.slice(1)) while (common && x !== common && !x.startsWith(common.endsWith(sep) ? common : common + sep)) { const up = dirname(common); if (up === common) return null; common = up; }
  return dirname(common) === common ? null : common;
}

export function startRun(id: string, opts: { paid?: boolean } = {}): RunView {
  const plan = kept.get(id);
  if (!plan) throw new UserError(404, "This plan is no longer in Leanfare (it was restarted, or 20 newer plans were made). Make the plan again.", "plan_gone");
  const had = runs.get(id);
  if (had?.view.running && !had.ac.signal.aborted) {
    // A yes for the paid parts while the free ones run: they join this run.
    if (opts.paid && !had.yes.on) { had.yes.on = true; for (const r of had.view.parts) if (r.status === "asks") r.status = "waiting"; had.view.asks = null; had.tick(); }
    return had.view;
  }
  // Parts already done in an earlier run of this plan keep their answers; the rest run (again).
  const before = new Map((had?.view.parts ?? []).filter((r) => r.status === "done").map((r) => [r.n, r]));
  const yes = { on: !!opts.paid };
  const cap = settings().planAuto;
  const view: RunView = { id, started: now().toISOString(), running: true, cost: 0, asks: null,
    parts: plan.parts.map((p) => before.get(p.n) ?? ({ n: p.n, title: p.title, status: p.where === "you" ? "yours" : "waiting", answer: null, receipt: null, model: null, cost: null, seconds: null, error: null })) };
  const ac = new AbortController();
  const at = (n: number) => view.parts.find((x) => x.n === n)!;
  const partOf = (n: number) => plan.parts.find((x) => x.n === n)!;
  const going = new Set<number>();
  // What this run spent on paid parts: as charged, or at the estimate while one runs or when a stopped
  // or failed one's charge is not known.
  const spent = () => view.parts.reduce((sum, r) => {
    const p = partOf(r.n);
    if (p.where !== "paid" || before.has(r.n)) return sum;
    if (r.status === "running") return sum + (p.cost ?? 0);
    if (r.status === "done" || r.status === "failed" || r.status === "stopped") return sum + (r.cost ?? p.cost ?? 0);
    return sum;
  }, 0);
  const asking = () => {
    const ps = view.parts.filter((r) => r.status === "asks").map((r) => r.n);
    const ests = ps.map((n) => partOf(n).cost);
    view.asks = ps.length ? { parts: ps, estimate: ests.some((c) => c === null) ? null : ests.reduce<number>((a, b) => a + (b ?? 0), 0), cap } : null;
  };
  const finish = () => {
    // Still waiting at the end: stopped, or a paid part that waits for the yes too (on a part that asks), or blocked.
    for (const r of view.parts) if (r.status === "waiting") r.status = ac.signal.aborted ? "stopped" : partOf(r.n).where === "paid" && !yes.on ? "asks" : "blocked";
    const ran = view.parts.filter((r) => !before.has(r.n) && ["done", "failed", "stopped"].includes(r.status));
    // What each part's calls were charged, a stopped or failed one's too; not known if one's charge is not (Savings has every charge).
    view.cost = ran.some((r) => r.cost === null) ? null : ran.reduce((a, r) => a + (r.cost ?? 0), 0);
    asking();
    view.running = false;
  };
  const tick = () => {
    if (ac.signal.aborted) { if (!going.size) finish(); return; }
    for (const p of plan.parts) {
      const r = at(p.n);
      if (r.status !== "waiting") continue;
      if (p.needs.some((n) => ["yours", "after_yours"].includes(at(n).status))) { r.status = "after_yours"; continue; }
      if (p.needs.some((n) => ["failed", "stopped", "blocked"].includes(at(n).status))) { r.status = "blocked"; continue; }
      if (!p.needs.every((n) => at(n).status === "done")) continue;
      // A paid part: only with a yes, or while what was spent and its estimate stay within the cap.
      if (p.where === "paid" && !yes.on && (p.cost === null || spent() + p.cost > cap)) { r.status = "asks"; continue; }
      r.status = "running";
      going.add(p.n);
      runPart(p, plan, at, ac.signal, yes.on).then((got) => Object.assign(r, got)).catch((e: any) => {
        // spent: what its calls were charged before it stopped or failed, when known.
        Object.assign(r, { status: ac.signal.aborted || e?.status === 499 ? "stopped" : "failed", error: String(e?.message ?? e).slice(0, 500), cost: typeof e?.spent === "number" ? e.spent : null });
      }).finally(() => { going.delete(p.n); tick(); });
    }
    asking();
    if (!going.size) finish();
  };
  // A part kept from the earlier run keeps its grade (grading it again replaces it); a part that runs again
  // gives a new answer, graded anew.
  runs.set(id, { view, ac, tick, yes, grades: new Map([...(had?.grades ?? [])].filter(([n]) => before.has(n))) });
  tick();
  return view;
}

// Leanfare switched off (switch.ts): every running plan stops, as plan_stop stops one. Returns how many.
export function stopAllRuns(): number {
  let n = 0;
  for (const [id, r] of runs) if (r.view.running && !r.ac.signal.aborted) { stopRun(id); n++; }
  return n;
}

export function stopRun(id: string): RunView | null {
  const r = runs.get(id);
  if (!r) return null;
  r.ac.abort();
  if (r.view.running && !r.view.parts.some((p) => p.status === "running")) { for (const p of r.view.parts) if (p.status === "waiting") p.status = "stopped"; r.view.running = false; }
  return r.view;
}

async function runPart(p: Part, plan: PlanResult, at: (n: number) => RunPart, signal: AbortSignal, yes: boolean): Promise<Partial<RunPart>> {
  const before = p.needs.map((n) => { const x = at(n); return `Part ${n} (${x.title}):\n${(x.answer ?? "").slice(0, HANDED)}`; });
  const context = p.task.includes(CONTEXT) ? "" : `\n\n${CONTEXT} ${plan.task.slice(0, 4000)}`; // a part split by rules carries it already
  const task = `${p.task}${before.length ? `\n\nWhat the earlier parts found:\n\n${before.join("\n\n")}` : ""}${context}`;
  if (p.where === "codex") {
    // The switch in Settings and the ChatGPT plan's limits hold when the part runs, not only when the plan was made.
    const ok = await codexFor(plan.manager);
    if (!ok.ok) throw Object.assign(new UserError(409, `This part was to run on Codex, but ${ok.why ?? "Codex is off in Settings now"}. Make the plan again to place it elsewhere.`, "codex_off"), { spent: 0 });
    // Codex reads the files itself, from the folder that holds them all (none named: an empty folder).
    const known = wherePaths.get(plan.id) ?? new Map();
    const paths = p.files.map((n) => known.get(n)?.path).filter((x): x is string => !!x);
    const folder = commonFolder(paths);
    const r = await runCodex({ n: p.n, title: p.title, task, folder, files: folder ? paths.map((x) => relative(folder, x)) : paths, effort: p.effort }, signal);
    const bytes = p.files.reduce((n, f) => n + (known.get(f)?.size ?? 0), 0);
    notePart({ kind: p.kind, effort: p.effort, model: CODEX_ID, cost: 0, files: paths.length, fileTokens: Math.ceil(bytes / 4), task, answer: r.answer, plan: `${plan.id}:${p.n}` });
    return { status: "done", answer: r.answer, receipt: `${CODEX_LABEL}, read only, ${secondsText(r.seconds)}. It counts in your ChatGPT plan's Codex use; nothing to pay here.`, model: CODEX_LABEL, modelId: CODEX_ID, cost: 0, seconds: r.seconds };
  }
  if (p.kind === "search" && p.model) {
    const r = await runChat([{ role: "user", content: task }], p.model.id, signal, () => {}, `Plan part ${p.n}`, { source: "plan", maxOut: 4096 });
    if (r.status !== "ok") return { status: r.status === "stopped" ? "stopped" : "failed", error: String(r.meta?.error ?? "It failed."), cost: r.meta?.spent ?? r.meta?.cost ?? null, model: r.meta?.model?.label ?? null };
    notePart({ kind: "search", effort: p.effort, model: r.meta.model.id, cost: r.meta.spent ?? r.meta.cost ?? null, files: 0, fileTokens: 0, task, answer: r.text, plan: `${plan.id}:${p.n}` });
    return { status: "done", answer: r.text, receipt: `${r.meta.model.label}, ${usd(r.meta.cost ?? null)}.`, model: r.meta.model.label, modelId: r.meta.model.id, cost: r.meta.spent ?? r.meta.cost ?? null, seconds: (r.meta.ms ?? 0) / 1000 };
  }
  // Its files, as many as one hand off takes, in the plan's order; one that cannot be read is left out and named.
  const known = wherePaths.get(plan.id) ?? new Map();
  const mine = p.files.map((n) => known.get(n)).filter((x): x is { path: string; size: number } => !!x);
  const files: { name: string; text: string }[] = [];
  const skipped: string[] = [];
  for (const f of handOff(mine)) {
    const got = readForDelegate([f.path]);
    if (typeof got === "string") skipped.push(got.replace(/\.$/, "")); else files.push(...got);
  }
  if (mine.length && !files.length) throw Object.assign(new UserError(400, `None of its files could be handed over${skipped.length ? `: ${skipped.slice(0, 3).join("; ")}` : ""}.`, "plan_files"), { spent: 0 });
  // A free part stays on free models, its check too; a paid part within the cap goes unchecked (the estimate holds no check).
  const free = p.where === "local" || p.where === "free";
  const d = await runDelegate({ task, files, kind: DELEGATE_KIND[p.kind] ?? null, effort: p.effort, check: free || yes ? "auto" : "never", maxOut: DEFAULT_MAX_OUT, ...(free ? { only: isFree } : {}), ...(p.model ? { model: p.model.id } : {}), plan: `${plan.id}:${p.n}` }, signal);
  const notes = [
    mine.length > files.length + skipped.length ? `Handed over ${files.length} of its ${mine.length} files (the most one hand off takes is ${DELEGATE_LIMITS.count} files, ${DELEGATE_LIMITS.total / 1048576} MB).` : "",
    skipped.length ? `Left out: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? `, and ${skipped.length - 3} more` : ""}.` : "",
  ].filter(Boolean).join(" ");
  return { status: "done", answer: d.answer, receipt: `${d.receipt}${notes ? ` ${notes}` : ""}`, model: d.model.label, modelId: d.model.id, cost: d.total, seconds: d.seconds };
}

// ---- grading a part's answer ---------------------------------------------------------------------
// The manager (or you, in the Plan tab) grades the answer of a part Leanfare ran: the grade goes with the
// model that answered and the part's kind (grades.ts). Grading a part again replaces its grade.
const NOT_GRADABLE: Record<RunStatus, string> = { waiting: "it has not run yet", running: "it is still running", done: "no model of Leanfare's answered it", failed: "it failed", stopped: "it was stopped", yours: "it is yours", after_yours: "it runs after yours", blocked: "it waits for a part that is not done", asks: "it waits for your yes" };
export function gradePart(id: string, n: number, verdict: Verdict, source: string): { text: string; standing: ReturnType<typeof standing> } {
  const plan = kept.get(id);
  if (!plan) throw new UserError(404, "This plan is no longer in Leanfare (it was restarted, or 20 newer plans were made).", "plan_gone");
  const part = plan.parts.find((p) => p.n === n);
  const held = runs.get(id);
  const run = held?.view.parts.find((r) => r.n === n);
  if (!part || !run) throw new UserError(404, `Part ${n} of this plan has not run in Leanfare.`, "no_part");
  if (run.status !== "done" || !run.modelId) throw new UserError(400, `Part ${n} has no answer to grade (${NOT_GRADABLE[run.status]}).`, "nothing_to_grade");
  if (!(["read", "write", "reason", "search"] as string[]).includes(part.kind)) throw new UserError(400, `Part ${n} is a ${part.kind} part: only reading, drafting, working out and searching are graded.`, "not_graded");
  held!.grades.set(n, addGrade({ model: run.modelId, kind: part.kind as GradedKind, effort: part.effort, verdict, source }, held!.grades.get(n) ?? null));
  run.verdict = verdict;
  run.gradedBy = source === "you" ? "you" : "manager";
  gradeRow(verdict, { plan: `${id}:${n}` }); // kept with the part's row too: Savings counts the grades of the month
  const st = standing(run.modelId, part.kind as GradedKind);
  return { text: standingText(st), standing: st };
}
