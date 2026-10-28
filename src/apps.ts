// Use Leanfare in your apps: adds Leanfare's MCP server (its tools: plan, delegate, ask, spend, models,
// estimate, trial) to the AI apps you already use, so they work as usual with Leanfare on top. One
// press per app, undone the same way.
//
// Each app keeps its MCP servers in its own settings file. Leanfare adds or removes only its own
// entry, named "leanfare", and leaves everything else as it was:
//   - a file that is not valid JSON (or TOML), or not in the shape the app uses, is left alone,
//     and the screen says so; a TOML change that would not read back the same is not written;
//   - the file as it was before Leanfare first changed it is kept next to it (<file>.leanfare-backup);
//   - the new file is written whole, then swapped in, so the app never reads half a file;
//   - a settings file that is a link (kept with your dotfiles) stays a link;
//   - removing Leanfare from a file that does not have it changes nothing.
// Claude Code is the exception: its `claude mcp add` command does it, because Claude Code keeps
// rewriting its own file while it runs.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { selfCommand } from "./self";
import { keepingFolderTimes } from "./foldertime";
import { shellEnv } from "./shellenv";
import { autoView, setAuto, type AutoView } from "./workers";

// Your home folder as the apps see it: HOME (what your shell and the tests use), but on Windows the
// user profile, which is where the apps keep their files even when a Unix-style shell sets HOME.
const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
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
export interface AppView { id: string; name: string; status: AppStatus; file: string; after: string; manual: string | null; note: string | null; auto: AutoView | null } // auto: plan by itself (workers.ts), where the app has a way

const NAME = "leanfare";
export const entry = () => selfCommand("mcp");
// An entry is Leanfare's own when it runs "leanfare mcp", ".../cli.ts mcp" or the compiled file with mcp.
const isOurs = (e: any) => !!e && typeof e.command === "string" && Array.isArray(e.args) && e.args.at(-1) === "mcp";
const same = (e: any) => { const x = entry(); return isOurs(e) && e.command === x.command && JSON.stringify(e.args) === JSON.stringify(x.args); };

// ---- JSON files ---------------------------------------------------------------------------

const plain = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

// The file's JSON, when it is a JSON object whose servers (if any) are an object too.
function readJson(file: string, key: string): { ok: true; j: any } | { ok: false } {
  if (!existsSync(file)) return { ok: true, j: {} };
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return { ok: false }; } // a folder or an unreadable file where the settings should be: left alone

  if (!text.trim()) return { ok: true, j: {} };
  try { const j = JSON.parse(text); return plain(j) && (j[key] === undefined || plain(j[key])) ? { ok: true, j } : { ok: false }; } catch { return { ok: false }; }
}

// Where a write goes: the file, or the file a link points to (even one not there yet), so a link stays a link.
function writeTarget(file: string): string {
  try { if (lstatSync(file).isSymbolicLink()) { try { return realpathSync(file); } catch { return resolve(dirname(file), readlinkSync(file)); } } } catch {}
  return file;
}

function writeWhole(file: string, text: string) {
  const target = writeTarget(file);
  const backup = `${file}.leanfare-backup`;
  keepingFolderTimes([file, target], () => { // Leanfare's write is not use of the app (found.ts)
    if (existsSync(target) && !existsSync(backup)) copyFileSync(target, backup); // the file as it was before Leanfare first changed it
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.leanfare-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, target);
  });
}

function jsonStatus(a: AppDef): AppStatus {
  const r = readJson(a.file(), a.key!);
  if (!r.ok) return "broken";
  const e = r.j?.[a.key!]?.[NAME];
  return !e ? "not added" : same(e) ? "added" : "old";
}

function jsonSet(a: AppDef, on: boolean) {
  const r = readJson(a.file(), a.key!);
  if (!r.ok) throw new Error(`${a.name}'s settings file (${a.file()}) is not valid JSON in the shape ${a.name} uses, so Leanfare left it alone. Fix it in a text editor, then try again.`);
  const j = r.j;
  if (!on && !j[a.key!]?.[NAME]) return; // nothing to take out: the file stays as it is
  const servers = j[a.key!] ?? {};
  if (on) servers[NAME] = a.vscode ? { type: "stdio", ...entry() } : entry();
  else delete servers[NAME];
  j[a.key!] = servers;
  writeWhole(a.file(), JSON.stringify(j, null, 2) + "\n");
}

// ---- Codex's TOML ---------------------------------------------------------------------------
// Read with Bun's own TOML reader before and after: a file it cannot read is left alone, and a
// change is written only when the file reads back as before, apart from Leanfare's own entry.
// Leanfare's entry is the [mcp_servers.leanfare] table and any table under it ([...leanfare.env]).

const parseToml = (text: string): any | null => { try { return Bun.TOML.parse(text); } catch { return null; } };
// A table header for mcp_servers.leanfare or a table under it, spaced, quoted or with a comment.
const OUR_HEAD = /^\s*\[\s*("?)mcp_servers\1\s*\.\s*("?)leanfare\2\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const ANY_HEAD = /^\s*\[/;
const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string is written like a JSON one
const tomlEntry = () => { const e = entry(); return `[mcp_servers.leanfare]\ncommand = ${tomlString(e.command)}\nargs = [${e.args.map(tomlString).join(", ")}]\n`; };
const withoutOurs = (t: any) => { const c = structuredClone(t ?? {}); if (plain(c.mcp_servers)) { delete c.mcp_servers.leanfare; if (!Object.keys(c.mcp_servers).length) delete c.mcp_servers; } return c; };

// The text without Leanfare's tables; the comments just above the next table stay with it.
function tomlRemove(text: string): { text: string; found: boolean } {
  const out: string[] = [];
  let skipped: string[] | null = null, found = false;
  for (const line of text.split("\n")) {
    if (ANY_HEAD.test(line)) {
      const ours = OUR_HEAD.test(line);
      if (skipped && !ours) {
        let k = skipped.length;
        while (k > 0 && /^\s*(#.*)?$/.test(skipped[k - 1])) k--;
        out.push(...skipped.slice(k));
        skipped = null;
      }
      if (ours) { skipped ??= []; found = true; continue; }
    }
    (skipped ?? out).push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  return { text: out.join("\n"), found };
}

function tomlStatus(a: AppDef): AppStatus {
  const file = a.file();
  if (!existsSync(file)) return "not added";
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return "broken"; } // a folder or an unreadable file where config.toml should be
  const t = parseToml(text);
  if (t === null) return "broken";
  const e = plain(t.mcp_servers) ? t.mcp_servers.leanfare : undefined;
  return !e ? "not added" : same(e) && Object.keys(e).every((k) => k === "command" || k === "args") ? "added" : "old";
}

function tomlSet(a: AppDef, on: boolean) {
  const file = a.file();
  const target = writeTarget(file);
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  const was = parseToml(before);
  if (was === null) throw new Error(`${a.name}'s settings file (${file}) is not valid TOML, so Leanfare left it alone. Fix it in a text editor, then try again.`);
  const had = plain(was.mcp_servers) && was.mcp_servers.leanfare !== undefined;
  if (!on && !had) return; // nothing to take out: the file stays as it is
  const removed = tomlRemove(before);
  if (had && !removed.found) throw new Error(`Leanfare's entry in ${file} is written in a way Leanfare does not change by itself. Edit it there: ${on ? `replace it with these lines:\n${tomlEntry()}` : "delete it."}`);
  let text = removed.text.trimEnd();
  if (on) text = (text ? text + "\n\n" : "") + tomlEntry();
  text = text.trim() ? text.trimEnd() + "\n" : "";
  // Written only when it reads back as the file did, with Leanfare's entry added or gone.
  const now = parseToml(text);
  const want = on ? { command: entry().command, args: entry().args } : undefined;
  if (now === null || JSON.stringify(withoutOurs(now)) !== JSON.stringify(withoutOurs(was)) || JSON.stringify(now.mcp_servers?.leanfare) !== JSON.stringify(want)) {
    throw new Error(`Leanfare could not change ${file} safely, so it left it as it was.${on ? ` Add these lines to it yourself:\n${tomlEntry()}` : " Delete the [mcp_servers.leanfare] table yourself."}`);
  }
  writeWhole(file, text);
}

// ---- Claude Code, through its own command -------------------------------------------------

// The claude command. On Windows only claude.exe (the native install) is run; an npm install's
// claude.cmd needs a shell to run, so the screen gives the line to run in a terminal instead.
async function claudeBin(): Promise<string | null> {
  if (process.env.LEANFARE_CLAUDE_BIN) return existsSync(process.env.LEANFARE_CLAUDE_BIN) ? process.env.LEANFARE_CLAUDE_BIN : null;
  const sh = await shellEnv();
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...(sh.PATH ?? "").split(delimiter), join(home(), ".claude", "local"), join(home(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const name = win() ? "claude.exe" : "claude";
  for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  return null;
}

function claudeStatus(): AppStatus {
  const r = readJson(claudeJson(), "mcpServers");
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
      note: status === "broken" ? `Its settings file (${a.file()}) is not valid ${a.format === "toml" ? "TOML" : "JSON"} in the shape it uses, so Leanfare leaves it alone.` : status === "old" ? "Added before, from another copy of Leanfare: press Update to point it at this one." : null,
      auto: (() => { try { return autoView(a.id); } catch { return null; } })(),
    };
  });
}

export async function setApp(id: string, on: boolean): Promise<AppView> {
  const a = APPS.find((x) => x.id === id);
  if (!a) throw new Error(`Leanfare does not know an app called ${id}.`);
  if (a.format === "json") jsonSet(a, on);
  else if (a.format === "toml") tomlSet(a, on);
  else await claudeSet(on);
  // Leanfare's tools out: its plan by itself goes too (the line, the worker and the hook would point at nothing).
  if (!on) { const v = autoView(id); if (v && (v.on || v.partly)) setAuto(id, false); }
  return appsView().find((v) => v.id === id)!;
}
