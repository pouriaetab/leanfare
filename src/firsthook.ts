// Plan first, in every app that lets Leanfare hook in (0.14.1). A line on the page is not enough: at level 4 Claude Code
// heard "make Leanfare's plan tool your first tool call" on 63 prompts in a week and called it on none (level.ts). So at
// levels 4 and 5 the first tool call of a prompt that is not Leanfare's plan is turned back once, with the reason, and
// the next one goes through: one nudge a prompt, never a wall. A quick question uses no tool and meets nothing.
//
// The apps, and how each takes it:
//   Claude Code: PreToolUse (hookSpecificOutput, permissionDecision deny); the prompt hook already says the level;
//   Codex: UserPromptSubmit (its output joins the prompt) and PreToolUse on its shell (the same answer as Claude Code's);
//   Gemini CLI: BeforeAgent (hookSpecificOutput.additionalContext) and BeforeTool ({decision: "deny", reason});
//   Cursor: beforeShellExecution and beforeMCPExecution ({permission: "deny", agent_message}); it has no way to add to a
//   prompt, so its line goes with the reminder.
import { levelAdvice, levelFor, levelText, type Level } from "./level";
import { planMode } from "./modes";
import { hookSettings, noteSession, sessionFacts } from "./sessionlog";
import { clock } from "./statusline";
import { switchedOn } from "./switch";

export type HookApp = "claude-code" | "codex" | "gemini-cli" | "cursor";
export const APP_NAME: Record<HookApp, string> = { "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", cursor: "Cursor" };
export const isHookApp = (x: unknown): x is HookApp => typeof x === "string" && Object.hasOwn(APP_NAME, x);
// Claude Code's own tools that start real work (Leanfare's tools, ToolSearch and the task list are never turned back).
export const FIRST_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "Agent", "WebFetch", "WebSearch", "LS"];
export const FIRST_MATCHER = `^(${FIRST_TOOLS.join("|")})$|leanfare__plan$`;
// Leanfare's own tools, as each app may name them (mcp__leanfare__plan, leanfare__plan, mcp_leanfare_plan, or plain).
const OURS = /(^|__|_|\.)leanfare(__|_|\.)|^(plan|plan_run|plan_status|plan_stop|delegate|ask|grade|level|report|spend|models|estimate|trial|local_model|live)$/i;
const PLAN = /(leanfare(__|_|\.))?plan$/i;
// Tools that only look things up or keep the task list: never turned back.
const QUIET = /^(ToolSearch|Skill|TaskCreate|TaskUpdate|TaskList|TaskGet|TodoWrite|AskUserQuestion|SendUserMessage|ExitPlanMode|EnterPlanMode)$/;

const nameOf = (input: any): string => String(input?.tool_name ?? input?.toolName ?? (input?.command !== undefined ? "Shell" : input?.server ? `mcp:${input.server}` : ""));
const isPlan = (input: any) => { const t = nameOf(input); return PLAN.test(t) && (OURS.test(t) || t === "plan") || (input?.server && /leanfare/i.test(String(input.server)) && /^plan$/i.test(String(input?.tool_name ?? input?.tool ?? ""))); };
const isOurs = (input: any) => OURS.test(nameOf(input)) || (!!input?.server && /leanfare/i.test(String(input.server)));

export const FIRST_WORDS = (level: Level) => `Leanfare: level ${levelText(level)} in this session, so plan first: call Leanfare's plan tool (its name ends in leanfare__plan)${level === 4 ? " with your own split in parts" : ", and Leanfare makes the split"}, then follow its table; it starts Leanfare's parts by itself. If this prompt is a quick question, go on: this call goes through when you make it again.`;

// What the app is told before a tool call, or null to let it through (the whole decision; tested on its own).
export function firstReminder(input: any, app: HookApp = "claude-code", now = clock(), set: Record<string, any> | null = null): string | null {
  const sid = String(input?.session_id ?? input?.conversation_id ?? "");
  if (!sid) return null;
  if (isPlan(input)) { noteSession(sid, [["p", "first"]], now); return null; } // the plan: what comes after it goes through
  if (isOurs(input) || QUIET.test(nameOf(input))) return null;
  const facts = sessionFacts(sid, now);
  // Cursor sends no prompt hook: its prompt is the time since the last reminder or plan, an hour at most.
  const promptAt = app === "cursor" ? Math.max(facts?.plannedAt ?? 0, facts?.gatedAt ?? 0, now - 3_600_000) + 1 : facts?.promptAt ?? null;
  if (!promptAt) return null; // no prompt seen (its hook is off): nothing to time against
  const level = levelFor(set ?? hookSettings(), APP_NAME[app], facts?.level ?? null, planMode(now)).level;
  if (level < 4) return null;
  if ((facts?.plannedAt ?? 0) >= promptAt || (facts?.gatedAt ?? 0) >= promptAt) return null;
  noteSession(sid, [["g", 1]], now);
  return FIRST_WORDS(level);
}

// The line an app other than Claude Code hears with each prompt (Claude Code's is statusline.ts hookLine).
export function promptLine(input: any, app: HookApp, now = clock(), set: Record<string, any> | null = null): string {
  if (!switchedOn()) return "";
  const sid = String(input?.session_id ?? input?.conversation_id ?? "");
  const facts = sid ? sessionFacts(sid, now) : null;
  const v = levelFor(set ?? hookSettings(), APP_NAME[app], facts?.level ?? null, planMode(now));
  if (sid) noteSession(sid, [["s", 1]], now);
  return levelAdvice(v, "session");
}

// What each app reads back from a hook: a denial with the reason, or the prompt's added line.
export function denyOutput(app: HookApp, why: string): unknown {
  if (app === "gemini-cli") return { decision: "deny", reason: why };
  if (app === "cursor") return { permission: "deny", agent_message: why, user_message: "Leanfare asked your agent to plan first (level 4 or 5)." };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
}
export function lineOutput(app: HookApp, line: string): string {
  if (app === "gemini-cli") return JSON.stringify({ hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: line } });
  return line; // Codex adds plain output to the prompt, as Claude Code does
}

// leanfare hook first --app <app>: the JSON the app sends on stdin; a denial on stdout, or nothing (Cursor: an allow).
export async function runFirstHook(app: HookApp) {
  try {
    if (!switchedOn()) { if (app === "cursor") process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n"); return; }
    const why = firstReminder(JSON.parse(await Bun.stdin.text()), app);
    if (why) process.stdout.write(JSON.stringify(denyOutput(app, why)) + "\n");
    else if (app === "cursor") process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n");
  } catch { if (app === "cursor") process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n"); } // never in the way
}
export async function runPromptHook(app: HookApp) {
  try {
    let input: any = null;
    if (!process.stdin.isTTY) { try { input = JSON.parse(await Bun.stdin.text()); } catch {} }
    const line = promptLine(input, app);
    if (line) process.stdout.write(lineOutput(app, line) + "\n");
  } catch {}
}
