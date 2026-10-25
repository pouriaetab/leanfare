// Connect OpenRouter by signing in on OpenRouter's own page (OAuth with PKCE),
// so there is no key to copy and paste.
//
// How it goes:
//  1. start(): Leanfare makes a random secret (the verifier), keeps it in memory,
//     and gives the page a link to OpenRouter that carries only the secret's
//     fingerprint (the challenge) and a one use state.
//  2. You sign in on OpenRouter and press Authorize. OpenRouter sends your
//     browser back to Leanfare's callback address with a one time code.
//  3. finish(): Leanfare checks the state, trades the code and the verifier for
//     a key at OpenRouter, tests the key, and returns it. The caller saves it.
//
// Everything waiting for a sign in lives in memory for 10 minutes (OpenRouter's
// own codes last as long). Nothing about an attempt is written to disk.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { baseOf } from "./config";
import { checkKey } from "./upstream";
import { now } from "./util";

export const WAIT_MS = 10 * 60_000;

const b64url = (b: Buffer) => b.toString("base64url");
// The fingerprint OpenRouter wants: base64url(SHA-256(verifier)), no padding.
export const challengeFor = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

interface Attempt {
  state: string; // emptied once used, so a second visit with it is refused
  verifier: string;
  expires: number; // epoch ms, by the app's clock
  result: { ok: boolean; message: string } | null;
}
let attempt: Attempt | null = null;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// OpenRouter's sign in page is on its site, next to the API (https://openrouter.ai/auth).
export const authUrl = () => `${baseOf("openrouter").replace(/\/api\/v1$/, "")}/auth`;
export const callbackUrl = (port: number) => `http://127.0.0.1:${port}/connect/openrouter/callback`;

export function start(port: number): { url: string; expiresIn: number } {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  attempt = { state, verifier, expires: now().getTime() + WAIT_MS, result: null };
  const q = new URLSearchParams({ callback_url: callbackUrl(port), code_challenge: challengeFor(verifier), code_challenge_method: "S256", state });
  return { url: `${authUrl()}?${q}`, expiresIn: WAIT_MS / 1000 };
}

export function cancel() { attempt = null; }

// What the page asks while it waits: idle (nothing started, or Leanfare restarted),
// waiting, or the outcome of the callback.
export function status(): { status: "idle" | "waiting" | "connected" | "failed"; message: string | null } {
  if (!attempt) return { status: "idle", message: null };
  if (attempt.result) return { status: attempt.result.ok ? "connected" : "failed", message: attempt.result.message };
  if (now().getTime() > attempt.expires) return { status: "failed", message: EXPIRED };
  return { status: "waiting", message: null };
}

const EXPIRED = "The sign in took longer than 10 minutes. Press Connect OpenRouter to start again.";
const UNKNOWN = "Leanfare did not start this sign in, or it was already used. Go back to Leanfare and press Connect OpenRouter.";
const NO_CODE = "OpenRouter did not send a code. If you pressed Deny, nothing was connected. Go back to Leanfare and press Connect OpenRouter to try again.";

// OpenRouter's answers to the code trade, in plain words.
function exchangeError(status: number, text: string): string {
  let said = "";
  try { const j = JSON.parse(text); said = String(j?.error?.message ?? j?.error ?? j?.message ?? ""); } catch {}
  if (/expired/i.test(said)) return "OpenRouter says the code expired (codes last 10 minutes). Press Connect OpenRouter to start again.";
  if (status === 403) return "OpenRouter did not accept the code. It may be used already, or you were signed out of OpenRouter. Press Connect OpenRouter to try again.";
  if (status === 400) return "OpenRouter did not accept the request (the sign in method did not match). Press Connect OpenRouter to try again.";
  if (status === 429) return "OpenRouter is busy. Wait a minute and press Connect OpenRouter again.";
  if (status >= 500) return `OpenRouter had a problem on its side (HTTP ${status}). Try again in a few minutes.`;
  return `OpenRouter refused the code (HTTP ${status}${said ? `: ${said.slice(0, 120)}` : ""}). Press Connect OpenRouter to try again.`;
}

// Trade the code for a key. Returns the key to save, or the words to show.
export async function finish(code: string | null, state: string | null, signal?: AbortSignal): Promise<{ ok: true; key: string; message: string } | { ok: false; message: string }> {
  const a = attempt;
  if (!a || !state || !a.state || !same(state, a.state)) return { ok: false, message: code || state ? UNKNOWN : NO_CODE };
  const spent = (message: string) => { a.state = ""; a.verifier = ""; a.result = { ok: false, message }; return { ok: false as const, message }; }; // one use
  if (now().getTime() > a.expires) return spent(EXPIRED);
  if (!code) return spent(NO_CODE);
  const verifier = a.verifier;
  a.state = ""; // used from here on, whatever happens next
  let res: Response, text: string;
  try {
    res = await fetch(`${baseOf("openrouter")}/auth/keys`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
    text = await res.text();
  } catch (e: any) {
    return spent(e?.name === "TimeoutError" ? "OpenRouter did not answer within 15 seconds. Press Connect OpenRouter to try again." : "Leanfare could not reach OpenRouter. Check your internet connection and press Connect OpenRouter to try again.");
  }
  if (!res.ok) return spent(exchangeError(res.status, text));
  let key = "";
  try { key = String(JSON.parse(text)?.key ?? "").trim(); } catch {}
  if (key.length < 8 || /\s/.test(key)) return spent("OpenRouter answered, but without a key. Press Connect OpenRouter to try again.");
  // Test it before saving, so a bad key never replaces one that works.
  const check = await checkKey("openrouter", key, signal);
  if (!check.ok) return spent(`OpenRouter gave Leanfare a key, but the key did not pass its test: ${check.message}`);
  a.verifier = "";
  return { ok: true, key, message: "Connected to OpenRouter." };
}

// Called by the server once the key is saved (or could not be): the outcome the waiting page reads.
export function record(ok: boolean, message: string) { if (attempt) attempt.result = { ok, message }; }

// ---- the credit balance, when OpenRouter reports it ------------------------------

export interface Credit { remaining: number; purchased: number; used: number; at: string }
export let credit: Credit | null = null;
export const forgetCredit = () => { credit = null; };

// OpenRouter's /credits answer is { data: { total_credits, total_usage } }, in
// dollars. Some keys may not be allowed to ask; then nothing is shown (no guess).
export async function refreshCredit(key: string | null, signal?: AbortSignal): Promise<Credit | null> {
  if (!key) { credit = null; return null; }
  try {
    const res = await fetch(`${baseOf("openrouter")}/credits`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
    if (!res.ok) { credit = null; return null; }
    const d = (await res.json())?.data;
    const purchased = Number(d?.total_credits), used = Number(d?.total_usage);
    credit = Number.isFinite(purchased) && Number.isFinite(used) ? { remaining: Math.max(0, purchased - used), purchased, used, at: now().toISOString() } : null;
  } catch { credit = null; }
  return credit;
}
