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
//
// No credit left (0.13.3): a provider that answers 402, or 400 or 403 saying the balance or credit is too low (OpenRouter's
// "requires more credits", DeepSeek's "Insufficient Balance", Anthropic's "credit balance is too low"), has its paid
// models left out, and the work goes to your next model; its free ones (OpenRouter's ":free" models) keep working.
// OpenRouter's balance is read again every 30 minutes, for free; the others are tried again after 6 hours. An answer from
// one of its paid models clears it, and so does Check again once there is credit.
import { provider, type ProviderId } from "./config";
import { getSetting, putSetting } from "./db";
import { refreshCredit } from "./connect";
import { getKey } from "./keys";
import { checkKey } from "./upstream";
import { now } from "./util";

export interface KeyState { refused?: { at: string; status: number } | null; expires?: string | null; read?: string | null; checked?: string | null; noCredit?: { at: string; status: number } | null; creditChecked?: string | null }
const KEY = "keystate";
export const KEYS_EVERY = { recheck: 30 * 60_000, read: 24 * 3_600_000, warn: 7 * 86_400_000, credit: 6 * 3_600_000 };
// Where each provider takes credit, for the page's Add credit (else the page where its keys are made).
export const CREDIT_URL: Record<string, string> = { openrouter: "https://openrouter.ai/settings/credits", deepseek: "https://platform.deepseek.com/top_up", anthropic: "https://console.anthropic.com/settings/billing", openai: "https://platform.openai.com/settings/organization/billing/overview" };
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
  put(id, { refused: null, expires: expires ?? null, read: expires === undefined ? null : now().toISOString(), checked: null, noCredit: null, creditChecked: null });
}

// A provider refusing for want of credit: 402; or 400 and 403 whose words say the balance or credit is too low.
export function creditRefusal(status: number, said: string): boolean {
  if (status === 402) return true;
  if (status !== 400 && status !== 403) return false;
  return /credit balance is too low|insufficient (balance|credits?|funds)|requires more credits|no credits? left|out of credits?|payment required|billing hard limit/i.test(said);
}
// No credit since then, or null: OpenRouter until its balance is back; the others for 6 hours, then they are tried again.
export function noCredit(id: string, t = now().getTime()): { at: string; status: number } | null {
  const c = all()[id]?.noCredit;
  if (!c) return null;
  return id !== "openrouter" && t - Date.parse(c.at) >= KEYS_EVERY.credit ? null : c;
}
export function noteNoCredit(id: string, status: number) {
  if (!noCredit(id)) put(id, { ...(all()[id] ?? {}), noCredit: { at: now().toISOString(), status } });
}
export function clearNoCredit(id: string) {
  const s = all()[id];
  if (s?.noCredit) put(id, { ...s, noCredit: null });
}
// Reads OpenRouter's balance again (free): $0.01 or more brings its paid models back. Another provider has no balance to
// read: its paid models are let back in, and the next hand off tries them.
export async function recheckCredit(id: ProviderId, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  const name = provider(id)?.name ?? id, at = now().toISOString();
  if (id !== "openrouter") { put(id, { ...(all()[id] ?? {}), noCredit: null, creditChecked: at }); return { ok: true, message: `${name}'s paid models are back in: the next hand off tries them, and they are left out again if it still has no credit.` }; }
  const c = await refreshCredit(getKey("openrouter"), signal);
  if (c && c.remaining >= 0.01) { put(id, { ...(all()[id] ?? {}), noCredit: null, creditChecked: at }); return { ok: true, message: `OpenRouter has $${c.remaining.toFixed(2)} of credit: its paid models are back.` }; }
  put(id, { ...(all()[id] ?? {}), creditChecked: at });
  return { ok: false, message: c ? "OpenRouter still has no credit, so its paid models stay out; its free models keep working." : "Leanfare could not read OpenRouter's balance; it tries again in 30 minutes." };
}

// Checks a key again with the provider's free model list (no tokens are used): working, the refusal is cleared and
// OpenRouter's expiry read; refused, it is noted.
export async function recheckKey(id: ProviderId, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  const key = getKey(id);
  const name = provider(id)?.name ?? id;
  if (!key) return { ok: false, message: `There is no ${name} key to check.` };
  if (!all()[id]?.refused && noCredit(id)) return recheckCredit(id, signal); // the key works; its credit is what is checked
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
  const credit = getKey("openrouter") && !or?.refused && noCredit("openrouter", t) && since(t, or?.creditChecked ?? or?.noCredit?.at) >= KEYS_EVERY.recheck; // its balance, every 30 minutes
  if (!due.length && !credit) return;
  busy = true;
  (async () => {
    for (const id of new Set(due)) await recheckKey(id).catch(() => {});
    if (credit) await recheckCredit("openrouter").catch(() => {});
  })().finally(() => { busy = false; });
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
// For the page's notices: a refused key, one past its date, and one that expires within 7 days, each with its provider.
export type KeyNotice = { kind: "key" | "expires" | "credit"; level: "error" | "warn"; provider: string; text: string; url?: string };
export function keyNotices(t = now().getTime()): KeyNotice[] {
  const out: KeyNotice[] = [];
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
    // No credit: its paid models are left out (and its free ones keep working).
    if (!s.refused && noCredit(id, t)) out.push({ kind: "credit", level: "warn", provider: id, url: CREDIT_URL[id] ?? def.keyUrl,
      text: `${def.name} has no credit left, so Leanfare leaves its paid models out${id === "openrouter" ? " (its free models keep working)" : ""}. Add credit there, or Leanfare keeps going on your other models.` });
  }
  return out;
}

// For a hand off's receipt: the providers with no credit now, of those given (the ones with paid models ticked).
export function creditLeftOut(ids: string[], t = now().getTime()): string | null {
  const names = [...new Set(ids)].filter((id) => !keyUnusable(id, t) && noCredit(id, t)).map((id) => provider(id as ProviderId)?.name ?? id);
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "has" : "have"} no credit left, so ${names.length === 1 ? "its" : "their"} paid models were left out. Add credit there, or Leanfare keeps going on your other models.`;
}

// For a hand off's receipt: the providers whose key is unusable now, of those given (the ones with models ticked).
export function keysLeftOut(ids: string[], t = now().getTime()): string | null {
  const out = [...new Set(ids)].filter((id) => keyUnusable(id, t));
  if (!out.length) return null;
  const said = out.map((id) => { const n = provider(id as ProviderId)?.name ?? id; return all()[id]?.refused ? `${n} refused your key` : `your ${n} key expired`; });
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
  return `${list[0].toUpperCase()}${list.slice(1)}, so ${out.length === 1 ? "its" : "their"} models were left out. Keys can expire: make a new one in Leanfare's page.`;
}
