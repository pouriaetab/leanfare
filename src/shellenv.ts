// The environment of your login shell. Leanfare started from Finder, the Dock or at login
// (the Mac app) does not get the variables your ~/.zshrc or ~/.bash_profile export, so a key
// kept there (OPENAI_API_KEY and the like) would be missed. This asks your shell for them once,
// the way VS Code does: it starts `$SHELL -i -l -c` with a command that prints a random marker,
// the environment, and the marker again, and keeps only what is between the markers (banners and
// anything else your shell prints are dropped). At most 10 seconds; on any failure, nothing.
//
// Only the names Leanfare asks for are read (provider key variables), never the rest.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

let cached: Promise<Record<string, string>> | null = null;

export function shellEnv(timeoutMs = 10_000): Promise<Record<string, string>> {
  if (process.env.LEANFARE_SHELL_ENV === "off" || process.platform === "win32") return Promise.resolve({});
  cached ??= readShellEnv(timeoutMs);
  return cached;
}
export const forgetShellEnv = () => { cached = null; };

function readShellEnv(timeoutMs: number): Promise<Record<string, string>> {
  const shell = process.env.SHELL || "/bin/zsh";
  const mark = randomBytes(6).toString("hex");
  // csh and tcsh take -ic; everything else -ilc. env -0 separates the variables with NUL bytes,
  // so a value holding a newline stays whole.
  const csh = /\/t?csh$/.test(shell);
  const cmd = `printf '%s' '${mark}'; env -0; printf '%s' '${mark}'`;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (env: Record<string, string>) => { if (!done) { done = true; clearTimeout(timer); resolve(env); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, csh ? ["-ic", cmd] : ["-ilc", cmd], {
        stdio: ["ignore", "pipe", "ignore"], detached: true,
        env: { ...process.env, LEANFARE_RESOLVING_ENVIRONMENT: "1", DISABLE_AUTO_UPDATE: "true" },
      });
    } catch { resolve({}); return; }
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} finish({}); }, timeoutMs);
    child.stdout!.on("data", (d) => { out += d; if (out.length > 4_000_000) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} finish({}); } });
    child.on("error", () => finish({}));
    child.on("close", () => finish(parseEnv(out, mark)));
  });
}

export function parseEnv(out: string, mark: string): Record<string, string> {
  const a = out.indexOf(mark), b = out.lastIndexOf(mark);
  if (a < 0 || b <= a) return {};
  const env: Record<string, string> = {};
  for (const pair of out.slice(a + mark.length, b).split("\0")) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
}
