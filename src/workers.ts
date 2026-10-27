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

const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim() || join(home(), ".claude");
const codexDir = () => process.env.CODEX_HOME?.trim() || join(home(), ".codex");

export const START = "<!-- leanfare:start -->";
export const END = "<!-- leanfare:end -->";
const OWN = "(Leanfare wrote this file. Take it out in Leanfare's Settings, In your apps.)";

const RULE_CLAUDE = `## Leanfare

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first and follow its table: run the parts it gives to Leanfare with delegate (several in the same turn) or with the leanfare-worker subagent (one per part, at once), or call plan_run to run them in the background and plan_status for their answers. Do the parts it leaves to you yourself. Once you have used an answer of Leanfare's, grade it with Leanfare's grade tool (good, partly or wrong), so the models that do badly are moved down. Leanfare's parts run on local, free or cheap models, so your Claude plan lasts longer.`;
const RULE_OTHER = `## Leanfare

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first and follow its table: run the parts it gives to Leanfare with delegate (several in the same turn), or call plan_run to run them in the background and plan_status for their answers. Do the parts it leaves to you yourself. Once you have used an answer of Leanfare's, grade it with Leanfare's grade tool (good, partly or wrong), so the models that do badly are moved down.`;

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

// ---- Claude Code's prompt hook ----------------------------------------------------------------

export const hookCommand = () => { const c = selfCommand(); return [c.command, ...c.args].map(quote).join(" ") + " hook prompt"; };
const isOurHook = (cmd: unknown) => typeof cmd === "string" && /(^|[\s'"/\\])(leanfare(\.exe)?|cli\.ts)['"]?\s+hook\s+prompt\b/i.test(cmd);
function hookIn(j: any): boolean {
  const groups = j?.hooks?.UserPromptSubmit;
  return Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurHook(h?.command)));
}
function setHook(on: boolean) {
  const j = readClaudeSettings();
  if (on === hookIn(j) && (!on || hookUpToDate(j))) return;
  const hooks = j.hooks && typeof j.hooks === "object" && !Array.isArray(j.hooks) ? j.hooks : {};
  const groups: any[] = (Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [])
    .map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurHook(h?.command)) } : g))
    .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length);
  if (on) groups.push({ hooks: [{ type: "command", command: hookCommand(), timeout: 5 }] });
  if (groups.length) hooks.UserPromptSubmit = groups; else delete hooks.UserPromptSubmit;
  if (Object.keys(hooks).length) j.hooks = hooks; else delete j.hooks;
  writeClaudeSettings(j);
}
const hookUpToDate = (j: any) => j.hooks.UserPromptSubmit.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => h?.command === hookCommand()));

export { hookLine } from "./statusline"; // the line itself lives with the status line's, so the hook starts as fast

// ---- the apps ---------------------------------------------------------------------------------

export interface AutoView { on: boolean; partly: boolean; what: string } // partly: some of it is there (Turn off takes it out)
interface AutoDef { files: () => { rule: string; agent?: string }; hook?: boolean; rule: string; what: string }
export const AUTO: Record<string, AutoDef> = {
  "claude-code": { files: () => ({ rule: join(claudeDir(), "CLAUDE.md"), agent: join(claudeDir(), "agents", "leanfare-worker.md") }), hook: true, rule: RULE_CLAUDE,
    what: "Plan by itself: a line in CLAUDE.md, a worker subagent (leanfare-worker, on Haiku) for Leanfare's parts, and a prompt hook that says how much of your plan is left" },
  codex: { files: () => ({ rule: join(codexDir(), "AGENTS.md") }), rule: RULE_OTHER, what: "Plan by itself: a line in AGENTS.md that has Codex call Leanfare's plan for a task with several parts" },
  "gemini-cli": { files: () => ({ rule: join(home(), ".gemini", "GEMINI.md") }), rule: RULE_OTHER, what: "Plan by itself: a line in GEMINI.md that has Gemini CLI call Leanfare's plan for a task with several parts" },
};

const ourWorker = (file: string) => { try { return readFileSync(file, "utf8").includes(OWN); } catch { return false; } };

export function autoView(id: string): AutoView | null {
  const d = AUTO[id];
  if (!d) return null;
  const f = d.files();
  let hook = true;
  if (d.hook) { try { hook = hookIn(readClaudeSettings()); } catch { hook = false; } }
  const have = [hasBlock(f.rule), ...(f.agent ? [ourWorker(f.agent)] : []), ...(d.hook ? [hook] : [])];
  return { on: have.every(Boolean), partly: have.some(Boolean) && !have.every(Boolean), what: d.what };
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
      if (on) writeAtomic(f.agent, WORKER);
      else if (ourWorker(f.agent)) { const agent = f.agent; keepingFolderTimes([agent], () => unlinkSync(agent)); }
    }
  } catch (e) {
    for (const u of undo.reverse()) { try { u(); } catch {} }
    throw e;
  }
  return autoView(id)!;
}

