// The level (0.12): one number from 1 to 5, with a name, for how much Leanfare takes first. Set once in Leanfare for
// every app and new chat (Settings), per app, or for one chat or Claude Code session (the level tool). Raised when
// your Claude plan runs low (Settings: at least 4 when low, 5 when very low), unless a chat or session set its own.
//
// What a level changes: what the app is told (Claude Code's prompt hook, the level tool, the rules Leanfare writes
// into the apps), when Claude Code is reminded before it reads a file itself, which parts a plan sends out, and how
// many answers a stronger model checks. Nothing is ever stopped: a lower level only asks less of Leanfare.
import type { ModeView } from "./modes";

export type Level = 1 | 2 | 3 | 4 | 5;
export const LEVELS: Level[] = [1, 2, 3, 4, 5];
export const DEFAULT_LEVEL: Level = 3;
export const LEVEL_NAME: Record<Level, string> = { 1: "Off", 2: "Light", 3: "More", 4: "Most", 5: "All it can" };
// For the app, in the second person (the level tool and the prompt hook) and for you (Settings).
export const LEVEL_MEANS: Record<Level, string> = {
  1: "Leanfare waits until the user or you ask for it.",
  2: "Only big reads (about 40 KB of logs or docs, 200 KB of anything else, or more than 5 files) and tasks with several parts go to Leanfare.",
  3: "Reads over about 10 KB that you will not change, project wide searches, summaries, reviews and first drafts go to Leanfare first; you keep decisions, changes to files and the final answer.",
  4: "Every prompt that is more than a quick question is planned with Leanfare's plan tool first, and each part goes where the plan says.",
  5: "Every part a model the user ticked can do goes to Leanfare; you review, decide, change files and answer.",
};
// For you, in Settings: what each level does in your apps.
export const LEVEL_SAYS: Record<Level, string> = {
  1: "Leanfare waits until you or your app ask for it.",
  2: "Only big reads (long logs, docs, many files) and tasks with many parts.",
  3: "Reads over 10 KB, project wide searches, summaries, reviews and first drafts go first. Your app keeps decisions, file changes and the answer.",
  4: "Every prompt is planned first; each part goes to the cheapest model that does it well.",
  5: "Every part a model you ticked can do goes out; your app reviews, decides and answers.",
};
export const isLevel = (n: unknown): n is Level => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5;
export const levelText = (n: Level) => `${n} (${LEVEL_NAME[n]})`;

// The apps a level can be set for, by the name the MCP door gives them (mcp.ts: clientLabel).
export const APP_LEVELS: Record<string, string> = { "claude-code": "Claude Code", claude: "Claude Desktop and Cowork", codex: "Codex", "gemini-cli": "Gemini CLI", cursor: "Cursor" };
export function appKey(app: string | null | undefined): string | null {
  if (!app) return null;
  if (/^claude code$/i.test(app)) return "claude-code";
  if (/^(claude|cowork)$/i.test(app)) return "claude";
  if (/^codex$/i.test(app)) return "codex";
  if (/^gemini cli$/i.test(app)) return "gemini-cli";
  if (/^cursor$/i.test(app)) return "cursor";
  return null;
}
const CLAUDE = /claude|cowork/i;

export interface LevelView {
  level: Level; // the one in effect
  base: Level; // before raising
  from: "chat" | "app" | "default";
  raised: string | null; // why it was raised, in words
}
// The level for an app: a chat's or session's own first, else the app's, else the default; then, for a Claude app
// while "Raise it when my Claude plan runs low" is on, at least 4 when the plan is low and 5 when very low (never a
// level a chat set). s: Leanfare's settings (or what a hook could read of them).
export function levelFor(s: { level?: unknown; levels?: unknown; raiseWhenLow?: unknown }, app: string | null, chat: unknown = null, mode: ModeView | null = null): LevelView {
  const levels = s.levels && typeof s.levels === "object" ? (s.levels as Record<string, unknown>) : {};
  const key = appKey(app);
  const own = key ? levels[key] : undefined;
  const from: LevelView["from"] = isLevel(chat) ? "chat" : isLevel(own) ? "app" : "default";
  const base: Level = isLevel(chat) ? chat : isLevel(own) ? own : isLevel(s.level) ? s.level : DEFAULT_LEVEL;
  if (from === "chat" || s.raiseWhenLow === false || !mode || mode.mode === "plenty" || (app !== null && !CLAUDE.test(app))) return { level: base, base, from, raised: null };
  const floor: Level = mode.mode === "very low" ? 5 : 4;
  return floor > base ? { level: floor, base, from, raised: `raised from ${base}: ${mode.why}` } : { level: base, base, from, raised: null };
}

// Claude Code's read hook (readhook.ts): when a file it is about to read is big enough for a reminder, by level.
export const LEVEL_READ: Record<Level, { data: number; other: number } | null> = {
  1: null, 2: { data: 40 * 1024, other: 200 * 1024 }, 3: { data: 10 * 1024, other: 50 * 1024 }, 4: { data: 8 * 1024, other: 32 * 1024 }, 5: { data: 4 * 1024, other: 16 * 1024 },
};
// The share of answers a stronger model checks with checks on auto (delegate.ts), by level and effort.
export const LEVEL_CHECKS: Record<Level, Record<"low" | "medium" | "high", number>> = {
  1: { low: 0.1, medium: 0.25, high: 1 }, 2: { low: 0.1, medium: 0.25, high: 1 }, 3: { low: 0.25, medium: 0.5, high: 1 }, 4: { low: 1, medium: 1, high: 1 }, 5: { low: 1, medium: 1, high: 1 },
};

// What the app is told as each prompt goes (Claude Code's prompt hook) or when it asks (the level tool).
export function levelAdvice(v: LevelView, where: "session" | "chat"): string {
  const raised = v.raised ? ` (${v.raised})` : "";
  const head = `Leanfare: level ${levelText(v.level)} in this ${where}${raised}.`;
  const tail = v.level === 1 ? "" : ` Pass level ${v.level} to delegate and plan.`;
  const what: Record<Level, string> = {
    1: "Use Leanfare only when the user asks for it.",
    2: "Hand big reads you will not change (about 40 KB of logs or docs, 200 KB of anything else, or more than 5 files) to Leanfare's delegate, and plan tasks with several parts with Leanfare's plan.",
    3: "Hand reading over about 10 KB that you will not change, project wide searches, summaries, reviews and first drafts to Leanfare first (delegate, or plan for several parts); keep decisions, changes to files and the final answer.",
    4: "Call Leanfare's plan tool first for each prompt that is more than a quick question, and follow its table; hand reading, searching, summaries, reviews and drafts to Leanfare.",
    5: "Plan each prompt with Leanfare and hand every part a model can do to it (delegate, or plan_run); keep only decisions, changes to files and your final answer, and tell the user before any big job.",
  };
  return `${head} ${what[v.level]}${tail}`;
}
