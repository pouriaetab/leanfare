// Your ChatGPT plan, through Codex. A plan's reading, drafting and working out parts can run on OpenAI's
// own Codex command (codex exec, signed in with ChatGPT) instead of on a pay per use model: they count
// toward the plan's Codex limits, and Leanfare pays nothing for them. Codex runs each part read only (its
// sandbox: no file changes, no commands that change anything), in the folder of the part's files, with
// the part's task on its input. Only with the switch in Settings on (off until you turn it on), never
// when you work in Codex itself, and only while the ChatGPT plan is under 85% of its 5 hours and its week
// (when Leanfare can read them). Leanfare keeps no words: the answer goes to the plan, as any part's does.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

// The codex command: on the PATH Leanfare started with, the login shell's PATH (the Mac app starts
// without it), or where its installers put it.
export async function codexBin(): Promise<string | null> {
  const given = process.env.LEANFARE_CODEX_BIN;
  if (given !== undefined) return given && existsSync(given) ? given : null;
  const sh = await shellEnv();
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...(sh.PATH ?? "").split(delimiter), join(home(), ".local", "bin"), join(home(), ".npm-global", "bin"), join(home(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  return null;
}

// The codex command, run off the server's thread: what it printed and its exit code.
async function run(bin: string, args: string[], opts: { cwd?: string; input?: string; signal?: AbortSignal; ms: number }): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  let p: ReturnType<typeof Bun.spawn>;
  // env given on purpose: Bun.spawn otherwise hands the child the environment Leanfare started with.
  try { p = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdin: opts.input !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } }); }
  catch (e: any) { return { code: null, out: "", err: String(e?.message ?? e), timedOut: false }; }
  if (opts.input !== undefined) { try { (p.stdin as any).write(opts.input); (p.stdin as any).end(); } catch {} }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, opts.ms);
  const stop = () => p.kill();
  opts.signal?.addEventListener("abort", stop, { once: true });
  const outP = new Response(p.stdout as ReadableStream).text(), errP = new Response(p.stderr as ReadableStream).text();
  const code = await p.exited;
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", stop);
  // What it printed, once it has ended: a command it started may still hold its output open (killed or
  // not), and the answer is in its file anyway, so this waits at most two seconds for the rest.
  const rest = (x: Promise<string>) => Promise.race([x, Bun.sleep(2000).then(() => "")]);
  const [out, err] = await Promise.all([rest(outP), rest(errP)]);
  return { code, out, err, timedOut };
}

// ---- whether Codex is there and signed in -----------------------------------------------------
export interface CodexState { installed: boolean; signedIn: boolean; version: string | null; checked: string }
let state: CodexState | null = null;
let at = 0;
let pending: Promise<CodexState> | null = null;
export function forgetCodex() { state = null; at = 0; pending = null; }
export async function codexState(fresh = false): Promise<CodexState> {
  if (!fresh && state && Date.now() - at < 60_000) return state;
  pending ??= (async () => {
    const bin = await codexBin();
    const s: CodexState = { installed: !!bin, signedIn: false, version: null, checked: new Date().toISOString() };
    if (bin) {
      const v = await run(bin, ["--version"], { ms: 10_000 });
      if (v.code === 0) s.version = v.out.match(/\d+\.\d+\.\d+/)?.[0] ?? (v.out.trim().slice(0, 40) || null);
      s.signedIn = (await run(bin, ["login", "status"], { ms: 10_000 })).code === 0; // Codex: 0 when it holds a sign in
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
  if (!s.signedIn) return { ok: false, why: "Codex is not signed in (run codex login in Terminal)" };
  let w: { five: number | null; week: number | null } = { five: null, week: null };
  try { w = windowsNow("chatgpt", await planView("chatgpt")); } catch {}
  const near = [w.five !== null && w.five >= NEAR ? `the 5 hours at ${Math.round(w.five)}%` : "", w.week !== null && w.week >= NEAR ? `the week at ${Math.round(w.week)}%` : ""].filter(Boolean).join(", ");
  if (near) return { ok: false, why: `your ChatGPT plan is near its limit (${near})` };
  return { ok: true, why: null };
}

// ---- running one part -----------------------------------------------------------------------
// At most two Codex runs at once: each is a whole agent, and they share the plan's limits.
const AT_ONCE = 2;
let busy = 0;
const queue: (() => void)[] = [];
async function slot(signal: AbortSignal): Promise<() => void> {
  if (busy >= AT_ONCE) await new Promise<void>((go) => { queue.push(go); signal.addEventListener("abort", () => go(), { once: true }); });
  busy++;
  let freed = false;
  return () => { if (freed) return; freed = true; busy--; queue.shift()?.(); };
}

const tail = (s: string) => redact(s.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ")).slice(0, 300) || "no details";

export interface CodexPart { n: number; title: string; task: string; folder: string | null; files: string[]; effort: "low" | "medium" | "high" }
export function codexPrompt(p: CodexPart): string {
  return [
    "This is one part of a larger task, handed to you on its own. Read what it needs and answer. Do not change any file, and do not run anything that changes the project.",
    "", `Part ${p.n}: ${p.title}`, "", p.task, "",
    p.files.length ? `The files it reads, from this folder: ${p.files.join(", ")}` : "No files were named for this part: answer from the task itself.",
    "", "Answer in Markdown, as briefly as the part allows.",
  ].join("\n");
}

export async function runCodex(p: CodexPart, signal: AbortSignal, ms = CODEX_WAIT_MS): Promise<{ answer: string; seconds: number }> {
  const bin = await codexBin();
  if (!bin) throw new UserError(503, "Codex is not on this computer (any more), so this part did not run.", "codex_missing");
  const free = await slot(signal);
  const dir = mkdtempSync(join(tmpdir(), "leanfare-codex-"));
  try {
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    const answerFile = join(dir, "answer.md");
    // With no folder named, an empty one: Codex reads nothing of yours it was not handed.
    const cwd = p.folder && existsSync(p.folder) ? p.folder : dir;
    const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-c", 'approval_policy="never"', "-c", `model_reasoning_effort="${p.effort}"`, "-o", answerFile, "-"];
    const t0 = performance.now();
    const r = await run(bin, args, { cwd, input: codexPrompt(p), signal, ms });
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    if (r.timedOut) throw new UserError(504, `Codex did not finish this part within ${Math.round(ms / 60_000)} minutes.`, "codex_timeout");
    if (r.code !== 0) throw new UserError(502, `Codex stopped with an error: ${tail(r.err || r.out)}`, "codex_failed");
    const answer = existsSync(answerFile) ? readFileSync(answerFile, "utf8").trim() : "";
    if (!answer) throw new UserError(502, "Codex finished without an answer.", "codex_empty");
    return { answer, seconds: (performance.now() - t0) / 1000 };
  } finally {
    free();
    rmSync(dir, { recursive: true, force: true });
  }
}
