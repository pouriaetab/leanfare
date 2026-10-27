// Use Leanfare in your apps: adds Leanfare's MCP server (its tools: delegate, ask, spend, models,
// estimate) to the AI apps you already use, so they work as usual with Leanfare on top. One press
// per app, undone the same way.
//
// Each app keeps its MCP servers in its own settings file. Leanfare adds or removes only its own
// entry, named "leanfare", and leaves everything else as it was:
//   - a file that is not valid JSON (or TOML) is left alone, and the screen says so;
//   - the file as it was is copied next to it first (<file>.leanfare-backup);
//   - the new file is written whole, then swapped in, so the app never reads half a file;
//   - a settings file that is a link (kept with your dotfiles) stays a link.
// Claude Code is the exception: its `claude mcp add` command does it, because Claude Code keeps
// rewriting its own file while it runs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { selfCommand } from "./self";
import { shellEnv } from "./shellenv";

const home = () => process.env.HOME || homedir();
const appData = () => process.env.APPDATA || join(home(), "AppData", "Roaming");
const mac = () => process.platform === "darwin";
const win = () => process.platform === "win32";

export interface AppDef {
  id: string;
  name: string;
  format: "json" | "toml" | "claude-cli";
  file: () => string; // its settings file
  key?: "mcpServers" | "servers"; // where its servers live in that file
  vscode?: boolean; // VS Code's entries also say type: "stdio"
  installed: () => boolean; // the app is on this computer
  after: string; // what to do for it to load Leanfare
}

const configDir = (macPath: string, linuxPath: string, winPath: string) =>
  mac() ? join(home(), "Library", "Application Support", macPath) : win() ? join(appData(), winPath) : join(home(), ".config", linuxPath);

export const APPS: AppDef[] = [
  { id: "claude-desktop", name: "Claude Desktop (and Cowork)", format: "json", key: "mcpServers",
    file: () => join(configDir("Claude", "Claude", "Claude"), "claude_desktop_config.json"),
    installed: () => existsSync(configDir("Claude", "Claude", "Claude")) || (mac() && existsSync("/Applications/Claude.app")),
    after: "Quit Claude Desktop and open it again." },
  { id: "claude-code", name: "Claude Code", format: "claude-cli", file: () => claudeJson(),
    installed: () => existsSync(claudeJson()) || existsSync(join(home(), ".claude")),
    after: "Start Claude Code again (type /exit, then claude)." },
  { id: "cursor", name: "Cursor", format: "json", key: "mcpServers", file: () => join(home(), ".cursor", "mcp.json"),
    installed: () => existsSync(join(home(), ".cursor")) || (mac() && existsSync("/Applications/Cursor.app")),
    after: "Cursor picks it up by itself; turn it on in Cursor's settings, MCP." },
  { id: "codex", name: "Codex CLI", format: "toml", file: () => join(process.env.CODEX_HOME || join(home(), ".codex"), "config.toml"),
    installed: () => existsSync(process.env.CODEX_HOME || join(home(), ".codex")),
    after: "Start Codex again." },
  { id: "gemini-cli", name: "Gemini CLI", format: "json", key: "mcpServers", file: () => join(home(), ".gemini", "settings.json"),
    installed: () => existsSync(join(home(), ".gemini")),
    after: "Start Gemini CLI again." },
  { id: "windsurf", name: "Windsurf", format: "json", key: "mcpServers", file: () => join(home(), ".codeium", "windsurf", "mcp_config.json"),
    installed: () => existsSync(join(home(), ".codeium", "windsurf")),
    after: "Press Refresh in Windsurf's MCP panel." },
  { id: "vscode", name: "VS Code", format: "json", key: "servers", vscode: true,
    file: () => join(configDir("Code/User", "Code/User", "Code/User"), "mcp.json"),
    installed: () => existsSync(configDir("Code/User", "Code/User", "Code/User")),
    after: "VS Code shows it in its MCP servers list; start it there." },
  { id: "lm-studio", name: "LM Studio", format: "json", key: "mcpServers", file: () => join(home(), ".lmstudio", "mcp.json"),
    installed: () => existsSync(join(home(), ".lmstudio")),
    after: "LM Studio reloads its mcp.json by itself." },
];

// Claude Code keeps its user wide MCP servers in ~/.claude.json (or CLAUDE_CONFIG_DIR's).
function claudeJson() {
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  return dir ? join(dir, ".claude.json") : join(home(), ".claude.json");
}

export type AppStatus = "added" | "old" | "not added" | "broken" | "not installed";
export interface AppView { id: string; name: string; status: AppStatus; file: string; after: string; manual: string | null; note: string | null }

const NAME = "leanfare";
export const entry = () => selfCommand("mcp");
// An entry is Leanfare's own when it runs "leanfare mcp", ".../cli.ts mcp" or the compiled file with mcp.
const isOurs = (e: any) => !!e && typeof e.command === "string" && Array.isArray(e.args) && e.args.at(-1) === "mcp";
const same = (e: any) => { const x = entry(); return isOurs(e) && e.command === x.command && JSON.stringify(e.args) === JSON.stringify(x.args); };

// ---- JSON files ---------------------------------------------------------------------------

function readJson(file: string): { ok: true; j: any } | { ok: false } {
  if (!existsSync(file)) return { ok: true, j: {} };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { ok: true, j: {} };
  try { const j = JSON.parse(text); return j && typeof j === "object" && !Array.isArray(j) ? { ok: true, j } : { ok: false }; } catch { return { ok: false }; }
}

function writeWhole(file: string, text: string) {
  if (existsSync(file)) copyFileSync(file, `${file}.leanfare-backup`);
  let target = file;
  try { target = realpathSync(file); } catch {}
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.leanfare-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, target);
}

function jsonStatus(a: AppDef): AppStatus {
  const r = readJson(a.file());
  if (!r.ok) return "broken";
  const e = r.j?.[a.key!]?.[NAME];
  return !e ? "not added" : same(e) ? "added" : "old";
}

function jsonSet(a: AppDef, on: boolean) {
  const r = readJson(a.file());
  if (!r.ok) throw new Error(`${a.name}'s settings file (${a.file()}) is not valid JSON, so Leanfare left it alone. Fix it in a text editor, then try again.`);
  const j = r.j;
  const servers = j[a.key!] && typeof j[a.key!] === "object" ? j[a.key!] : {};
  if (on) servers[NAME] = a.vscode ? { type: "stdio", ...entry() } : entry();
  else delete servers[NAME];
  j[a.key!] = servers;
  writeWhole(a.file(), JSON.stringify(j, null, 2) + "\n");
}

// ---- Codex's TOML ---------------------------------------------------------------------------

const TOML_HEAD = /^\[mcp_servers\.leanfare\]\s*$/m;
// Leanfare's block: its header to the next table header (or the end).
function tomlBlock(text: string): { start: number; end: number } | null {
  const m = TOML_HEAD.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^\s*\[/m.exec(rest);
  return { start: m.index, end: next ? m.index + m[0].length + next.index : text.length };
}
const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string is written like a JSON one
const tomlEntry = () => { const e = entry(); return `[mcp_servers.leanfare]\ncommand = ${tomlString(e.command)}\nargs = [${e.args.map(tomlString).join(", ")}]\n`; };

function tomlStatus(a: AppDef): AppStatus {
  const file = a.file();
  if (!existsSync(file)) return "not added";
  const text = readFileSync(file, "utf8");
  const b = tomlBlock(text);
  if (!b) return "not added";
  return text.slice(b.start, b.end).trim() === tomlEntry().trim() ? "added" : "old";
}

function tomlSet(a: AppDef, on: boolean) {
  const file = a.file();
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const b = tomlBlock(text);
  if (b) text = text.slice(0, b.start) + text.slice(b.end);
  if (on) text = (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + tomlEntry();
  text = text.replace(/\n{3,}/g, "\n\n");
  writeWhole(file, text.trim() ? text.trimEnd() + "\n" : "");
}

// ---- Claude Code, through its own command -------------------------------------------------

async function claudeBin(): Promise<string | null> {
  if (process.env.LEANFARE_CLAUDE_BIN) return existsSync(process.env.LEANFARE_CLAUDE_BIN) ? process.env.LEANFARE_CLAUDE_BIN : null;
  const sh = await shellEnv();
  const dirs = [...(process.env.PATH ?? "").split(":"), ...(sh.PATH ?? "").split(":"), join(home(), ".claude", "local"), join(home(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) if (d && existsSync(join(d, win() ? "claude.exe" : "claude"))) return join(d, win() ? "claude.exe" : "claude");
  return null;
}

function claudeStatus(): AppStatus {
  const r = readJson(claudeJson());
  if (!r.ok) return "broken";
  const e = r.j?.mcpServers?.[NAME];
  return !e ? "not added" : same(e) ? "added" : "old";
}

const shq = (s: string) => (/^[\w./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const claudeAddLine = () => { const e = entry(); return `claude mcp add --scope user leanfare -- ${[e.command, ...e.args].map(shq).join(" ")}`; };

async function runClaude(args: string[]): Promise<{ ok: boolean; out: string }> {
  const bin = await claudeBin();
  if (!bin) return { ok: false, out: "Leanfare did not find the claude command." };
  let p: ReturnType<typeof Bun.spawn>;
  // env given on purpose: Bun.spawn otherwise hands the child the environment Leanfare started with.
  try { p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } }); }
  catch (e: any) { return { ok: false, out: `The claude command did not start (${String(e?.message ?? e)}).` }; }
  const timer = setTimeout(() => p.kill(), 30_000);
  const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
  clearTimeout(timer);
  return { ok: (await p.exited) === 0, out: (out + err).trim() };
}

async function claudeSet(on: boolean) {
  // Replacing an old entry: remove it first (claude mcp add will not overwrite one).
  if (claudeStatus() !== "not added") { const r = await runClaude(["mcp", "remove", "--scope", "user", NAME]); if (!r.ok && on === false) throw new Error(r.out || "claude mcp remove failed."); }
  if (on) {
    const e = entry();
    const r = await runClaude(["mcp", "add", "--scope", "user", NAME, "--", e.command, ...e.args]);
    if (!r.ok) throw new Error(`${r.out || "claude mcp add failed."} You can run it in Terminal instead: ${claudeAddLine()}`);
  }
}

// ---- what the screen and the command line use ---------------------------------------------

export function appStatus(a: AppDef): AppStatus {
  const st = a.format === "json" ? jsonStatus(a) : a.format === "toml" ? tomlStatus(a) : claudeStatus();
  if (st === "not added" && !a.installed()) return "not installed";
  return st;
}

export function appsView(): AppView[] {
  return APPS.map((a) => {
    const status = appStatus(a);
    return {
      id: a.id, name: a.name, status, file: a.file(), after: a.after,
      manual: a.format === "claude-cli" ? claudeAddLine() : null,
      note: status === "broken" ? `Its settings file (${a.file()}) is not valid ${a.format === "toml" ? "TOML" : "JSON"}, so Leanfare leaves it alone.` : status === "old" ? "Added before, from another copy of Leanfare: press Update to point it at this one." : null,
    };
  });
}

export async function setApp(id: string, on: boolean): Promise<AppView> {
  const a = APPS.find((x) => x.id === id);
  if (!a) throw new Error(`Leanfare does not know an app called ${id}.`);
  if (a.format === "json") jsonSet(a, on);
  else if (a.format === "toml") tomlSet(a, on);
  else await claudeSet(on);
  return appsView().find((v) => v.id === id)!;
}
