// Your plans: the tokens your Claude Code and Codex sessions used, valued at API
// prices, next to what you pay for the plan.
//
// Leanfare reads the usage numbers in the log files those two programs keep on this
// computer, and nothing else: no message text is kept, shown or sent anywhere (each
// line is parsed, the model name, the time and the token counts are taken, and the
// line is dropped). The result is an estimate: the plan has limits and a flat price
// that the logs do not show, and Anthropic gives other apps no remaining limit.
//
// ChatGPT's limits: Codex writes how much of the plan's windows (5 hours, a week) each message had used; that is shown
// as of its last message. Claude's come from Claude Code's status line instead (statusline.ts, meter.ts).
//
// Claude subscriptions are shown, never used: Anthropic's terms (19 Feb 2026) forbid
// other apps from using a Free, Pro or Max login, so Leanfare only counts.
//
// Where the logs are (the same places ccusage reads, so the two agree):
//  - Claude Code: $CLAUDE_CONFIG_DIR/projects (a comma separated list), or
//    ~/.config/claude/projects and ~/.claude/projects. Every *.jsonl inside.
//    Lines with type "assistant" carry message.model and message.usage.
//    The same answer can appear on several lines and in several files (a resumed
//    session copies it), so it is counted once per message id plus request id.
//  - Codex: $CODEX_HOME/sessions (default ~/.codex/sessions) and archived_sessions,
//    rollout-*.jsonl, and rollout-*.jsonl.zst (Codex compresses sessions older than a week).
//    "token_count" events carry running totals for the session; what one event adds is
//    the difference from the one before. The model comes from the last "turn_context".
//
// The other subscriptions (Perplexity, Google AI, GitHub Copilot, Cursor) keep no usage on the
// computer: Leanfare shows their limits as their companies publish them (subscriptions.ts).
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { costOf, fromAnthropicUsage, type Usage } from "./cost";
import { getModel } from "./data";
import { foundApps, usedIn } from "./found";
import { PLAN_KEYS, covers, settings, type Plan, type PlanProvider } from "./settings";
import { lastSnap } from "./statusline";
import { SUBSCRIPTIONS, chatgptPlan, presetLimits } from "./subscriptions";
import { localMonth, now } from "./util";

export const PLAN_PROVIDERS: Record<PlanProvider, { label: string; logs: string | null; example: string }> = Object.fromEntries(
  PLAN_KEYS.map((k) => [k, { label: SUBSCRIPTIONS[k].label, logs: SUBSCRIPTIONS[k].logs, example: SUBSCRIPTIONS[k].presets.at(-1)?.name ?? SUBSCRIPTIONS[k].label }]),
) as Record<PlanProvider, { label: string; logs: string | null; example: string }>;
export const planProviders = PLAN_KEYS;
const LOGGED: PlanProvider[] = ["claude", "chatgpt"]; // the plans whose use is in log files on this computer

// ---- where the logs are ----------------------------------------------------------------------------

export function claudeDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR?.split(",").map((s) => s.trim()).filter(Boolean);
  const roots = env?.length ? env : [join(homedir(), ".config", "claude"), join(homedir(), ".claude")];
  return [...new Set(roots.map((r) => join(r, "projects")))].filter((d) => existsSync(d));
}
export function codexDirs(): string[] {
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return [join(root, "sessions"), join(root, "archived_sessions")].filter((d) => existsSync(d));
}
// Codex's session files: plain, or compressed once they are a week old.
export const isCodexLog = (n: string) => /(^|[\\/])rollout-[^\\/]*\.jsonl(\.zst)?$/.test(n);
const logMatch = (provider: PlanProvider) => (provider === "claude" ? (n: string) => n.endsWith(".jsonl") : isCodexLog);

interface LogFile { path: string; mtime: number; size: number }
function listFiles(dirs: string[], match: (name: string) => boolean, notBefore: number): { files: LogFile[]; folders: number } {
  const files: LogFile[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = readdirSync(dir, { recursive: true }) as string[]; } catch { continue; }
    for (const name of names) {
      if (!match(name)) continue;
      const path = join(dir, name);
      try {
        const s = statSync(path);
        if (s.isFile() && s.mtimeMs >= notBefore) files.push({ path, mtime: s.mtimeMs, size: s.size });
      } catch {}
    }
  }
  // The same session in two places (moved to archived_sessions, or compressed with the plain file
  // still there) counts once: the newest copy of each file name, .zst or not, is kept.
  const one = new Map<string, LogFile>();
  for (const f of files) {
    const k = basename(f.path).replace(/\.zst$/, "");
    const had = one.get(k);
    if (!had || f.mtime > had.mtime) one.set(k, f);
  }
  return { files: match === isCodexLog ? [...one.values()] : files, folders: dirs.length };
}

// ---- reading one log file ----------------------------------------------------------------------------

// One answer: [dedupe key or "", time (ms), model, uncached, cache read, cache write 5 min, cache write 1 hour, output]
type Entry = [string, number, string, number, number, number, number, number];
const TS = 1, MODEL = 2;

async function* linesOf(path: string): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  if (path.endsWith(".zst")) { // a compressed session: small enough to open whole
    const text = dec.decode(Bun.zstdDecompressSync(new Uint8Array(await Bun.file(path).arrayBuffer())));
    for (const line of text.split("\n")) if (line) yield line;
    return;
  }
  for await (const chunk of Bun.file(path).stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function claudeEntry(line: string): Entry | null {
  if (!line.includes('"usage"')) return null; // most lines are not answers: do not even parse them
  let o: any;
  try { o = JSON.parse(line); } catch { return null; } // a half written last line, or damage: skipped
  if (o?.type !== "assistant") return null;
  const m = o.message;
  if (!m || typeof m.model !== "string" || !m.model || m.model.startsWith("<")) return null; // "<synthetic>": an error notice, not an answer
  const u = fromAnthropicUsage(m.usage);
  const ts = Date.parse(o.timestamp);
  if (!u || !Number.isFinite(ts)) return null;
  const cw1 = u.cacheWrite1h ?? 0;
  if (!u.uncached && !u.cacheRead && !u.cacheWrite && !cw1 && !u.output) return null;
  const key = typeof m.id === "string" && typeof o.requestId === "string" ? `${m.id}:${o.requestId}` : "";
  return [key, ts, m.model, u.uncached, u.cacheRead, u.cacheWrite, cw1, u.output];
}

// Codex: the running total at one event (OpenAI style: input_tokens includes the cached ones).
interface Totals { input: number; cached: number; output: number }
const totalsOf = (t: any): Totals | null => (t && typeof t === "object" ? { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens) } : null);

// Codex also writes how much of the plan's limits had been used at each message (rate_limits). Anthropic gives
// nothing like it to other apps, so only the ChatGPT side shows limits, as of the last message in the logs.
export interface Win { used: number; minutes: number | null; resets: number | null } // used: percent; resets: epoch seconds
export interface Limits { at: number; plan: string | null; windows: Win[] }
// resets_at (epoch seconds) since Codex 0.50; before that, resets_in_seconds from the event's time.
const winOf = (w: any, at: number): Win | null => (w && typeof w === "object" && typeof w.used_percent === "number" && Number.isFinite(w.used_percent)
  ? { used: Math.max(0, w.used_percent), minutes: num(w.window_minutes) || null, resets: num(w.resets_at) || (num(w.resets_in_seconds) ? Math.round(at / 1000 + num(w.resets_in_seconds)) : null) }
  : null);
export function limitsOf(rl: any, at: number): Limits | null {
  if (!rl || typeof rl !== "object") return null;
  const windows = [winOf(rl.primary, at), winOf(rl.secondary, at)].filter((w): w is Win => !!w);
  return windows.length ? { at, plan: typeof rl.plan_type === "string" && rl.plan_type ? rl.plan_type : null, windows } : null;
}

// What else a log file says besides the answers: the project folder it ran in (only the folder's own
// name is kept, never the path above it) and, for Codex, how much of the plan each message had used.
export interface FileMeta { project: string | null; snaps: Limits[] }
export const folderName = (cwd: unknown): string | null => (typeof cwd === "string" && cwd.trim() ? cwd.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null : null);

export async function readCodex(path: string, onLimits?: (l: Limits) => void, meta?: FileMeta): Promise<Entry[]> {
  const out: Entry[] = [];
  let model = "unknown";
  let prev: Totals | null = null;
  let limits: Limits | null = null;
  for await (const line of linesOf(path)) {
    const ctx = line.includes('"turn_context"');
    const sess = !ctx && line.includes('"session_meta"');
    if (!ctx && !sess && !line.includes('"token_count"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o?.payload;
    if (sess && o?.type === "session_meta") { if (meta && !meta.project) meta.project = folderName(p?.cwd); continue; }
    if (ctx && o?.type === "turn_context") {
      if (typeof p?.model === "string" && p.model) model = p.model;
      if (meta && !meta.project) meta.project = folderName(p?.cwd);
      continue;
    }
    if (o?.type !== "event_msg" || p?.type !== "token_count" || !p.info) continue;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    const snap = limitsOf(p.rate_limits, ts);
    if (snap) { limits = snap; meta?.snaps.push(snap); }
    const total = totalsOf(p.info.total_token_usage);
    const last = totalsOf(p.info.last_token_usage);
    let d: Totals | null = null;
    if (total && prev && total.input >= prev.input && total.cached >= prev.cached && total.output >= prev.output) d = { input: total.input - prev.input, cached: total.cached - prev.cached, output: total.output - prev.output };
    else d = last ?? total; // the first event, or the count started over
    if (total) prev = total;
    if (!d || (!d.input && !d.output)) continue; // a repeated event adds nothing
    const cached = Math.min(d.cached, d.input);
    out.push(["", ts, model, d.input - cached, cached, 0, 0, d.output]);
  }
  if (limits) onLimits?.(limits);
  return out;
}

export async function readClaude(path: string, meta?: FileMeta): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const line of linesOf(path)) {
    // The folder the session ran in: from the first line that names it (only the folder's own name is kept).
    if (meta && !meta.project && line.includes('"cwd"')) { try { meta.project = folderName(JSON.parse(line)?.cwd); } catch {} }
    const e = claudeEntry(line);
    if (e) out.push(e);
  }
  return out;
}

// What is already read: a file is read again only when its size or time changed.
interface Read { mtime: number; size: number; entries: Entry[]; limits: Limits | null; meta: FileMeta }
const fileCache = new Map<string, Read>();
export const forgetLogs = () => { fileCache.clear(); viewCache.clear(); };

async function entriesOf(f: LogFile, provider: PlanProvider): Promise<Read> {
  const hit = fileCache.get(f.path);
  if (hit && hit.mtime === f.mtime && hit.size === f.size) return hit;
  let entries: Entry[] = [], limits: Limits | null = null;
  const meta: FileMeta = { project: null, snaps: [] };
  try { entries = provider === "claude" ? await readClaude(f.path, meta) : await readCodex(f.path, (l) => { limits = l; }, meta); } catch {} // a file that vanished or cannot be read counts as empty
  const got: Read = { mtime: f.mtime, size: f.size, entries, limits, meta };
  fileCache.set(f.path, got);
  return got;
}

// For the plan meter (meter.ts): every answer since a time, with its file (one session) and that
// session's project folder name, and Codex's snapshots of the plan's windows. One answer counts once.
export interface MeterEntry { ts: number; model: string; u: Usage; file: string; project: string | null }
export async function recentEntries(provider: PlanProvider, since: number): Promise<{ entries: MeterEntry[]; snaps: Limits[]; found: boolean }> {
  const dirs = provider === "claude" ? claudeDirs() : codexDirs();
  const { files } = listFiles(dirs, logMatch(provider), since - 36 * 3600_000);
  const merged = new Map<string, MeterEntry>();
  const loose: MeterEntry[] = [];
  const snaps: Limits[] = [];
  for (const f of files) {
    const got = await entriesOf(f, provider);
    for (const sn of got.meta.snaps) if (sn.at >= since) snaps.push(sn);
    for (const e of got.entries) {
      if (e[TS] < since) continue;
      const me: MeterEntry = { ts: e[TS], model: e[MODEL], u: { uncached: e[3], cacheRead: e[4], cacheWrite: e[5], cacheWrite1h: e[6], output: e[7] }, file: f.path, project: got.meta.project };
      if (!e[0]) { loose.push(me); continue; }
      const old = merged.get(e[0]);
      if (!old) { merged.set(e[0], me); continue; }
      old.u = { uncached: Math.max(old.u.uncached, me.u.uncached), cacheRead: Math.max(old.u.cacheRead, me.u.cacheRead), cacheWrite: Math.max(old.u.cacheWrite, me.u.cacheWrite), cacheWrite1h: Math.max(old.u.cacheWrite1h ?? 0, me.u.cacheWrite1h ?? 0), output: Math.max(old.u.output, me.u.output) };
    }
  }
  snaps.sort((a, b) => a.at - b.at);
  return { entries: [...merged.values(), ...loose].sort((a, b) => a.ts - b.ts), snaps, found: dirs.length > 0 };
}

// ---- the month's numbers ----------------------------------------------------------------------------

export interface ModelRow {
  model: string; label: string; id: string | null; // id: the catalogue model it is priced as; null: no listed price
  input: number; cached: number; output: number; tokens: number; value: number | null;
}
export interface PlanView {
  provider: PlanProvider; label: string; logs: string | null; // logs: the program whose log files hold its use; null: none on this computer
  month: string;
  apps: { name: string; first: string | null; last: string | null; used: boolean }[]; // its apps on this computer (found.ts); used: in this month
  outside: Plan | null; // the plan you entered, when it does not cover this month (then plan is null)
  usageUrl: string | null; // the company's own page for the plan's use
  limitsText: string | null; // the kinds of limits the plan has (subscriptions.ts), for the plan you entered
  recognized: { name: string; price: number | null; from: string } | null; // ChatGPT: the plan Codex says you are on
  found: boolean; files: number; // log folders found, and files read for this month
  plan: { name: string; price: number } | null;
  input: number; cached: number; output: number; tokens: number;
  value: number; unpricedTokens: number;
  ratio: number | null; // value divided by the plan's price
  models: ModelRow[];
  limits: LimitsView | null; // ChatGPT only, this month only: how much of the plan's limits the last Codex message had used
  at: string;
}
export interface LimitsView { at: string; plan: string | null; windows: { label: string; used: number; resets: string | null }[] }
const windowLabel = (m: number | null) => (m === null ? "a limit" : m === 300 ? "5 hour limit" : m === 10080 ? "weekly limit" : m % 1440 === 0 ? `${m / 1440} day limit` : m % 60 === 0 ? `${m / 60} hour limit` : `${m} minute limit`);

// The catalogue model a logged name is priced as. Exact names, with the date stamp
// and the "[1m]" long context marker taken off. Nothing is guessed beyond that.
export function pricedAs(provider: PlanProvider, logged: string): string | null {
  const base = logged.replace(/\[[^\]]*\]$/, "").trim();
  const names = new Set([base, base.replace(/-\d{8}$/, ""), base.replace(/-\d{4}-\d{2}-\d{2}$/, ""), base.replace(/-latest$/, "")]);
  const prefix = provider === "claude" ? "anthropic/" : "openai/";
  for (const n of names) if (getModel(prefix + n)) return prefix + n;
  return null;
}

// Only windows that have not reset since that message: after a reset, the number it showed no longer holds.
function limitsView(l: Limits | null): LimitsView | null {
  if (!l) return null;
  const t = now().getTime() / 1000;
  const windows = l.windows.filter((w) => w.resets === null || w.resets > t)
    .map((w) => ({ label: windowLabel(w.minutes), used: w.used, resets: w.resets === null ? null : new Date(w.resets * 1000).toISOString() }));
  return windows.length ? { at: new Date(l.at).toISOString(), plan: l.plan, windows } : null;
}

const viewCache = new Map<string, { at: number; view: PlanView }>();

// The plan and the ratio come from the settings as they are now, never from when the files were read:
// a plan saved a second ago shows at once, without reading the files again. A plan counts only in the
// months it covers; the apps found on this computer are added the same way.
function withPlan(view: PlanView): PlanView {
  const entered = settings().plans?.[view.provider] ?? null;
  const plan = entered && covers(entered, view.month) ? entered : null;
  const apps = foundApps().filter((a) => a.provider === view.provider).map((a) => ({ name: a.name, first: a.first, last: a.last, used: usedIn(a, view.month) }));
  return { ...view, plan, outside: entered && !plan ? entered : null, apps, ratio: plan && plan.price > 0 ? view.value / plan.price : null, limitsText: plan ? presetLimits(view.provider, plan.name) : null };
}
const FRESH_MS = 30_000;

// Two askers at once (the page and the menu bar) share one reading.
const running = new Map<string, Promise<PlanView>>();
export function planView(provider: PlanProvider, month = localMonth(), force = false): Promise<PlanView> {
  const key = `${provider}:${month}`;
  const hit = viewCache.get(key);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(withPlan(hit.view));
  const going = running.get(key);
  if (going) return going;
  const p = readMonth(provider, month).then(withPlan).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

// A plan with no log files on this computer: its price and its kinds of limits only.
function unlogged(provider: PlanProvider, month: string): PlanView {
  return {
    provider, label: PLAN_PROVIDERS[provider].label, logs: null, month, apps: [], outside: null, usageUrl: SUBSCRIPTIONS[provider].usageUrl, limitsText: null, recognized: null,
    found: false, files: 0, plan: null, input: 0, cached: 0, output: 0, tokens: 0, value: 0, unpricedTokens: 0, ratio: null, models: [], limits: null, at: new Date().toISOString(),
  };
}

async function readMonth(provider: PlanProvider, month: string): Promise<PlanView> {
  if (!LOGGED.includes(provider)) return unlogged(provider, month);
  const [y, mo] = month.split("-").map(Number);
  const monthStart = new Date(y, mo - 1, 1).getTime();
  const notBefore = monthStart - 36 * 3600_000; // a file not touched since before the month began holds nothing from it
  const dirs = provider === "claude" ? claudeDirs() : codexDirs();
  const { files } = listFiles(dirs, logMatch(provider), notBefore);

  // One answer once: the same message in two files (a resumed session) or on two lines (one per block) counts one time, at its largest counts.
  const merged = new Map<string, Entry>();
  const loose: Entry[] = [];
  let newest: Limits | null = null;
  for (const f of files) {
    const got = await entriesOf(f, provider);
    if (got.limits && (!newest || got.limits.at > newest.at)) newest = got.limits;
    for (const e of got.entries) {
      if (localMonth(new Date(e[TS])) !== month) continue;
      if (!e[0]) { loose.push(e); continue; }
      const old = merged.get(e[0]);
      if (!old) merged.set(e[0], [...e] as Entry);
      else for (let i = 3; i <= 7; i++) old[i] = Math.max(old[i] as number, e[i] as number);
    }
  }

  const byModel = new Map<string, { u: Usage }>();
  for (const e of [...merged.values(), ...loose]) {
    const row = byModel.get(e[MODEL]) ?? byModel.set(e[MODEL], { u: { uncached: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 } }).get(e[MODEL])!;
    row.u.uncached += e[3]; row.u.cacheRead += e[4]; row.u.cacheWrite += e[5]; row.u.cacheWrite1h! += e[6]; row.u.output += e[7];
  }
  const models: ModelRow[] = [];
  let value = 0, unpriced = 0;
  for (const [name, { u }] of byModel) {
    const id = pricedAs(provider, name);
    const m = id ? getModel(id) : undefined;
    // A request is priced as a whole, but the log is summed by model: long context prices are not applied to the sum.
    const v = m ? costOf({ ...m, above200k: null }, u) : null;
    const input = u.uncached + u.cacheWrite + (u.cacheWrite1h ?? 0);
    const tokens = input + u.cacheRead + u.output;
    if (v === null) unpriced += tokens; else value += v;
    models.push({ model: name, label: m?.label ?? name, id: m ? id : null, input, cached: u.cacheRead, output: u.output, tokens, value: v });
  }
  models.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.tokens - a.tokens);
  const sum = (k: "input" | "cached" | "output") => models.reduce((n, m) => n + m[k], 0);
  const view: PlanView = {
    provider, label: PLAN_PROVIDERS[provider].label, logs: PLAN_PROVIDERS[provider].logs, month, apps: [], outside: null,
    usageUrl: SUBSCRIPTIONS[provider].usageUrl, limitsText: null,
    recognized: provider === "chatgpt" ? chatgptPlan(newest?.plan ?? null) : null,
    found: dirs.length > 0, files: files.length, plan: null,
    input: sum("input"), cached: sum("cached"), output: sum("output"), tokens: models.reduce((n, m) => n + m.tokens, 0),
    value, unpricedTokens: unpriced,
    ratio: null, // withPlan puts the plan and the ratio in, as the settings are when asked
    models, limits: provider === "chatgpt" && month === localMonth() ? limitsView(newest) : null, at: new Date().toISOString(),
  };
  viewCache.set(`${provider}:${month}`, { at: Date.now(), view });
  return view;
}

// Claude and ChatGPT always (their logs may be here); the others when you entered a plan for them,
// or when one of their apps is on this computer.
export async function plansView(month = localMonth(), force = false) {
  const apps = foundApps(force);
  const wanted = planProviders.filter((p) => LOGGED.includes(p) || settings().plans?.[p] || apps.some((a) => a.provider === p));
  const views = await Promise.all(wanted.map((p) => planView(p, month, force)));
  return { month, providers: views, note: settings().showValue ? NOTE + VALUE_NOTE : NOTE };
}

export const NOTE = "A subscription is measured in its limits and its tokens: Leanfare shows the limits it can read and the tokens in the log files on this computer (only the numbers, never the words). Codex writes how much of its limits each message had used; Claude's two percentages come from Claude Code's status line once Leanfare is in it. Work on other computers or in the apps' own chat windows is not in these logs.";
export const VALUE_NOTE = " What the same use would cost per use is an estimate at the providers' list prices.";

// The plan's two windows as last seen, in percent used, or null: Claude's from Claude Code's status
// line, ChatGPT's from Codex's last message. A window that has reset since says nothing.
export function windowsNow(provider: PlanProvider, view: PlanView | null, at = now().getTime()): { five: number | null; week: number | null } {
  if (provider === "claude") {
    const s = lastSnap();
    const live = (w: { used: number; resets: number | null } | null | undefined) => (w && (w.resets === null || w.resets > at) ? w.used : null);
    return { five: live(s?.five), week: live(s?.week) };
  }
  const ws = view?.limits?.windows.filter((w) => w.resets === null || Date.parse(w.resets) > at) ?? [];
  return { five: ws.find((w) => w.label === "5 hour limit")?.used ?? null, week: ws.find((w) => w.label === "weekly limit")?.used ?? null };
}

// What the Mac menu shows, from what was last worked out. Asking never waits for the log files:
// when the numbers are older than ten minutes (or missing) a new reading starts in the background.
// A plan is told in its limits and tokens; its value at API prices only when Settings says to show it.
const BRIEF_STALE_MS = 10 * 60_000;
export interface Brief { plan: string; price: number; tokens: number; five: number | null; week: number | null; value: number | null; ratio: number | null }
export function plansBrief(): Partial<Record<PlanProvider, Brief>> {
  const out: Partial<Record<PlanProvider, Brief>> = {};
  const month = localMonth();
  const show = settings().showValue;
  for (const p of planProviders) {
    const plan = settings().plans?.[p];
    if (!plan || !covers(plan, month)) continue;
    const hit = viewCache.get(`${p}:${month}`);
    if (!hit || Date.now() - hit.at > BRIEF_STALE_MS) planView(p, month, true).catch(() => {});
    const w = windowsNow(p, hit?.view ?? null);
    const found = !!hit?.view.found;
    if (!found && w.five === null && w.week === null) continue;
    const value = found && show ? hit!.view.value : null;
    out[p] = { plan: plan.name, price: plan.price, tokens: found ? hit!.view.tokens : 0, five: w.five, week: w.week, value, ratio: value !== null && plan.price > 0 ? value / plan.price : null };
  }
  return out;
}
