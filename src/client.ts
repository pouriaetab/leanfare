// Reaching the running Leanfare from another process (leanfare mcp, leanfare trial): its address
// and control token from the files it writes at start, and a start in the background when it is
// not running (as `leanfare --no-open` would).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { PORT, paths } from "./config";
import { selfCommand } from "./self";

export interface App { base: string; token: string }

// Inside the app itself (server.ts startServer): its own address and token, so a call the app runs for a door older
// than it (mcp.ts) reaches this app, never another copy found through the files.
let self: App | null = null;
export const setSelf = (a: App | null) => { self = a; };

export function where(): App {
  if (self) return self;
  if (process.env.LEANFARE_URL) return { base: process.env.LEANFARE_URL.replace(/\/+$/, ""), token: process.env.LEANFARE_TOKEN ?? "" };
  let port = PORT;
  try { port = JSON.parse(readFileSync(paths.pid, "utf8")).port ?? PORT; } catch {}
  const token = existsSync(paths.token) ? readFileSync(paths.token, "utf8").trim() : "";
  return { base: `http://127.0.0.1:${port}`, token };
}

// The running app's version, as its last health check said (0.11): a door older than its app hands calls to the app.
let seen: string | null = null;
export const seenVersion = () => seen;
export async function healthy(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j?.app !== "leanfare") return false;
    if (typeof j.version === "string") seen = j.version;
    return true;
  } catch { return false; }
}

// 0.14.1, always on: an app's door waits up to 20 seconds for a Leanfare it started (it was 10, and his Mac took longer
// while it was busy), keeps what that Leanfare said in start.log, and a start that fails says why from it.
export const startWait = () => { const n = Number(process.env.LEANFARE_START_WAIT); return n > 0 ? n : 20; };
const LOG_MAX = 1_000_000; // bytes: past it, the log starts again
export function lastSaid(file = paths.startLog): string | null {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const last = lines.filter((x) => /error|failed|cannot|could not|in use|denied|refused|not found|EADDRINUSE|EACCES/i.test(x)).at(-1) ?? lines.at(-1);
    return last ? last.replace(/\s+/g, " ").slice(0, 300) : null;
  } catch { return null; }
}
export const notStarted = (said: string | null) => `Leanfare did not start${said ? ` (it said: ${said.replace(/[.]$/, "")})` : ""}. Open it once from Terminal with: leanfare${process.platform === "darwin" ? ", or open the Leanfare app and turn on Open at Login in its menu" : ""}.`;

let starting: Promise<App> | null = null;
export async function app(): Promise<App> {
  let a = where();
  if (await healthy(a.base)) return a;
  if (process.env.LEANFARE_URL) throw new Error(`Leanfare is not answering at ${a.base}.`);
  starting ??= (async () => {
    const self = selfCommand("--no-open");
    let out: number | "ignore" = "ignore";
    try {
      mkdirSync(dirname(paths.startLog), { recursive: true });
      const big = existsSync(paths.startLog) && statSync(paths.startLog).size > LOG_MAX;
      out = openSync(paths.startLog, big ? "w" : "a");
    } catch {}
    const child = Bun.spawn([self.command, ...self.args], { stdin: "ignore", stdout: out, stderr: out, env: { ...process.env, LEANFARE_NO_OPEN: "1" } });
    child.unref();
    if (typeof out === "number") try { closeSync(out); } catch {}
    for (let i = 0; i < startWait() * 10; i++) {
      await Bun.sleep(100);
      a = where();
      if (a.token && (await healthy(a.base))) return a; // this one, or another that started meanwhile (the Mac app)
    }
    throw new Error(notStarted(lastSaid()));
  })().finally(() => { starting = null; });
  return starting;
}

export async function call(path: string, init: RequestInit & { json?: unknown } = {}, signal?: AbortSignal): Promise<any> {
  const a = await app();
  const headers: Record<string, string> = { "x-leanfare": "1", "x-leanfare-token": a.token, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) };
  const r = await fetch(a.base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(j?.error?.message ?? (typeof j?.error === "string" ? j.error : null) ?? `Leanfare answered ${r.status}.`);
  return { j, headers: r.headers };
}
