// Automatic model choice.
//
// Task guess: rules read the conversation and name one Arena task.
// Best value pick: among the models you ticked, the cheapest whose rating
// for that task is within the mode's margin of the best one.
// Every pick carries its reason, so a wrong guess is visible at a glance.
import { costOf, promptTokens, textOfContent } from "./cost";
import { TASKS, allModels, getModel, isRetired, type Model } from "./data";
import { MODES, type Mode } from "./settings";
import { localDay } from "./util";

export interface Guess { task: string; why: string; alt: string | null }
export interface Msg { role: string; content: unknown }

const taskLabel = (t: string) => TASKS.find(([id]) => id === t)?.[1] ?? t;

const CODE_FENCE = /```/;
// Case matters here: "Let me know" is not `let x = 1`.
const CODE_SIGNS = /(Traceback \(most recent call last\)|^\s*(def \w+\(|class \w+[:(]|import \w|from [\w.]+ import |function \w*\(|const \w+ = |let \w+ = |var \w+ = |#include <|SELECT .+ FROM |public (static |class )|async def )|\w+\.\w+\([^)]*\);\s*$|<\/?(div|span|html|body|script)\b)/m;
const CODE_WORDS = /\b(python|javascript|typescript|java|rust|golang|kotlin|swift|c\+\+|sql|regex|bash|html|css|react|node\.?js|npm|pip|docker|kubernetes|git|github|api|endpoint|json|yaml|csv|compile|compiler|debug|debugging|bug|stack trace|exception|refactor|unit tests?|code|codebase|repo)\b/gi;
// Names that only ever mean programming: one is enough. ("Swift" and "Rust"
// are left out: a singer and a metal.)
const CODE_STRONG = /\b(python|javascript|typescript|golang|kotlin|c\+\+|sql|regex|bash script|html|css|json|yaml|dockerfile|kubernetes|npm|github|stack trace|traceback|unit tests?|codebase)\b/i;
const MATH_WORDS = /\b(solve|equation|integral|derivative|probability|calculate|compute|proof|prove|theorem|matrix|algebra|geometry|logarithm|polynomial|how many ways)\b/gi;
const MATH_STRONG = /\b(solve|calculate|compute|integral|derivative|prove)\b/i;
const MATH_SIGNS = /(\d\s*[+*^×÷]\s*\d)|(\b[a-z]\s*=\s*-?\d)|(\d[a-z]\s*[+\-=]\s*\d)|(\d\s*%\s*of\b)|\\frac|\\int|\\sum|√|∫|∑|\b[a-z]\^\d/;
const CREATIVE = /\b(write|compose|draft|create|tell)\b[^.?!\n]{0,40}\b(story|stories|poem|poems|haiku|song|lyrics|novel|fiction|screenplay|fable|limerick|sonnet|fairy tale|short story)\b/i;
const BUSINESS = /\b(revenue|profit|margin|marketing|sales|startup|investor|pitch|business plan|pricing|finance|financial|accounting|invoice|cash flow|valuation|market share|kpi|roi|budget|customers?)\b/gi;
const LEGAL = /\b(contract|lawsuit|legal|law|attorney|lawyer|court|liability|clause|regulation|compliance|gdpr|copyright|trademark|patent|tenant|landlord|lease|terms of service)\b/gi;
const MEDICINE = /\b(symptoms?|diagnosis|disease|medication|medicine|dose|dosage|doctor|treatment|clinical|patient|blood pressure|vaccine|infection|chronic|prescription)\b/gi;

const distinct = (text: string, re: RegExp) => [...new Set((text.match(re) ?? []).map((w) => w.toLowerCase()))];

export function guessTask(messages: Msg[]): Guess {
  const users = messages.filter((m) => m.role === "user");
  const last = textOfContent(users.at(-1)?.content ?? "");
  const recent = users.slice(-3).map((m) => textOfContent(m.content)).join("\n");
  const turns = users.length;

  if (CODE_FENCE.test(recent)) return { task: "coding", why: "the conversation has a code block", alt: turns > 5 ? "multi_turn" : "overall" };
  const codeWords = distinct(recent, CODE_WORDS);
  if (CODE_SIGNS.test(last) || codeWords.length >= 2 || CODE_STRONG.test(recent)) {
    return { task: "coding", why: codeWords.length ? `programming words (${codeWords.slice(0, 3).join(", ")})` : "it looks like code", alt: "overall" };
  }
  const mathWords = distinct(last, MATH_WORDS);
  if (MATH_SIGNS.test(last) || mathWords.length >= 2 || (MATH_STRONG.test(last) && /\d/.test(last))) {
    return { task: "math", why: MATH_SIGNS.test(last) ? "numbers with operators" : `math words (${mathWords.slice(0, 3).join(", ")})`, alt: "overall" };
  }
  if (CREATIVE.test(last)) return { task: "creative_writing", why: "it asks for a story, poem or song", alt: "overall" };
  if (last.length >= 2000) return { task: "longer_query", why: `a long message (${last.length.toLocaleString("en-US")} characters)`, alt: "overall" };
  if (turns > 5) return { task: "multi_turn", why: `follow-up number ${turns - 1}`, alt: "overall" };
  for (const [task, re, label] of [["business", BUSINESS, "business words"], ["legal", LEGAL, "legal words"], ["medicine", MEDICINE, "health words"]] as const) {
    const w = distinct(last, re);
    if (w.length >= 2) return { task, why: `${label} (${w.slice(0, 3).join(", ")})`, alt: "overall" };
  }
  return { task: "overall", why: "no strong signal, so the everyday rating", alt: null };
}

// The same guess without the user's words, for the cost ledger (which keeps
// no message content).
export const ledgerWhy = (g: Guess) => g.why.replace(/\s*\([^)]*\)/, "");

// Output tokens an answer is expected to have, before it is written.
const DEFAULT_OUT: Record<string, number> = { overall: 400, coding: 700, math: 500, creative_writing: 900, longer_query: 600, multi_turn: 400, business: 600, legal: 600, medicine: 500 };
export function expectedOutput(task: string, model: Model | null, history: (task: string, model: string | null) => number | null): number {
  const fromHistory = history(task, model?.id ?? null) ?? history(task, null);
  if (fromHistory) return Math.round(fromHistory);
  const base = DEFAULT_OUT[task] ?? 400;
  return model?.skills.includes("reasoning") ? base * 2 : base;
}

export const rating = (m: Model, task: string): number | null => m.ratings[task] ?? m.ratings.overall ?? null;

export interface Candidate { model: Model; rating: number | null; estimate: number | null }
export interface Pick {
  model: Model;
  guess: Guess;
  mode: Mode;
  reason: string;
  estimate: number | null; // the estimate for the picked model
  candidates: Candidate[]; // in fallback order
  best: Candidate | null;
}

export function estimateFor(m: Model, inTokens: number, outTokens: number): number | null {
  return costOf(m, { uncached: inTokens, cacheRead: 0, cacheWrite: 0, output: outTokens });
}

const fmtUsd = (v: number | null) => (v === null ? "no listed price" : v === 0 ? "$0" : v < 0.0001 ? "under $0.0001" : `$${v < 0.01 ? v.toPrecision(2) : v.toFixed(v < 1 ? 3 : 2)}`);

// The best value pick. `usable` is the set of ticked models whose provider is ready.
export function pickModel(messages: Msg[], usable: Model[], mode: Mode, history: (task: string, model: string | null) => number | null, system?: unknown): Pick | null {
  const guess = guessTask(messages);
  const inTok = promptTokens(messages as any, system);
  const day = localDay();
  const live = usable.filter((m) => !isRetired(m, day));
  const rated: Candidate[] = [];
  const unrated: Candidate[] = [];
  for (const m of live) {
    const r = rating(m, guess.task);
    const c = { model: m, rating: r, estimate: estimateFor(m, inTok, expectedOutput(guess.task, m, history)) };
    (r !== null && c.estimate !== null ? rated : unrated).push(c);
  }
  if (!rated.length) return null;
  const margin = MODES[mode].margin;
  const best = rated.reduce((a, b) => (b.rating! > a.rating! ? b : a));
  const eligible = rated.filter((c) => c.rating! >= best.rating! - margin);
  eligible.sort((a, b) => a.estimate! - b.estimate! || b.rating! - a.rating! || (b.model.added ?? "").localeCompare(a.model.added ?? ""));
  const rest = rated.filter((c) => !eligible.includes(c)).sort((a, b) => b.rating! - a.rating!);
  const chosen = eligible[0];
  const usedRating = chosen.model.ratings[guess.task] !== undefined ? guess.task : "overall";
  const gap = Math.round(best.rating! - chosen.rating!);
  let reason = `${taskLabel(guess.task)}, guessed from ${guess.why}. ${MODES[mode].label}: ${MODES[mode].blurb}.`;
  if (chosen === best) reason += ` ${chosen.model.label} is the best rated for this (${Math.round(chosen.rating!)}) and the cheapest of the ${eligible.length} within reach.`;
  else reason += ` ${chosen.model.label} is rated ${Math.round(chosen.rating!)}${usedRating !== guess.task ? " overall" : ""}, ${gap} under ${best.model.label}, at about ${fmtUsd(chosen.estimate)} instead of ${fmtUsd(best.estimate)}.`;
  return { model: chosen.model, guess, mode, reason, estimate: chosen.estimate, candidates: [...eligible, ...rest], best };
}

// What a request's "model" field means. Accepts "auto", Leanfare's own ids
// ("google/gemini-3.8-flash"), llmledger keys ("gemini/gemini-3.8-flash") and
// the id a provider itself uses ("gemini-3.8-flash", "claude-sonnet-5-5").
export function resolveModel(asked: string): Model | null {
  const s = asked.trim();
  const direct = getModel(s);
  if (direct) return direct;
  const all = allModels();
  const slash = s.indexOf("/");
  if (slash > 0) {
    const head = s.slice(0, slash), tail = s.slice(slash + 1);
    const alias: Record<string, string> = { gemini: "google", "x-ai": "xai", mistralai: "mistral" };
    const viaAlias = getModel(`${alias[head] ?? head}/${tail}`);
    if (viaAlias) return viaAlias;
    const bySource = all.find((m) => m.source === s);
    if (bySource) return bySource;
    // "anthropic/claude-sonnet-5.5" is how OpenRouter names it.
    const viaRouter = getModel(`openrouter/${s}`);
    if (viaRouter) return viaRouter;
  }
  const byApi = all.filter((m) => m.apiId === s && m.provider !== "openrouter");
  if (byApi.length) return byApi[0];
  return null;
}
