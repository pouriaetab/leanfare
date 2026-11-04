// Your Google account's Gemini, through Gemini CLI (0.14.1, his loop: "if possible other platform own models"): a plan's
// reading, drafting and working out parts run on Gemini CLI signed in with your Google account, in its own allowance,
// before any paid model, as Codex runs them on your ChatGPT plan. Read only: one prompt (gemini -p) in plan mode, where
// anything that would ask to change a file or run a command is refused, in the folder that holds the part's files (an
// empty one when it names none). When you work in Gemini CLI itself, its parts go to a lighter Gemini model this way.
// Claude Code is not used this way for other apps: Anthropic's terms do not allow a tool to drive a Claude plan.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { settings } from "./settings";
import { shellEnv } from "./shellenv";
import { UserError } from "./upstream";

export const GEMINI_CLI_ID = "gemini-cli/auto";
export const GEMINI_CLI_LABEL = "Gemini CLI";
export const GEMINI_CLI_WAIT_MS = 180_000;
// The lighter model a part of Gemini CLI's own goes to (LEANFARE_GEMINI_LIGHT names another); refused, Gemini CLI's own pick.
export const lightModel = () => process.env.LEANFARE_GEMINI_LIGHT?.trim() || "gemini-3.8-flash";
const home = () => process.env.HOME || homedir();

export async function geminiCliBin(): Promise<string | null> {
  const given = process.env.LEANFARE_GEMINI_BIN;
  if (given !== undefined) return given && existsSync(given) ? given : null;
  const sh = await shellEnv();
  const names = process.platform === "win32" ? ["gemini.cmd", "gemini.exe"] : ["gemini"];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...(sh.PATH ?? "").split(delimiter),
    join(home(), ".local", "bin"), join(home(), ".npm-global", "bin"), join(home(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) for (const n of names) if (d && existsSync(join(d, n))) return join(d, n);
  return null;
}
// Signed in with a Google account: Gemini CLI keeps its sign in in ~/.gemini (Leanfare looks that the file is there, and
// never opens it).
export const geminiCliSignedIn = () => existsSync(join(home(), ".gemini", "oauth_creds.json"));

export interface GeminiState { installed: boolean; signedIn: boolean; on: boolean }
export async function geminiCliState(): Promise<GeminiState> {
  const bin = await geminiCliBin();
  return { installed: !!bin, signedIn: !!bin && geminiCliSignedIn(), on: !!settings().geminiCliPlan };
}

// Whether a plan's parts may run on Gemini CLI now, and why not; own: you work in Gemini CLI, so its parts go to a lighter
// Gemini model on the same account.
export async function geminiCliFor(manager: string): Promise<{ ok: boolean; why: string | null; own: boolean }> {
  const own = /gemini/i.test(manager);
  if (!settings().geminiCliPlan) return { ok: false, why: null, own };
  if (!(await geminiCliBin())) return { ok: false, why: "Gemini CLI is not on this computer (Settings, Hand work to your other AI plans, says how to get it)", own };
  if (!geminiCliSignedIn()) return { ok: false, why: "Gemini CLI is not signed in with a Google account (run gemini once in Terminal and choose Sign in with Google)", own };
  return { ok: true, why: null, own };
}

export interface GeminiPart { n: number; title: string; task: string; folder: string | null; files: string[] }
export function geminiPrompt(p: GeminiPart): string {
  return [
    "This is one part of a larger task, handed to you on its own. Read what it needs and answer. Do not change any file, and do not run anything that changes the project.",
    "", `Part ${p.n}: ${p.title}`, "", p.task, "",
    p.files.length ? `The files it reads, from this folder: ${p.files.join(", ")}` : "No files were named for this part: answer from the task itself.",
    "", "Answer in Markdown, as briefly as the part allows.",
  ].join("\n");
}
export const geminiArgs = (prompt: string, model: string | null, mode = "plan") => ["-p", prompt, "--output-format", "json", "--approval-mode", mode, ...(model ? ["-m", model] : [])];
// What Gemini CLI printed: its JSON's response, or the error it gave.
export function geminiAnswer(out: string): { answer: string | null; error: string | null } {
  const start = out.indexOf("{");
  if (start < 0) return { answer: null, error: out.trim().slice(0, 300) || "Gemini CLI gave no answer." };
  try {
    const j = JSON.parse(out.slice(start));
    if (typeof j?.response === "string" && j.response.trim()) return { answer: j.response.trim(), error: null };
    return { answer: null, error: String(j?.error?.message ?? j?.error ?? "Gemini CLI gave no answer.").slice(0, 300) };
  } catch { return { answer: null, error: out.trim().slice(0, 300) }; }
}

async function once(bin: string, args: string[], cwd: string, signal: AbortSignal, ms: number): Promise<{ code: number; out: string; err: string }> {
  const sh = await shellEnv();
  const p = Bun.spawn([bin, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: [process.env.PATH, sh.PATH].filter(Boolean).join(delimiter) } });
  const stop = () => { try { p.kill(); } catch {} };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, ms);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}

export async function runGeminiCli(p: GeminiPart, signal: AbortSignal, o: { light?: boolean; ms?: number } = {}): Promise<{ answer: string; seconds: number; model: string | null }> {
  const bin = await geminiCliBin();
  if (!bin) throw new UserError(503, "Gemini CLI is not on this computer (any more), so this part did not run.", "gemini_missing");
  const t0 = Date.now();
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "leanfare-gemini-"));
    const cwd = p.folder && existsSync(p.folder) ? p.folder : dir;
    const prompt = geminiPrompt(p);
    let model: string | null = o.light ? lightModel() : null;
    let r = await once(bin, geminiArgs(prompt, model), cwd, signal, o.ms ?? GEMINI_CLI_WAIT_MS);
    if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
    let said = `${r.out}\n${r.err}`;
    // An older Gemini CLI without plan mode: its default mode, where in a prompt like this anything that asks is refused.
    if (r.code !== 0 && /approval-mode|Invalid values/i.test(said)) { r = await once(bin, geminiArgs(prompt, model, "default"), cwd, signal, o.ms ?? GEMINI_CLI_WAIT_MS); said = `${r.out}\n${r.err}`; }
    // A lighter model the account does not have: Gemini CLI's own pick.
    if (r.code !== 0 && model && /model/i.test(said) && /not found|not supported|invalid|unknown/i.test(said)) { model = null; r = await once(bin, geminiArgs(prompt, null), cwd, signal, o.ms ?? GEMINI_CLI_WAIT_MS); }
    const got = geminiAnswer(r.out);
    if (!got.answer) throw new UserError(502, `Gemini CLI did not answer: ${got.error ?? (r.err.trim().slice(0, 300) || `it stopped with code ${r.code}`)}`, "gemini_failed");
    return { answer: got.answer, seconds: (Date.now() - t0) / 1000, model };
  } finally { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}
