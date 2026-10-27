// Your ChatGPT plan, through Codex. A plan's reading, drafting and working out parts can run on OpenAI's
// own Codex command (codex exec, signed in with ChatGPT) instead of on a pay per use model: they count
// toward the plan's Codex limits, and Leanfare pays nothing for them. Codex runs each part read only (its
// sandbox: no file changes, no commands that change anything), in the folder of the part's files, with
// the part's task on its input, and without your MCP servers, apps, plugins, hooks or browser, which act
// outside its sandbox. Only with the switch in Settings on (off until you turn it on), only when Codex is
// signed in with ChatGPT (an API key would bill per use), never when you work in Codex itself, and only
// while the ChatGPT plan is under 85% of its 5 hours and its week (when Leanfare can read them). Leanfare
// keeps no words: the answer goes to the plan, as any part's does.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { planView, windowsNow } from "./plans";
import { settings } from "./settings";
import { shellEnv } from "./shellenv";
import { UserError } from "./upstream";
import { redact } from "./util";

export const CODEX_ID = "codex";
export const CODEX_LABEL = "Codex (your ChatGPT plan)";
export const CODEX_WAIT_MS = 15 * 60_000; // the longest one part may take
const NEAR = 85; // percent of a ChatGPT window used: from here on, Codex is left alone
const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());

// ---- the codex command --------------------------------------------------------------------------
// npm, Bun and pnpm install Codex as a small Node script (on Windows, npm adds codex.cmd) that starts
// Codex's own program from a package for this computer. Leanfare starts that program itself, so Codex
// runs without Node on the PATH (the Mac app starts without the shell's PATH) and on Windows.
const TRIPLE: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
};
export function nativeCodex(found: string, platform: string = process.platform, arch: string = process.arch): string {
  let real = found;
  try { real = realpathSync(found); } catch {}
  const pkg = /\.(cmd|ps1)$/i.test(found) ? join(dirname(found), "node_modules", "@openai", "codex")
    : /[\\/]bin[\\/]codex\.js$/.test(real) ? dirname(dirname(real)) : null;
  const key = `${platform}-${arch}`;
  if (!pkg || !TRIPLE[key]) return found;
  const exe = platform === "win32" ? "codex.exe" : "codex";
  for (const root of [join(pkg, "node_modules", "@openai", `codex-${key}`), join(dirname(pkg), `codex-${key}`), pkg]) {
    for (const sub of ["bin", "codex"]) { const p = join(root, "vendor", TRIPLE[key], sub, exe); if (existsSync(p)) return p; }
  }
  return found;
}

// Where it is: on the PATH Leanfare started with, the login shell's PATH (the Mac app starts without it),
// or where its installers put it.
export async function codexBin(): Promise<string | null> {
  const given = process.env.LEANFARE_CODEX_BIN;
  if (given !== undefined) return given && existsSync(given) ? given : null;
  const sh = await shellEnv();
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...(sh.PATH ?? "").split(delimiter),
    ...(process.platform === "win32" && process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : []),
    join(home(), ".local", "bin"), join(home(), ".npm-global", "bin"), join(home(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) for (const n of names) if (d && existsSync(join(d, n))) return nativeCodex(join(d, n));
  return null;
}

// The PATH Codex runs with: its own folder, Leanfare's PATH and the login shell's, so the commands it
// runs (and Node, for a Codex that is still a Node script) are found as in Terminal.
async function childEnv(bin: string): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return { ...process.env };
  const sh = await shellEnv();
  const parts = [dirname(bin), ...(process.env.PATH ?? "").split(delimiter), ...(sh.PATH ?? "").split(delimiter)].filter(Boolean);
  return { ...process.env, PATH: [...new Set(parts)].join(delimiter) };
}

// Ends the command and everything it started: Codex runs commands of its own. Leanfare quitting ends
// the runs it started too.
const live = new Set<ChildProcess>();
process.on("exit", () => { for (const p of live) endAll(p); });
function endAll(p: ChildProcess) {
  if (p.pid === undefined || p.exitCode !== null) return;
  if (process.platform === "win32") { try { spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} return; }
  try { process.kill(-p.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch {} }, 2000).unref?.();
}

// The codex command, run off the server's thread: what it printed and its exit code.
async function run(bin: string, args: string[], opts: { cwd?: string; input?: string; signal?: AbortSignal; ms: number }): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  const env = await childEnv(bin);
  return new Promise((done) => {
    let p: ChildProcess;
    // Its own process group (not on Windows), so Stop and the time limit end the commands it started too.
    try { p = spawn(bin, args, { cwd: opts.cwd, env, stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }); }
    catch (e: any) { done({ code: null, out: "", err: String(e?.message ?? e), timedOut: false }); return; }
    live.add(p);
    let out = "", err = "", timedOut = false, finished = false;
    const MAX = 1_000_000;
    p.stdout?.on("data", (d) => { if (out.length < MAX) out += d; });
    p.stderr?.on("data", (d) => { if (err.length < MAX) err += d; });
    const timer = setTimeout(() => { timedOut = true; endAll(p); }, opts.ms);
    const stop = () => endAll(p);
    opts.signal?.addEventListener("abort", stop, { once: true });
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      live.delete(p);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      done({ code, out, err, timedOut });
    };
    p.on("error", (e) => { err += String((e as any)?.message ?? e); finish(null); });
    // Its output, once it has ended: a command it started may still hold the output open, and the answer
    // is in its file anyway, so this waits at most two seconds for the rest.
    p.on("exit", (code) => { setTimeout(() => finish(code), 2000).unref?.(); });
    p.on("close", (code) => finish(code));
    if (opts.input !== undefined) { p.stdin?.on("error", () => {}); p.stdin?.end(opts.input); }
  });
}

// ---- whether Codex is there and signed in with ChatGPT ---------------------------------------------
// login: how Codex is signed in. Only "chatgpt" uses the ChatGPT plan; "other" (an API key, or another
// kind of login) would be billed per use, so Leanfare does not use it.
export interface CodexState { installed: boolean; signedIn: boolean; login: "chatgpt" | "other" | null; version: string | null; checked: string }
let state: CodexState | null = null;
let at = 0;
let pending: Promise<CodexState> | null = null;
export function forgetCodex() { state = null; at = 0; pending = null; }
export async function codexState(fresh = false): Promise<CodexState> {
  if (!fresh && state && Date.now() - at < 60_000) return state;
  pending ??= (async () => {
    const bin = await codexBin();
    const s: CodexState = { installed: !!bin, signedIn: false, login: null, version: null, checked: new Date().toISOString() };
    if (bin) {
      const v = await run(bin, ["--version"], { ms: 10_000 });
      if (v.code === 0) s.version = v.out.match(/\d+\.\d+\.\d+/)?.[0] ?? (v.out.trim().slice(0, 40) || null);
      // Codex says how it is signed in ("Logged in using ChatGPT", "API key configured - sk-...") and ends
      // with 0 for any sign in; Leanfare reads only that line, never the sign in itself.
      const l = await run(bin, ["login", "status"], { ms: 10_000 });
      if (l.code === 0) s.login = /Logged in using ChatGPT/i.test(`${l.out}\n${l.err}`) ? "chatgpt" : "other";
      s.signedIn = s.login === "chatgpt";
    }
    state = s; at = Date.now();
    return s;
  })().finally(() => { pending = null; });
  return pending;
}

// Whether a plan may put parts on Codex now: ok, or why not (null: nothing to say, as when it is off).
export async function codexFor(manager: string): Promise<{ ok: boolean; why: string | null }> {
  if (!settings().codexPlan) return { ok: false, why: null };
  if (/codex|chatgpt/i.test(manager)) return { ok: false, why: null }; // you work in Codex: its parts are yours anyway
  const s = await codexState();
  if (!s.installed) return { ok: false, why: "Codex is not on this computer (Settings, Your ChatGPT plan through Codex, says how to get it)" };
  if (s.login === "other") return { ok: false, why: "Codex is signed in with an API key or another login, not with ChatGPT, so its use would be billed (run codex login in Terminal and sign in with ChatGPT)" };
  if (!s.signedIn) return { ok: false, why: "Codex is not signed in (run codex login in Terminal)" };
  let w: { five: number | null; week: number | null } = { five: null, week: null };
  try { w = windowsNow("chatgpt", await planView("chatgpt")); } catch {}
  const near = [w.five !== null && w.five >= NEAR ? `the 5 hours at ${Math.round(w.five)}%` : "", w.week !== null && w.week >= NEAR ? `the week at ${Math.round(w.week)}%` : ""].filter(Boolean).join(", ");
  if (near) return { ok: false, why: `your ChatGPT plan is near its limit (${near})` };
  return { ok: true, why: null };
}

// ---- running one part -----------------------------------------------------------------------
// At most two Codex runs at once: each is a whole agent, and they share the plan's limits. A slot that
// frees goes straight to the next run waiting; a run stopped while it waits leaves the line.
const AT_ONCE = 2;
let busy = 0;
const queue: (() => void)[] = [];
async function slot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
  if (busy < AT_ONCE) busy++;
  else {
    await new Promise<void>((go, fail) => {
      const take = () => { signal.removeEventListener("abort", leave); go(); };
      const leave = () => { const i = queue.indexOf(take); if (i >= 0) queue.splice(i, 1); fail(new UserError(499, "Stopped.", "stopped")); };
      queue.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
  let freed = false;
  return () => { if (freed) return; freed = true; const next = queue.shift(); if (next) next(); else busy--; };
}
export const codexBusy = () => ({ running: busy, waiting: queue.length }); // for tests

const tail = (s: string) => redact(s.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ")).slice(0, 300) || "no details";

// What Codex would bring that acts outside its sandbox, turned off for a part (a name it does not know is
// ignored): ChatGPT's apps, plugins, hooks, the browser and the computer.
const OFF = ["apps", "plugins", "remote_plugin", "hooks", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation"];
// The MCP servers Codex would start in this folder (yours, and a project's), each turned off for the part:
// they run outside the sandbox (Leanfare's own among them, whose tools spend money).
async function mcpOff(bin: string, cwd: string, signal: AbortSignal): Promise<string[]> {
  const r = await run(bin, ["mcp", "list", "--json"], { cwd, signal, ms: 20_000 });
  let list: unknown;
  try { list = JSON.parse(r.out); } catch { list = null; }
  if (r.code !== 0 || !Array.isArray(list)) throw new UserError(502, `Leanfare could not see which MCP servers Codex would start, so this part did not run on Codex (it runs them outside its sandbox). Update Codex (npm install -g @openai/codex) and try again: ${tail(r.err || r.out)}`, "codex_mcp");
  const on = list.filter((s: any) => s && typeof s.name === "string" && s.enabled !== false).map((s: any) => s.name as string);
  const odd = on.find((n) => !/^[A-Za-z0-9_-]+$/.test(n));
  if (odd) throw new UserError(400, `Codex has an MCP server named ${JSON.stringify(odd.slice(0, 40))}, which Leanfare cannot turn off for a part, so this part did not run on Codex. Rename it in Codex's config.toml.`, "codex_mcp");
  return on.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]);
}

export interface CodexPart { n: number; title: string; task: string; folder: string | null; files: string[]; effort: "low" | "medium" | "high" }
export function codexPrompt(p: CodexPart): string {
  return [
    "This is one part of a larger task, handed to you on its own. Read what it needs and answer. Do not change any file, and do not run anything that changes the project.",
    "", `Part ${p.n}: ${p.title}`, "", p.task, "",
    p.files.length ? `The files it reads, from this folder: ${p.files.join(", ")}` : "No files were named for this part: answer from the task itself.",
    "", "Answer in Markdown, as briefly as the part allows.",
  ].join("\n");
}

export function codexArgs(effort: CodexPart["effort"], answerFile: string, extra: string[] = []): string[] {
  return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-c", 'approval_policy="never"', "-c", `model_reasoning_effort="${effort}"`,
    ...OFF.flatMap((f) => ["-c", `features.${f}=false`]), ...extra, "-o", answerFile, "-"];
}

export async function runCodex(p: CodexPart, signal: AbortSignal, ms = CODEX_WAIT_MS): Promise<{ answer: string; seconds: number }> {
  const bin = await codexBin();
  if (!bin) throw new UserError(503, "Codex is not on this computer (any more), so this part did not run.", "codex_missing");
  const free = await slot(signal);
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "leanfare-codex-"));
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    const answerFile = join(dir, "answer.md");
    // With no folder named, an empty one: Codex reads nothing of yours it was not handed.
    const cwd = p.folder && existsSync(p.folder) ? p.folder : dir;
    const servers = await mcpOff(bin, cwd, signal);
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    const t0 = performance.now();
    const r = await run(bin, codexArgs(p.effort, answerFile, servers), { cwd, input: codexPrompt(p), signal, ms });
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    if (r.timedOut) throw new UserError(504, `Codex did not finish this part within ${Math.round(ms / 60_000)} minutes.`, "codex_timeout");
    if (r.code !== 0) throw new UserError(502, `Codex stopped with an error: ${tail(r.err || r.out)}`, "codex_failed");
    const answer = existsSync(answerFile) ? readFileSync(answerFile, "utf8").trim() : "";
    if (!answer) throw new UserError(502, "Codex finished without an answer.", "codex_empty");
    return { answer, seconds: (performance.now() - t0) / 1000 };
  } finally {
    free();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
