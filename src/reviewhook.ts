// Claude Code's review hooks (0.12, Settings, In your apps, Plan by itself): Claude reviews each answer Leanfare brings
// back, grades it, and fixes it before it answers you. Two hooks, both Leanfare's own entries in ~/.claude/settings.json:
//
//  - the hand off hook (PostToolUse, on Leanfare's delegate, plan and grade tools) notes which hand offs and plans a
//    session got: their numbers and the session's id, never the words;
//  - the stop hook (Stop) asks Claude once, as it is about to finish, to grade the ones that have no grade yet and to
//    fix what is partly or wrong first. Once per hand off: a hand off it asked about is never asked about again, and
//    while Claude is already doing what a stop hook asked, it lets Claude finish.
//
// Like the other hooks it must never get in the way: anything that goes wrong lets Claude finish. Off in Settings
// (Review every answer), or while Leanfare is switched off, it asks nothing.
import { Database } from "bun:sqlite";
import { paths } from "./config";
import { switchedOn } from "./switch";
import { clock } from "./statusline";
import { compactSessions, hookSettings, noteSession, SESSION_ID, sessionFacts, sessionFile } from "./sessionlog";

export const reviewFile = sessionFile;
const PLAN = /^[\w-]{4,40}$/;
const SHOWN = 6;

// The hand offs a tool's result names: the handoff number delegate and a fix give in their structured result, else
// "hand off N" in the text; and the plan's id, from what plan_run or plan_status was asked, or from the plan tool's
// result (it starts Leanfare's parts itself since 0.13).
export function handoffsIn(input: any): { handoffs: number[]; plan: string | null } {
  const out = new Set<number>();
  let s = "";
  try { s = JSON.stringify(input?.tool_response ?? "") ?? ""; } catch {}
  for (const m of s.matchAll(/\\?"handoff\\?"\s*:\s*(\d{1,9})\b/g)) out.add(Number(m[1]));
  for (const m of s.matchAll(/\bhand off (\d{1,9})\b/gi)) out.add(Number(m[1]));
  const tool = String(input?.tool_name ?? "");
  const made = /__plan$/.test(tool) ? (/\\?"id\\?"\s*:\s*\\?"([\w-]{4,40})\\?"/.exec(s)?.[1] ?? /\bplan's id: ([\w-]{4,40})\b/.exec(s)?.[1] ?? null) : null;
  const id = made ?? input?.tool_input?.id;
  const plan = (made || /__plan_(run|status)$/.test(tool)) && typeof id === "string" && PLAN.test(id) ? id : null;
  return { handoffs: [...out].filter((n) => n > 0), plan };
}

// The hand off hook's whole work, tested on its own: the hand offs and the plan a tool's result names, and a level the
// level tool set for this session (scope chat, the default).
export function noteHandoffs(input: any, now = clock()) {
  const sid = String(input?.session_id ?? "");
  if (!SESSION_ID.test(sid)) return;
  const { handoffs, plan } = handoffsIn(input);
  const set = input?.tool_input?.set, scope = input?.tool_input?.scope;
  const level = /__level$/.test(String(input?.tool_name ?? "")) && Number.isInteger(set) && set >= 1 && set <= 5 && (scope === undefined || scope === "chat") ? set : null;
  noteSession(sid, [...handoffs.map((n): [string, number] => ["h", n]), ...(plan ? [["p", plan] as [string, string]] : []), ...(level ? [["l", level] as [string, number]] : [])], now);
}

const TASK_KIND: Record<string, string> = { longer_query: "read", instruction_following: "write", hard_prompts: "reason" };
const shortModel = (id: string | null) => String(id ?? "a model").replace(/^.*\//, "");
const openDb = (): Database | null => { try { return new Database(paths.db, { readonly: true }); } catch { return null; } };

// What Claude Code is told as it is about to finish, or null to let it finish (the stop hook's whole decision).
export function stopDecision(input: any, now = clock(), open: () => Database | null = openDb): { decision: "block"; reason: string } | null {
  if (input?.stop_hook_active === true) return null; // already doing what a stop hook asked: once is enough
  const sid = String(input?.session_id ?? "");
  const s = sessionFacts(sid, now);
  if (!s || (!s.handoffs.size && !s.plans.size)) return null; // a session with nothing from Leanfare: nothing to open
  if (hookSettings(open).reviewHook === false) return null;
  const d = open();
  if (!d) return null;
  try {
    const rows = new Map<number, any>();
    const ids = [...s.handoffs].filter((n) => !s.asked.has(n));
    if (ids.length)
      for (const r of d.query(`SELECT id, model, rerun, kind, task FROM delegations WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'ok' AND grade IS NULL`).all(...ids) as any[]) rows.set(r.id, r);
    for (const p of s.plans)
      for (const r of d.query("SELECT id, model, rerun, kind, task FROM delegations WHERE substr(plan, 1, ?) = ? AND status = 'ok' AND grade IS NULL").all(p.length + 1, `${p}:`) as any[])
        if (!s.asked.has(r.id)) rows.set(r.id, r);
    const open_ = [...rows.values()].sort((a, b) => a.id - b.id);
    if (!open_.length) return null;
    noteSession(sid, open_.map((r): [string, number] => ["a", r.id]), now);
    compactSessions(now);
    const one = open_.length === 1;
    const list = open_.slice(0, SHOWN).map((r) => `hand off ${r.id} (${shortModel(r.rerun ?? r.model)}, ${r.kind ?? TASK_KIND[r.task] ?? "work"})`).join(", ");
    const more = open_.length > SHOWN ? ` and ${open_.length - SHOWN} more` : "";
    return {
      decision: "block",
      reason: `Leanfare: before you finish, review what Leanfare brought back. ${list[0].toUpperCase()}${list.slice(1)}${more} ${one ? "has" : "have"} no grade yet. `
        + `Check ${one ? "it" : "each"} against its task, grade ${one ? "it" : "each"} with Leanfare's grade tool (good, partly or wrong, with its handoff number), `
        + `and fix anything partly or wrong before your final answer: yourself (fix "myself"), or with fix "leanfare" and why. Leanfare asks this once.`,
    };
  } catch { return null; } finally { try { d.close(); } catch {} }
}

// leanfare hook handoff and leanfare hook stop: the JSON Claude Code sends on stdin; the stop hook's decision on stdout.
export async function runHandoffHook() {
  try { if (switchedOn()) noteHandoffs(JSON.parse(await Bun.stdin.text())); } catch {}
}
export async function runStopHook() {
  try {
    if (!switchedOn()) return;
    const d = stopDecision(JSON.parse(await Bun.stdin.text()));
    if (d) process.stdout.write(JSON.stringify(d) + "\n");
  } catch {} // never in the way
}
