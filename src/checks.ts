// Checks set once per project (0.14, his loop: "running some tests that are cheap and were set in the beginning of the
// project for quality control"): a short list per folder, kept here, shown with every plan made in that folder, and
// used when a plan's parts are back. Three kinds:
//   run: a command the app runs itself (the tests, a scan): Leanfare never runs a command;
//   words: words that must not appear in what comes back: Leanfare scans each answer for them itself, for nothing;
//   look: anything else, which the app checks by reading.
// The app reports what passed with grade (checks), and the loop (planner.ts) sends a part that failed out again.
import { db } from "./db";
import { now } from "./util";

export type CheckKind = "run" | "words" | "look";
export interface Check { n: number; kind: CheckKind; what: string }
export interface CheckResult { passed: number[]; failed: number[]; why: string | null; at: string }
export const MAX_CHECKS = 12;
export const MAX_CHECK = 300; // characters
// A line that starts like a command is one to run.
const RUN_START = /^(bun|npm|npx|pnpm|yarn|node|deno|python3?|pytest|uv|pip|bash|sh|zsh|make|go|cargo|swift|xcodebuild|gradle|mvn|dotnet|ruby|rake|php|composer|tsc|eslint|ruff|mypy|git|\.\/)(\s|$)/;

// The list as the app gives it: lines like "run: bun test", "words: utilize, leverage" or "the page fits one screen".
export function parseChecks(list: unknown): Check[] | string {
  const bad = `checks must be a list of 1 to ${MAX_CHECKS} short lines (at most ${MAX_CHECK} characters each), like "run: bun test", "words: utilize, leverage" or "the Savings page fits one screen".`;
  if (!Array.isArray(list) || !list.length || list.length > MAX_CHECKS) return bad;
  if (list.some((x) => typeof x !== "string" || !x.trim() || x.length > MAX_CHECK || /[\u0000-\u0008\u000b-\u001f]/.test(x))) return bad;
  return (list as string[]).map((raw, i) => {
    const x = raw.trim();
    const m = /^(run|words|look)\s*:\s*([\s\S]+)$/i.exec(x);
    if (m) return { n: i + 1, kind: m[1].toLowerCase() as CheckKind, what: m[2].trim() };
    return { n: i + 1, kind: RUN_START.test(x) ? "run" : "look", what: x };
  });
}

const read = (v: string): Check[] => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } };
export function checksFor(folder: string | null | undefined): Check[] {
  if (!folder) return [];
  const row = db.query("SELECT list FROM checks WHERE folder = ?").get(folder) as { list: string } | null;
  return row ? read(row.list) : [];
}
export function setChecks(folder: string, checks: Check[]): void {
  db.query("INSERT INTO checks(folder, list, set_at) VALUES (?, ?, ?) ON CONFLICT(folder) DO UPDATE SET list = excluded.list, set_at = excluded.set_at").run(folder, JSON.stringify(checks), now().toISOString());
}
export function removeChecks(folder: string): boolean { return db.query("DELETE FROM checks WHERE folder = ?").run(folder).changes > 0; }
export function allChecks(): { folder: string; checks: Check[]; set: string }[] {
  return (db.query("SELECT folder, list, set_at FROM checks ORDER BY set_at DESC").all() as { folder: string; list: string; set_at: string }[]).map((r) => ({ folder: r.folder, checks: read(r.list), set: r.set_at }));
}

export const checkText = (c: Pick<Check, "kind" | "what">) => (c.kind === "run" ? `run ${c.what}` : c.kind === "words" ? `none of these in what comes back: ${c.what}` : c.what);
export const checksLine = (checks: Check[]) => checks.map((c) => `${c.n}. ${checkText(c)}`).join("; ");

// The words of the project's words checks that an answer holds, each once, as the list writes them.
export function wordsFound(checks: Check[], text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const c of checks.filter((x) => x.kind === "words")) {
    for (const w of c.what.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}($|[^\\p{L}\\p{N}])`, "iu");
      if (re.test(text) && !out.includes(w)) out.push(w);
    }
  }
  return out;
}

// What the app reported, checked against the list: numbers on it only, each once, none both passed and failed.
export function checkResult(checks: Check[], b: any): CheckResult | string {
  const nums = (x: unknown) => (Array.isArray(x) ? x : x === undefined ? [] : null);
  const passed = nums(b?.passed), failed = nums(b?.failed);
  if (!passed || !failed) return "checks takes passed and failed: lists of the checks' numbers.";
  const known = new Set(checks.map((c) => c.n));
  for (const n of [...passed, ...failed]) if (!Number.isInteger(n) || !known.has(n as number)) return `There is no check ${n} in this project's list (${checks.length ? `1 to ${checks.length}` : "it has none"}).`;
  if (passed.some((n) => failed.includes(n))) return "A check cannot both pass and fail.";
  const why = typeof b?.why === "string" && b.why.trim() ? b.why.trim().slice(0, 500) : null;
  return { passed: [...new Set(passed as number[])].sort((a, z) => a - z), failed: [...new Set(failed as number[])].sort((a, z) => a - z), why, at: now().toISOString() };
}
