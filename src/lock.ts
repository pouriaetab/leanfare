// The optional access key ("Other apps need a key"). Off by default, so any
// app on this computer can use Leanfare with no setup. When it is on, the
// engine addresses (/v1/...) want the key as their API key, and the screens'
// own API (/api/...) wants the session cookie the page gets once it is
// unlocked, or the control token only you can read (~/.leanfare/control.token),
// which Leanfare's own command, Mac app and MCP door use.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { settings } from "./settings";

export const COOKIE = "leanfare_session";
export const newAccessKey = () => "lf-" + randomBytes(20).toString("hex");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const sessionFor = (key: string) => createHmac("sha256", key).update("leanfare page session").digest("hex");
export const sessionCookie = (key: string) => `${COOKIE}=${sessionFor(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
export const locked = () => !!settings().accessKey;

// The key an app sent: OpenAI's clients send it as a bearer token, Anthropic's as x-api-key.
function keyFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return req.headers.get("x-api-key");
}
function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
const tokenOk = (req: Request, controlToken: string) => { const t = req.headers.get("x-leanfare-token"); return !!t && !!controlToken && same(t, controlToken); };
export const keyOk = (given: string | null | undefined) => { const k = settings().accessKey; return !!k && !!given && same(given, k); };

export function engineAllowed(req: Request, controlToken: string): boolean {
  if (!locked()) return true;
  return keyOk(keyFrom(req)) || tokenOk(req, controlToken);
}

export function pageAllowed(req: Request, controlToken: string): boolean {
  const k = settings().accessKey;
  if (!k) return true;
  const c = cookie(req, COOKIE);
  return (!!c && same(c, sessionFor(k))) || tokenOk(req, controlToken) || keyOk(keyFrom(req));
}

export const controlOk = tokenOk;
