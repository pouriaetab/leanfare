// The plan meter: what is left of your Claude and ChatGPT plans, in dollars of work at API
// prices and in tokens, and which of your projects still fits before the limit.
//
// Numbers only, never words. The percentages come from Claude Code's status line
// (statusline.ts) and from Codex's own logs; the work comes from the log files the plans
// card reads (plans.ts), of which only the model, the time and the token counts are kept.
//
// How much 1% holds (k, in dollars of work at API prices):
//  1. Each window (5 hours, or the week, from one reset to the next) is one observation:
//     between its first and last snapshot the percent went up by D, and the logs show W
//     dollars of work in between. W / D is what one percent held in that window.
//  2. Work the logs cannot see (Claude chats, Cowork, the phone apps) also moves the
//     percent, so it can only pull W / D down. k is the 80th percentile of the windows'
//     W / D, and its 90% interval comes from resampling the windows (a bootstrap).
//  3. With fewer than 3 windows, k starts from what others measured for the plan, and the
//     screen says it is a starting estimate.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config";
import { costOf, type Usage } from "./cost";
import { getModel } from "./data";
import { pricedAs, recentEntries, type Limits, type MeterEntry } from "./plans";
import { settings, type PlanProvider } from "./settings";
import { selfCommand } from "./self";
import { meterCacheFile, quote, readSnaps, unquote, type Snap } from "./statusline";
import { UserError } from "./upstream";
import { now } from "./util";

const DAY = 86_400_000;
export const LOOK_BACK = 21 * DAY; // three weeks of windows and sessions
const MIN_RISE = 2; // percent points: a window that moved less says too little (the percent is often rounded)
const MIN_WINDOWS = 3;

// ---- the statistics -------------------------------------------------------------------------------

export interface Point { at: number; used: number; resets: number | null }
export interface Obs { w: number; d: number } // dollars of logged work, percent points

// Linear interpolation between order statistics (the same as R's type 7).
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// One observation per window: points with the same reset (to the minute) belong to one window;
// without a reset time, a drop in the percent starts a new one.
export function observations(points: Point[], work: { ts: number; value: number }[]): Obs[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const groups: Point[][] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    const sameWindow = !!prev && (p.resets !== null && prev.resets !== null ? Math.round(p.resets / 60_000) === Math.round(prev.resets / 60_000) : p.used >= prev.used);
    if (sameWindow) g.push(p); else groups.push([p]);
  }
  const ts = work.map((x) => x.ts);
  const prefix = [0];
  for (const x of work) prefix.push(prefix[prefix.length - 1] + x.value);
  const upTo = (t: number) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m + 1; else hi = m; } return lo; }; // how many at or before t
  const out: Obs[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const first = g[0], last = g[g.length - 1];
    const d = last.used - first.used;
    const w = prefix[upTo(last.at)] - prefix[upTo(first.at)];
    if (d > 0) out.push({ w, d });
  }
  return out;
}

// A small random number maker with a seed, so the interval is the same every time for the same data.
export function seeded(seed = 12345) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

export interface Estimate { k: number; lo: number; hi: number; n: number }
export function estimate(obs: Obs[], rand = seeded(), draws = 500): Estimate | null {
  const ok = obs.filter((o) => o.d >= MIN_RISE && o.w > 0);
  if (ok.length < MIN_WINDOWS) return null;
  const stat = (xs: Obs[]) => quantile(xs.map((o) => o.w / o.d).sort((a, b) => a - b), 0.8);
  const k = stat(ok);
  const boots: number[] = [];
  for (let b = 0; b < draws; b++) boots.push(stat(ok.map(() => ok[Math.floor(rand() * ok.length)])));
  boots.sort((a, b) => a - b);
  return { k, lo: quantile(boots, 0.05), hi: quantile(boots, 0.95), n: ok.length };
}

// What others measured (wokey.ai, 19 Oct 2026), in dollars of API priced work: Pro about $14 a
// 5 hour window and $170 a week; Max 20x about $205 and $1,640. Max 5x was not measured: Anthropic
// says 5 times Pro for the 5 hours; the week is a rough guess between the two. ChatGPT: none known.
export function startingK(provider: PlanProvider, price: number | null): { k5: number; kWeek: number; plan: string; rough: boolean } | null {
  if (provider !== "claude" || price === null) return null;
  if (price <= 25) return { k5: 0.14, kWeek: 1.7, plan: "Pro", rough: false };
  if (price <= 120) return { k5: 0.7, kWeek: 6, plan: "Max 5x", rough: true }; // 5 times Pro's 0.14 for the 5 hours
  return { k5: 2.05, kWeek: 16.4, plan: "Max 20x", rough: false };
}

// ---- the work in the logs, in dollars --------------------------------------------------------------

const priceCache = new Map<string, Parameters<typeof costOf>[0] | null>();
function valueOf(provider: PlanProvider, e: MeterEntry): number {
  const key = `${provider}:${e.model}`;
  if (!priceCache.has(key)) {
    const id = pricedAs(provider, e.model);
    const m = id ? getModel(id) : undefined;
    priceCache.set(key, m ? { ...m, above200k: null } : null);
  }
  const p = priceCache.get(key);
  return p ? costOf(p, e.u) ?? 0 : 0;
}
const tokensOf = (u: Usage) => u.uncached + u.cacheRead + u.cacheWrite + (u.cacheWrite1h ?? 0) + u.output;

// ---- the view -------------------------------------------------------------------------------------

export interface WindowView {
  kind: "5 hours" | "week"; used: number; resets: string | null;
  k: number | null; kLo: number | null; kHi: number | null; from: "measured" | "starting estimate" | null; windows: number;
  left: number | null; leftLo: number | null; leftHi: number | null; tokensLeft: number | null;
}
export interface ProjectView { name: string; typical: number; sessions: number; pctOfWeek: number | null; sessionsLeft: number | null }
export interface MeterView {
  provider: PlanProvider; source: "status line" | "Codex logs"; at: string | null; // when the newest snapshot was taken
  windows: WindowView[]; projects: ProjectView[];
  other: number | null; // percent points of this week's window from use the logs do not show (Claude chats, Cowork, phone)
  rough: boolean; plan: string | null; note: string;
}

const pointsFromSnaps = (snaps: Snap[], kind: "five" | "week"): Point[] =>
  snaps.flatMap((s) => (s[kind] ? [{ at: s.at, used: s[kind]!.used, resets: s[kind]!.resets }] : []));
const pointsFromCodex = (snaps: Limits[], minutes: number): Point[] =>
  snaps.flatMap((s) => s.windows.filter((w) => w.minutes === minutes).map((w) => ({ at: s.at, used: w.used, resets: w.resets === null ? null : w.resets * 1000 })));

export async function meterView(provider: PlanProvider): Promise<MeterView> {
  const t = now().getTime();
  const since = t - LOOK_BACK;
  const { entries, snaps: codexSnaps } = await recentEntries(provider, since);
  const work = entries.map((e) => ({ ts: e.ts, value: valueOf(provider, e) }));
  const plan = settings().plans?.[provider] ?? null;
  const start = startingK(provider, plan?.price ?? null);
  const claudeSnaps = provider === "claude" ? readSnaps(since) : [];
  const series: Record<"five" | "week", Point[]> = provider === "claude"
    ? { five: pointsFromSnaps(claudeSnaps, "five"), week: pointsFromSnaps(claudeSnaps, "week") }
    : { five: pointsFromCodex(codexSnaps, 300), week: pointsFromCodex(codexSnaps, 10080) };
  const newest = Math.max(0, ...series.five.map((p) => p.at), ...series.week.map((p) => p.at));

  // Tokens a dollar buys at your recent mix (the last 7 days; cache reads are most of them).
  const recent = entries.filter((e) => e.ts >= t - 7 * DAY);
  const recentValue = recent.reduce((n, e, i) => n + work[entries.length - recent.length + i].value, 0);
  const tokensPerDollar = recentValue > 0 ? recent.reduce((n, e) => n + tokensOf(e.u), 0) / recentValue : null;

  const windows: WindowView[] = [];
  for (const kind of ["five", "week"] as const) {
    const pts = series[kind];
    const last = pts[pts.length - 1];
    if (!last || (last.resets !== null && last.resets <= t)) continue; // no number yet, or that window has reset since
    const est = estimate(observations(pts, work));
    const prior = start ? (kind === "five" ? start.k5 : start.kWeek) : null;
    const k = est?.k ?? prior;
    const lo = est ? est.lo : prior !== null ? prior * 0.7 : null;
    const hi = est ? est.hi : prior !== null ? prior * 1.3 : null;
    const leftPct = Math.max(0, 100 - last.used);
    windows.push({
      kind: kind === "five" ? "5 hours" : "week", used: last.used, resets: last.resets === null ? null : new Date(last.resets).toISOString(),
      k, kLo: lo, kHi: hi, from: est ? "measured" : prior !== null ? "starting estimate" : null, windows: est?.n ?? 0,
      left: k === null ? null : leftPct * k, leftLo: lo === null ? null : leftPct * lo, leftHi: hi === null ? null : leftPct * hi,
      tokensLeft: k === null || tokensPerDollar === null ? null : leftPct * k * tokensPerDollar,
    });
  }

  // Projects: one log file is one session; a project's typical session is the median of its last 10.
  const sessions = new Map<string, { project: string; value: number; last: number }>();
  entries.forEach((e, i) => {
    if (!e.project) return;
    const s = sessions.get(e.file) ?? sessions.set(e.file, { project: e.project, value: 0, last: 0 }).get(e.file)!;
    s.value += work[i].value; s.last = Math.max(s.last, e.ts);
  });
  const byProject = new Map<string, { value: number; last: number }[]>();
  for (const s of sessions.values()) if (s.value >= 0.01) (byProject.get(s.project) ?? byProject.set(s.project, []).get(s.project)!).push(s);
  const week = windows.find((w) => w.kind === "week") ?? null;
  const five = windows.find((w) => w.kind === "5 hours") ?? null;
  const leftNow = [week?.left, five?.left].filter((x): x is number => typeof x === "number");
  const projects: ProjectView[] = [...byProject].map(([name, ss]) => {
    const lastTen = ss.sort((a, b) => b.last - a.last).slice(0, 10).map((s) => s.value).sort((a, b) => a - b);
    const typical = quantile(lastTen, 0.5);
    return { name, typical, sessions: ss.length, pctOfWeek: week?.k ? typical / week.k : null, sessionsLeft: leftNow.length ? Math.min(...leftNow) / typical : null };
  }).sort((a, b) => (b.sessions - a.sessions) || a.name.localeCompare(b.name)).slice(0, 8);

  // This week's window: how much of its rise the logs do not explain.
  let other: number | null = null;
  const wk = series.week, lastW = wk[wk.length - 1];
  if (week?.k && lastW) {
    const cur = wk.filter((p) => p.resets !== null && lastW.resets !== null ? Math.round(p.resets / 60_000) === Math.round(lastW.resets / 60_000) : true);
    const ob = observations(cur, work)[0];
    if (ob) other = Math.max(0, ob.d - ob.w / week.k);
  }

  const view: MeterView = {
    provider, source: provider === "claude" ? "status line" : "Codex logs", at: newest ? new Date(newest).toISOString() : null,
    windows, projects, other: other !== null && other >= 0.5 ? other : other === null ? null : 0,
    rough: !!start?.rough && windows.some((w) => w.from === "starting estimate"), plan: start?.plan ?? null,
    note: provider === "claude"
      ? "From Claude Code's status line (the two percentages) and its log files (the work, at API prices). Claude chats, Cowork and the phone apps use the same limits but keep no log here, so they show only as other use."
      : "From Codex's log files: each message carries how much of the plan's windows it had used.",
  };
  if (provider === "claude") {
    try { writeFileSync(meterCacheFile(), JSON.stringify({ at: t, k5: five?.k ?? null, kWeek: week?.k ?? null, projects: Object.fromEntries(projects.map((p) => [p.name, p.typical])) }), { mode: 0o600 }); } catch {}
  }
  return view;
}

export async function meterViews() {
  const [claude, chatgpt] = await Promise.all([meterView("claude"), meterView("chatgpt")]);
  return { claude, chatgpt, statusline: statuslineState() };
}

// ---- putting Leanfare in Claude Code's status line --------------------------------------------------

// Claude Code's own settings file: in CLAUDE_CONFIG_DIR when that is set, as Claude Code does.
export const claudeSettingsFile = () => {
  if (process.env.LEANFARE_CLAUDE_SETTINGS) return process.env.LEANFARE_CLAUDE_SETTINGS;
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  return join(dir || join(homedir(), ".claude"), "settings.json");
};
const keptFile = () => join(DATA_DIR, "statusline-kept.json"); // the status line you had, as it was, to give back
export const ourCommand = () => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + " statusline"; };
// Leanfare's line, set by the button or by hand ("leanfare statusline", "bun .../cli.ts statusline").
// On Windows the program is ...\leanfare.exe, written with backslashes, in any case.
const ours = (cmd: unknown): cmd is string => typeof cmd === "string" && /(^|[\s'"/\\])(leanfare(\.exe)?|cli\.ts)['"]?\s+statusline\b/i.test(cmd);
// The command Leanfare's line runs first: what was there before (kept after --then).
const before = (cmd: string): string | null => { const i = cmd.indexOf(" --then "); return i < 0 ? null : unquote(cmd.slice(i + 8).trim()); };

export function readClaudeSettings(): any {
  const file = claudeSettingsFile();
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let j: unknown;
  try { j = JSON.parse(text); } catch { j = undefined; }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new UserError(409, `Claude Code's settings file (${file}) is not a valid settings file (a JSON object), so Leanfare left it alone. Fix it in a text editor, then try again.`);
  return j;
}

export function statuslineState() {
  let j: any = {};
  try { j = readClaudeSettings(); } catch { return { installed: false, file: claudeSettingsFile(), keeps: null, broken: true }; }
  const cmd = j?.statusLine?.command;
  return { installed: ours(cmd), file: claudeSettingsFile(), keeps: ours(cmd) ? before(cmd) : null, broken: false };
}

function readKept(): any {
  try { const k = JSON.parse(readFileSync(keptFile(), "utf8")); return k && typeof k === "object" ? k : null; } catch { return null; }
}

export function setStatusline(on: boolean) {
  const j = readClaudeSettings();
  const cur = j.statusLine?.command;
  if (on) {
    const keep = ours(cur) ? before(cur) : typeof cur === "string" && cur.trim() ? cur : null;
    if (!ours(cur) && j.statusLine && typeof j.statusLine === "object") writeFileSync(keptFile(), JSON.stringify(j.statusLine), { mode: 0o600 });
    j.statusLine = { type: "command", command: ourCommand() + (keep ? ` --then ${quote(keep)}` : ""), padding: 0 };
  } else if (ours(cur)) {
    const keep = before(cur);
    const kept = readKept();
    if (keep) j.statusLine = kept?.command === keep ? kept : { type: "command", command: keep };
    else delete j.statusLine;
    try { unlinkSync(keptFile()); } catch {}
  }
  writeClaudeSettings(j);
  return statuslineState();
}

// Claude Code's settings file, written whole, then swapped in, so Claude Code never reads half a
// file; the file as it was is kept next to it, once per change. A settings file that is a link
// (kept with your dotfiles) stays a link: the file it points to is the one written.
export function writeClaudeSettings(j: unknown) {
  const file = claudeSettingsFile();
  if (existsSync(file)) copyFileSync(file, `${file}.leanfare-backup`);
  let target = file;
  try { target = realpathSync(file); } catch {}
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.leanfare-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
  renameSync(tmp, target);
}
