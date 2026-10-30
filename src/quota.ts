// Models a key has no quota for (0.11). Some free keys come with none at all for some models: Google's free tier answers
// every request for Gemini 4 Argon with 429 and "limit: 0". Resting (rest.ts) does not help there: it lets the model back
// in every few hours, and every try fails again. Such a model is left out of Auto, plans, checks and side by side until
// its key changes, you press Try again, or two weeks pass (then it gets one more try). A model you name yourself is still
// asked. Two ways to know: the provider says its limit is 0, or every try of the last 30 days was refused as rate limited,
// at least 4 of them on 2 or more days, and not one answered. And a third (0.11.2): the provider says it no longer serves
// the model to this key (Google: "This model ... is no longer available to new users"; OpenAI: "does not exist or you do
// not have access to it"; Groq: "has been decommissioned"). Kept: the model, when, how many tries, why. No words.
import { getModel } from "./data";
import { db } from "./db";
import { failOfText } from "./fails";
import { now } from "./util";

export const NO_QUOTA = { tries: 4, within: 30 * 86_400_000, keep: 14 * 86_400_000 };
const SAYS_ZERO = /\blimit:\s*0\b/i; // Google: "Quota exceeded for metric: ...free_tier_requests, limit: 0, model: ..."

export interface NoQuota { model: string; provider: string; since: string; tries: number; why: "said" | "refused" | "gone" }
// The provider says it no longer serves this model to the key: a model not found, retired or closed to new users.
export const SAYS_GONE = /\bmodels?\b.{0,100}?\b(no longer available|not found|does not exist|(has been|was) (deprecated|retired|shut down|decommissioned))|model_not_found|decommissioned|does not know this: model: /i;

let cache: { at: number; map: Map<string, NoQuota> } | null = null;
export const forgetNoQuota = () => { cache = null; };
function current(): Map<string, NoQuota> {
  const t = now().getTime();
  if (cache && t - cache.at < 10_000) return cache.map;
  const map = new Map<string, NoQuota>();
  try {
    const rows = db.query("SELECT model, provider, since, tries, why FROM noquota WHERE cleared IS NULL AND since > ? ORDER BY id").all(new Date(t - NO_QUOTA.keep).toISOString()) as any[];
    for (const r of rows) map.set(r.model, { model: r.model, provider: r.provider, since: r.since, tries: r.tries, why: r.why === "said" || r.why === "gone" ? r.why : "refused" });
  } catch { if (cache) return cache.map; } // the database busy: what was known
  cache = { at: t, map };
  return map;
}

// The model's mark now, or null.
export const noQuota = (model: string): NoQuota | null => current().get(model) ?? null;
export const noQuotaNow = (): NoQuota[] => [...current().values()];

// After a failed try (engine.ts record): a key with no quota for this model is noted once.
export function noteRefusal(model: string, provider: string, error: string | null, kind: string | null) {
  if (provider === "ollama" || noQuota(model)) return;
  const k = kind ?? failOfText(error);
  const t = now().getTime();
  let mark: { tries: number; why: NoQuota["why"] } | null = null;
  if (k === "refused" && error && SAYS_GONE.test(error)) mark = { tries: 1, why: "gone" };
  else if (k !== "limit") return;
  else if (error && SAYS_ZERO.test(error)) mark = { tries: 1, why: "said" };
  else {
    let rows: { ts: string; status: string; fail: string | null; error: string | null }[];
    try {
      rows = db.query("SELECT ts, status, fail, error FROM ledger WHERE model = ? AND ts >= ? AND status != 'stopped' ORDER BY id")
        .all(model, new Date(t - NO_QUOTA.within).toISOString()) as any[];
    } catch { return; }
    const refused = rows.filter((r) => r.status === "error" && (r.fail ?? failOfText(r.error)) === "limit");
    const days = new Set(refused.map((r) => r.ts.slice(0, 10))).size;
    if (rows.length && refused.length === rows.length && refused.length >= NO_QUOTA.tries && days >= 2) mark = { tries: refused.length, why: "refused" };
  }
  if (!mark) return;
  try {
    db.query("INSERT INTO noquota(model, provider, since, tries, why) VALUES (?, ?, ?, ?, ?)").run(model, provider, new Date(t).toISOString(), mark.tries, mark.why);
  } catch (e) { console.error("leanfare: could not note a model with no quota:", String(e)); return; }
  forgetNoQuota();
}

// Try again (one model), or a new key for a provider (every model of it). The number of marks cleared.
export function clearNoQuota(by: { model?: string; provider?: string }): number {
  let n = 0;
  try {
    const t = now().toISOString();
    if (by.model) n = db.query("UPDATE noquota SET cleared = ? WHERE cleared IS NULL AND model = ?").run(t, by.model).changes;
    else if (by.provider) n = db.query("UPDATE noquota SET cleared = ? WHERE cleared IS NULL AND provider = ?").run(t, by.provider).changes;
  } catch {}
  forgetNoQuota();
  return n;
}

// Why, in words: "your Google Gemini key has no quota for it: Google said its limit is 0" / "...: all 68 tries refused".
export function noQuotaWhy(q: NoQuota, providerName?: string): string {
  const who = providerName ?? q.provider;
  if (q.why === "gone") return `your ${who} key can't use it anymore (${who} said it is no longer available)`;
  return q.why === "said" ? `your ${who} key has no quota for it (${who} said its limit is 0)`
    : `your ${who} key has no quota for it: all ${q.tries} tries in 30 days were refused as rate limited, and none answered`;
}
export function noQuotaText(q: NoQuota, providerName?: string): string {
  return `${getModel(q.model)?.label ?? q.model} is left out: ${noQuotaWhy(q, providerName)}`;
}
