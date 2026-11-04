// Plan by itself, in the apps that let Leanfare add to them on purpose: the line that has the app
// call Leanfare's plan for a task with several parts, and in Claude Code also a worker (a subagent:
// a helper thread Claude Code runs, several at once, each on its own) and a prompt hook (a command
// Claude Code runs as you send each prompt) that says how much of your Claude plan is left.
//
//  - Claude Code: ~/.claude/agents/leanfare-worker.md, a block in ~/.claude/CLAUDE.md, and an entry
//    in hooks.UserPromptSubmit in ~/.claude/settings.json (CLAUDE_CONFIG_DIR's when that is set);
//  - Codex: a block in ~/.codex/AGENTS.md (CODEX_HOME's);
//  - Gemini CLI: a block in ~/.gemini/GEMINI.md.
// Leanfare adds and takes out only its own: the worker file it wrote, the block between its two
// marker lines, its own hook entry. Everything else in those files stays as it was.
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { keepingFolderTimes } from "./foldertime";
import { claudeSettingsFile, readClaudeSettings, writeClaudeSettings } from "./meter";
import { selfCommand } from "./self";
import { quote } from "./statusline";
import { remindersLately } from "./readhook";
import { FIRST_MATCHER } from "./firsthook";

const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim() || join(home(), ".claude");
const codexDir = () => process.env.CODEX_HOME?.trim() || join(home(), ".codex");

export const START = "<!-- leanfare:start -->";
export const END = "<!-- leanfare:end -->";
const OWN = "(Leanfare wrote this file. Take it out in Leanfare's Settings, In your apps.)";

// What the app is told (0.11: by size and kind, not only "a task with several parts", which Claude judged most prompts
// not to be: in a week of Plan by itself, Claude Code handed off nothing in 112 prompts).
const BY_SIZE = `Before you read a file you will not change that is big (a log, data, docs or notes of about 40 KB or more, any other file over about 200 KB), or more than 5 files to answer one question, hand the reading to Leanfare's delegate tool (kind read, the files as full paths, and a task that says what to find): only the answer comes back, and the files stay out of your context. Keep for yourself the files you will change, short files, and anything you must quote exactly.`;
// 0.12: how much goes to Leanfare first is its level (level.ts). Claude Code hears it from the prompt hook with each prompt;
// the other apps ask the level tool. The block stays the same whatever the level, so changing it rewrites nothing.
const LEVELS_RULE = `How much you hand to Leanfare first is its level, from 1 to 5: 1 Off (only when the user asks), 2 Light (the big reads above, and tasks with several parts), 3 More (also reads over about 10 KB you will not change, project wide searches, summaries, reviews and first drafts), 4 Most (plan every prompt that is more than a quick question with Leanfare's plan tool first), 5 All it can (hand every part a model can do to Leanfare; keep decisions, changes to files and the final answer). Pass the level to delegate and plan. When the user sets one ("Leanfare 4", "use Leanfare less"), call Leanfare's level tool with set.`;
// 0.12: every answer Leanfare brings back is reviewed, graded and fixed before the app answers (Settings, Review every answer).
const REVIEW = `Review every answer Leanfare brings back before you use it: check it against its task, grade it with Leanfare's grade tool (good, partly or wrong, with its handoff number), and fix anything partly or wrong before you answer: yourself, or with grade fix leanfare and why, and Leanfare asks again one tier up and sends back a new answer to review. Models graded down too often are picked less.`;
const RULE_CLAUDE = `## Leanfare

Leanfare hands reading and searching to free or cheap models, so your Claude plan lasts longer. ${BY_SIZE}

${LEVELS_RULE} Leanfare's prompt hook says the level for this session with each prompt.

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first: Leanfare starts its own parts by itself and the plan answers with those that finish quickly. Do the parts it leaves to you, then call plan_status with the plan's id (wait 50) for the rest; never run Leanfare's parts again with delegate. ${REVIEW}`;
const RULE_OTHER = `## Leanfare

Leanfare hands reading and searching to free or cheap models, so your plan lasts longer. ${BY_SIZE}

${LEVELS_RULE} At the start of a chat, call Leanfare's level tool once to learn the level, and follow it.

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first: Leanfare starts its own parts by itself and the plan answers with those that finish quickly. Do the parts it leaves to you, then call plan_status with the plan's id (wait 50) for the rest; never run Leanfare's parts again with delegate. ${REVIEW}`;

export const WORKER = `---
name: leanfare-worker
description: Runs one part of a Leanfare plan through Leanfare's delegate tool, on the model Leanfare picked, so the main conversation keeps its context and the user's Claude plan. Use it for the parts a Leanfare plan gives to Leanfare, one worker per part, several at once.
tools: mcp__leanfare__delegate, mcp__leanfare__ask, mcp__leanfare__plan_status
model: haiku
---
You run one part of a plan that Leanfare made. You get the part's task, its kind, its effort and its files.

1. Call Leanfare's delegate tool once, with that task, kind and effort, and the files as full paths. For a search part, call ask with the model the plan named.
2. Do not read the files yourself and do not do the part yourself: Leanfare's model does it, which is the point.
3. Reply with the answer and the receipt line delegate gave, nothing else. If delegate fails, reply with its message in one line.

${OWN}
`;

// ---- blocks in a markdown file ------------------------------------------------------------------

// Leanfare's blocks in the text: a START line, then an END line, with no other marker between them.
// A marker left on its own (its pair deleted by hand) is the user's text now: it stays, and so does
// everything around it.
function blocks(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; ;) {
    const s = text.indexOf(START, i);
    if (s < 0) break;
    const e = text.indexOf(END, s + START.length);
    if (e < 0) break;
    const next = text.indexOf(START, s + START.length);
    if (next >= 0 && next < e) { i = next; continue; } // this START has no END of its own
    out.push([s, e + END.length]);
    i = e + END.length;
  }
  return out;
}

// The file's text with Leanfare's blocks taken out (body null), or with one block at the end in place
// of any it had: only the blocks and the blank lines next to them change.
export function withBlock(text: string, body: string | null): string {
  const found = blocks(text);
  if (body === null && !found.length) return text; // no whole block: nothing is taken out
  let rest = text;
  for (const [s, e] of found.reverse()) { // the last first, so the earlier places stay right
    const before = rest.slice(0, s).replace(/\n+$/, ""), after = rest.slice(e).replace(/^\n+/, "");
    rest = before && after ? `${before}\n\n${after}` : before + after;
  }
  rest = rest.replace(/\s+$/, "");
  if (body === null) return rest ? rest + "\n" : "";
  return `${rest ? rest + "\n\n" : ""}${START}\n${body}\n${END}\n`;
}
const hasBlock = (file: string) => { try { return blocks(readFileSync(file, "utf8")).length > 0; } catch { return false; } };
// Written whole, then swapped in. A file that is a link (kept with your dotfiles) stays a link: the
// file it points to is the one written; and the file keeps its permissions (a private one stays private).
function target(file: string): string {
  try { if (lstatSync(file).isSymbolicLink()) { try { return realpathSync(file); } catch { return resolve(dirname(file), readlinkSync(file)); } } } catch {}
  return file;
}
function writeAtomic(file: string, text: string) {
  const to = target(file);
  keepingFolderTimes([file, to], () => { // Leanfare's write is not use of the app (found.ts)
    mkdirSync(dirname(to), { recursive: true });
    let mode: number | undefined;
    try { mode = statSync(to).mode & 0o777; } catch {}
    const tmp = `${to}.leanfare-${process.pid}`;
    try {
      writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
      if (mode !== undefined) chmodSync(tmp, mode);
      renameSync(tmp, to);
    } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
  });
}
// Whether Leanfare can write a file there, asked before anything changes.
function writable(file: string): string | null {
  const to = target(file);
  try {
    if (existsSync(to)) accessSync(to, constants.W_OK);
    let d = dirname(to);
    while (!existsSync(d)) d = dirname(d);
    accessSync(d, constants.W_OK);
    return null;
  } catch { return `Leanfare cannot write ${file} (it is read only, or locked by another program), so it changed nothing.`; }
}
function setBlock(file: string, body: string | null) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (body === null && !before.includes(START)) return; // nothing of Leanfare's: the file stays as it is
  const after = withBlock(before, body);
  if (after === before) return;
  writeAtomic(file, after); // a file left empty stays, empty: it may have been there before Leanfare
}

// ---- Claude Code's hooks: the prompt hook, the read hook (0.11), and the review hooks (0.12) ---------

// The prompt hook says how much of your Claude plan is left as each prompt goes; the read hook reminds Claude Code once
// before it reads a big file itself (readhook.ts). Both are Leanfare's own entries in ~/.claude/settings.json.
export const hookCommand = () => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + " hook prompt"; };
export const readHookCommand = () => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + " hook read"; };
// The review hooks (reviewhook.ts): which hand offs a session got, and a grade asked for once before Claude finishes.
export const handoffHookCommand = () => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + " hook handoff"; };
export const stopHookCommand = () => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + " hook stop"; };
// 0.14.1: plan first (firsthook.ts), and the hooks of the other apps, each with the app it is for.
export const firstHookCommand = (app?: string) => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + ` hook first${app ? ` --app ${app}` : ""}`; };
export const promptHookCommand = (app: string) => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + ` hook prompt --app ${app}`; };
export const HANDOFF_MATCHER = "mcp__.*leanfare.*__(delegate|plan|plan_run|plan_status|grade|level)";
const ourHook = (what: "prompt" | "read" | "handoff" | "stop" | "first") => (cmd: unknown) => typeof cmd === "string" && new RegExp(`(^|[\\s'"/\\\\])(leanfare(\\.exe)?|cli\\.ts)['"]?\\s+hook\\s+${what}\\b`, "i").test(cmd);
const isOurHook = ourHook("prompt"), isOurReadHook = ourHook("read"), isOurHandoffHook = ourHook("handoff"), isOurStopHook = ourHook("stop"), isOurFirstHook = ourHook("first");
const HOOKS = [
  { event: "UserPromptSubmit", ours: isOurHook, entry: () => ({ hooks: [{ type: "command", command: hookCommand(), timeout: 5 }] }), command: hookCommand },
  { event: "PreToolUse", ours: isOurReadHook, entry: () => ({ matcher: "Read", hooks: [{ type: "command", command: readHookCommand(), timeout: 5 }] }), command: readHookCommand },
  { event: "PreToolUse", ours: isOurFirstHook, entry: () => ({ matcher: FIRST_MATCHER, hooks: [{ type: "command", command: firstHookCommand(), timeout: 5 }] }), command: () => firstHookCommand() },
  { event: "PostToolUse", ours: isOurHandoffHook, entry: () => ({ matcher: HANDOFF_MATCHER, hooks: [{ type: "command", command: handoffHookCommand(), timeout: 5 }] }), command: handoffHookCommand },
  { event: "Stop", ours: isOurStopHook, entry: () => ({ hooks: [{ type: "command", command: stopHookCommand(), timeout: 10 }] }), command: stopHookCommand },
];
// exact: this version's command and matcher (0.12: the hand off hook's matcher grew the level tool, so an older entry
// is brought up to date).
const has = (j: any, h: (typeof HOOKS)[number], exact = false) => {
  const groups = j?.hooks?.[h.event];
  const matcher = (h.entry() as { matcher?: string }).matcher;
  return Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && (!exact || g.matcher === matcher) && g.hooks.some((x: any) => (exact ? x?.command === h.command() : h.ours(x?.command))));
};
function hookIn(j: any): boolean { return HOOKS.every((h) => has(j, h)); }
const hookAny = (j: any) => HOOKS.some((h) => has(j, h));
const hookUpToDate = (j: any) => HOOKS.every((h) => has(j, h, true));
// Whether the app's own hooks are in Claude Code's settings: the Leanfare plugin's hooks then stay quiet (cli.ts), so
// nothing runs twice. The plugin's hooks, as the plugin lists them (plugin/hooks/hooks.json), for its test.
export const appHooksOn = () => hookAny(readClaudeSettings());
export const CLAUDE_HOOKS = HOOKS.map((h) => ({ event: h.event, matcher: (h.entry() as { matcher?: string }).matcher ?? null, timeout: h.entry().hooks[0].timeout, what: h.command().split(" hook ").pop()! }));
function setHook(on: boolean) {
  const j = readClaudeSettings();
  if (on ? hookIn(j) && hookUpToDate(j) : !hookAny(j)) return;
  const hooks = j.hooks && typeof j.hooks === "object" && !Array.isArray(j.hooks) ? j.hooks : {};
  for (const h of HOOKS) {
    const groups: any[] = (Array.isArray(hooks[h.event]) ? hooks[h.event] : [])
      .map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((x: any) => !h.ours(x?.command)) } : g))
      .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (on) groups.push(h.entry());
    if (groups.length) hooks[h.event] = groups; else delete hooks[h.event];
  }
  if (Object.keys(hooks).length) j.hooks = hooks; else delete j.hooks;
  writeClaudeSettings(j);
}

export { hookLine } from "./statusline"; // the line itself lives with the status line's, so the hook starts as fast

// ---- the other apps' hooks (0.14.1): Codex, Gemini CLI and Cursor ----------------------------------------
// Each app's own hook file, read as JSON (one that does not read as JSON is left alone, and nothing changes), with
// Leanfare's entries found by their command and replaced, kept or taken out; everything else in the file stays.
interface AppHook { event: string; matcher?: string; command: () => string; timeout?: number }
interface AppHooks { file: () => string; cursor?: boolean; list: AppHook[] }
const ourAny = (cmd: unknown) => typeof cmd === "string" && /(^|[\s'"/\\])(leanfare(\.exe)?|cli\.ts)['"]?\s+hook\s+(prompt|first)\b/i.test(cmd);
export const APP_HOOKS: Record<string, AppHooks> = {
  // Codex: Claude Code's shape in ~/.codex/hooks.json; its tool hook sees its shell.
  codex: { file: () => join(codexDir(), "hooks.json"), list: [
    { event: "UserPromptSubmit", command: () => promptHookCommand("codex"), timeout: 5 },
    { event: "PreToolUse", matcher: "^Bash$", command: () => firstHookCommand("codex"), timeout: 5 },
  ] },
  // Gemini CLI: in ~/.gemini/settings.json, timeouts in milliseconds.
  "gemini-cli": { file: () => join(home(), ".gemini", "settings.json"), list: [
    { event: "BeforeAgent", command: () => promptHookCommand("gemini-cli"), timeout: 5000 },
    { event: "BeforeTool", matcher: ".*", command: () => firstHookCommand("gemini-cli"), timeout: 5000 },
  ] },
  // Cursor: ~/.cursor/hooks.json (version 1); it has no hook that adds to a prompt.
  cursor: { file: () => join(home(), ".cursor", "hooks.json"), cursor: true, list: [
    { event: "beforeShellExecution", command: () => firstHookCommand("cursor") },
    { event: "beforeMCPExecution", command: () => firstHookCommand("cursor") },
  ] },
};
function readJson(file: string): any {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  try { const j = JSON.parse(text); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch {}
  throw new Error(`${file} does not read as JSON, so Leanfare changed nothing in it.`);
}
const entriesOf = (j: any, event: string): any[] => (Array.isArray(j?.hooks?.[event]) ? j.hooks[event] : []);
const commandsOf = (g: any): unknown[] => (Array.isArray(g?.hooks) ? g.hooks.map((x: any) => x?.command) : [g?.command]);
function appHooksState(d: AppHooks): { all: boolean; any: boolean; current: boolean } {
  let j: any = {};
  try { j = readJson(d.file()); } catch { return { all: false, any: false, current: false }; }
  const found = d.list.map((h) => entriesOf(j, h.event).some((g) => commandsOf(g).some(ourAny)));
  const current = d.list.every((h) => entriesOf(j, h.event).some((g) => commandsOf(g).includes(h.command()) && (g?.matcher ?? undefined) === h.matcher));
  return { all: found.every(Boolean), any: found.some(Boolean), current };
}
function setAppHooks(d: AppHooks, on: boolean) {
  const file = d.file();
  const j = readJson(file);
  const st = appHooksState(d);
  if (on ? st.all && st.current : !st.any) return;
  const hooks = j.hooks && typeof j.hooks === "object" && !Array.isArray(j.hooks) ? j.hooks : {};
  for (const event of new Set(d.list.map((h) => h.event))) {
    const kept = entriesOf(j, event).map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((x: any) => !ourAny(x?.command)) } : g))
      .filter((g: any) => (Array.isArray(g?.hooks) ? g.hooks.length : !ourAny(g?.command)));
    if (on) for (const h of d.list.filter((x) => x.event === event))
      kept.push(d.cursor ? { command: h.command() } : { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: h.command(), ...(h.timeout ? { timeout: h.timeout } : {}) }] });
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (Object.keys(hooks).length) j.hooks = hooks; else delete j.hooks;
  if (d.cursor && j.hooks) j.version ??= 1;
  writeAtomic(file, JSON.stringify(j, null, 2) + "\n");
}

// ---- the apps ---------------------------------------------------------------------------------

export interface AutoView { on: boolean; partly: boolean; what: string; reminders?: { n: number; kb: number } } // partly: some of it is there (Turn off takes it out); reminders: the read hook's last 7 days
interface AutoDef { files: () => { rule: string | null; agent?: string }; hook?: boolean; rule: string; what: string; appHooks?: AppHooks } // rule null: the app has no file for rules (Cursor)
export const AUTO: Record<string, AutoDef> = {
  "claude-code": { files: () => ({ rule: join(claudeDir(), "CLAUDE.md"), agent: join(claudeDir(), "agents", "leanfare-worker.md") }), hook: true, rule: RULE_CLAUDE,
    what: "Plan by itself: a block in CLAUDE.md (hand off big reads, and plan tasks with several parts), a worker subagent (leanfare-worker, on Haiku) for Leanfare's parts, a prompt hook that says how much of your plan is left, a reminder before Claude Code reads a big file itself, and, before Claude finishes, a request to grade and fix the answers Leanfare brought back" },
  codex: { files: () => ({ rule: join(codexDir(), "AGENTS.md") }), rule: RULE_OTHER, appHooks: APP_HOOKS.codex, what: "Plan by itself: a block in AGENTS.md that has Codex hand off big reads and call Leanfare's plan for a task with several parts, a prompt hook that says the level, and at levels 4 and 5 a reminder to plan first before its first command of a prompt (hooks.json)" },
  "gemini-cli": { files: () => ({ rule: join(home(), ".gemini", "GEMINI.md") }), rule: RULE_OTHER, appHooks: APP_HOOKS["gemini-cli"], what: "Plan by itself: a block in GEMINI.md that has Gemini CLI hand off big reads and call Leanfare's plan for a task with several parts, a hook that says the level with each prompt, and at levels 4 and 5 a reminder to plan first before its first tool of a prompt" },
  cursor: { files: () => ({ rule: null }), rule: RULE_OTHER, appHooks: APP_HOOKS.cursor, what: "Plan by itself: at levels 4 and 5, Cursor's agent is asked once a prompt to plan with Leanfare first, before its first command or tool (Cursor's hooks.json); Cursor has no file for rules every project reads" },
};

const ourWorker = (file: string) => { try { return readFileSync(file, "utf8").includes(OWN); } catch { return false; } };

export function autoView(id: string): AutoView | null {
  const d = AUTO[id];
  if (!d) return null;
  const f = d.files();
  let hook = true, some = true;
  if (d.hook) { try { const j = readClaudeSettings(); hook = hookIn(j); some = hookAny(j); } catch { hook = false; some = false; } }
  const ah = d.appHooks ? appHooksState(d.appHooks) : null;
  const have = [...(f.rule ? [hasBlock(f.rule)] : []), ...(f.agent ? [ourWorker(f.agent)] : []), ...(d.hook ? [hook] : []), ...(ah ? [ah.all] : [])];
  const any = have.some(Boolean) || (!!d.hook && some) || !!ah?.any;
  return { on: have.every(Boolean), partly: any && !have.every(Boolean), what: d.what, ...(id === "claude-code" ? { reminders: remindersLately() } : {}) };
}

export function setAuto(id: string, on: boolean): AutoView {
  const d = AUTO[id];
  if (!d) throw new Error(`Leanfare cannot plan by itself in ${id}.`);
  const f = d.files();
  if (on && f.agent && existsSync(f.agent) && !ourWorker(f.agent)) throw new Error(`${f.agent} is not Leanfare's, so Leanfare left it alone. Rename it, then turn this on again.`);
  // Everything is checked first: the settings file reads as JSON, and every file can be written.
  if (d.hook) readClaudeSettings();
  if (d.appHooks) readJson(d.appHooks.file()); // a hook file that does not read as JSON: nothing changes
  for (const file of [...(f.rule ? [f.rule] : []), ...(f.agent ? [f.agent] : []), ...(d.hook ? [claudeSettingsFile()] : []), ...(d.appHooks ? [d.appHooks.file()] : [])]) { const why = writable(file); if (why) throw new Error(why); }
  // Then each change, undone if a later one fails, so nothing is left half done.
  const undo: (() => void)[] = [];
  try {
    if (d.hook) { const was = hookIn(readClaudeSettings()); setHook(on); undo.push(() => setHook(was)); }
    if (d.appHooks) { const hf = d.appHooks.file(), was = existsSync(hf) ? readFileSync(hf, "utf8") : null; setAppHooks(d.appHooks, on); undo.push(() => { if (was !== null) writeAtomic(hf, was); }); }
    const rule = f.rule;
    if (rule) {
      const before = existsSync(rule) ? readFileSync(rule, "utf8") : null;
      setBlock(rule, on ? d.rule : null);
      undo.push(() => { if (before !== null) writeAtomic(rule, before); });
    }
    if (f.agent) {
      if (on) { if (!existsSync(f.agent) || readFileSync(f.agent, "utf8") !== WORKER) writeAtomic(f.agent, WORKER); }
      else if (ourWorker(f.agent)) { const agent = f.agent; keepingFolderTimes([agent], () => unlinkSync(agent)); }
    }
  } catch (e) {
    for (const u of undo.reverse()) { try { u(); } catch {} }
    throw e;
  }
  return autoView(id)!;
}

// After an update (the app starts): Plan by itself, where you have it on, is brought up to this version's text and hooks
// (0.11: the block by size, the read hook). Only where its block is there: Leanfare never turns it on by itself.
export function refreshAuto(): string[] {
  const done: string[] = [];
  for (const id of Object.keys(AUTO)) {
    try { const d = AUTO[id], rule = d.files().rule; if (rule ? hasBlock(rule) : !!d.appHooks && appHooksState(d.appHooks).any) { setAuto(id, true); done.push(id); } } catch (e) { console.error(`leanfare: could not bring Plan by itself up to date in ${id}: ${String((e as Error)?.message ?? e)}`); }
  }
  return done;
}

