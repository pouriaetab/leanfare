// A key a provider refused, and when a key expires (0.13.1).
//
// Keys can expire: Groq's and OpenRouter's can be made to last 30, 90 or 180 days, and a key can be revoked. When a
// provider refuses a key (401, or 400 and 403 whose words are about the key, like Google's "API key expired"), Leanfare
// notes it here and leaves that provider's models out of Auto, plans and checks, so the work goes to your other models.
// The page says the key may have expired, with one press to make a new one: OpenRouter signs you in again (which makes
// a new key), the others open the page where their keys are made, next to the box for the new one. A new key saved, an
// answer from that provider, or a check that finds the key working again clears it.
//
// Where the provider says when a key expires (OpenRouter's /api/v1/key gives expires_at), Leanfare reads it when the
// key is saved and once a day, and the page says so from 7 days before. Numbers only: the provider, the times and the
// status, never the key.
import { provider, type ProviderId } from "./config";
import { getSetting, putSetting } from "./db";
import { getKey } from "./keys";
import { checkKey } from "./upstream";
import { now } from "./util";

export interface KeyState { refused?: { at: string; status: number } | null; expires?: string | null; read?: string | null; checked?: string | null }
const KEY = "keystate";
export const KEYS_EVERY = { recheck: 30 * 60_000, read: 24 * 3_600_000, warn: 7 * 86_400_000 };
let cache: Record<string, KeyState> | null = null;
const all = (): Record<string, KeyState> => (cache ??= getSetting<Record<string, KeyState>>(KEY, {}));
function put(id: string, next: KeyState) { cache = { ...all(), [id]: next }; putSetting(KEY, cache); }
export function clearKeyState() { cache = {}; putSetting(KEY, {}); } // the tests

// A provider refusing the key itself: 401; or 400 and 403 when its words are about the key (Google answers 400 "API key
// expired. Please renew the API key."); a 403 about a model or a region is not the key's fault.
export function keyRefusal(status: number, said: string): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return /API_KEY_INVALID|api[_ ]key (has )?(expired|not valid|is (invalid|expired|disabled)|was revoked)|(invalid|incorrect|expired|revoked|disabled) api[_ ]key|\bkey (has )?(expired|been revoked|is (disabled|invalid|revoked|expired))/i.test(said);
}

export const keyState = (id: string): KeyState => all()[id] ?? {};
// Refused, or past the date its provider gave: its models are left out until a new key or a working check.
export function keyUnusable(id: string, t = now().getTime()): boolean {
  const s = all()[id];
  return !!s && (!!s.refused || (!!s.expires && Date.parse(s.expires) <= t));
}
export function noteRefused(id: string, status: number) {
  const s = all()[id] ?? {};
  if (!s.refused) put(id, { ...s, refused: { at: now().toISOString(), status } }); // the first time counts
}
export function clearRefused(id: string) {
  const s = all()[id];
  if (s?.refused) put(id, { ...s, refused: null });
}
// A new key: what was known of the old one goes. expires: what the provider said of the new one (undefined: not asked).
export function keyChanged(id: string, expires?: string | null) {
  put(id, { refused: null, expires: expires ?? null, read: expires === undefined ? null : now().toISOString(), checked: null });
}

// Checks a key again with the provider's free model list (no tokens are used): working, the refusal is cleared and
// OpenRouter's expiry read; refused, it is noted.
export async function recheckKey(id: ProviderId, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  const key = getKey(id);
  const name = provider(id)?.name ?? id;
  if (!key) return { ok: false, message: `There is no ${name} key to check.` };
  const c = await checkKey(id, key, signal);
  const s = all()[id] ?? {}, at = now().toISOString();
  if (c.ok) put(id, { ...s, refused: null, checked: at, ...(c.expires !== undefined ? { expires: c.expires, read: at } : {}) });
  else put(id, { ...s, checked: at, refused: keyRefusal(c.status, c.message) ? s.refused ?? { at, status: c.status } : s.refused ?? null });
  return { ok: c.ok, message: c.ok ? `${name} takes your key again.` : c.message };
}

// As the page asks for its state, and as work is handed over: a refused key is checked again at most every 30 minutes
// (it may have been a hiccup on the provider's side), and OpenRouter's expiry is read once a day (a read that failed, at
// most every 30 minutes). In the background: nothing waits for it. LEANFARE_KEY_CHECKS=off turns it off (the tests).
let busy = false;
const since = (t: number, iso: string | null | undefined) => (iso ? t - Date.parse(iso) : Infinity);
export function keepKeysFresh(t = now().getTime()) {
  if (busy || process.env.LEANFARE_KEY_CHECKS === "off") return;
  const due: ProviderId[] = [];
  for (const [id, s] of Object.entries(all())) if (s.refused && getKey(id as ProviderId) && since(t, s.checked ?? s.refused.at) >= KEYS_EVERY.recheck) due.push(id as ProviderId);
  const or = all().openrouter;
  if (getKey("openrouter") && !or?.refused && since(t, or?.read) >= KEYS_EVERY.read && since(t, or?.checked) >= KEYS_EVERY.recheck) due.push("openrouter");
  if (!due.length) return;
  busy = true;
  (async () => { for (const id of new Set(due)) await recheckKey(id).catch(() => {}); })().finally(() => { busy = false; });
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
// For the page's notices: a refused key, one past its date, and one that expires within 7 days, each with its provider.
export function keyNotices(t = now().getTime()): { kind: "key" | "expires"; level: "error" | "warn"; provider: string; text: string }[] {
  const out: { kind: "key" | "expires"; level: "error" | "warn"; provider: string; text: string }[] = [];
  for (const [id, s] of Object.entries(all())) {
    const def = provider(id as ProviderId);
    if (!def || !getKey(id as ProviderId)) continue;
    const left = s.expires ? Date.parse(s.expires) - t : null;
    if (s.refused) out.push({ kind: "key", level: "error", provider: id, text: `${def.name} refused your key (${s.refused.status}) on ${dateText(s.refused.at)}, so Leanfare leaves its models out. Keys can expire, and yours may have: make a new one.` });
    else if (left !== null && left <= 0) out.push({ kind: "key", level: "error", provider: id, text: `Your ${def.name} key expired on ${dateText(s.expires!)}, so Leanfare leaves its models out. Make a new one to use ${def.name} again.` });
    else if (left !== null && left <= KEYS_EVERY.warn) {
      const d = Math.max(1, Math.ceil(left / 86_400_000));
      out.push({ kind: "expires", level: "warn", provider: id, text: `Your ${def.name} key expires on ${dateText(s.expires!)}, in ${d} day${d === 1 ? "" : "s"}. Make a new one before then.` });
    }
  }
  return out;
}

// For a hand off's receipt: the providers whose key is unusable now, of those given (the ones with models ticked).
export function keysLeftOut(ids: string[], t = now().getTime()): string | null {
  const out = [...new Set(ids)].filter((id) => keyUnusable(id, t));
  if (!out.length) return null;
  const said = out.map((id) => { const n = provider(id as ProviderId)?.name ?? id; return all()[id]?.refused ? `${n} refused your key` : `your ${n} key expired`; });
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
  return `${list[0].toUpperCase()}${list.slice(1)}, so ${out.length === 1 ? "its" : "their"} models were left out. Keys can expire: make a new one in Leanfare's page.`;
}
