// Speed, failures, cost and quality for each model (modelstats.ts, 0.10): every call in a span, from the ledger. Each
// failed try is kept with why it failed (busy, rate limited, timed out...), from the provider's status, or from its
// words for older rows; the report shows a dot per model and a table, and Claude gets a line of it.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { failOfStatus, failOfText } from "../src/fails";
import { addGrade } from "../src/grades";
import { reportLines, speedLine } from "../src/mcp";
import { failsText, modelStats } from "../src/modelstats";
import { checkReport, report } from "../src/report";
import { boot, keys, reset } from "./app";
import { closeApp, openApp, win } from "./dom";

const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash", GROK = "xai/grok-4.20-beta", CLAUDE = "anthropic/claude-sonnet-4-6";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
// A question to the OpenAI address, as an app asks it.
const chat = (content: string) => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content }] }) });
beforeEach(async () => { await reset(); });
afterEach(closeApp);
// A call as the ledger keeps it.
let at = 0;
function call(model: string, f: Record<string, unknown> = {}) {
  const ts = new Date(Date.parse("2026-10-21T11:00:00Z") + at++ * 1000).toISOString();
  const row = { ts, month: "2026-10", day: "2026-10-21", source: "delegate", provider: model.split("/")[0], model, auto: 1, in_tokens: 1000, cached: 0, cache_write: 0, out_tokens: 200,
    cost: 0, list_cost: 0, price_status: "listed", usage_status: "reported", status: "ok", ms: 4000, first_ms: 1000, ...f };
  const keys = Object.keys(row);
  db.query(`INSERT INTO ledger(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
}
const span = { from: Date.parse("2026-10-21T10:00:00Z"), to: Date.parse("2026-10-21T12:00:01Z") };

describe("why a try failed", () => {
  test("from the provider's status", () => {
    expect([429, 503, 529, 408, 504, 500, 502, 400, 401, 402, 404, 422, 302].map(failOfStatus))
      .toEqual(["limit", "busy", "busy", "timeout", "timeout", "server", "server", "refused", "refused", "refused", "refused", "refused", "other"]);
  });
  test("from the words Leanfare wrote for it, for rows from before the kind was kept", () => {
    expect(failOfText("Google Gemini had a problem on its side (503): This model is currently experiencing high demand.")).toBe("busy");
    expect(failOfText("Anthropic had a problem on its side (529): Overloaded")).toBe("busy");
    expect(failOfText("xAI says too many requests or the plan's limit is reached: slow down. Wait a minute, or check your plan.")).toBe("limit");
    expect(failOfText("Mistral did not answer within the time limit (api.mistral.ai).")).toBe("timeout");
    expect(failOfText("Could not reach xAI at api.x.ai: Unable to connect")).toBe("unreachable");
    expect(failOfText("Ollama is not running on this computer (nothing answered at 127.0.0.1:11434). Open the Ollama app, then try again.")).toBe("unreachable");
    expect(failOfText("OpenAI rejected the key: Incorrect API key provided")).toBe("refused");
    expect(failOfText("DeepSeek answered 422: bad request")).toBe("refused");
    expect(failOfText("cut off: the stream ended early")).toBe("cut");
    expect(failOfText("came back empty")).toBe("cut");
    expect(failOfText(null)).toBe("other");
  });
});

describe("each model's numbers", () => {
  test("calls, failures by kind, first word and whole answer (middle and slowest 1 in 10), writing speed and cost", () => {
    for (let i = 0; i < 10; i++) call(GEMINI, { first_ms: 1000 + i * 100, ms: 4000 + i * 1000, out_tokens: 300 }); // 300 tokens in 3 to 12 s after the first word
    call(GEMINI, { status: "error", fail: "busy", out_tokens: 0, ms: 300, first_ms: null, error: "busy" });
    call(GEMINI, { status: "error", out_tokens: 0, ms: 60000, first_ms: null, error: "Google Gemini had a problem on its side (503): high demand" }); // no kind kept: from its words
    call(GEMINI, { status: "error", fail: "timeout", out_tokens: 0, ms: 45000, first_ms: null });
    call(GEMINI, { status: "stopped", ms: 2000 });
    call(DEEPSEEK, { cost: 0.0004, ms: 11000, first_ms: 1800, out_tokens: 500 });
    call(DEEPSEEK, { cost: 0.0006, ms: 13000, first_ms: 2000, out_tokens: 500 });
    const [g, d] = modelStats(span);
    expect(g).toMatchObject({ id: GEMINI, label: "Gemini 3.8 Flash", provider: "google", where: "free", calls: 14, ok: 10, failed: 3, stopped: 1, fails: { busy: 2, timeout: 1 } });
    expect(g.first).toEqual({ mid: 1.5, slow: 1.9 }); // ten answers, their first word at 1.0 to 1.9 s (a stopped one does not count)
    expect(g.whole).toEqual({ mid: 8.5, slow: 13 }); // whole answers of 4 to 13 s
    expect(g.perSecond).toBe(43); // 300 tokens after the first word, in 3 to 11.1 s: the middle two, 40 and 45 a second
    expect(failsText(g)).toBe("2 busy, 1 timed out");
    expect(d).toMatchObject({ id: DEEPSEEK, where: "paid", calls: 2, failed: 0, fails: {}, cost: 0.001, whole: { mid: 12, slow: 13 } });
    expect(d.costPerCall).toBeCloseTo(0.0005, 8);
  });

  test("most calls first; a span, a provider or a model narrows it; a model moved down by its grades says so", () => {
    call(DEEPSEEK); call(GEMINI); call(GEMINI); call(GROK, { ts: "2026-10-20T11:00:00Z" }); // a day before the span
    expect(modelStats(span).map((m) => m.id)).toEqual([GEMINI, DEEPSEEK]);
    expect(modelStats({ ...span, provider: "deepseek" }).map((m) => m.id)).toEqual([DEEPSEEK]);
    expect(modelStats({ ...span, model: GEMINI }).map((m) => m.calls)).toEqual([2]);
    for (let i = 0; i < 3; i++) addGrade({ model: GEMINI, kind: "write", effort: "low", verdict: "wrong", source: "app" }, null);
    expect(modelStats(span)[0].movedDown).toEqual(["write"]);
  });
});

describe("failures are kept with their kind as they happen", () => {
  test("a busy first pick passes the work on: its try is kept as busy, the next one answers", async () => {
    await reset({ ticked: [GEMINI, CLAUDE], mode: "best" });
    await keys("google", "anthropic");
    const r = await chat("What is the capital of Australia? [fail@google 503]");
    expect(r.status).toBe(200);
    const rows = db.query("SELECT model, status, fail FROM ledger ORDER BY id").all() as any[];
    expect(rows).toEqual([{ model: GEMINI, status: "error", fail: "busy" }, { model: CLAUDE, status: "ok", fail: null }]);
  });
  test("rate limited, and an answer cut off and asked again", async () => {
    await reset({ ticked: [GEMINI] });
    await keys("google");
    await (await chat("Hi [fail 429]")).text();
    const r = await runDelegate({ task: "Say hello. [cut1]", files: [], kind: "write", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal);
    expect(r.answer).toBeTruthy(); // asked again, and answered
    expect((db.query("SELECT status, fail FROM ledger ORDER BY id").all() as any[])).toEqual([
      { status: "error", fail: "limit" }, { status: "error", fail: "cut" }, { status: "ok", fail: null }]);
  });
});

describe("in the report", () => {
  test("each model with its grades; Claude gets a line of it", async () => {
    call(GEMINI, { ms: 9000, first_ms: 2100 }); call(GEMINI, { ms: 9000, first_ms: 2100 });
    call(GEMINI, { status: "error", fail: "busy", out_tokens: 0, first_ms: null });
    db.query(`INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance, grade)
      VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'longer_query', 'read', 'low', ?, 0, 1, 900, 40, 'ok', 0, 'good')`).run(GEMINI);
    const r = await report(checkReport(new URLSearchParams({ range: "custom", from: "2026-10-21T10:00:00Z", to: "2026-10-21T12:00:01Z" })) as any);
    expect(r.speed).toEqual([expect.objectContaining({ id: GEMINI, calls: 3, failed: 1, graded: 1, goodShare: 1, whole: { mid: 9, slow: 9 }, first: { mid: 2.1, slow: 2.1 } })]);
    expect(speedLine(r.speed)).toBe("Speed by model: Gemini 3.8 Flash 9 s an answer (first word 2.1 s), 1 of 3 calls failed (1 busy).");
    expect(reportLines(r, "custom")).toContain("Speed by model: Gemini 3.8 Flash 9 s an answer");
    expect(speedLine([])).toBe("");
  });

  test("the page: a dot for each model, and the table", async () => {
    for (let i = 0; i < 4; i++) call(GEMINI, { ms: 9000, first_ms: 2100, out_tokens: 1500 });
    call(GEMINI, { status: "error", fail: "busy", out_tokens: 0, first_ms: null });
    call(GEMINI, { status: "error", fail: "timeout", out_tokens: 0, first_ms: null });
    call(DEEPSEEK, { cost: 0.0004, ms: 11000, first_ms: 1800 });
    db.query(`INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance, grade)
      VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'longer_query', 'read', 'low', ?, 0, 1, 900, 40, 'ok', 0, 'good')`).run(GEMINI);
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#reportCard .sp-table"); i++) await Bun.sleep(50);
    const rows = [...doc.querySelectorAll("#reportCard .sp-table tbody tr")].map((tr: any) => [...tr.querySelectorAll("td")].map((td: any) => td.textContent.trim()));
    expect(rows).toEqual([
      ["Gemini 3.8 Flashfree · Google Gemini", "6", "2 failed1 busy · 1 timed out", "2.1 s · 2.1 s", "9 s · 9 s", "217 /s", "$0", "100%", "ready"],
      ["DeepSeek V4 Flashpaid · DeepSeek", "1", "none", "1.8 s · 1.8 s", "11 s · 11 s", "22 /s", "$0.00040", "not graded", "ready"],
    ]);
    const dots = [...doc.querySelectorAll("#reportCard .sp-chart circle.spd")];
    expect(dots.map((c: any) => c.getAttribute("class"))).toEqual(["spd ready", "spd none"]); // most calls first; not graded: hollow
    expect([...doc.querySelectorAll("#reportCard .sp-chart text.lab")].map((t: any) => t.textContent)).toEqual(["Gemini 3.8 Flash", "DeepSeek V4 Flash, not graded yet"]);
    expect(/\bnull\b|\bundefined\b|NaN/.test(doc.querySelector("#reportCard").textContent)).toBe(false);
    void win;
  });
});
