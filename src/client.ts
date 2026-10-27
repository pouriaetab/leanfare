// Reaching the running Leanfare from another process (leanfare mcp, leanfare trial): its address
// and control token from the files it writes at start, and a start in the background when it is
// not running (as `leanfare --no-open` would).
import { existsSync, readFileSync } from "node:fs";
import { PORT, paths } from "./config";
import { selfCommand } from "./self";

export interface App { base: string; token: string }

export function where(): App {
  if (process.env.LEANFARE_URL) return { base: process.env.LEANFARE_URL.replace(/\/+$/, ""), token: process.env.LEANFARE_TOKEN ?? "" };
  let port = PORT;
  try { port = JSON.parse(readFileSync(paths.pid, "utf8")).port ?? PORT; } catch {}
  const token = existsSync(paths.token) ? readFileSync(paths.token, "utf8").trim() : "";
  return { base: `http://127.0.0.1:${port}`, token };
}

export async function healthy(base: string): Promise<boolean> {
  try { const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) }); return (await r.json())?.app === "leanfare"; } catch { return false; }
}

let starting: Promise<App> | null = null;
export async function app(): Promise<App> {
  let a = where();
  if (await healthy(a.base)) return a;
  if (process.env.LEANFARE_URL) throw new Error(`Leanfare is not answering at ${a.base}.`);
  starting ??= (async () => {
    const self = selfCommand("--no-open");
    const child = Bun.spawn([self.command, ...self.args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, LEANFARE_NO_OPEN: "1" } });
    child.unref();
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(100);
      a = where();
      if (a.token && (await healthy(a.base))) return a;
    }
    throw new Error("Leanfare did not start. Open it once from Terminal with: leanfare");
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
