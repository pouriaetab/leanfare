// Why a try failed, in a few kinds a person can act on (0.10): from the provider's HTTP status when there is one, else
// from the words Leanfare wrote down for it. Kept with each failed try in the ledger (ledger.fail).
export const FAIL_KINDS = ["busy", "limit", "timeout", "unreachable", "server", "refused", "cut", "other"] as const;
export type FailKind = (typeof FAIL_KINDS)[number];
export const FAIL_WORD: Record<FailKind, string> = {
  busy: "busy", limit: "rate limited", timeout: "timed out", unreachable: "could not be reached", server: "error on its side",
  refused: "refused", cut: "cut off or empty", other: "other errors",
};

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

