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

const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim() || join(home(), ".claude");
const codexDir = () => process.env.CODEX_HOME?.trim() || join(home(), ".codex");

export const START = "<!-- leanfare:start -->";
export const END = "<!-- leanfare:end -->";
const OWN = "(Leanfare wrote this file. Take it out in Leanfare's Settings, In your apps.)";

// What the app is told (0.11: by size and kind, not only "a task with several parts", which Claude judged most prompts
// not to be: in a week of Plan by itself, Claude Code handed off nothing in 112 prompts).
const BY_SIZE = `Before you read a file you will not change that is big (a log, data, docs or notes of about 40 KB or more, any other file over about 200 KB), or more than 5 files to answer one question, hand the reading to Leanfare's delegate tool (kind read, the files as full paths, and a task that says what to find): only the answer comes back, and the files stay out of your context. Keep for yourself the files you will change, short files, and anything you must quote exactly.`;
// 0.12: every answer Leanfare brings back is reviewed, graded and fixed before the app answers (Settings, Review every answer).
const REVIEW = `Review every answer Leanfare brings back before you use it: check it against its task, grade it with Leanfare's grade tool (good, partly or wrong, with its handoff number), and fix anything partly or wrong before you answer: yourself, or with grade fix leanfare and why, and Leanfare asks again one tier up and sends back a new answer to review. Models graded down too often are picked less.`;
const RULE_CLAUDE = `## Leanfare

Leanfare hands reading and searching to free or cheap models, so your Claude plan lasts longer. ${BY_SIZE}

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first and follow its table: run the parts it gives to Leanfare with delegate (several in the same turn) or with the leanfare-worker subagent (one per part, at once), or call plan_run to run them in the background and plan_status for their answers. Do the parts it leaves to you yourself. ${REVIEW}`;
const RULE_OTHER = `## Leanfare

Leanfare hands reading and searching to free or cheap models, so your plan lasts longer. ${BY_SIZE}

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first and follow its table: run the parts it gives to Leanfare with delegate (several in the same turn), or call plan_run to run them in the background and plan_status for their answers. Do the parts it leaves to you yourself. ${REVIEW}`;

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
export const HANDOFF_MATCHER = "mcp__.*leanfare.*__(delegate|plan_run|plan_status|grade)";
const ourHook = (what: "prompt" | "read" | "handoff" | "stop") => (cmd: unknown) => typeof cmd === "string" && new RegExp(`(^|[\\s'"/\\\\])(leanfare(\\.exe)?|cli\\.ts)['"]?\\s+hook\\s+${what}\\b`, "i").test(cmd);
const isOurHook = ourHook("prompt"), isOurReadHook = ourHook("read"), isOurHandoffHook = ourHook("handoff"), isOurStopHook = ourHook("stop");
const HOOKS = [
  { event: "UserPromptSubmit", ours: isOurHook, entry: () => ({ hooks: [{ type: "command", command: hookCommand(), timeout: 5 }] }), command: hookCommand },
  { event: "PreToolUse", ours: isOurReadHook, entry: () => ({ matcher: "Read", hooks: [{ type: "command", command: readHookCommand(), timeout: 5 }] }), command: readHookCommand },
  { event: "PostToolUse", ours: isOurHandoffHook, entry: () => ({ matcher: HANDOFF_MATCHER, hooks: [{ type: "command", command: handoffHookCommand(), timeout: 5 }] }), command: handoffHookCommand },
  { event: "Stop", ours: isOurStopHook, entry: () => ({ hooks: [{ type: "command", command: stopHookCommand(), timeout: 10 }] }), command: stopHookCommand },
];
const has = (j: any, h: (typeof HOOKS)[number], exact = false) => {
  const groups = j?.hooks?.[h.event];
  return Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((x: any) => (exact ? x?.command === h.command() : h.ours(x?.command))));
};
function hookIn(j: any): boolean { return HOOKS.every((h) => has(j, h)); }
const hookAny = (j: any) => HOOKS.some((h) => has(j, h));
const hookUpToDate = (j: any) => HOOKS.every((h) => has(j, h, true));
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

// ---- the apps ---------------------------------------------------------------------------------

export interface AutoView { on: boolean; partly: boolean; what: string; reminders?: { n: number; kb: number } } // partly: some of it is there (Turn off takes it out); reminders: the read hook's last 7 days
interface AutoDef { files: () => { rule: string; agent?: string }; hook?: boolean; rule: string; what: string }
export const AUTO: Record<string, AutoDef> = {
  "claude-code": { files: () => ({ rule: join(claudeDir(), "CLAUDE.md"), agent: join(claudeDir(), "agents", "leanfare-worker.md") }), hook: true, rule: RULE_CLAUDE,
    what: "Plan by itself: a block in CLAUDE.md (hand off big reads, and plan tasks with several parts), a worker subagent (leanfare-worker, on Haiku) for Leanfare's parts, a prompt hook that says how much of your plan is left, a reminder before Claude Code reads a big file itself, and, before Claude finishes, a request to grade and fix the answers Leanfare brought back" },
  codex: { files: () => ({ rule: join(codexDir(), "AGENTS.md") }), rule: RULE_OTHER, what: "Plan by itself: a block in AGENTS.md that has Codex hand off big reads and call Leanfare's plan for a task with several parts" },
  "gemini-cli": { files: () => ({ rule: join(home(), ".gemini", "GEMINI.md") }), rule: RULE_OTHER, what: "Plan by itself: a block in GEMINI.md that has Gemini CLI hand off big reads and call Leanfare's plan for a task with several parts" },
};

const ourWorker = (file: string) => { try { return readFileSync(file, "utf8").includes(OWN); } catch { return false; } };

export function autoView(id: string): AutoView | null {
  const d = AUTO[id];
  if (!d) return null;
  const f = d.files();
  let hook = true, some = true;
  if (d.hook) { try { const j = readClaudeSettings(); hook = hookIn(j); some = hookAny(j); } catch { hook = false; some = false; } }
  const have = [hasBlock(f.rule), ...(f.agent ? [ourWorker(f.agent)] : []), ...(d.hook ? [hook] : [])];
  const any = have.some(Boolean) || (!!d.hook && some);
  return { on: have.every(Boolean), partly: any && !have.every(Boolean), what: d.what, ...(id === "claude-code" ? { reminders: remindersLately() } : {}) };
}

export function setAuto(id: string, on: boolean): AutoView {
  const d = AUTO[id];
  if (!d) throw new Error(`Leanfare cannot plan by itself in ${id}.`);
  const f = d.files();
  if (on && f.agent && existsSync(f.agent) && !ourWorker(f.agent)) throw new Error(`${f.agent} is not Leanfare's, so Leanfare left it alone. Rename it, then turn this on again.`);
  // Everything is checked first: the settings file reads as JSON, and every file can be written.
  if (d.hook) readClaudeSettings();
  for (const file of [f.rule, ...(f.agent ? [f.agent] : []), ...(d.hook ? [claudeSettingsFile()] : [])]) { const why = writable(file); if (why) throw new Error(why); }
  // Then each change, undone if a later one fails, so nothing is left half done.
  const undo: (() => void)[] = [];
  try {
    if (d.hook) { const was = hookIn(readClaudeSettings()); setHook(on); undo.push(() => setHook(was)); }
    const before = existsSync(f.rule) ? readFileSync(f.rule, "utf8") : null;
    setBlock(f.rule, on ? d.rule : null);
    undo.push(() => { if (before !== null) writeAtomic(f.rule, before); });
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
    try { if (hasBlock(AUTO[id].files().rule)) { setAuto(id, true); done.push(id); } } catch (e) { console.error(`leanfare: could not bring Plan by itself up to date in ${id}: ${String((e as Error)?.message ?? e)}`); }
  }
  return done;
}

