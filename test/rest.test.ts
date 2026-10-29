// Resting (rest.ts, 0.10): a model that failed too often lately rests for a while, and Auto picks others while one can
// take the work. And a try that does not start answering in time fails as timed out: Auto passes it to its next pick.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { ANSWER_TIME, runChat } from "../src/engine";
import { modelStats } from "../src/modelstats";
import { REST, endRest, noteFailure, restOf, restText, resting } from "../src/rest";
import { setNow } from "../src/util";
import { boot, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const GEMINI = "google/gemini-3.8-flash", DEEPSEEK = "deepseek/deepseek-v4-flash", CLAUDE = "anthropic/claude-sonnet-4-6";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); });
afterEach(closeApp);
let n = 0;
// A try as the ledger keeps it, at the test clock's time less some seconds.
function tried(model: string, f: Record<string, unknown> = {}, ago = 0) {
  const ts = new Date(Date.parse("2026-10-21T12:00:00Z") - ago * 1000 - n++).toISOString();
  const row = { ts, month: "2026-10", day: "2026-10-21", source: "delegate", provider: model.split("/")[0], model, auto: 1, in_tokens: 100, cached: 0, cache_write: 0, out_tokens: 0, cost: 0, list_cost: 0, price_status: "listed", usage_status: "reported", status: "error", ms: 300, ...f };
  const k = Object.keys(row);
  db.query(`INSERT INTO ledger(${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
}
const minutes = (r: any) => Math.round((Date.parse(r.until) - Date.parse(r.start)) / 60_000);

describe("when a model rests", () => {
  test("3 of its last 6 tries in 30 minutes failed: it rests 30 minutes; fewer, or older ones, do not count", () => {
    tried(GEMINI, { fail: "busy" }, 60 * 40); tried(GEMINI, { fail: "busy" }, 60 * 35); // more than 30 minutes ago
    tried(GEMINI, { fail: "busy" }, 30); tried(GEMINI, { status: "ok", out_tokens: 50 }, 20); tried(GEMINI, { fail: "timeout" }, 10);
    noteFailure(GEMINI);
    expect(resting(GEMINI)).toBe(false); // 2 of the last ones
    tried(GEMINI, { error: "Google Gemini had a problem on its side (503): high demand" }, 5); // no kind kept: from its words
    noteFailure(GEMINI);
    const r = restOf(GEMINI)!;
    expect([minutes(r), r.fails, r.tries, r.kinds]).toEqual([30, 3, 4, { busy: 2, timeout: 1 }]);
    expect(restText(r)).toBe("Gemini 3.8 Flash is resting for 30 more minutes: 3 of its last 4 tries failed (2 busy, 1 timed out)");
  });
  test("a key or a request refused does not count: that is not the model being down", () => {
    for (let i = 0; i < 4; i++) tried(GEMINI, { fail: "refused" }, i);
    noteFailure(GEMINI);
    expect(resting(GEMINI)).toBe(false);
  });
  test("rate limits clear soon: 5 minutes; a rest that follows another within 6 hours lasts twice the last, at most 4 hours", () => {
    for (let i = 0; i < 3; i++) tried(DEEPSEEK, { fail: "limit" }, i);
    noteFailure(DEEPSEEK);
    expect(minutes(restOf(DEEPSEEK))).toBe(5);
    let at = Date.parse("2026-10-21T12:00:00Z");
    for (let round = 0; round < 8; round++) {
      at += 31 * 60_000 * (round + 1) * 2; // after the rest ended
      setNow(new Date(at).toISOString());
      expect(resting(DEEPSEEK)).toBe(false);
      for (let i = 0; i < 3; i++) tried(DEEPSEEK, { ts: new Date(at - i * 1000).toISOString(), fail: "busy" });
      noteFailure(DEEPSEEK);
    }
    const lengths = (db.query("SELECT start, until FROM rests WHERE model = ? ORDER BY id").all(DEEPSEEK) as any[]).map(minutes);
    expect(lengths[0]).toBe(5);
    expect(lengths[1]).toBe(30); // busy now: at least the usual first rest
    expect(lengths.slice(2)).toEqual(lengths.slice(2).map((_, i) => Math.min(240, 30 * 2 ** (i + 1)))); // doubling, at most 4 hours
    expect(Math.max(...lengths)).toBe(REST.most / 60_000);
  });
  test("Try it now ends it, from the page's address", async () => {
    for (let i = 0; i < 3; i++) tried(GEMINI, { fail: "busy" }, i);
    noteFailure(GEMINI);
    expect(resting(GEMINI)).toBe(true);
    expect((await ui(url, "/api/rest/end", { model: GEMINI })).json).toEqual({ ended: true });
    expect(resting(GEMINI)).toBe(false);
    expect(endRest(GEMINI)).toBe(false);
    expect((await ui(url, "/api/rest/end", {})).status).toBe(400);
  });
  test("a failed try starts it as it happens", async () => {
    await reset({ ticked: [GEMINI] });
    await keys("google");
    for (let i = 0; i < 3; i++) await runChat([{ role: "user", content: "Hi [fail 503]" }], "auto", new AbortController().signal, () => {});
    expect(resting(GEMINI)).toBe(true);
  });
});

describe("while it rests", () => {
  test("Auto picks another and says why; a model you name is still asked", async () => {
    await reset({ ticked: [GEMINI, CLAUDE], mode: "save" });
    await keys("google", "anthropic");
    for (let i = 0; i < 3; i++) tried(GEMINI, { fail: "busy" }, i);
    noteFailure(GEMINI);
    const r = await runChat([{ role: "user", content: "Hi" }], "auto", new AbortController().signal, () => {});
    expect(r.meta.model.id).toBe(CLAUDE);
    expect(r.meta.notes).toContain("Gemini 3.8 Flash is resting for 30 more minutes: 3 of its last 3 tries failed (3 busy), so Auto picked Claude Sonnet 4.6.");
    const named = await runChat([{ role: "user", content: "Hi" }], GEMINI, new AbortController().signal, () => {});
    expect([named.status, named.meta.model.id]).toEqual(["ok", GEMINI]);
  });
  test("every model for it resting: Auto tries them anyway, and says so", async () => {
    await reset({ ticked: [GEMINI] });
    await keys("google");
    for (let i = 0; i < 3; i++) tried(GEMINI, { fail: "busy" }, i);
    noteFailure(GEMINI);
    const r = await runChat([{ role: "user", content: "Hi" }], "auto", new AbortController().signal, () => {});
    expect([r.status, r.meta.model.id]).toEqual(["ok", GEMINI]);
    expect(r.meta.notes.join(" ")).toContain("is resting after failing too often lately, so Auto tries them anyway");
  });
  test("a plan's part named for a resting model goes to Auto, and the receipt says why", async () => {
    await reset({ ticked: [GEMINI, DEEPSEEK] });
    await keys("google", "deepseek");
    for (let i = 0; i < 3; i++) tried(GEMINI, { fail: "timeout" }, i);
    noteFailure(GEMINI);
    const r = await runDelegate({ task: "Say hello.", files: [], kind: "write", effort: "low", check: "never", maxOut: 2000, model: GEMINI, plan: "abc:1" } as any, new AbortController().signal);
    expect(r.model.id).toBe(DEEPSEEK);
    expect(r.receipt).toContain("The plan named Gemini 3.8 Flash, but it is resting for 30 more minutes: 3 of its last 3 tries failed (3 timed out), so Auto picked another.");
  });
  test("the report shows it first, with why and until when; the page offers Try it now", async () => {
    tried(DEEPSEEK, { status: "ok", out_tokens: 300, ms: 9000, first_ms: 1500 }, 100);
    tried(DEEPSEEK, { status: "ok", out_tokens: 300, ms: 9000, first_ms: 1500 }, 90);
    for (let i = 0; i < 3; i++) tried(GEMINI, { fail: "busy" }, i);
    noteFailure(GEMINI);
    const rows = modelStats({ from: Date.parse("2026-10-21T11:00:00Z"), to: Date.parse("2026-10-21T12:00:01Z") });
    expect(rows.map((m) => [m.id, m.rest?.why ?? null])).toEqual([[GEMINI, "3 of its last 3 tries failed (3 busy)"], [DEEPSEEK, null]]);
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#reportCard .sp-table tr.resting"); i++) await Bun.sleep(50);
    const row = doc.querySelector("#reportCard .sp-table tr.resting");
    expect(row.querySelector("td.now").textContent).toMatch(/^resting until .+3 of its last 3 tries failed \(3 busy\)\. Auto picks others until then\.Try it now$/);
    row.querySelector("td.now button").click();
    for (let i = 0; i < 100 && resting(GEMINI); i++) await Bun.sleep(30);
    expect(resting(GEMINI)).toBe(false);
  });
});

describe("a try that does not start answering in time", () => {
  test("fails as timed out, and Auto passes the work to its next pick", async () => {
    await reset({ ticked: [GEMINI, CLAUDE], mode: "save" });
    await keys("google", "anthropic");
    ANSWER_TIME.start = 300;
    const r = await runChat([{ role: "user", content: "Hi [slow@google 3000]" }], "auto", new AbortController().signal, () => {});
    expect([r.status, r.meta.model.id]).toEqual(["ok", CLAUDE]);
    expect(r.meta.notes).toContain("Gemini 3.8 Flash did not start answering within 300 ms, so Auto passed the request to its next pick.");
    expect(db.query("SELECT model, status, fail, error FROM ledger ORDER BY id").all()).toEqual([
      { model: GEMINI, status: "error", fail: "timeout", error: "Gemini 3.8 Flash did not start answering within 300 ms." },
      { model: CLAUDE, status: "ok", fail: null, error: null }]);
  });
  test("a model you named: the try fails, and you are told", async () => {
    await reset({ ticked: [GEMINI] });
    await keys("google");
    ANSWER_TIME.start = 300;
    const r = await runChat([{ role: "user", content: "Hi [slow 3000]" }], GEMINI, new AbortController().signal, () => {});
    expect([r.status, r.meta.error]).toEqual(["error", "Gemini 3.8 Flash did not start answering within 300 ms."]);
    expect(db.query("SELECT status, fail FROM ledger").all()).toEqual([{ status: "error", fail: "timeout" }]);
  });
  test("one that went quiet part way is cut off, and asked once more", async () => {
    await reset({ ticked: [GEMINI] });
    await keys("google");
    ANSWER_TIME.idle = 20; // the pieces come 50 ms apart
    const r = await runChat([{ role: "user", content: "Tell me more [chunks 40]" }], GEMINI, new AbortController().signal, () => {});
    expect(r.status).toBe("error");
    expect(r.meta.error).toBe("Gemini 3.8 Flash stopped sending for 20 ms.");
    expect((db.query("SELECT status, fail FROM ledger ORDER BY id").all() as any[]).map((x) => x.fail)).toEqual(["cut", "timeout"]);
  });
});
