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
import { VERSION } from "./config";
import { planView, windowsNow } from "./plans";
import { saveSettings, settings } from "./settings";
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
export function forgetCodex() { state = null; at = 0; pending = null; picked = null; offered = null; }
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

export interface CodexPart { n: number; title: string; task: string; folder: string | null; files: string[]; effort: "low" | "medium" | "high"; search?: boolean } // search: Codex's own web search on (0.13)
export function codexPrompt(p: CodexPart): string {
  return [
    "This is one part of a larger task, handed to you on its own. Read what it needs and answer. Do not change any file, and do not run anything that changes the project.",
    "", `Part ${p.n}: ${p.title}`, "", p.task, "",
    p.files.length ? `The files it reads, from this folder: ${p.files.join(", ")}` : "No files were named for this part: answer from the task itself.",
    ...(p.search ? ["", "Search the web for what the part asks, and name the pages you used."] : []),
    "", "Answer in Markdown, as briefly as the part allows.",
  ].join("\n");
}

export function codexArgs(effort: CodexPart["effort"], answerFile: string, extra: string[] = [], model: string | null = null): string[] {
  return ["exec", ...(model ? ["-m", model] : []), "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-c", 'approval_policy="never"', "-c", `model_reasoning_effort="${effort}"`,
    ...OFF.flatMap((f) => ["-c", `features.${f}=false`]), ...extra, "-o", answerFile, "-"];
}

// ---- the model: one the ChatGPT plan offers (0.13.1) ---------------------------------------------
// Codex runs a part on the model its settings name (~/.codex/config.toml), or on its own pick when they name none.
// ChatGPT sign in drops older models from time to time (GPT-5.5 on 14 Oct 2026), and a setting that still names one
// stops every part: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account". Then Leanfare asks
// Codex which models it offers this account (its app server's model list, the one its pickers show, else `codex debug
// models`), runs the part again on Codex's own pick (then the next, up to three in all), and keeps that model for the
// next parts until Leanfare restarts. The receipt says so, and how to change the setting.
const NOT_OFFERED = /not supported when using Codex with a ChatGPT account/i;
// The model Codex was refused, from what it printed: its name, "" when it gave none, null when this is another error.
export function notOffered(said: string): string | null {
  if (!NOT_OFFERED.test(said)) return null;
  return /'([^'\s]{1,80})' model is not supported/i.exec(said)?.[1] ?? "";
}
let picked: { model: string; instead: string } | null = null;
let offered: { at: number; list: string[] } | null = null;
export const codexPicked = () => picked;

// The models Codex offers the account it is signed in with, its own pick first, without those it offers an upgrade
// from; [] when it cannot say. Asked at most every 6 hours.
export async function codexModels(bin: string, signal?: AbortSignal): Promise<string[]> {
  if (offered && Date.now() - offered.at < 6 * 3_600_000) return offered.list;
  let list = await modelList(bin, signal);
  if (!list?.length && !signal?.aborted) {
    const r = await run(bin, ["debug", "models"], { signal, ms: 20_000 });
    try {
      const all = JSON.parse(r.out)?.models;
      list = Array.isArray(all) ? all.filter((m: any) => typeof m?.slug === "string" && m.visibility === "list" && !m.upgrade).sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99)).map((m: any) => m.slug as string) : [];
    } catch { list = []; }
  }
  if (list?.length) offered = { at: Date.now(), list };
  return list ?? [];
}
// Codex's app server (codex app-server, JSON lines on its input and output): initialize, then model/list. null when
// it does not answer within 20 seconds.
async function modelList(bin: string, signal?: AbortSignal): Promise<string[] | null> {
  const env = await childEnv(bin);
  return new Promise((done) => {
    let p: ChildProcess;
    try { p = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true }); }
    catch { done(null); return; }
    live.add(p);
    let buf = "", over = false;
    const end = (v: string[] | null) => {
      if (over) return;
      over = true; clearTimeout(timer); signal?.removeEventListener("abort", stop); live.delete(p); endAll(p); done(v);
    };
    const stop = () => end(null);
    const timer = setTimeout(stop, 20_000);
    signal?.addEventListener("abort", stop, { once: true });
    p.on("error", stop);
    p.on("exit", stop);
    p.stdout?.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o: any = null;
        try { o = JSON.parse(line); } catch { continue; }
        if (o?.id !== 2) continue;
        const data = Array.isArray(o.result?.data) ? o.result.data : [];
        const ok = data.filter((m: any) => typeof m?.model === "string" && !m.hidden && !m.upgrade);
        end([...ok.filter((m: any) => m.isDefault), ...ok.filter((m: any) => !m.isDefault)].map((m: any) => m.model as string));
        return;
      }
    });
    p.stdin?.on("error", () => {});
    const send = (o: object) => p.stdin?.write(JSON.stringify(o) + "\n");
    send({ method: "initialize", id: 1, params: { clientInfo: { name: "leanfare", title: "Leanfare", version: VERSION }, capabilities: null } });
    send({ method: "initialized" });
    send({ method: "model/list", id: 2, params: {} });
  });
}

export async function runCodex(p: CodexPart, signal: AbortSignal, ms = CODEX_WAIT_MS): Promise<{ answer: string; seconds: number; model: string | null; note: string | null }> {
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
    const go = (m: string | null) => run(bin, [...(p.search ? ["--search"] : []), ...codexArgs(p.effort, answerFile, servers, m)], { cwd, input: codexPrompt(p), signal, ms });
    let model = picked?.model ?? null;
    let r = await go(model);
    const bad = r.code !== 0 && !r.timedOut && !signal.aborted ? notOffered(`${r.err}\n${r.out}`) : null;
    if (bad !== null) {
      const tries = (await codexModels(bin, signal)).filter((m) => m !== bad && m !== model).slice(0, 3);
      for (const m of tries) {
        if (signal.aborted) break;
        r = await go(m);
        model = m;
        if (r.code === 0 || r.timedOut || notOffered(`${r.err}\n${r.out}`) === null) break; // it ran, or failed for another reason
      }
      if (r.code === 0 && model) picked = { model, instead: bad };
      else if (!signal.aborted && !r.timedOut && notOffered(`${r.err}\n${r.out}`) !== null)
        throw new UserError(502, `Codex's settings name ${bad || "a model"}, which ChatGPT sign in does not offer${tries.length ? `, and Codex did not run ${tries.join(", ")} either` : ", and Codex did not say which models it offers"}. Remove the model line from ~/.codex/config.toml (or set a model your plan has), or run codex and pick one with /model.`, "codex_model");
    }
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    if (r.timedOut) throw new UserError(504, `Codex did not finish this part within ${Math.round(ms / 60_000)} minutes.`, "codex_timeout");
    if (r.code !== 0) throw new UserError(502, `Codex stopped with an error: ${tail(r.err || r.out)}`, "codex_failed");
    const answer = existsSync(answerFile) ? readFileSync(answerFile, "utf8").trim() : "";
    if (!answer) throw new UserError(502, "Codex finished without an answer.", "codex_empty");
    const note = picked && model === picked.model ? `Codex's settings name ${picked.instead || "a model"}, which your ChatGPT plan does not offer, so it ran on ${picked.model}, a model Codex offers you. To make that stick, remove the model line from ~/.codex/config.toml.` : null;
    return { answer, seconds: (performance.now() - t0) / 1000, model, note };
  } finally {
    free();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// ---- one press: Connect ChatGPT (0.13) -------------------------------------------------------------
// The ChatGPT row next to your apps does the steps a person would do in Terminal: install Codex when it is not here
// (npm's package, else Homebrew's), start `codex login` (it opens ChatGPT's sign in page in the browser; the link is
// shown too, in case it cannot), and, once Codex says it is signed in with ChatGPT, turn on hand offs on the ChatGPT
// plan. Making a ChatGPT account, in the browser, is the person's part. Nothing else on the computer changes.
export type ConnectStep = "idle" | "installing" | "signing_in" | "connected" | "failed";
export interface Connect { step: ConnectStep; why: string | null; url: string | null; since: string | null }
let connect: Connect = { step: "idle", why: null, url: null, since: null };
let loginProc: ChildProcess | null = null;
export const connectState = (): Connect => connect;
export function forgetConnect() { if (loginProc) endAll(loginProc); loginProc = null; connect = { step: "idle", why: null, url: null, since: null }; }
const SIGN_IN_MS = 10 * 60_000; // how long the sign in page may wait for the person

async function findTool(name: string): Promise<string | null> {
  const sh = await shellEnv();
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...(sh.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  return null;
}

// Installs Codex: npm's package first, else Homebrew's. LEANFARE_CODEX_INSTALL names the command instead (the tests).
export async function installCodex(signal?: AbortSignal): Promise<{ ok: boolean; why: string | null }> {
  const given = process.env.LEANFARE_CODEX_INSTALL;
  const npm = given ? null : await findTool(process.platform === "win32" ? "npm.cmd" : "npm");
  const brew = given || npm || process.platform === "win32" ? null : await findTool("brew");
  const cmd = given ? [given] : npm ? [npm, "install", "-g", "@openai/codex"] : brew ? [brew, "install", "codex"] : null;
  if (!cmd) return { ok: false, why: "Codex installs with npm (part of Node.js, from nodejs.org) or Homebrew (brew.sh), and neither is on this computer. Install one, then press Connect again." };
  const r = await run(cmd[0], cmd.slice(1), { signal, ms: 5 * 60_000 });
  forgetCodex();
  if (r.code !== 0) return { ok: false, why: `Installing Codex did not work (${tail(r.err || r.out)}). In Terminal: ${brew ? "brew install codex" : "npm install -g @openai/codex"}, then press Connect again.` };
  return { ok: true, why: null };
}

// Starts `codex login` and keeps the sign in link it prints; it ends by itself once the person has signed in.
async function startLogin(bin: string) {
  if (loginProc && loginProc.exitCode === null) return;
  const env = await childEnv(bin);
  let p: ChildProcess;
  try { p = spawn(bin, ["login"], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }); }
  catch (e: any) { connect = { ...connect, step: "failed", why: `Codex could not start its sign in (${String(e?.message ?? e)}). In Terminal: codex login.` }; return; }
  loginProc = p;
  live.add(p);
  const seen = (d: unknown) => { const m = /https:\/\/[^\s"'<>]*(auth|login|oauth)[^\s"'<>]*/i.exec(String(d)); if (m && !connect.url) connect = { ...connect, url: m[0] }; };
  p.stdout?.on("data", seen);
  p.stderr?.on("data", seen);
  const timer = setTimeout(() => endAll(p), SIGN_IN_MS);
  p.on("exit", () => { clearTimeout(timer); live.delete(p); if (loginProc === p) loginProc = null; });
}

// One press: where Codex stands, and the next step taken. The screen asks again every 2 seconds while it is going.
export async function connectChatGPT(): Promise<Connect> {
  if (connect.step === "installing") return connect;
  connect = { step: "installing", why: null, url: null, since: new Date().toISOString() };
  let s = await codexState(true);
  if (!s.installed) {
    const r = await installCodex();
    if (!r.ok) return (connect = { ...connect, step: "failed", why: r.why });
    s = await codexState(true);
    if (!s.installed) return (connect = { ...connect, step: "failed", why: "Codex was installed but Leanfare cannot find it. In Terminal: codex --version, then press Connect again." });
  }
  if (s.login === "other") return (connect = { ...connect, step: "failed", why: "Codex is signed in with an API key, which bills per use, so Leanfare does not use it. In Terminal: codex logout, then press Connect again to sign in with ChatGPT." });
  if (s.signedIn) return connected();
  await startLogin((await codexBin())!);
  if (connect.step !== "failed") connect = { ...connect, step: "signing_in" };
  return connect;
}
function connected(): Connect {
  if (!settings().codexPlan) saveSettings({ codexPlan: true });
  if (loginProc) { endAll(loginProc); loginProc = null; }
  return (connect = { ...connect, step: "connected", why: null });
}
// While the sign in is open: the screen's look at Codex finishes the connection once Codex says it is signed in.
export async function connectProgress(): Promise<Connect> {
  if (connect.step !== "signing_in") return connect;
  const s = await codexState(true);
  if (s.signedIn) return connected();
  if (!loginProc) connect = { ...connect, step: "failed", why: "The ChatGPT sign in ended before it finished. Press Connect to try again." };
  return connect;
}
