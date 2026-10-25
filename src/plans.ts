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
//  - Codex: $CODEX_HOME/sessions (default ~/.codex/sessions), rollout-*.jsonl.
//    "token_count" events carry running totals for the session; what one event adds is
//    the difference from the one before. The model comes from the last "turn_context".
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { costOf, fromAnthropicUsage, type Usage } from "./cost";
import { getModel } from "./data";
import { PLAN_KEYS, settings, type PlanProvider } from "./settings";
import { localMonth, now } from "./util";

export const PLAN_PROVIDERS: Record<PlanProvider, { label: string; logs: string; example: string }> = {
  claude: { label: "Claude", logs: "Claude Code", example: "Claude Max" },
  chatgpt: { label: "ChatGPT", logs: "Codex", example: "ChatGPT Plus" },
};
export const planProviders = PLAN_KEYS;

// ---- where the logs are ----------------------------------------------------------------------------

export function claudeDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR?.split(",").map((s) => s.trim()).filter(Boolean);
  const roots = env?.length ? env : [join(homedir(), ".config", "claude"), join(homedir(), ".claude")];
  return [...new Set(roots.map((r) => join(r, "projects")))].filter((d) => existsSync(d));
}
export function codexDirs(): string[] {
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const d = join(root, "sessions");
  return existsSync(d) ? [d] : [];
}

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
  return { files, folders: dirs.length };
}

// ---- reading one log file ----------------------------------------------------------------------------

// One answer: [dedupe key or "", time (ms), model, uncached, cache read, cache write 5 min, cache write 1 hour, output]
type Entry = [string, number, string, number, number, number, number, number];
const TS = 1, MODEL = 2;

async function* linesOf(path: string): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
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
const winOf = (w: any): Win | null => (w && typeof w === "object" && typeof w.used_percent === "number" && Number.isFinite(w.used_percent) ? { used: Math.max(0, w.used_percent), minutes: num(w.window_minutes) || null, resets: num(w.resets_at) || null } : null);
export function limitsOf(rl: any, at: number): Limits | null {
  if (!rl || typeof rl !== "object") return null;
  const windows = [winOf(rl.primary), winOf(rl.secondary)].filter((w): w is Win => !!w);
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
  const { files } = listFiles(dirs, provider === "claude" ? (n) => n.endsWith(".jsonl") : (n) => /(^|\/)rollout-[^/]*\.jsonl$/.test(n), since - 36 * 3600_000);
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
  provider: PlanProvider; label: string; logs: string;
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
// a plan saved a second ago shows at once, without reading the files again.
function withPlan(view: PlanView): PlanView {
  const plan = settings().plans?.[view.provider] ?? null;
  return { ...view, plan, ratio: plan && plan.price > 0 ? view.value / plan.price : null };
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

async function readMonth(provider: PlanProvider, month: string): Promise<PlanView> {
  const [y, mo] = month.split("-").map(Number);
  const monthStart = new Date(y, mo - 1, 1).getTime();
  const notBefore = monthStart - 36 * 3600_000; // a file not touched since before the month began holds nothing from it
  const dirs = provider === "claude" ? claudeDirs() : codexDirs();
  const { files } = listFiles(dirs, provider === "claude" ? (n) => n.endsWith(".jsonl") : (n) => /(^|\/)rollout-[^/]*\.jsonl$/.test(n), notBefore);

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
  const plan = settings().plans?.[provider] ?? null;
  const sum = (k: "input" | "cached" | "output") => models.reduce((n, m) => n + m[k], 0);
  const view: PlanView = {
    provider, label: PLAN_PROVIDERS[provider].label, logs: PLAN_PROVIDERS[provider].logs,
    found: dirs.length > 0, files: files.length, plan,
    input: sum("input"), cached: sum("cached"), output: sum("output"), tokens: models.reduce((n, m) => n + m.tokens, 0),
    value, unpricedTokens: unpriced,
    ratio: plan && plan.price > 0 ? value / plan.price : null,
    models, limits: provider === "chatgpt" && month === localMonth() ? limitsView(newest) : null, at: new Date().toISOString(),
  };
  viewCache.set(`${provider}:${month}`, { at: Date.now(), view });
  return view;
}

export async function plansView(month = localMonth(), force = false) {
  const views = await Promise.all(planProviders.map((p) => planView(p, month, force)));
  return { month, providers: views, note: NOTE };
}

export const NOTE = "An estimate from the usage numbers in the log files on this computer, at the providers' list prices for the same tokens. Your plan has a flat price and its own limits. Codex writes how much of its limits each message had used, so ChatGPT shows that, as of its last message; Claude's limits show once Leanfare is in Claude Code's status line (the button above), which hands it the two percentages. Work done on other computers or in the apps' own chat windows is not in these logs.";

// What the Mac menu shows, from what was last worked out. Asking never waits for the log files:
// when the numbers are older than ten minutes (or missing) a new reading starts in the background.
const BRIEF_STALE_MS = 10 * 60_000;
export interface Brief { plan: string; price: number; value: number; ratio: number | null }
export function plansBrief(): Partial<Record<PlanProvider, Brief>> {
  const out: Partial<Record<PlanProvider, Brief>> = {};
  const month = localMonth();
  for (const p of planProviders) {
    const plan = settings().plans?.[p];
    if (!plan) continue;
    const hit = viewCache.get(`${p}:${month}`);
    if (!hit || Date.now() - hit.at > BRIEF_STALE_MS) planView(p, month, true).catch(() => {});
    if (hit && hit.view.found) out[p] = { plan: plan.name, price: plan.price, value: hit.view.value, ratio: plan.price > 0 ? hit.view.value / plan.price : null };
  }
  return out;
}
