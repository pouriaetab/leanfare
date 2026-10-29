// Free plans (0.10): a provider's free key, as you say in Settings (Google's, Groq's, Mistral's). Its answers cost you
// nothing, so Leanfare counts them at $0; what the provider's terms let it do with what is sent is said (platforms.ts:
// readRisk); and a request too big for a free plan's limit of tokens a minute goes to another model (Groq's: 8,000).
// The limits are the providers' own published numbers, as read on 29 Oct 2026; your account's page has yours.
import type { ProviderId } from "./config";
import { settings } from "./settings";

export interface FreePlan { tokensPerMinute: number | null; risk: string | null }
export const FREE_PLANS: Partial<Record<ProviderId, FreePlan>> = {
  google: { tokensPerMinute: null, risk: "people may read it" }, // Gemini API Additional Terms, Unpaid Services
  groq: { tokensPerMinute: 8_000, risk: null }, // console.groq.com/docs/rate-limits: gpt-oss-120b, 8K tokens a minute
  mistral: { tokensPerMinute: null, risk: "its company may train on it" }, // Mistral's Experiment plan: requests may train its models
};
export const onFreePlan = (pid: string): boolean => !!FREE_PLANS[pid as ProviderId] && !!settings().providers[pid]?.free;
// The most tokens one request may have, its answer included, on a free plan that limits tokens a minute (null: no cap).
export const freeCap = (m: { provider: string }): number | null => (onFreePlan(m.provider) ? FREE_PLANS[m.provider as ProviderId]!.tokensPerMinute : null);
// Text of this many characters (about three a token, as everywhere) and an answer of this many tokens fit its free plan.
export const fitsFree = (m: { provider: string }, chars: number, out: number): boolean => { const cap = freeCap(m); return cap === null || Math.ceil(chars / 3) + out <= cap; };
