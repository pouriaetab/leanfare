// A score out of 100 from grades (0.11, his pick): you still press Good, Partly or Wrong (what you did with the answer),
// and the report shows them as one number. Good counts 1, partly half, wrong 0: the score is their mean, with its 90%
// range (Wilson's interval, as for the checks), so a score from 3 grades does not read like one from 30.
export interface Score { score: number; lo: number; hi: number; n: number }

// Wilson's interval for a share: it stays inside 0 to 1 and keeps its coverage with few grades, where the plain
// p ± z·se does not. z is the normal quantile for a 90% range.
export function wilson(k: number, n: number, z = 1.6448536269514722): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export function scoreOf(c: { good: number; partly: number; wrong: number }): Score | null {
  const n = c.good + c.partly + c.wrong;
  if (!n) return null;
  const k = c.good + c.partly / 2, w = wilson(k, n)!;
  return { score: Math.round((k / n) * 100), lo: Math.round(w.lo * 100), hi: Math.round(w.hi * 100), n };
}
// "75 of 100 (30 to 95, 4 grades)", or none.
export const scoreText = (s: Score | null, none = "not graded") => (s ? `${s.score} of 100 (${s.lo} to ${s.hi}, ${s.n} grade${s.n === 1 ? "" : "s"})` : none);
