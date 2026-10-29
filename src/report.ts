// The report (0.9): what Leanfare did for your apps over any span of time, with filters, and each prompt with the
// work it handed off. Numbers only, as everywhere: the hand offs' records (delegations, comparisons) and, for Claude
// Code, its own files (each prompt's time and length, and the tokens of its answers; never the words). Claude's
// chats and Cowork, and other apps, tell Leanfare nothing of their own use: their prompts show the work handed to
// Leanfare, grouped by time, and their own use as not known.
//
// Tokens an app used are counted as new tokens: its input not read again from its cache, its cache writes and its
// output. Re-reads from the cache are shown apart: each turn reads the whole conversation again, and counting those
// would bury everything else. A file Leanfare read instead would have been new input for the app.
import { basename } from "node:path";
import { CODEX_ID } from "./codex";
import { getModel } from "./data";
import { db } from "./db";
import { modelName, planFor } from "./planner";
import { recentEntries, recentPrompts } from "./plans";
import { now } from "./util";

export const RANGES = ["1h", "6h", "today", "7d", "30d", "year"] as const;
export type Range = (typeof RANGES)[number];
const HOUR = 3600_000, DAY = 24 * HOUR;
const GAP = 10 * 60_000; // hand offs of an app without its own files: a new prompt after 10 minutes without one
const ATTACH = 6 * HOUR; // a Claude Code hand off belongs to its last prompt begun at most this long before

export interface ReportQuery { from: number; to: number; app?: string | null; provider?: string | null; model?: string | null; kind?: string | null; thread?: string | null }
export type Grade = "good" | "partly" | "wrong";
export interface ReportPart {
  id: number; ts: string; kind: string | null; model: string; label: string; provider: string; where: "local" | "free" | "plan" | "paid";
  read: number; back: number; cost: number | null; ms: number | null;
  grade: Grade | null; gradedBy: "app" | "check" | null; check: "pass" | "fail" | null; checker: string | null; side: "same" | "better" | "worse" | null; plan: string | null;
}
export interface Own { fresh: number; cached: number; input: number; output: number }
export interface ReportPrompt {
  key: string; ts: string; app: string; thread: string | null; project: string | null;
  model: { id: string; label: string } | null; plan: string | null;
  prompt: number | null; // the prompt's own tokens (Claude Code), about four characters each
  own: Own | null; // null: the app does not say
  parts: ReportPart[]; kept: number; back: number; cost: number; saved: number | null; grade: Grade | null;
}

// From and to of a range, by this computer's clock: today starts at local midnight.
export function rangeOf(r: Range, at = now().getTime()): { from: number; to: number } {
  if (r === "today") { const d = new Date(at); d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: at }; }
  const span = { "1h": HOUR, "6h": 6 * HOUR, "7d": 7 * DAY, "30d": 30 * DAY, year: 365 * DAY }[r];
  return { from: at - span, to: at };
}
// The length of one point of the chart: 15 minutes up to 6 hours, an hour up to 2 days, a day up to 62, else a week.
export function bucketOf(span: number): number { return span <= 6 * HOUR ? 15 * 60_000 : span <= 2 * DAY ? HOUR : span <= 62 * DAY ? DAY : 7 * DAY; }
// Where each point starts, by this computer's clock, as the page shows them: on the quarter hour or the hour, and a
// day or a week at midnight (calendar days, so a day the clocks change is still one point). At most 400.
export function startsOf(from: number, to: number, step: number): number[] {
  const d = new Date(from);
  if (step >= DAY) d.setHours(0, 0, 0, 0);
  else if (step >= HOUR) d.setMinutes(0, 0, 0);
  else d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  const out: number[] = [];
  while (d.getTime() < to && out.length < 400) {
    out.push(d.getTime());
    if (step >= DAY) d.setDate(d.getDate() + Math.round(step / DAY)); else d.setTime(d.getTime() + step);
  }
  return out;
}
// The session a Claude Code file belongs to: <id>.jsonl, or <id>/subagents/agent-*.jsonl for its subagents' work,
// which runs on the same plan.
const bySubagent = (path: string) => /[\\/]subagents[\\/][^\\/]+$/.test(path);
export function sessionOf(path: string): string {
  const parts = path.split(/[\\/]/), n = parts.length;
  return (bySubagent(path) && n >= 3 ? parts[n - 3] : parts[n - 1]).replace(/\.jsonl$/, "");
}

const providerOf = (id: string) => (id === CODEX_ID ? "codex" : getModel(id)?.local ? "local" : getModel(id)?.provider ?? id.split("/")[0]);
const labelOf = (id: string) => (id === CODEX_ID ? "Codex" : getModel(id)?.label ?? (id.split("/").slice(1).join("/") || id)); // Codex: its place says "ChatGPT plan"
const whereOf = (id: string, cost: number | null): ReportPart["where"] => (id === CODEX_ID ? "plan" : getModel(id)?.local ? "local" : cost === 0 ? "free" : "paid");
const freshOf = (u: { uncached: number; cacheWrite: number; cacheWrite1h?: number; output: number }) => u.uncached + u.cacheWrite + (u.cacheWrite1h ?? 0) + u.output;

// The hand offs and plan parts in a span (finished ones), each with its grade: the app's, else the check's verdict.
function partsIn(from: number, to: number): (ReportPart & { app: string | null; appModel: string | null; at: number })[] {
  const rows = db.query(`SELECT d.id, d.ts, d.kind, d.model, d.rerun, d.cost, d.check_cost, d.rerun_cost, d.file_tokens, d.task_tokens, d.answer_tokens, d.verdict, d.checker, d.grade, d.plan, d.app, d.app_model, d.ms,
      c.verdict AS side, COALESCE(c.top_cost, 0) + COALESCE(c.judge_cost, 0) AS side_cost
    FROM delegations d LEFT JOIN comparisons c ON c.handoff = d.id AND c.verdict IN ('same', 'better', 'worse')
    WHERE d.status = 'ok' AND d.ts >= ? AND d.ts < ? ORDER BY d.ts, d.id`).all(new Date(from).toISOString(), new Date(to).toISOString()) as any[];
  const seen = new Set<number>();
  return rows.filter((r) => !seen.has(r.id) && !!seen.add(r.id)).map((r) => {
    const model = r.rerun ?? r.model ?? "unknown";
    const grade: Grade | null = ["good", "partly", "wrong"].includes(r.grade) ? r.grade : r.verdict === "pass" ? "good" : r.verdict === "fail" ? "wrong" : null;
    const parts = [r.cost, r.check_cost, r.rerun_cost].filter((v) => v !== null && v !== undefined) as number[];
    return {
      id: r.id, ts: r.ts, at: Date.parse(r.ts), kind: r.kind, model, label: labelOf(model), provider: providerOf(model), where: whereOf(model, r.cost),
      read: (r.file_tokens ?? 0) + (r.task_tokens ?? 0), back: r.answer_tokens ?? 0,
      cost: r.cost === null && !parts.length ? null : parts.reduce((a, b) => a + b, 0) + (r.side_cost ?? 0), ms: r.ms ?? null,
      grade, gradedBy: grade === null ? null : ["good", "partly", "wrong"].includes(r.grade) ? "app" : "check",
      check: r.verdict === "pass" || r.verdict === "fail" ? r.verdict : null, checker: r.checker ? labelOf(r.checker) : null,
      side: r.side ?? null, plan: r.plan ? String(r.plan).split(":")[0] : null, app: r.app ?? null, appModel: r.app_model ?? null,
    };
  });
}

const KIND_ORDER = ["read", "write", "reason", "search", "other"];
const worst = (gs: (Grade | null)[]): Grade | null => (gs.includes("wrong") ? "wrong" : gs.includes("partly") ? "partly" : gs.includes("good") ? "good" : null);

export async function report(q: ReportQuery) {
  const span = Math.max(1, q.to - q.from);
  // Claude Code: its prompts (with a day before, for one begun earlier that still ran) and its answers' tokens.
  const prompts = await recentPrompts(q.from - DAY);
  const { entries } = await recentEntries("claude", q.from - DAY);
  const ccPlan = planFor("Claude Code");
  // Each Claude Code prompt runs until the next one of the same session.
  const bySession = new Map<string, typeof prompts>();
  for (const p of prompts) bySession.set(p.file, [...(bySession.get(p.file) ?? []), p]);
  const cc: (ReportPrompt & { start: number; end: number; models: Map<string, number> })[] = [];
  for (const [file, ps] of bySession) {
    ps.forEach((p, i) => cc.push({
      key: `cc:${basename(file)}:${p.ts}`, ts: new Date(p.ts).toISOString(), app: "Claude Code", thread: sessionOf(file), project: p.project,
      model: null, plan: ccPlan, prompt: Math.ceil(p.chars / 4), own: { fresh: 0, cached: 0, input: 0, output: 0 }, parts: [], kept: 0, back: 0, cost: 0, saved: null, grade: null,
      start: p.ts, end: ps[i + 1]?.ts ?? Infinity, models: new Map(),
    }));
  }
  const sessionPrompts = new Map<string, typeof cc>();
  for (const p of cc) sessionPrompts.set(p.thread!, [...(sessionPrompts.get(p.thread!) ?? []), p]);
  const promptOf = (e: { file: string; ts: number }) => sessionPrompts.get(sessionOf(e.file))?.find((x) => e.ts >= x.start && e.ts < x.end);
  for (const e of entries) {
    const p = promptOf(e);
    if (!p) continue;
    p.own!.fresh += freshOf(e.u); p.own!.cached += e.u.cacheRead;
    p.own!.input += e.u.uncached + e.u.cacheWrite + (e.u.cacheWrite1h ?? 0); p.own!.output += e.u.output;
    if (!bySubagent(e.file)) p.models.set(e.model, (p.models.get(e.model) ?? 0) + e.u.output + 1); // the main model: the session's own, not a subagent's
  }
  for (const p of cc) {
    const top = [...p.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top) p.model = { id: top, label: modelName(top) };
  }

  // The hand offs: a Claude Code one goes to its prompt; the others, a plan's parts together, are grouped by time.
  const parts = partsIn(q.from - ATTACH, q.to);
  const ccStarts = [...cc].sort((a, b) => a.start - b.start);
  const others: ReportPrompt[] = [];
  let open: (ReportPrompt & { last: number; appModel: string | null }) | null = null;
  for (const part of parts) {
    if (part.app === "Claude Code") {
      let host: (typeof cc)[number] | undefined;
      for (const p of ccStarts) { if (p.start <= part.at) host = p; else break; }
      if (host && part.at - host.start <= ATTACH) { host.parts.push(part); continue; }
    }
    const app = part.app ?? "Your app";
    const samePlan = open && part.plan && open.parts.some((x) => x.plan === part.plan);
    if (!open || open.app !== app || (!samePlan && part.at - open.last > GAP)) {
      open = { key: `h:${part.id}`, ts: part.ts, app, thread: null, project: null, model: part.appModel ? { id: part.appModel, label: modelName(part.appModel) } : null,
        plan: planFor(app), prompt: null, own: null, parts: [], kept: 0, back: 0, cost: 0, saved: null, grade: null, last: part.at, appModel: part.appModel };
      others.push(open);
    }
    open.parts.push(part); open.last = part.at;
    if (!open.model && part.appModel) open.model = { id: part.appModel, label: modelName(part.appModel) };
  }

  // Every prompt that began in the span, then the filters.
  const all: ReportPrompt[] = [...cc, ...others].filter((p) => { const t = Date.parse(p.ts); return t >= q.from && t < q.to; });
  const options = {
    apps: [...new Set(all.map((p) => p.app))].sort(),
    providers: [...new Set(all.flatMap((p) => p.parts.map((x) => x.provider)))].sort(),
    models: [...new Map(all.flatMap((p) => p.parts.map((x) => [x.model, x.label] as [string, string]))).entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    kinds: [...new Set(all.flatMap((p) => p.parts.map((x) => x.kind).filter((k): k is string => !!k)))].sort(),
    threads: [...new Map(all.filter((p) => p.thread).map((p) => [p.thread!, { id: p.thread!, project: p.project, first: p.ts, prompts: 0 }])).values()]
      .map((t) => ({ ...t, prompts: all.filter((p) => p.thread === t.id).length, first: all.filter((p) => p.thread === t.id).map((p) => p.ts).sort()[0] })).sort((a, b) => (a.first < b.first ? 1 : -1)),
  };
  const partFilter = q.provider || q.model || q.kind;
  const keepPart = (x: ReportPart) => (!q.provider || x.provider === q.provider) && (!q.model || x.model === q.model) && (!q.kind || x.kind === q.kind);
  const shown = all
    .filter((p) => (!q.app || p.app === q.app) && (!q.thread || p.thread === q.thread))
    .map((p) => ({ ...p, parts: p.parts.filter(keepPart) }))
    .filter((p) => !partFilter || p.parts.length)
    .map((p) => {
      const kept = p.parts.reduce((n, x) => n + x.read, 0), back = p.parts.reduce((n, x) => n + x.back, 0);
      const out: ReportPrompt = { key: p.key, ts: p.ts, app: p.app, thread: p.thread, project: p.project, model: p.model, plan: p.plan, prompt: p.prompt, own: p.own, parts: p.parts,
        kept, back, cost: p.parts.reduce((n, x) => n + (x.cost ?? 0), 0), saved: p.own ? (kept + p.own.fresh > 0 ? kept / (kept + p.own.fresh) : null) : null, grade: worst(p.parts.map((x) => x.grade)) };
      return out;
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));

  // The tiles.
  const ps = shown.flatMap((p) => p.parts);
  const kept = ps.reduce((n, x) => n + x.read, 0);
  const known = shown.filter((p) => p.own);
  const keptKnown = known.reduce((n, p) => n + p.kept, 0), freshKnown = known.reduce((n, p) => n + p.own!.fresh, 0);
  const priceModel = mainModel(shown);
  const price = priceModel ? getModel(priceModel) ?? getModel(`anthropic/${priceModel}`) : null;
  const counts = { good: ps.filter((x) => x.grade === "good").length, partly: ps.filter((x) => x.grade === "partly").length, wrong: ps.filter((x) => x.grade === "wrong").length };
  const graded = counts.good + counts.partly + counts.wrong;
  const blind = ps.filter((x) => x.check || x.side);
  const judges = new Map<string, number>();
  for (const x of blind) if (x.checker) judges.set(x.checker, (judges.get(x.checker) ?? 0) + 1);
  const tiles = {
    kept: { tokens: kept, share: keptKnown + freshKnown > 0 && known.length ? keptKnown / (keptKnown + freshKnown) : null,
      value: price?.input != null ? (kept / 1e6) * price.input : null, valueModel: price ? price.label : null },
    own: { fresh: freshKnown, cached: known.reduce((n, p) => n + p.own!.cached, 0), measured: known.length, notKnown: shown.length - known.length,
      byApp: [...new Set(shown.map((p) => p.app))].map((app) => ({ app, measured: shown.some((p) => p.app === app && p.own), fresh: shown.filter((p) => p.app === app && p.own).reduce((n, p) => n + p.own!.fresh, 0) })) },
    cost: { usd: ps.reduce((n, x) => n + (x.cost ?? 0), 0), freeShare: ps.length ? ps.filter((x) => x.where !== "paid").length / ps.length : null, parts: ps.length, prompts: shown.length },
    quality: { ...counts, graded, goodShare: graded ? counts.good / graded : null, blind: blind.length, judge: [...judges.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null },
  };

  // Tokens over time: kept by Leanfare's models against the new tokens of the apps whose use is known.
  const step = bucketOf(span);
  const starts = startsOf(q.from, q.to, step);
  const series = starts.map((t) => ({ at: new Date(t).toISOString(), kept: 0, used: 0 }));
  const slot = (t: number) => { // the last point that starts at or before t
    if (!starts.length || t < starts[0] || t >= q.to) return undefined;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
    return series[lo];
  };
  for (const x of ps) { const s = slot(Date.parse(x.ts)); if (s) s.kept += x.read; }
  const shownKeys = new Set(shown.filter((p) => p.own).map((p) => p.key));
  for (const e of entries) {
    if (e.ts < q.from || e.ts >= q.to) continue;
    const p = promptOf(e);
    if (!p || !shownKeys.has(p.key)) continue;
    const s = slot(e.ts); if (s) s.used += freshOf(e.u);
  }

  // By model and by kind of work.
  const byModel = [...new Map(ps.map((x) => [x.model, x])).keys()].map((id) => {
    const xs = ps.filter((x) => x.model === id);
    const g = xs.filter((x) => x.grade), good = xs.filter((x) => x.grade === "good").length;
    return { id, label: xs[0].label, where: xs[0].where, provider: xs[0].provider, read: xs.reduce((a, x) => a + x.read, 0), parts: xs.length,
      cost: xs.reduce((a, x) => a + (x.cost ?? 0), 0), graded: g.length, goodShare: g.length ? good / g.length : null };
  }).sort((a, b) => b.read - a.read || b.parts - a.parts);
  const byKind = [...new Set(ps.map((x) => x.kind ?? "other"))].map((kind) => {
    const xs = ps.filter((x) => (x.kind ?? "other") === kind);
    const c = { good: xs.filter((x) => x.grade === "good").length, partly: xs.filter((x) => x.grade === "partly").length, wrong: xs.filter((x) => x.grade === "wrong").length };
    const models = [...new Set(xs.map((x) => x.model))].map((id) => { const g = xs.filter((x) => x.model === id && x.grade); return { id, label: labelOf(id), n: g.length, share: g.length ? g.filter((x) => x.grade === "good").length / g.length : 0, parts: xs.filter((x) => x.model === id).length }; })
      .filter((m) => m.n >= 2).sort((a, b) => b.share - a.share || b.parts - a.parts);
    return { kind, parts: xs.length, ...c, best: models[0] ? { id: models[0].id, label: models[0].label } : null };
  }).sort((a, b) => b.parts - a.parts || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  return { from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString(), step, tiles, series, byModel, byKind, prompts: shown.slice(0, 200), more: Math.max(0, shown.length - 200), options };
}

// The model your apps ran on most in these prompts: what kept tokens would have cost there.
function mainModel(ps: ReportPrompt[]): string | null {
  const n = new Map<string, number>();
  for (const p of ps) if (p.model) n.set(p.model.id, (n.get(p.model.id) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// The query from the page or a tool: a range or from and to, and the filters (each a short name, or nothing).
export function checkReport(p: URLSearchParams, at = now().getTime()): ReportQuery | string {
  const range = p.get("range") ?? "7d";
  let from: number, to: number;
  if (range === "custom") {
    from = Date.parse(p.get("from") ?? ""); to = Date.parse(p.get("to") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return "A custom range needs from and to, dates with from before to.";
    if (to - from > 3 * 366 * DAY) return "A custom range can be at most 3 years.";
  } else if ((RANGES as readonly string[]).includes(range)) ({ from, to } = rangeOf(range as Range, at));
  else return `range must be ${RANGES.join(", ")} or custom.`;
  const name = (k: string) => { const v = p.get(k); return v && v.length <= 120 ? v : null; };
  return { from, to, app: name("app"), provider: name("provider"), model: name("model"), kind: name("kind"), thread: name("thread") };
}
