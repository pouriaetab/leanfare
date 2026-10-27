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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readClaudeSettings, writeClaudeSettings } from "./meter";
import { selfCommand } from "./self";
import { quote } from "./statusline";

const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim() || join(home(), ".claude");
const codexDir = () => process.env.CODEX_HOME?.trim() || join(home(), ".codex");

export const START = "<!-- leanfare:start -->";
export const END = "<!-- leanfare:end -->";
const OWN = "(Leanfare wrote this file. Take it out in Leanfare's Settings, In your apps.)";

const RULE_CLAUDE = `## Leanfare

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first and follow its table: run the parts it gives to Leanfare with delegate (several in the same turn) or with the leanfare-worker subagent (one per part, at once), or call plan_run to run them in the background and plan_status for their answers. Do the parts it leaves to you yourself. Leanfare's parts run on local, free or cheap models, so your Claude plan lasts longer.`;
const RULE_OTHER = `## Leanfare

For a task with several parts (a feature, a fix across files, research across many files), call Leanfare's plan tool first and follow its table: run the parts it gives to Leanfare with delegate (several in the same turn), or call plan_run to run them in the background and plan_status for their answers. Do the parts it leaves to you yourself.`;

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

// The file's text with Leanfare's block taken out (body null) or put in at the end, in place of any
// block it had: only the block and the blank lines next to it change.
export function withBlock(text: string, body: string | null): string {
  const s = text.indexOf(START), e = text.indexOf(END);
  let rest = text;
  if (s >= 0 && e > s) {
    const before = text.slice(0, s).replace(/\n+$/, ""), after = text.slice(e + END.length).replace(/^\n+/, "");
    rest = before && after ? `${before}\n\n${after}` : before + after;
  }
  rest = rest.replace(/\s+$/, "");
  if (body === null) return rest ? rest + "\n" : "";
  return `${rest ? rest + "\n\n" : ""}${START}\n${body}\n${END}\n`;
}
const hasBlock = (file: string) => { try { const t = readFileSync(file, "utf8"); return t.includes(START) && t.includes(END); } catch { return false; } };
function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.leanfare-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
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

export interface AutoView { on: boolean; what: string }
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
  const on = hasBlock(f.rule) && (!f.agent || ourWorker(f.agent)) && hook;
  return { on, what: d.what };
}

export function setAuto(id: string, on: boolean): AutoView {
  const d = AUTO[id];
  if (!d) throw new Error(`Leanfare cannot plan by itself in ${id}.`);
  const f = d.files();
  if (on && f.agent && existsSync(f.agent) && !ourWorker(f.agent)) throw new Error(`${f.agent} is not Leanfare's, so Leanfare left it alone. Rename it, then turn this on again.`);
  if (d.hook) setHook(on); // first: a settings file that is not valid JSON stops here, before anything else changes
  setBlock(f.rule, on ? d.rule : null);
  if (f.agent) {
    if (on) writeAtomic(f.agent, WORKER);
    else if (ourWorker(f.agent)) { try { unlinkSync(f.agent); } catch {} }
  }
  return autoView(id)!;
}

