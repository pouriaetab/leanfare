// Scores out of 100 from grades (score.ts, 0.11): good 1, partly half, wrong 0; the mean, and its 90% range (Wilson),
// so a score from a few grades reads as uncertain as it is.
import { describe, expect, test } from "bun:test";
import { scoreOf, scoreText, wilson } from "../src/score";

describe("a score out of 100", () => {
  test("good counts 1, partly half, wrong 0", () => {
    expect(scoreOf({ good: 2, partly: 2, wrong: 0 })!.score).toBe(75);
    expect(scoreOf({ good: 5, partly: 3, wrong: 6 })!.score).toBe(46);
    expect(scoreOf({ good: 0, partly: 0, wrong: 0 })).toBeNull();
  });
  test("its 90% range narrows as the grades add up, and stays between 0 and 100", () => {
    const few = scoreOf({ good: 3, partly: 0, wrong: 1 })!, many = scoreOf({ good: 30, partly: 0, wrong: 10 })!;
    expect([few.score, many.score]).toEqual([75, 75]);
    expect(few.hi - few.lo).toBeGreaterThan(2 * (many.hi - many.lo));
    expect(scoreOf({ good: 1, partly: 0, wrong: 0 })).toEqual({ score: 100, lo: 27, hi: 100, n: 1 });
    expect(scoreOf({ good: 0, partly: 0, wrong: 3 })).toEqual({ score: 0, lo: 0, hi: 47, n: 3 });
    expect(wilson(0, 0)).toBeNull();
  });
  test("in words", () => {
    expect(scoreText(scoreOf({ good: 1, partly: 1, wrong: 0 }))).toBe("75 of 100 (25 to 96, 2 grades)");
    expect(scoreText(null)).toBe("not graded");
    expect(scoreText(null, "not known")).toBe("not known");
  });
});
