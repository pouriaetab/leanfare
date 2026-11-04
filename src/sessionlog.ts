// What Leanfare notes about each Claude Code session (0.12), from its hooks: the hand offs and plans it got, which of
// them the stop hook asked about, the level set for it, and that a prompt went. The session's id and numbers only,
// never the words. One line per fact, appended (several hooks of one turn may write at once). A session's facts are
// read for two days; eight are kept (0.13.8), so the check of an app that hands nothing off sees a week (silentapp.ts).
//
//   <when>\t<session>\t<what>\t<value>   what: h a hand off, p a plan, a asked about, l a level, s a prompt
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "./config";

export const sessionFile = () => join(dirname(paths.db), "review.log");
export const SESSION_ID = /^[\w-]{1,100}$/;
const KEEP = 2 * 86_400_000;
const HELD = 8 * 86_400_000; // what the file keeps
const BIG = 512 * 1024; // past this the file keeps its last two days only

export function noteSession(sid: string, facts: [string, string | number][], now: number) {
  if (!SESSION_ID.test(sid) || !facts.length) return;
  try { appendFileSync(sessionFile(), facts.map(([w, v]) => `${now}\t${sid}\t${w}\t${v}\n`).join(""), { mode: 0o600 }); } catch {}
}

export interface SessionFacts { handoffs: Set<number>; plans: Set<string>; asked: Set<number>; level: number | null; prompts: number; promptAt: number | null; plannedAt: number | null; gatedAt: number | null } // 0.14.1: when the last prompt went, the last plan was called, and the plan first reminder was last given
export function sessionFacts(sid: string, now: number): SessionFacts | null {
  if (!SESSION_ID.test(sid)) return null;
  let text = "";
  try { text = readFileSync(sessionFile(), "utf8"); } catch { return null; }
  const s: SessionFacts = { handoffs: new Set(), plans: new Set(), asked: new Set(), level: null, prompts: 0, promptAt: null, plannedAt: null, gatedAt: null };
  let seen = false;
  for (const line of text.split("\n")) {
    const [t, id, what, v] = line.split("\t");
    if (id !== sid || !(now - Number(t) < KEEP) || v === undefined) continue;
    seen = true;
    if (what === "h") s.handoffs.add(Number(v));
    else if (what === "p") { s.plans.add(v); s.plannedAt = Math.max(s.plannedAt ?? 0, Number(t)); }
    else if (what === "g") s.gatedAt = Math.max(s.gatedAt ?? 0, Number(t));
    else if (what === "a") s.asked.add(Number(v));
    else if (what === "l") { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 5) s.level = n; } // the last one set
    else if (what === "s") { s.prompts++; s.promptAt = Math.max(s.promptAt ?? 0, Number(t)); }
  }
  return seen ? s : null;
}

// The sessions that Leanfare's prompt line reached since a time (0.13.8): the prompt hook notes each prompt it adds to.
export function heardSessions(since: number): Set<string> {
  const out = new Set<string>();
  let text = "";
  try { text = readFileSync(sessionFile(), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const [t, id, what] = line.split("\t");
    if (what === "s" && id && Number(t) >= since) out.add(id);
  }
  return out;
}

export function compactSessions(now: number) {
  try {
    if (statSync(sessionFile()).size < BIG) return;
    const keep = readFileSync(sessionFile(), "utf8").split("\n").filter((l) => l && now - Number(l.split("\t")[0]) < HELD);
    const tmp = `${sessionFile()}.${process.pid}`;
    writeFileSync(tmp, keep.map((l) => l + "\n").join(""), { mode: 0o600 });
    renameSync(tmp, sessionFile());
  } catch {}
}

// Leanfare's settings as a hook reads them: straight from the database, read only (a hook runs on its own, for a
// moment, while the app may be writing). Empty when they cannot be read: the defaults then.
export function hookSettings(open: () => Database | null = () => { try { return new Database(paths.db, { readonly: true }); } catch { return null; } }): Record<string, any> {
  const d = open();
  if (!d) return {};
  try {
    const st = d.query("SELECT v FROM settings WHERE k = 'settings'").get() as { v: string } | null;
    const j = st ? JSON.parse(st.v) : {};
    return j && typeof j === "object" ? j : {};
  } catch { return {}; } finally { try { d.close(); } catch {} }
}
