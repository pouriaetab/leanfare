// Your plans: the month's tokens in Claude Code's and Codex's log files, valued at API prices.
// Every test writes its own log files into the temp folders test/setup.ts points
// CLAUDE_CONFIG_DIR and CODEX_HOME at (never your real ones), in the formats ccusage documents.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { claudeEntry, forgetLogs, limitsOf, planView, plansBrief, pricedAs, plansView, readCodex } from "../src/plans";
import { settings, validatePatch } from "../src/settings";
import { boot, outgoing, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
const claudeRoot = () => process.env.CLAUDE_CONFIG_DIR!;
const codexRoot = () => process.env.CODEX_HOME!;
beforeEach(async () => {
  rmSync(claudeRoot(), { recursive: true, force: true });
  rmSync(codexRoot(), { recursive: true, force: true });
  forgetLogs();
  await reset();
});

const MONTH = "2026-10";
const jsonl = (rows: unknown[]) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
function put(path: string, text: string, mtime?: Date) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mtime) utimesSync(path, mtime, mtime);
}

// One Claude Code answer line.
function asst(id: string, model: string, usage: unknown, ts = "2026-10-20T10:00:00Z", extra: Record<string, unknown> = {}) {
  return { type: "assistant", timestamp: ts, requestId: "req_" + id, message: { id: "msg_" + id, model, role: "assistant", content: [{ type: "text", text: "SECRET-ANSWER-TEXT" }], usage }, ...extra };
}
const claudeFile = (name: string, rows: unknown[], project = "-Users-you-app") => put(join(claudeRoot(), "projects", project, name + ".jsonl"), jsonl(rows));

// Codex lines.
const ctx = (model: string, ts = "2026-10-20T10:00:00Z") => ({ timestamp: ts, type: "turn_context", payload: { cwd: "/x", model } });
const tc = (ts: string, total: [number, number, number], last: [number, number, number] | null = null) => ({
  timestamp: ts, type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: 0, total_tokens: total[0] + total[2] }, last_token_usage: last ? { input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2] } : null } },
});
const codexFile = (name: string, rows: unknown[]) => put(join(codexRoot(), "sessions", "2026", "10", "20", `rollout-2026-10-20T10-00-00-${name}.jsonl`), jsonl(rows));

// sonnet 4.6 in the fixture catalogue: $3 in, $15 out, $0.30 cache read, $3.75 cache write (5 min), 1 hour writes twice the input price.
const sonnet = (u: { i?: number; cr?: number; w5?: number; w1?: number; o?: number }) => ((u.i ?? 0) * 3 + (u.cr ?? 0) * 0.3 + (u.w5 ?? 0) * 3.75 + (u.w1 ?? 0) * 6 + (u.o ?? 0) * 15) / 1e6;

describe("Claude Code logs", () => {
  test("one answer: tokens by kind, valued at the model's prices", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } })]);
    const v = await planView("claude", MONTH);
    expect(v.found).toBe(true);
    expect(v.files).toBe(1);
    expect(v.models).toHaveLength(1);
    expect(v.models[0]).toMatchObject({ model: "claude-sonnet-4-6", id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", input: 1000 + 300 + 100, cached: 2000, output: 500 });
    expect(v.value).toBeCloseTo(sonnet({ i: 1000, cr: 2000, w5: 300, w1: 100, o: 500 }), 10);
    expect(v.tokens).toBe(1400 + 2000 + 500);
    expect(v.unpricedTokens).toBe(0);
  });

  test("the same answer on two lines, and in two files (a resumed session), counts once", async () => {
    const a = asst("1", "claude-sonnet-4-6", { input_tokens: 100, output_tokens: 10 });
    const bigger = asst("1", "claude-sonnet-4-6", { input_tokens: 100, output_tokens: 80 }); // the same message, written again once finished
    claudeFile("s1", [a, bigger]);
    claudeFile("s1-resumed", [bigger], "-Users-you-other");
    claudeFile("s2", [asst("2", "claude-sonnet-4-6", { input_tokens: 5, output_tokens: 5 })]);
    const v = await planView("claude", MONTH);
    expect(v.models[0].input).toBe(105);
    expect(v.models[0].output).toBe(85); // 80 once, not 10 + 80 + 80
  });

  test("lines that are not answers are skipped: notices, user lines, no usage, empty counts, damage, other months", async () => {
    claudeFile("s1", [
      asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 }),
      asst("2", "<synthetic>", { input_tokens: 999, output_tokens: 999 }), // an error notice, not an answer
      { type: "user", timestamp: "2026-10-20T10:00:00Z", message: { role: "user", model: "claude-sonnet-4-6", usage: { input_tokens: 999 }, content: "hi" } },
      { type: "summary", timestamp: "2026-10-20T10:00:00Z", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 999 } } },
      asst("3", "claude-sonnet-4-6", { input_tokens: 0, output_tokens: 0 }),
      asst("4", "claude-sonnet-4-6", "not usage"),
      asst("5", "claude-sonnet-4-6", { input_tokens: 777, output_tokens: 7 }, "2026-09-30T23:59:59Z"), // last month
      asst("6", "claude-sonnet-4-6", { input_tokens: 888, output_tokens: 8 }, "not a time"),
      '{"type":"assistant","message":{"usage":', // half a line, as when a session is being written
      "plain words with no usage in them",
      "",
      { type: "assistant", timestamp: "2026-10-20T10:00:00Z", message: { usage: { input_tokens: 5 } } }, // no model
    ]);
    const v = await planView("claude", MONTH);
    expect(v.models.map((m) => [m.model, m.input, m.output])).toEqual([["claude-sonnet-4-6", 10, 1]]);
  });

  test("a date stamp or a long context marker on the name still finds the model's price; an unknown model is counted, not priced", async () => {
    claudeFile("s1", [
      asst("1", "claude-haiku-4-5-20251001", { input_tokens: 1000, output_tokens: 1000 }),
      asst("2", "claude-sonnet-4-6[1m]", { input_tokens: 1000, output_tokens: 0 }),
      asst("3", "claude-future-9", { input_tokens: 4000, output_tokens: 1000 }),
    ]);
    const v = await planView("claude", MONTH);
    const by = Object.fromEntries(v.models.map((m) => [m.model, m]));
    expect(by["claude-haiku-4-5-20251001"].id).toBe("anthropic/claude-haiku-4-5");
    expect(by["claude-haiku-4-5-20251001"].value).toBeCloseTo((1000 * 1 + 1000 * 5) / 1e6, 10);
    expect(by["claude-sonnet-4-6[1m]"].id).toBe("anthropic/claude-sonnet-4-6");
    expect(by["claude-future-9"]).toMatchObject({ id: null, value: null, label: "claude-future-9", tokens: 5000 });
    expect(v.unpricedTokens).toBe(5000);
    expect(v.value).toBeCloseTo((6000 + 3000) / 1e6, 10); // the unknown one adds nothing, and is said so
    expect(v.models[v.models.length - 1].model).toBe("claude-future-9"); // priced models first
  });

  test("pricedAs: exact names only, nothing guessed", () => {
    expect(pricedAs("claude", "claude-sonnet-4-5-20250929")).toBe("anthropic/claude-sonnet-4-5");
    expect(pricedAs("claude", "claude-sonnet-4-6-latest")).toBe("anthropic/claude-sonnet-4-6");
    expect(pricedAs("claude", "claude-sonnet-4")).toBeNull(); // not the same model as 4-5
    expect(pricedAs("chatgpt", "gpt-4.1-2025-04-14")).toBe("openai/gpt-4.1");
    expect(pricedAs("chatgpt", "gpt-5-codex")).toBeNull();
    expect(pricedAs("claude", "gpt-4.1")).toBeNull(); // the provider's own models only
  });

  test("the words you and Claude exchanged are never kept, shown or sent", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 })]);
    const before = outgoing.length;
    const v = await planView("claude", MONTH, true);
    const r = await ui(url, `/api/plans?month=${MONTH}&refresh=1`);
    expect(JSON.stringify(v)).not.toContain("SECRET-ANSWER-TEXT");
    expect(JSON.stringify(r.json)).not.toContain("SECRET-ANSWER-TEXT");
    expect(outgoing.slice(before).filter((a) => !a.startsWith(url))).toEqual([]); // reading logs reaches no address at all (only this test's own calls to Leanfare are recorded)
  });

  test("the logs of the several folders in CLAUDE_CONFIG_DIR are all read (a comma list), and an answer in two of them counts once", async () => {
    const second = join(claudeRoot(), "..", "claude-logs-2");
    const old = process.env.CLAUDE_CONFIG_DIR;
    try {
      put(join(old!, "projects", "p", "a.jsonl"), jsonl([asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 })]));
      process.env.CLAUDE_CONFIG_DIR = `${old}, ${second}`;
      put(join(second, "projects", "p", "b.jsonl"), jsonl([asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 }), asst("2", "claude-sonnet-4-6", { input_tokens: 20, output_tokens: 2 })]));
      const v = await planView("claude", MONTH);
      expect(v.files).toBe(2);
      expect(v.models[0]).toMatchObject({ input: 30, output: 3 });
    } finally { process.env.CLAUDE_CONFIG_DIR = old; rmSync(second, { recursive: true, force: true }); }
  });

  test("no logs on this computer: found is false, and the month is empty rather than an error", async () => {
    const v = await planView("claude", MONTH);
    expect(v).toMatchObject({ found: false, files: 0, tokens: 0, value: 0, models: [] });
  });

  test("a file not touched since before the month began is not even opened", async () => {
    put(join(claudeRoot(), "projects", "p", "old.jsonl"), jsonl([asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 })]), new Date("2026-08-01T00:00:00Z"));
    const v = await planView("claude", "2026-10");
    expect(v.files).toBe(0);
  });

  test("a file is read again only when it changed, and a new line shows up", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 })]);
    expect((await planView("claude", MONTH, true)).models[0].input).toBe(10);
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 }), asst("2", "claude-sonnet-4-6", { input_tokens: 50, output_tokens: 1 })]);
    expect((await planView("claude", MONTH, false)).models[0].input).toBe(10); // asked again within 30 seconds: the earlier reading
    expect((await planView("claude", MONTH, true)).models[0].input).toBe(60); // refresh: the file changed, so it is read again
  });

  test("claudeEntry keeps only the numbers", () => {
    const e = claudeEntry(JSON.stringify(asst("1", "claude-sonnet-4-6", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 })))!;
    expect(e.slice(2)).toEqual(["claude-sonnet-4-6", 1, 3, 0, 0, 2]);
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(claudeEntry("no usage here")).toBeNull();
  });
});

describe("Codex logs", () => {
  test("running totals become what each step used; a repeated event adds nothing; cached input is split out", async () => {
    codexFile("a", [
      ctx("gpt-4.1"),
      tc("2026-10-20T10:00:01Z", [1000, 400, 100]),
      tc("2026-10-20T10:00:02Z", [1000, 400, 100]), // sent twice
      tc("2026-10-20T10:00:03Z", [2500, 1400, 300]),
      { timestamp: "2026-10-20T10:00:04Z", type: "event_msg", payload: { type: "token_count", info: null } }, // no numbers yet
    ]);
    const v = await planView("chatgpt", MONTH);
    expect(v.models).toHaveLength(1);
    expect(v.models[0]).toMatchObject({ model: "gpt-4.1", id: "openai/gpt-4.1", input: 1100, cached: 1400, output: 300 });
    // gpt-4.1: $2 in, $8 out, $0.50 cached
    expect(v.value).toBeCloseTo((1100 * 2 + 1400 * 0.5 + 300 * 8) / 1e6, 10);
  });

  test("the model follows the latest turn; before any turn it is unknown and unpriced", async () => {
    codexFile("a", [
      tc("2026-10-20T10:00:00Z", [100, 0, 10]),
      ctx("gpt-5-mini"),
      tc("2026-10-20T10:00:01Z", [300, 0, 30]),
      ctx("gpt-4.1"),
      tc("2026-10-20T10:00:02Z", [600, 0, 60]),
    ]);
    const v = await planView("chatgpt", MONTH);
    const by = Object.fromEntries(v.models.map((m) => [m.model, m]));
    expect(by["unknown"]).toMatchObject({ input: 100, output: 10, value: null, id: null });
    expect(by["gpt-5-mini"]).toMatchObject({ input: 200, output: 20 });
    expect(by["gpt-4.1"]).toMatchObject({ input: 300, output: 30 });
    expect(v.unpricedTokens).toBe(110);
  });

  test("a count that starts over (a new session in the same file) uses the step's own numbers", async () => {
    codexFile("a", [ctx("gpt-4.1"), tc("2026-10-20T10:00:00Z", [1000, 0, 100]), tc("2026-10-20T10:00:01Z", [200, 0, 20], [200, 0, 20])]);
    const v = await planView("chatgpt", MONTH);
    expect(v.models[0]).toMatchObject({ input: 1200, output: 120 });
  });

  test("other months, damaged lines and files that are not rollouts are left out", async () => {
    codexFile("a", [ctx("gpt-4.1"), tc("2026-09-30T23:00:00Z", [5000, 0, 500]), "{broken", tc("2026-10-20T10:00:00Z", [5100, 0, 510])]);
    put(join(codexRoot(), "sessions", "2026", "10", "20", "notes.jsonl"), jsonl([ctx("gpt-4.1"), tc("2026-10-20T10:00:00Z", [9999, 0, 999])]));
    const v = await planView("chatgpt", MONTH);
    expect(v.files).toBe(1);
    // the September event is left out, but the totals it carried are the base the October step is measured from
    expect(v.models[0]).toMatchObject({ input: 100, output: 10 });
  });

  test("no Codex folder: found is false", async () => {
    expect((await planView("chatgpt", MONTH)).found).toBe(false);
  });
});

describe("the plan you pay for", () => {
  test("value over price, and the plan comes with the view", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 100_000 })]); // $3 + $1.50
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 1.5 } } });
    const v = await planView("claude", MONTH, true);
    expect(v.plan).toEqual({ name: "Claude Max", price: 1.5 });
    expect(v.value).toBeCloseTo(4.5, 8);
    expect(v.ratio).toBeCloseTo(3, 8);
  });

  test("a plan saved a moment after the files were read shows at once, without reading them again", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 })]);
    const first = (await ui(url, "/api/plans")).json.providers[0];
    expect(first.plan).toBeNull();
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 6 } } });
    const v = (await ui(url, "/api/plans")).json.providers[0];
    expect(v.plan).toEqual({ name: "Claude Max", price: 6 });
    expect(v.ratio).toBeCloseTo(0.5, 8);
    expect(v.at).toBe(first.at); // the same reading, not a new one
    await ui(url, "/api/settings", { plans: { claude: null } });
    expect((await ui(url, "/api/plans")).json.providers[0]).toMatchObject({ plan: null, ratio: null });
  });

  test("no plan entered, or a free one: no ratio (never a divide by zero)", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 1 })]);
    expect((await planView("claude", MONTH, true)).ratio).toBeNull();
    await ui(url, "/api/settings", { plans: { claude: { name: "Free", price: 0 } } });
    const v = await planView("claude", MONTH, true);
    expect(v.plan).toEqual({ name: "Free", price: 0 });
    expect(v.ratio).toBeNull();
  });

  test("settings: a name and a price per plan, checked; null removes one", async () => {
    const ok = await ui(url, "/api/settings", { plans: { claude: { name: "  Claude Max 5x ", price: "100.456" }, chatgpt: { name: "ChatGPT Plus", price: 20 } } });
    expect(ok.status).toBe(200);
    expect(settings().plans).toEqual({ claude: { name: "Claude Max 5x", price: 100.46 }, chatgpt: { name: "ChatGPT Plus", price: 20 } });
    expect(ok.json.settings.plans.chatgpt.price).toBe(20);
    await ui(url, "/api/settings", { plans: { chatgpt: null } });
    expect(settings().plans).toEqual({ claude: { name: "Claude Max 5x", price: 100.46 } }); // only the named plan goes
    await ui(url, "/api/settings", { plans: { claude: null } });
    expect(settings().plans).toEqual({});
    for (const bad of [
      { claude: { name: "", price: 20 } },
      { claude: { name: "x", price: -1 } },
      { claude: { name: "x", price: "" } },
      { claude: { name: "x", price: "abc" } },
      { claude: { name: "x" } },
      { gemini: { name: "x", price: 1 } },
      [],
      "claude",
    ]) {
      const r = await ui(url, "/api/settings", { plans: bad });
      expect(r.status).toBe(400);
      expect(r.json.error).toBeString();
    }
    expect("error" in (validatePatch({ plans: null }) as any)).toBe(true);
    expect((validatePatch({ plans: { claude: { name: "a".repeat(100), price: 5 } } }) as any).patch.plans.claude.name).toHaveLength(60);
  });
});

describe("the page's and the menu's numbers", () => {
  test("/api/plans has both providers, the month and the honest note", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 1 })]);
    const r = await ui(url, "/api/plans");
    expect(r.status).toBe(200);
    expect(r.json.month).toBe(MONTH);
    expect(r.json.providers.map((p: any) => p.provider)).toEqual(["claude", "chatgpt"]);
    expect(r.json.providers[0]).toMatchObject({ found: true, label: "Claude", logs: "Claude Code" });
    expect(r.json.providers[1]).toMatchObject({ found: false, label: "ChatGPT", logs: "Codex" });
    expect(r.json.note).toContain("estimate");
    const other = await ui(url, "/api/plans?month=2026-09");
    expect(other.json.month).toBe("2026-09");
    expect(other.json.providers[0].tokens).toBe(0);
    const junk = await ui(url, "/api/plans?month=banana");
    expect(junk.json.month).toBe(MONTH); // a bad month falls back to this one
  });

  test("two askers at once share one reading", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 1 })]);
    const [a, b] = await Promise.all([planView("claude", MONTH, true), planView("claude", MONTH, true)]);
    expect(a).toBe(b);
  });

  test("the menu's numbers: nothing without a plan; with one, a reading starts in the background and the next ask has it", async () => {
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 })]);
    expect(plansBrief()).toEqual({});
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Pro", price: 6 } } });
    expect(plansBrief()).toEqual({}); // the first ask never waits for the files
    await plansView(MONTH); // (the background reading, finished)
    expect(plansBrief()).toEqual({ claude: { plan: "Claude Pro", price: 6, value: 3, ratio: 0.5 } });
    const s = (await ui(url, "/api/summary")).json;
    expect(s.plans.claude).toMatchObject({ plan: "Claude Pro", value: 3 });
    // changing the price shows the new one at once, never the old ratio
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Pro", price: 3 } } });
    expect(plansBrief().claude).toEqual({ plan: "Claude Pro", price: 3, value: 3, ratio: 1 });
    await ui(url, "/api/settings", { plans: { claude: null } });
    expect(plansBrief()).toEqual({}); // a removed plan leaves the menu
  });
});

// Lines copied from a real Claude Code session and a real Codex session on the owner's computer (22 Oct 2026),
// with ids replaced and every piece of text taken out. The shape is what the programs write today.
const REAL_CLAUDE = `{"parentUuid":"u-1","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_real1","type":"message","role":"assistant","container":null,"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":15892,"cache_read_input_tokens":12271,"output_tokens":159,"output_tokens_details":{"thinking_tokens":17},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":15892,"ephemeral_5m_input_tokens":0},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":159,"cache_read_input_tokens":12271,"cache_creation_input_tokens":15892,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":15892},"type":"message"}],"speed":"standard","fallback_credit":null},"input_transformations":[],"diagnostics":null,"context_management":null},"thinkingDurationMs":89,"requestId":"req_real1","requestRef":"r-1","requestedModel":"claude-opus-5-5","type":"assistant","uuid":"u-2","timestamp":"2026-10-20T21:17:22.648Z","advisorModel":"claude-opus-5-5","userType":"external","entrypoint":"sdk-cli","sessionId":"s-1","version":"2.1.303"}`;
const REAL_CODEX = [
  `{"timestamp":"2026-10-20T13:05:15.430Z","type":"turn_context","payload":{"turn_id":"t-1","current_date":"2026-10-20","timezone":"America/Chicago","approval_policy":"on-request","model":"gpt-5.4","personality":"friendly","effort":"medium"}}`,
  `{"timestamp":"2026-10-20T13:05:26.636Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":14241,"cached_input_tokens":10624,"output_tokens":501,"reasoning_output_tokens":297,"total_tokens":14742},"last_token_usage":{"input_tokens":14241,"cached_input_tokens":10624,"output_tokens":501,"reasoning_output_tokens":297,"total_tokens":14742},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":1.0,"window_minutes":300,"resets_at":1792590000},"secondary":{"used_percent":10.0,"window_minutes":10080,"resets_at":1792900000},"credits":null,"plan_type":"plus"}}}`,
];

describe("lines as the programs really write them", () => {
  test("a real Claude Code line is read: model, the four kinds of tokens, the one hour cache write", () => {
    const e = claudeEntry(REAL_CLAUDE)!;
    expect(e).toEqual(["msg_real1:req_real1", Date.parse("2026-10-20T21:17:22.648Z"), "claude-opus-5-5", 2, 12271, 0, 15892, 159]);
  });

  test("real Codex lines are read: the model from the turn, input split from its cached part, and the limits", async () => {
    codexFile("real", REAL_CODEX);
    let got: any = null;
    const entries = await readCodex(join(codexRoot(), "sessions", "2026", "10", "20", "rollout-2026-10-20T10-00-00-real.jsonl"), (l) => { got = l; });
    expect(entries).toEqual([["", Date.parse("2026-10-20T13:05:26.636Z"), "gpt-5.4", 14241 - 10624, 10624, 0, 0, 501]]);
    expect(got).toEqual({ at: Date.parse("2026-10-20T13:05:26.636Z"), plan: "plus", windows: [{ used: 1, minutes: 300, resets: 1792590000 }, { used: 10, minutes: 10080, resets: 1792900000 }] });
    const v = await planView("chatgpt", MONTH);
    expect(v.models[0]).toMatchObject({ model: "gpt-5.4", input: 3617, cached: 10624, output: 501 });
  });
});

describe("the ChatGPT plan's limits, as of the last Codex message", () => {
  // The test clock is 2026-10-21T12:00Z = 1792584000.
  test("the 5 hour and weekly windows, with how much they had used and when they reset", async () => {
    codexFile("a", REAL_CODEX);
    const v = await planView("chatgpt", MONTH);
    expect(v.limits).toEqual({ at: "2026-10-20T13:05:26.636Z", plan: "plus", windows: [
      { label: "5 hour limit", used: 1, resets: new Date(1792590000 * 1000).toISOString() },
      { label: "weekly limit", used: 10, resets: new Date(1792900000 * 1000).toISOString() },
    ] });
  });

  test("a window that has reset since that message is dropped; with none left there is no line", async () => {
    codexFile("a", [REAL_CODEX[0], REAL_CODEX[1].replace('"resets_at":1792590000', '"resets_at":1792500000')]);
    expect((await planView("chatgpt", MONTH, true)).limits!.windows.map((w) => w.label)).toEqual(["weekly limit"]);
    codexFile("a", [REAL_CODEX[0], REAL_CODEX[1].replace('"resets_at":1792590000', '"resets_at":1792500000').replace('"resets_at":1792900000', '"resets_at":1792500001')]);
    expect((await planView("chatgpt", MONTH, true)).limits).toBeNull();
  });

  test("the newest message of all the files counts; a file with no limits does not hide it", async () => {
    codexFile("a", REAL_CODEX);
    const later = REAL_CODEX[1].replace("2026-10-20T13:05:26.636Z", "2026-10-20T15:00:00.000Z").replace('"used_percent":10.0', '"used_percent":42.5');
    put(join(codexRoot(), "sessions", "2026", "10", "20", "rollout-b.jsonl"), jsonl([REAL_CODEX[0], later]));
    put(join(codexRoot(), "sessions", "2026", "10", "20", "rollout-c.jsonl"), jsonl([REAL_CODEX[0], tc("2026-10-20T16:00:00Z", [10, 0, 1])])); // a newer file, but it carries no limits
    expect((await planView("chatgpt", MONTH)).limits!.windows[1]).toMatchObject({ label: "weekly limit", used: 42.5 });
  });

  test("a later message in the same file with no limits does not erase the earlier ones", async () => {
    codexFile("a", [...REAL_CODEX, tc("2026-10-20T14:00:00Z", [20000, 10624, 700])]);
    expect((await planView("chatgpt", MONTH)).limits!.windows).toHaveLength(2);
  });

  test("other windows are named from their length, a missing reset time is kept, damage is ignored", () => {
    expect(limitsOf({ primary: { used_percent: 5, window_minutes: 90 }, secondary: { used_percent: "x" } }, 1)).toEqual({ at: 1, plan: null, windows: [{ used: 5, minutes: 90, resets: null }] });
    expect(limitsOf(null, 1)).toBeNull();
    expect(limitsOf({ primary: null }, 1)).toBeNull();
    expect(limitsOf({ primary: { used_percent: -3 } }, 1)!.windows[0].used).toBe(0);
  });

  test("only for this month, and only for ChatGPT", async () => {
    codexFile("a", REAL_CODEX);
    claudeFile("s1", [asst("1", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 1 })]);
    expect((await planView("chatgpt", "2026-09")).limits).toBeNull();
    expect((await planView("claude", MONTH)).limits).toBeNull();
  });
});
