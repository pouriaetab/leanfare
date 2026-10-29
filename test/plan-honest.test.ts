// A plan's numbers say what they are (planner.ts: totalsText, TINY_CHARS): before its parts run they are an estimate,
// and a guess where no files were named for the reading (a research plan's sources); a task small enough to answer
// yourself is not split at all. Before, a plan that never ran read as 160k tokens kept out (28 Oct): its research
// step guessed 150k tokens of sources that did not exist.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SIZE_TOKENS, isTiny, makePlan } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); await keys("google", "deepseek"); });
const plan = (task: string, files: { name: string; size: number }[] = [], split: "auto" | "rules" = "auto") =>
  makePlan({ task, files, manager: "Claude", split, signal: new AbortController().signal });

describe("a task small enough to answer yourself", () => {
  test("is not split, nothing goes out, no model is asked, and the plan says why", async () => {
    const before = fake.seen.length;
    const p = await plan("What does HTTP 418 mean?");
    expect(fake.seen.length).toBe(before); // no model split it
    expect(p.parts).toMatchObject([{ n: 1, where: "you", keep: true }]);
    expect(p.parts[0].why).toBe("it is small enough to answer yourself: handing it off would cost more than it saves");
    expect(p.totals).toMatchObject({ parts: 1, out: 0, kept: 0 });
    expect(p.table).toContain("Nothing goes to Leanfare.");
    expect(p.table).toContain("It is small enough to answer yourself: handing it off would cost more than it saves.");
    expect(p.next).toBe("Answer it yourself: it is too small to hand off.");
  });

  test("a short task that builds, researches or names files is still split", async () => {
    expect((await plan("Fix the login bug.", [], "rules")).parts.length).toBeGreaterThan(1);
    expect((await plan("Compare the best open source gateways.", [], "rules")).parts.length).toBeGreaterThan(1);
    expect((await plan("Summarize this.", [{ name: "notes.md", size: 40_000 }], "rules")).parts.length).toBeGreaterThan(1);
  });

  test("only a question is small enough: short work, or a question about a project, is still work", () => {
    for (const q of ["What does HTTP 418 mean?", "Why is the sky blue?", "How do I center a div?"]) expect(isTiny(q, [])).toBe(true);
    for (const t of ["Work out why the nightly job is slow", "Plan a birthday party for twelve people", "Why does my test fail?",
      "Why is the nightly job slow?", "Can you check the server?", "What does HTTP 418 mean"]) expect(isTiny(t, [])).toBe(false);
    expect(isTiny("What does this mean?", [{ name: "a.txt", size: 10 }])).toBe(false);
    expect(isTiny(`What ${"is it ".repeat(80)}?`, [])).toBe(false); // longer than a few sentences
  });
});

describe("before the parts run", () => {
  test("research with no files: the sources' size is a middling guess, and the plan says it is a guess", async () => {
    const p = await plan("Research the best open source LLM gateways and compare their features for a small team", [], "rules");
    const facts = p.parts.find((x) => x.title === "Pull out the facts")!;
    expect(facts.size).toBe("medium");
    expect(facts.guess).toBe(true);
    expect(facts.tokens).toBeLessThan(SIZE_TOKENS.large); // not the 150k it guessed before
    expect(p.totals.guessed).toBe(true);
    expect(p.table).toContain(": a guess, as no files were named for the reading.");
    expect(p.table).toMatch(/parts go to Leanfare\. If they run, about \S+ tokens stay out of your plan \(\d+% of the parts' tokens\)/);
  });

  test("with files named: an estimate until they run", async () => {
    const p = await plan("Find out why the nightly job fails and fix it", [{ name: "logs/app.log", size: 120_000 }], "rules");
    expect(p.totals.guessed).toBe(false);
    expect(p.table).toContain(": an estimate until they run.");
  });
});
