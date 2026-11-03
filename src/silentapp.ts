// When Claude Code hands nothing to Leanfare (0.13.8). Claude Code's own files show its prompts (numbers only), so
// Leanfare can say why none came:
//  - its line never reached Claude Code: no session heard the level (the prompt hook is not in Claude Code's settings,
//    nor the Leanfare plugin's), so Claude Code was never told to hand anything off;
//  - Claude Code heard the level but never opened Leanfare's tools (the MCP door is not connected there);
//  - it had both and still handed nothing off.
// Checked over the last 7 days, and never from before this version first looked (what it counts was not noted
// earlier); quiet until a day has passed and 10 prompts have gone. One notice, which × hides until what it says changes.
import { db, getSetting, putSetting } from "./db";
import { levelFor } from "./level";
import { planMode } from "./modes";
import { recentPrompts } from "./plans";
import { sessionOf } from "./report";
import { heardSessions } from "./sessionlog";
import { settings } from "./settings";
import { switchedOn } from "./switch";
import { now } from "./util";

const DAY = 86_400_000;
export const SILENT_DAYS = 7;
export const SILENT_MIN = 10; // prompts before it says anything
const EVERY = 10 * 60_000; // the notice's check, at most this often
const SINCE = "silentSince", HIDDEN = "silentHidden";
const APP = "Claude Code";

export type SilentWhy = "line" | "tools" | "chose";
export interface Silent { app: string; prompts: number; sessions: number; heard: number; opened: boolean; why: SilentWhy; text: string; key: string }

// An app opened Leanfare's tools (the MCP door's hello, server.ts).
export function noteDoor(app: unknown, at = now()) {
  if (typeof app !== "string" || !app.trim()) return;
  const name = app.replace(/[^\w .-]/g, "").trim().slice(0, 40), iso = at.toISOString();
  if (name) db.query("INSERT INTO doors(app, first, last, opens) VALUES (?, ?, ?, 1) ON CONFLICT(app) DO UPDATE SET last = excluded.last, opens = opens + 1").run(name, iso, iso);
}

export async function silentCheck(at = now().getTime()): Promise<Silent | null> {
  if (!switchedOn()) return null; // switched off: the apps are not told about Leanfare
  if (levelFor(settings(), APP, null, planMode(at)).level === 1) return null; // Off: Claude Code hands off only when asked
  let since = getSetting<number | null>(SINCE, null);
  if (typeof since !== "number") { since = at; putSetting(SINCE, at); }
  const from = Math.max(at - SILENT_DAYS * DAY, since);
  if (at - from < DAY) return null;
  const prompts = (await recentPrompts(from)).filter((p) => p.ts >= from && p.ts <= at);
  if (prompts.length < SILENT_MIN) return null;
  const fromIso = new Date(from).toISOString();
  const handed = db.query("SELECT COUNT(*) AS n FROM delegations WHERE app = ? AND ts >= ?").get(APP, fromIso) as { n: number };
  if (handed.n) return null;
  const sessions = new Set(prompts.map((p) => sessionOf(p.file)));
  const reached = heardSessions(from);
  const heard = [...sessions].filter((s) => reached.has(s)).length;
  const door = db.query("SELECT last FROM doors WHERE app = ?").get(APP) as { last: string } | null;
  const opened = !!door && door.last >= fromIso;
  const days = Math.min(SILENT_DAYS, Math.floor((at - from) / DAY));
  const span = days >= SILENT_DAYS ? `the last ${SILENT_DAYS} days` : `the last ${days} day${days === 1 ? "" : "s"}`;
  const n = prompts.length;
  const why: SilentWhy = !heard ? "line" : !opened ? "tools" : "chose";
  const text = why === "line"
    ? `Claude Code ran ${n} prompts in ${span} and handed nothing to Leanfare: Leanfare's line never reached it, so it was never told the level. Turn Claude Code on in Settings, In your apps (or turn on the Leanfare plugin in Claude Code), then start a new Claude Code session.`
    : why === "tools"
      ? `Claude Code ran ${n} prompts in ${span} and handed nothing to Leanfare: it heard the level in ${heard} of its ${sessions.size} sessions but never opened Leanfare's tools. In Claude Code, type /mcp: if leanfare is not connected there, connect it in Settings, In your apps, then start a new session.`
      : `Claude Code ran ${n} prompts in ${span}, heard the level and had Leanfare's tools, but handed nothing off. Ask it in a prompt to use Leanfare, or raise the level.`;
  return { app: APP, prompts: n, sessions: sessions.size, heard, opened, why, text, key: `${APP}|${why}` };
}

// The notice (server.ts): the last check's, started again in the background once it is 10 minutes old.
let last: { at: number; s: Silent | null } | null = null;
let running: Promise<void> | null = null;
let round = 0; // a check started before forgetSilent writes nothing
export function forgetSilent() { last = null; running = null; round++; }
export function silentNow(at = now().getTime()): Promise<void> {
  const r = round;
  running ??= silentCheck(at).then((s) => { if (r === round) last = { at, s }; }, () => { if (r === round) last = { at, s: null }; }).finally(() => { if (r === round) running = null; });
  return running;
}
export function silentNotice(at = now().getTime()): { kind: "silent"; level: "info"; provider: string; text: string } | null {
  if (!last || at - last.at >= EVERY) void silentNow(at);
  const s = last?.s;
  if (!s || getSetting<string | null>(HIDDEN, null) === s.key) return null;
  return { kind: "silent", level: "info", provider: s.app, text: s.text };
}
export function hideSilent() { if (last?.s) putSetting(HIDDEN, last.s.key); }
