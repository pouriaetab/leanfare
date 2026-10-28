// leanfare statusline: the command Claude Code runs for its status line (the line at the
// bottom of Claude Code). Claude Code hands it a JSON on stdin that holds the plan's two
// windows: rate_limits.five_hour and rate_limits.seven_day, each with the percent used and
// when it resets. This saves a snapshot whenever one of those numbers changes
// (limits.jsonl, for the plan meter in meter.ts) and prints one line, for example
// "5h 42% · week 90% · about 2 llmledger sessions left".
//
// Numbers only: the JSON holds no messages, and only the two windows and the name of the
// folder Claude Code runs in are read. It must be quick, because Claude Code runs it often:
// it reads two small files, writes one line when something changed, and talks to nothing.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";
import { switchedOn } from "./switch";

export interface Win { used: number; resets: number | null } // percent used, 0 to 100; when it resets, epoch ms
export interface Snap { at: number; five: Win | null; week: Win | null }

export const limitsFile = () => join(DATA_DIR, "limits.jsonl");
const lastFile = () => join(DATA_DIR, "limits-last.json");
export const meterCacheFile = () => join(DATA_DIR, "meter-cache.json");

// The clock: the tests set LEANFARE_NOW (this file does not load the rest of the app, to stay quick).
export const clock = () => (process.env.LEANFARE_NOW ? Date.parse(process.env.LEANFARE_NOW) : Date.now());

// resets_at as Claude Code writes it: epoch seconds, epoch milliseconds, or an ISO date.
export function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const winOf = (w: any): Win | null => {
  const used = Number(w?.used_percentage);
  if (w === null || typeof w !== "object" || !Number.isFinite(used)) return null;
  return { used: Math.min(100, Math.max(0, used)), resets: toMs(w.resets_at) };
};

export function snapOf(j: any, at: number): Snap | null {
  const rl = j?.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const five = winOf(rl.five_hour), week = winOf(rl.seven_day);
  return five || week ? { at, five, week } : null;
}

// The same numbers as before: the percent to a tenth, the reset to the minute.
const sameWin = (a: Win | null, b: Win | null) =>
  (!a && !b) || (!!a && !!b && Math.abs(a.used - b.used) < 0.05 && Math.round((a.resets ?? 0) / 60_000) === Math.round((b.resets ?? 0) / 60_000));
export const sameSnap = (a: Snap | null, b: Snap | null) => !!a && !!b && sameWin(a.five, b.five) && sameWin(a.week, b.week);

export function lastSnap(): Snap | null {
  try { return JSON.parse(readFileSync(lastFile(), "utf8")); } catch { return null; }
}

// Saves a snapshot when a number changed. Returns whether it saved one.
export function saveSnap(s: Snap): boolean {
  if (sameSnap(lastSnap(), s)) return false;
  appendFileSync(limitsFile(), JSON.stringify(s) + "\n", { mode: 0o600 });
  writeFileSync(lastFile(), JSON.stringify(s), { mode: 0o600 });
  return true;
}

export function readSnaps(since: number): Snap[] {
  if (!existsSync(limitsFile())) return [];
  const out: Snap[] = [];
  for (const line of readFileSync(limitsFile(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line); if (Number.isFinite(s?.at) && s.at >= since) out.push(s); } catch {} // a damaged line is skipped
  }
  return out.sort((a, b) => a.at - b.at);
}

// What the meter last worked out, for this line: dollars of work one percent holds in each
// window, and each project's typical session in dollars (written by meter.ts).
export interface MeterCache { at: number; k5: number | null; kWeek: number | null; projects: Record<string, number> }
export function readMeterCache(): MeterCache | null {
  try { return JSON.parse(readFileSync(meterCacheFile(), "utf8")); } catch { return null; }
}

const live = (w: Win | null, at: number) => !!w && (w.resets === null || w.resets > at);

export function lineFor(s: Snap | null, cache: MeterCache | null, project: string | null, at: number): string {
  if (!s) return "Leanfare: no plan numbers yet";
  const parts: string[] = [];
  if (s.five && live(s.five, at)) parts.push(`5h ${Math.round(s.five.used)}%`);
  if (s.week && live(s.week, at)) parts.push(`week ${Math.round(s.week.used)}%`);
  const typical = project && cache?.projects?.[project];
  if (typical && typical > 0 && cache) {
    const lefts: number[] = [];
    if (s.five && live(s.five, at) && cache.k5) lefts.push((100 - s.five.used) * cache.k5);
    if (s.week && live(s.week, at) && cache.kWeek) lefts.push((100 - s.week.used) * cache.kWeek);
    if (lefts.length) {
      const n = Math.min(...lefts) / typical;
      parts.push(n >= 1 ? `about ${Math.floor(n)} ${project} session${Math.floor(n) === 1 ? "" : "s"} left` : `under 1 ${project} session left`);
    }
  }
  return parts.length ? parts.join(" · ") : "Leanfare: the plan's windows have reset";
}

const folderOf = (j: any): string | null => {
  const cwd = j?.workspace?.current_dir ?? j?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null : null;
};

// Undoes the quoting setStatusline puts around the status line command it keeps: 'it'\''s' -> it's.
export function unquote(q: string): string {
  let out = "", i = 0;
  while (i < q.length) {
    if (q[i] === "'") { const end = q.indexOf("'", i + 1); if (end < 0) return out + q.slice(i + 1); out += q.slice(i + 1, end); i = end + 1; }
    else if (q[i] === "\\" && i + 1 < q.length) { out += q[i + 1]; i += 2; }
    else { out += q[i]; i++; }
  }
  return out;
}
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function runStatusline(args: string[]): Promise<void> {
  console.log(await statuslineOutput(await Bun.stdin.text(), args));
}

// What the status line shows for one JSON from Claude Code (and saves its snapshot).
export async function statuslineOutput(input: string, args: string[] = []): Promise<string> {
  let j: any = null;
  try { j = JSON.parse(input); } catch {}
  const at = clock();
  const s = j ? snapOf(j, at) : null;
  if (s) { try { saveSnap(s); } catch {} } // a line on screen matters more than the file
  let ours = lineFor(s ?? lastSnap(), readMeterCache(), folderOf(j), at);
  // A status line you already had keeps its place, first: --then '<its command>'.
  const i = args.indexOf("--then");
  if (i >= 0 && args[i + 1]) {
    const theirs = await runTheirs(args[i + 1], input);
    if (theirs) ours = `${theirs} · ${ours}`;
  }
  return ours;
}

// Your own status line command, with the same JSON, given `ms` to finish. It runs in its
// own process group, so at the limit everything it started is stopped with it (a script's
// git or curl too), and Leanfare's line is never held up past the limit. Its first line is used.
export function runTheirs(cmd: string, input: string, ms = 2000): Promise<string> {
  return new Promise((resolve) => {
    let out = "", done = false;
    let child: ReturnType<typeof spawn>;
    try { child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "ignore"], detached: true }); } catch { resolve(""); return; }
    const finish = (late: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (late) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
      child.stdout?.destroy();
      child.unref();
      resolve(out.split("\n")[0].trim());
    };
    const timer = setTimeout(() => finish(true), ms);
    child.stdout!.on("data", (d) => { out += d; });
    child.stdout!.on("close", () => finish(false));
    child.on("error", () => finish(false));
    child.stdin!.on("error", () => {}); // a command that does not read its input
    child.stdin!.end(input);
  });
}

// Claude Code's prompt hook (workers.ts adds it): what Claude is told as each prompt goes, as a fact,
// numbers only (the prompt is never read), from the status line's last reading.
export function hookLine(at = clock()): string {
  if (!switchedOn()) return ""; // switched off: Claude is told nothing about Leanfare
  const s = lastSnap();
  const live = (w: { used: number; resets: number | null } | null | undefined) => (w && (w.resets === null || w.resets > at) ? Math.round(w.used) : null);
  const five = live(s?.five), week = live(s?.week);
  const parts = [five !== null ? `its 5 hour window is ${five}% used` : "", week !== null ? `its week ${week}% used` : ""].filter(Boolean);
  const near = (five ?? 0) >= 85 || (week ?? 0) >= 85;
  return `Leanfare: ${parts.length ? `the Claude plan: ${parts.join(", ")}. ` : ""}Leanfare's plan tool splits a task with several parts across cheaper models${near ? "; near a limit, its delegate and plan_run can do the reading and drafting off the plan" : ""}.`;
}

