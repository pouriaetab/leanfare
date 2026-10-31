// The Claude plan's use, read by itself (0.12, his ask: "as automated as possible"). Leanfare knew the plan's use only
// from Claude Code's status line, which runs only in an open Claude Code session, so a day in Cowork or Claude Desktop
// left the reading days old (it said 9% of the week while the plan was at 92%). Now, while the app runs, Leanfare asks
// Claude Code itself for its usage view (`claude -p "/usage"`) when the last reading is over 45 minutes old: Claude Code
// fetches the numbers with its own sign-in; Leanfare only reads what it prints, and never touches the sign-in (his rule,
// and Anthropic's policy for companion tools).
//
// It must never cost anything: it asks for JSON, and when Claude Code answers through a model (tokens used) or prints
// no usage, Leanfare stops asking until Claude Code's version changes. Its session goes to a folder of Leanfare's own,
// which the report leaves out. Settings: "Read my Claude plan's use through Claude Code" (on at first).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./config";
import { clock, lastSnap, saveSnap, touchSnap, type Snap, type Win } from "./statusline";

export const PROBE_DIR = () => join(DATA_DIR, "meter-probe"); // Claude Code files its session under this folder's name (the report skips it)
export const PROBE_FOLDER_MARK = "meter-probe";
const stateFile = () => join(DATA_DIR, "meter-probe.json");
export const PROBE_AFTER = 45 * 60_000; // a reading older than this is read again
const TIMEOUT = 45_000;

export interface ProbeState { at: number; ok: boolean; why: string; version: string | null; read: Snap | null }
export function probeState(): ProbeState | null { try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return null; } }
function keep(s: ProbeState) { try { writeFileSync(stateFile(), JSON.stringify(s), { mode: 0o600 }); } catch {} }

// Where Claude Code is: LEANFARE_CLAUDE_BIN (tests), the PATH, or where its installer puts it.
export function claudeBin(): string | null {
  if (process.env.LEANFARE_CLAUDE_BIN) return existsSync(process.env.LEANFARE_CLAUDE_BIN) ? process.env.LEANFARE_CLAUDE_BIN : null;
  const home = process.env.HOME || homedir();
  const dirs = [...(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"), join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]) { const p = join(d, n); if (existsSync(p)) return p; }
  }
  return null;
}

function run(bin: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "", done = false;
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // the plan's own sign-in, never an API key's bill
    let child: ReturnType<typeof spawn>;
    try { child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); } catch { resolve({ code: null, out: "" }); return; }
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, TIMEOUT);
    child.stdout?.on("data", (d) => { out += d; if (out.length > 200_000) { try { child.kill(); } catch {} } });
    child.stderr?.on("data", () => {});
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// "Resets 5pm (America/Chicago)" or "Resets Nov 5, 9:30am (...)", as this computer's local time; null when not clear.
export function resetsOf(text: string, now: number): number | null {
  const m = /Resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  let h = Number(m[3]) % 12; if (m[5].toLowerCase() === "pm") h += 12;
  const d = new Date(now);
  if (m[1]) {
    const mon = MONTHS.indexOf(m[1].toLowerCase());
    if (mon < 0) return null;
    const t = new Date(d.getFullYear(), mon, Number(m[2]), h, Number(m[4] ?? 0)).getTime();
    return t < now - 86_400_000 ? new Date(d.getFullYear() + 1, mon, Number(m[2]), h, Number(m[4] ?? 0)).getTime() : t;
  }
  let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, Number(m[4] ?? 0)).getTime();
  if (t <= now) t += 86_400_000;
  return t;
}
// The usage view's two windows: "Current session" and "Current week (all models)", each with "N% used" and when it resets.
export function usageOf(text: string, now: number): Snap | null {
  const win = (head: RegExp): Win | null => {
    const at = text.search(head);
    if (at < 0) return null;
    const part = text.slice(at, at + 400);
    const m = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i.exec(part);
    return m ? { used: Math.min(100, Number(m[1])), resets: resetsOf(part, now) } : null;
  };
  const five = win(/Current session/i), week = win(/Current week \(all models\)|Current week(?! \()/i);
  return five || week ? { at: now, five, week } : null;
}

// Asks Claude Code once. force: even when the last reading is fresh, or an earlier try found it does not work.
export async function probeUsage(opts: { force?: boolean; now?: number } = {}): Promise<ProbeState> {
  const now = opts.now ?? clock();
  const last = lastSnap();
  const before = probeState();
  const bin = claudeBin();
  if (!bin) { const s = { at: now, ok: false, why: "Claude Code is not on this computer", version: null, read: null }; keep(s); return s; }
  const version = (await run(bin, ["--version"], DATA_DIR)).out.trim().slice(0, 60) || null;
  if (!opts.force) {
    if (last && now - last.at < PROBE_AFTER) return before ?? { at: now, ok: true, why: "the last reading is fresh", version, read: last };
    if (before && !before.ok && before.version === version) return before; // it did not work with this version: not again
  }
  try { mkdirSync(PROBE_DIR(), { recursive: true }); } catch {}
  const r = await run(bin, ["-p", "/usage", "--output-format", "json", "--model", "haiku"], PROBE_DIR());
  let text = r.out, tokens = 0, json = false;
  try {
    const j = JSON.parse(r.out);
    json = true;
    text = typeof j?.result === "string" ? j.result : "";
    const u = j?.usage ?? {};
    tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  } catch {}
  let s: ProbeState;
  if (r.code === null) s = { at: now, ok: false, why: "Claude Code did not answer in time", version, read: null };
  else if (tokens > 0) s = { at: now, ok: false, why: "Claude Code answered through a model, which would spend your plan, so Leanfare stopped asking", version, read: null };
  else {
    const read = usageOf(text, now);
    s = read ? { at: now, ok: true, why: `read through Claude Code's usage view${json ? "" : " (as text)"}`, version, read } : { at: now, ok: false, why: "Claude Code's answer had no usage in it", version, read: null };
    if (read && !saveSnap(read)) touchSnap(read);
  }
  keep(s);
  return s;
}

// While the app runs: a look every 15 minutes, which asks only when the reading is old.
let timer: ReturnType<typeof setInterval> | null = null;
export function startUsageProbe(on: () => boolean) {
  if (timer) return;
  const tick = () => { if (on()) probeUsage().catch(() => {}); };
  setTimeout(tick, 60_000);
  timer = setInterval(tick, 15 * 60_000);
  (timer as any).unref?.();
}
