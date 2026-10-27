// The delegate trial: Leanfare's own made-up files, the same everywhere; grading that takes right
// answers in their usual shapes and nothing else; a run through the real delegate against the fake
// providers; the report, the verdict and the line for CLAUDE.md; sharing that sends nothing.
//
// The fixture, every key: low effort picks DeepSeek V4 Flash for most questions, medium Gemini 3.8 Flash
// or Grok 4.20 Beta (whichever is cheaper for that prompt's length), high Gemini 3.8 Flash (the best
// rated, so no stronger model checks it).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { VERSION } from "../src/config";
import { db } from "../src/db";
import { CORPUS, QUESTIONS, REPO_ISSUES, claudeLineFor, firstNumber, lastTrial, nums, timing, trialFiles, truths } from "../src/trial";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; timing.pause = 0; timing.rateWait = 400; });
afterAll(() => { timing.pause = 2000; timing.rateWait = 65_000; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const ALL_KEYS = ["openai", "anthropic", "google", "deepseek", "xai", "mistral"];
const T = truths();
const right = (id: string) => { const v = T[QUESTIONS.findIndex((q) => q.id === id)]; return Array.isArray(v) ? v.join(", ") : String(v); };
// DeepSeek (low) misses the two order questions; the others get them all.
function answers() {
  fake.hooks.answer = (prompt, provider) => {
    if (prompt.includes("You check another model's work")) return "PASS";
    const q = QUESTIONS.find((x) => prompt.includes(x.task));
    if (!q) return null;
    if (provider === "deepseek" && q.id === "csv-refunds") return "2400.00";
    if (provider === "deepseek" && q.id === "csv-customer") return "Ben Okafor";
    return right(q.id);
  };
}
async function finished(ms = 30_000) {
  let v: any = null;
  for (let i = 0; i < ms / 50; i++) { v = (await ui(url, "/api/trial")).json; if (!v.running) return v; await Bun.sleep(50); }
  throw new Error("the trial did not finish");
}

describe("the files and their known answers", () => {
  test("the same files on every computer, so results compare across people; a change needs a new question version", () => {
    expect(trialFiles()).toEqual(trialFiles());
    expect(CORPUS).toBe("1");
    expect(T).toEqual([19, "r-11104", "u-23", 7, 2412.77, "Hana Sato", ["renewPlan", "retryPayment", "upgradeSeat", "chargeOverage", "billUsage"], "2026-03-17", "Ines", "203.0.113.77"]);
  });
  test("every question has one answer: one 503, one top user, one top customer, one first in Lisbon, one export", () => {
    const f = trialFiles();
    expect(f["server.log"].match(/status=503/g)).toHaveLength(1);
    expect(f["access.log"].match(/\/admin\/export/g)).toHaveLength(1);
    const top = (xs: string[]) => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c.values()].sort((a, b) => b - a); };
    const errUsers = f["server.log"].split("\n").filter((l) => l.slice(20, 25).trim() === "ERROR").map((l) => /user=(\S+)/.exec(l)![1]);
    const [a, b] = top(errUsers);
    expect(a).toBeGreaterThan(b);
    const paid = new Map<string, number>();
    for (const r of f["orders.csv"].trim().split("\n").slice(1).map((x) => x.split(","))) if (r[3] === "paid") paid.set(r[2], (paid.get(r[2]) ?? 0) + Number(r[4]));
    const sorted = [...paid.values()].sort((x, y) => y - x);
    expect(sorted[0] - sorted[1]).toBeGreaterThan(1);
    const lisbon = f["team.csv"].trim().split("\n").slice(1).map((x) => x.split(",")).filter((r) => r[1] === "Lisbon").map((r) => r[3]).sort();
    expect(lisbon[0]).not.toBe(lisbon[1]);
  });
  test("big enough to count: one long file, and about 30,000 tokens a round", () => {
    const f = trialFiles();
    const tokens = QUESTIONS.reduce((n, q) => n + q.files.reduce((m, name) => m + Math.ceil(f[name].length / 4), 0), 0);
    expect(tokens).toBeGreaterThan(25_000);
    expect(tokens).toBeLessThan(40_000);
    expect(Math.ceil(f["access.log"].length / 4)).toBeGreaterThan(10_000);
  });
});

describe("grading", () => {
  const grade = (id: string, answer: string) => { const i = QUESTIONS.findIndex((q) => q.id === id); return QUESTIONS[i].grade(answer, T[i]); };
  const cases: [string, string, boolean][] = [
    ["log-errors", "19", true], ["log-errors", "There are 19 ERROR lines.", true], ["log-errors", "18", false], ["log-errors", "u-19", false],
    ["log-503", "r-11104", true], ["log-503", "`r-11104`", true], ["log-503", "r-11104 or r-10001", false], ["log-503", "r-1110", false], ["log-503", "r-111040", false],
    ["log-user", "u-23", true], ["log-user", "u-23 (4 lines)", true], ["log-user", "u-14", false], ["log-user", "u-23, u-14", false],
    ["yaml-retry", "7", true], ["yaml-retry", "retry_limit: 7", true], ["yaml-retry", "4", false], ["yaml-retry", "Seven.", true],
    ["csv-refunds", "2412.77", true], ["csv-refunds", "$2,412.77", true], ["csv-refunds", "2412.7", false], ["csv-refunds", "2,400.00", false],
    ["csv-customer", "Hana Sato", true], ["csv-customer", "**Hana Sato**", true], ["csv-customer", "Ben Okafor", false], ["csv-customer", "Hana Sato or Ben Okafor", false],
    ["code-callers", "renewPlan, retryPayment, upgradeSeat, chargeOverage, billUsage", true], ["code-callers", "`billUsage`, `chargeOverage`, `renewPlan()`, `retryPayment`, `upgradeSeat`", true],
    ["code-callers", "renewPlan, retryPayment, upgradeSeat, chargeOverage", false], ["code-callers", "renewPlan, retryPayment, upgradeSeat, chargeOverage, billUsage, scheduleRenewal", false],
    ["notes-date", "2026-03-17", true], ["notes-date", "Released 2026-03-17.", true], ["notes-date", "2026-03-25", false], ["notes-date", "March 17, 2026", false],
    ["team-first", "Ines", true], ["team-first", "Ines (2019-06-04)", true], ["team-first", "Aiko", false], ["team-first", "Ines or Aiko", false],
    ["big-needle", "203.0.113.77", true], ["big-needle", "The IP is 203.0.113.77.", true], ["big-needle", "198.51.100.77", false],
  ];
  for (const [id, answer, want] of cases) test(`${id}: "${answer}" is ${want ? "right" : "wrong"}`, () => expect(grade(id, answer)).toBe(want));
  test("numbers in their usual shapes, and not the digits inside a name", () => {
    expect(nums("4,747 and 0.25 and u-23 and k5")).toEqual([4747, 0.25]);
    expect(firstNumber("five")).toBe(5);
    expect(firstNumber("none")).toBeNull();
  });
});

describe("a run", () => {
  test("30 answers through the real delegate; the report, the verdict and the CLAUDE.md line", async () => {
    await keys(...ALL_KEYS);
    answers();
    const before = (await ui(url, "/api/trial")).json;
    expect(before.running).toBe(false);
    expect(before.report).toBeNull();
    expect(before.estimate).toMatchObject({ questions: 10, answers: 30, models: { low: "deepseek/deepseek-v4-flash", medium: "google/gemini-3.8-flash", high: "google/gemini-3.8-flash" } });
    expect(before.estimate.estimate).toBeGreaterThan(0);
    expect(before.estimate.seconds).toBeGreaterThan(0);
    const started = (await ui(url, "/api/trial/start", {})).json;
    expect(started.running).toBe(true);
    const v = await finished();
    const r = v.report;
    expect(r).toMatchObject({ status: "done", done: 30, total: 30, version: VERSION, corpus: "1", lowest: "medium", claudeLine: claudeLineFor("medium") });
    expect(r.claudeLine).toBe("To read large files or logs, use the leanfare delegate tool with effort medium, and work from its answer.");
    expect(r.arms.map((a: any) => [a.effort, a.right, a.answered, a.verdict])).toEqual([["low", 8, 10, "does not pass"], ["medium", 10, 10, "passes"], ["high", 10, 10, "passes"]]);
    expect(r.arms.map((a: any) => a.models.reduce((n: number, m: any) => n + m.count, 0))).toEqual([10, 10, 10]);
    expect(r.arms[0].models[0]).toMatchObject({ id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }); // most answers first
    expect(r.arms[2].models).toEqual([{ id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", count: 10 }]);
    expect(r.arms[0].cost).toBeGreaterThan(0);
    expect(r.checks).toEqual({ passed: 0, failed: 0, fixed: 0, missed: 0, other: 10 }); // no model is rated above Gemini here
    expect(r.misses.map((m: any) => [m.effort, m.q, m.said, m.known])).toEqual([["low", "csv-refunds", "2400.00", "2412.77"], ["low", "csv-customer", "Ben Okafor", "Hana Sato"]]);
    expect(r.kept).toBeGreaterThan(25_000);
    expect(r.rows).toHaveLength(30);
    expect(r.rows[0]).toMatchObject({ q: "log-errors", effort: "low", ok: true, right: true, label: "DeepSeek V4 Flash" });
    // The money is real, so it is in the ledger, as the trial's; the delegate's own pass rates never see it.
    const rows = ledger();
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((x) => x.source))).toEqual(new Set(["trial"]));
    expect(db.query("SELECT COUNT(*) AS n FROM delegations").get()).toEqual({ n: 0 });
    // Kept: the same report after a restart of the screen.
    expect(lastTrial()!.rows).toHaveLength(30);
  }, 60_000);

  test("sharing: a GitHub issue filled in with numbers, for the person to read and send; nothing is sent", async () => {
    await keys(...ALL_KEYS);
    answers();
    await ui(url, "/api/trial/start", {});
    const { share } = (await finished()).report;
    expect(share.title).toBe(`Trial results: Leanfare ${VERSION}, low 8/10, medium 10/10, high 10/10`);
    expect(share.url.startsWith(`${REPO_ISSUES}?title=`)).toBe(true);
    expect(decodeURIComponent(share.url.split("&body=")[1])).toBe(share.body);
    expect(share.body).toContain("| low, no check | 8 of 10 |");
    expect(share.body).toMatch(/\| low, no check \| 8 of 10 \| about a second \| \$[\d.]+ \| deepseek\/deepseek-v4-flash ×\d+/);
    expect(share.body).toContain("| high, checked | 10 of 10 | about a second |");
    expect(share.body).toContain('- low · the total of refunded orders (orders.csv): said "2400.00", known 2412.77');
    expect(share.body).toContain("nothing from my files or chats");
    expect(share.body).not.toContain("status=200"); // no file text
    expect(share.body).not.toMatch(/sk-|AIza|xai-test/); // no keys
    expect(share.url.length).toBeLessThan(8000); // GitHub's address limit
    expect(fake.seen.some((s) => s.path.includes("github"))).toBe(false);
  }, 60_000);

  test("Stop ends it where it is; a run left going by a Leanfare that quit reads as stopped", async () => {
    await keys(...ALL_KEYS);
    answers();
    timing.pause = 100;
    try {
      await ui(url, "/api/trial/start", {});
      await Bun.sleep(250);
      const v = (await ui(url, "/api/trial/stop", {})).json;
      expect(v.running).toBe(false);
      expect(v.report.status).toBe("stopped");
      expect(v.report.done).toBeLessThan(30);
      expect(v.report.lowest).toBeNull(); // too few answers to say
    } finally { timing.pause = 0; }
    db.query("INSERT INTO trials(started, status, corpus, version, total, rows) VALUES ('2026-10-21T10:00:00Z', 'running', '1', '0.4.0', 30, '[]')").run();
    expect(lastTrial()!.status).toBe("stopped");
    expect((db.query("SELECT status FROM trials ORDER BY id DESC LIMIT 1").get() as any).status).toBe("stopped");
  }, 60_000);

  test("a free plan's limit a minute: the trial waits, then asks once more; the wait is not the answer's time", async () => {
    await keys(...ALL_KEYS);
    answers();
    const until = Date.now() + 200;
    fake.hooks.fail = () => (Date.now() < until ? 429 : null);
    await ui(url, "/api/trial/start", {});
    const r = (await finished()).report;
    expect(r.rows[0]).toMatchObject({ q: "log-errors", effort: "low", ok: true, right: true });
    expect(r.rows[0].seconds).toBeLessThan(timing.rateWait / 1000);
    expect(r.errors).toEqual([]);
    expect(ledger().filter((x) => x.status === "error").length).toBeGreaterThan(0); // the refused tries, as the trial's
  }, 60_000);
  test("stopped while it waits out a limit: nothing more is sent", async () => {
    await keys(...ALL_KEYS);
    answers();
    fake.hooks.fail = () => 429;
    timing.rateWait = 5000;
    try {
      await ui(url, "/api/trial/start", {});
      for (let i = 0; i < 100 && ledger().length === 0; i++) await Bun.sleep(20);
      await Bun.sleep(100); // now waiting out the limit
      const sent = fake.seen.length;
      const v = (await ui(url, "/api/trial/stop", {})).json;
      expect(v.report.status).toBe("stopped");
      await Bun.sleep(150);
      expect(fake.seen.length).toBe(sent);
      expect(ledger().filter((x) => x.status === "stopped")).toEqual([]);
    } finally { timing.rateWait = 400; }
  }, 60_000);
  test("Stop in Leanfare (the running list's Stop) stops the trial, not just one answer", async () => {
    await keys(...ALL_KEYS);
    answers();
    const { stopRunning } = await import("../src/engine");
    fake.hooks.slow = () => 300; // each answer takes a while, so the Stop lands while one is running
    await ui(url, "/api/trial/start", {});
    await Bun.sleep(120);
    stopRunning();
    const v = await finished();
    expect(v.report.status).toBe("stopped");
    expect(v.report.done).toBeLessThan(30);
  }, 60_000);
  test("when the budget is why no model can answer, the estimate says so", async () => {
    await reset({ ticked: ALL_TICKED, budget: 0.000001, atLimit: "stop" });
    await keys(...ALL_KEYS);
    const { db: d } = await import("../src/db");
    d.query("INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, cost, out_tokens) VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'chat', 'google', 'google/gemini-3.8-flash', 'listed', 'reported', 'ok', 1, 10)").run();
    const { resetBudget } = await import("../src/budget");
    resetBudget();
    const e = (await ui(url, "/api/trial")).json.estimate;
    expect(e.models.low).toBeNull();
    expect(e.error).toContain("budget");
  });

  test("with no model ready, the estimate says so and nothing runs", async () => {
    const v = (await ui(url, "/api/trial")).json;
    expect(v.estimate.models).toEqual({ low: null, medium: null, high: null });
    expect(v.estimate.estimate).toBeNull();
  });
});

describe("leanfare trial, in Terminal", () => {
  const cli = (...args: string[]) => {
    const p = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "trial", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_NO_OPEN: "1" } });
    return Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([o, e, code]) => ({ out: o + e, code }));
  };
  test("before any run, --report says how to start one", async () => {
    const r = await cli("--report");
    expect(r.code).toBe(0);
    expect(r.out).toContain("No trial has run yet. Run one with: leanfare trial");
  });
  test("it runs, a line per answer, then the report and the line for CLAUDE.md; --share gives the GitHub address", async () => {
    await keys(...ALL_KEYS);
    answers();
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Leanfare delegate trial: 10 questions with known answers about files Leanfare makes up, each asked at low, medium and high effort (30 answers).");
    expect(r.out).toMatch(/ {2}1\/30 {2}how many ERROR lines \(server\.log\) · low · right · DeepSeek V4 Flash · about a second/);
    expect(r.out).toContain("30/30");
    expect(r.out).toContain("==== Report ====");
    expect(r.out).toMatch(/low, no check +8 of 10 right · half took under about a second · \$[\d.]+ · DeepSeek V4 Flash ×\d+.* · DOES NOT PASS/);
    expect(r.out).toContain("Medium effort passes (at most one miss): Claude can hand reading work to Leanfare at effort medium.");
    expect(r.out).toContain("  To read large files or logs, use the leanfare delegate tool with effort medium, and work from its answer.");
    const share = await cli("--share");
    expect(share.code).toBe(0);
    expect(share.out.trim()).toStartWith(`${REPO_ISSUES}?title=Trial%20results`);
  }, 60_000);
  test("with no model ready it says so and exits 1", async () => {
    const r = await cli();
    expect(r.code).toBe(1);
    expect(r.out).toContain("No model is ready yet.");
  });
});
