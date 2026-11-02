// Why a try failed, in a few kinds a person can act on (0.10): from the provider's HTTP status when there is one, else
// from the words Leanfare wrote down for it. Kept with each failed try in the ledger (ledger.fail).
export const FAIL_KINDS = ["busy", "limit", "timeout", "unreachable", "server", "refused", "cut", "other"] as const;
export type FailKind = (typeof FAIL_KINDS)[number];
export const FAIL_WORD: Record<FailKind, string> = {
  busy: "busy", limit: "rate limited", timeout: "timed out", unreachable: "could not be reached", server: "error on its side",
  refused: "refused", cut: "cut off or empty", other: "other errors",
};

// A provider refusing the key itself: 401; or 400 and 403 when its words are about the key (Google answers 400 "API key
// expired. Please renew the API key."); a 403 about a model or a region is not the key's fault (keystate.ts).
export function keyRefusal(status: number, said: string): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return /API_KEY_INVALID|api[_ ]key (has )?(expired|not valid|is (invalid|expired|disabled)|was revoked)|(invalid|incorrect|expired|revoked|disabled) api[_ ]key|\bkey (has )?(expired|been revoked|is (disabled|invalid|revoked|expired))/i.test(said);
}
// A provider refusing for want of credit: 402; or 400 and 403 whose words say the balance or credit is too low.
export function creditRefusal(status: number, said: string): boolean {
  if (status === 402) return true;
  if (status !== 400 && status !== 403) return false;
  return /credit balance is too low|insufficient (balance|credits?|funds)|requires more credits|no credits? left|out of credits?|payment required|billing hard limit/i.test(said);
}
// Words that point at where the request comes from (0.13.4): the network (Groq: "Access denied. Please check your network
// settings."), the location (Google: "User location is not supported for the API use."), the country (OpenAI).
export const SAYS_PLACE = /check your network settings|location is not supported|unsupported_country|(country|region|territory|location)(,? region,? or territory)? (is )?not supported|not available in your (country|region|location|area)/i;
const SAYS_MODEL = /\bmodels?\b/i, SAYS_REQUEST = /moderation|flagged/i;
// What a refusal that is neither the key nor credit turned away (keystate.ts): the provider as a whole, one model, or
// this one request (a moderation flag). 403s and 451; 400s only when their words point at the location (other 400s are
// about the request, and stay errors).
export function turnedAway(status: number, said: string): "provider" | "model" | "request" | null {
  if (status === 451) return "provider";
  if (status === 400) return SAYS_PLACE.test(said) ? (SAYS_MODEL.test(said) ? "model" : "provider") : null;
  if (status !== 403 || keyRefusal(status, said) || creditRefusal(status, said)) return null;
  if (SAYS_REQUEST.test(said)) return "request";
  return SAYS_MODEL.test(said) ? "model" : "provider";
}

// From the provider's HTTP status: busy (503, 529), rate limited (429), timed out (408, 504), an error on its side (other
// 5xx), refused (a key, credit or request it would not take).
export function failOfStatus(status: number): FailKind {
  if (status === 429) return "limit";
  if (status === 503 || status === 529) return "busy";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  if (status >= 400) return "refused";
  return "other";
}
// From the words Leanfare wrote down for a failed try (rows from before 0.10 have no kind of their own).
export function failOfText(error: string | null): FailKind {
  const e = error ?? "";
  const code = /\((\d{3})\)|\banswered (\d{3})\b/.exec(e);
  if (code) return failOfStatus(Number(code[1] ?? code[2]));
  if (/too many requests|rate limit|limit is reached|quota/i.test(e)) return "limit";
  if (/overloaded|high demand|temporarily unavailable/i.test(e)) return "busy";
  if (/time limit|timed out|did not start answering|stopped sending/i.test(e)) return "timeout";
  if (/could not reach|not running on this computer|nothing answered/i.test(e)) return "unreachable";
  if (/rejected the key|no credit|does not know this/i.test(e)) return "refused";
  if (/cut off|came back empty|answer limit thinking|empty answer/i.test(e)) return "cut";
  return "other";
}

