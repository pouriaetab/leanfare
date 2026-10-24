// The engine end to end: the real server, the fake providers, the real database.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { paths } from "../src/config";
import { setPaused } from "../src/engine";
import { setNow } from "../src/util";
import { ALL_TICKED, boot, fake, keys, ledger, outgoing, post, readSSE, reset, syntheticData, ui } from "./app";
import { KEYS } from "./fake";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const chat = (model: string, content: string, extra: Record<string, unknown> = {}) => post(`${url}/v1/chat/completions`, { model, messages: [{ role: "user", content }], ...extra });

describe("OpenAI address: /v1/chat/completions", () => {
  test("a named model: the answer, the exact cost header, one ledger row", async () => {
    await keys("anthropic");
    const r = await chat("anthropic/claude-sonnet-4-6", "Hi [usage 2000 500]");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.choices[0].message.content).toBe("Hello from claude-sonnet-4-6.");
    expect(j.usage.prompt_tokens).toBe(2000);
    expect(r.headers.get("x-leanfare-cost-usd")).toBe("0.01350000"); // a known answer
    expect(r.headers.get("x-leanfare-model")).toBe("anthropic/claude-sonnet-4-6");
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "openai", model: "anthropic/claude-sonnet-4-6", in_tokens: 2000, out_tokens: 500, status: "ok", usage_status: "reported", price_status: "listed" });
    expect(rows[0].cost.toFixed(8)).toBe("0.01350000");
  });

  test("cached input is priced at the cache price (Claude through the OpenAI address)", async () => {
    await keys("anthropic");
    const r = await chat("claude-sonnet-4-6", "Hi [usage 2000 500] [cached 1500]");
    expect(r.headers.get("x-leanfare-cost-usd")).toBe("0.00945000");
  });

  test("the other known answers", async () => {
    await keys("anthropic", "openai");
    expect((await chat("anthropic/claude-haiku-4-5", "x [usage 2000 500]")).headers.get("x-leanfare-cost-usd")).toBe("0.00450000");
    expect((await chat("openai/gpt-5-mini", "x [usage 2000 500]")).headers.get("x-leanfare-cost-usd")).toBe("0.00150000");
  });

  test("streaming: chunks pass through, the usage chunk Leanfare asked for stays hidden, the cost comes last", async () => {
    await keys("openai");
    const r = await chat("openai/gpt-5-mini", "Hi [usage 2000 500]", { stream: true });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const { events, raw } = await readSSE(r);
    const text = events.filter((e) => e?.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content).join("");
    expect(text).toBe("Hello from gpt-5-mini.");
    expect(events.some((e) => e?.usage)).toBe(false); // the client did not ask for usage
    expect(raw).toContain(": leanfare model=openai/gpt-5-mini cost_usd=0.00150000");
    expect(raw.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const sent = fake.seen.find((s) => s.path.endsWith("/chat/completions"))!;
    expect(sent.body.stream_options).toEqual({ include_usage: true });
    expect(ledger()[0]).toMatchObject({ in_tokens: 2000, out_tokens: 500, usage_status: "reported" });
  });

  test("streaming: a client that asks for usage gets it", async () => {
    await keys("openai");
    const { events } = await readSSE(await chat("openai/gpt-5-mini", "Hi [usage 10 5]", { stream: true, stream_options: { include_usage: true } }));
    expect(events.find((e) => e?.usage)?.usage.prompt_tokens).toBe(10);
  });

  test("streaming Claude through the OpenAI address is translated chunk by chunk", async () => {
    await keys("anthropic");
    const { events, raw } = await readSSE(await chat("anthropic/claude-haiku-4-5", "Hi [usage 2000 500]", { stream: true }));
    expect(events[0].choices[0].delta.role).toBe("assistant");
    expect(events.filter((e) => e?.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content).join("")).toBe("Hello from claude-haiku-4-5.");
    expect(events.find((e) => e?.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("stop");
    expect(raw).toContain("cost_usd=0.00450000");
    const sent = fake.seen.find((s) => s.path.endsWith("/v1/messages"))!;
    expect(sent.body.max_tokens).toBe(8192);
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("no token counts from the provider: estimated, and marked as estimated", async () => {
    await keys("openai");
    await chat("openai/gpt-5-mini", "Hi there [nousage]");
    expect(ledger()[0].usage_status).toBe("estimated");
  });

  test("an unknown model, a model without a key, and an empty request get plain answers", async () => {
    let r = await chat("no-such-model", "hi");
    expect(r.status).toBe(404);
    expect((await r.json()).error.message).toContain('does not know the model "no-such-model"');
    r = await chat("openai/gpt-5-mini", "hi");
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("There is no OpenAI key");
    r = await post(`${url}/v1/chat/completions`, { model: "auto", messages: [] });
    expect(r.status).toBe(400);
  });

  test("/v1/models lists Auto and the ready, ticked models", async () => {
    await keys("google");
    const j = await (await fetch(`${url}/v1/models`)).json();
    const ids = j.data.map((m: any) => m.id);
    expect(ids).toEqual(["auto", "auto-save", "auto-balanced", "auto-best", "google/gemini-3.8-flash"]);
  });
});

describe("Auto", () => {
  test("picks per the mode, names the model and the reason in headers", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    const r = await chat("auto", "What is the capital of Australia?");
    expect(r.headers.get("x-leanfare-model")).toBe("xai/grok-4.20-beta");
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("Balanced");
    expect((await chat("auto-save", "What is the capital of Australia?")).headers.get("x-leanfare-model")).toBe("deepseek/deepseek-v4-flash");
    expect((await chat("auto-best", "What is the capital of Australia?")).headers.get("x-leanfare-model")).toBe("google/gemini-3.8-flash");
    const rows = ledger();
    expect(rows.every((x) => x.auto === 1)).toBe(true);
    expect(rows[0].reason).toBe("overall: no strong signal, so the everyday rating");
  });

  test("only providers with a key take part", async () => {
    await keys("anthropic");
    expect((await chat("auto", "What is the capital of Australia?")).headers.get("x-leanfare-model")).toBe("anthropic/claude-sonnet-4-6");
  });

  test("a busy provider passes the request to the next pick, and the failure is recorded", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    // Grok is the Balanced pick; make every xAI call fail with 429.
    process.env.LEANFARE_XAI_BASE = "http://127.0.0.1:1/v1"; // nothing listens there
    try {
      const r = await chat("auto", "What is the capital of Australia?");
      expect(r.status).toBe(200);
      expect(r.headers.get("x-leanfare-model")).not.toBe("xai/grok-4.20-beta");
      expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("could not be reached");
    } finally { process.env.LEANFARE_XAI_BASE = fake.bases.xai; }
    const rows = ledger();
    expect(rows[0]).toMatchObject({ model: "xai/grok-4.20-beta", status: "error", cost: 0 });
    expect(rows[1].status).toBe("ok");
  });

  test("a 429 from the provider also passes it on", async () => {
    await keys("google", "anthropic");
    await reset({ ticked: ["google/gemini-3.8-flash", "anthropic/claude-sonnet-4-6"], mode: "best" });
    await keys("google", "anthropic");
    const r = await chat("auto", "What is the capital of Australia? [fail 429]");
    // both fail with 429 here (the directive goes to every provider), so the last error is returned
    expect(r.status).toBe(429);
    expect((await r.json()).error.message).toContain("too many requests");
    expect(ledger().map((x) => x.status)).toEqual(["error", "error"]);
  });
});

describe("Anthropic address: /v1/messages", () => {
  test("passes Claude requests through with Anthropic's own format, beta flags included", async () => {
    await keys("anthropic");
    const r = await post(`${url}/v1/messages`, { model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: "Hi [usage 2000 500]" }] }, { "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "anything" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.content[0].text).toBe("Hello from claude-sonnet-4-6.");
    expect(r.headers.get("x-leanfare-cost-usd")).toBe("0.01350000");
    const sent = fake.seen.find((s) => s.path.endsWith("/v1/messages"))!;
    expect(sent.headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
    expect(sent.auth).toBe(KEYS.anthropic); // the stored key, not the client's "anything"
  });
  test("streams, and counts the tokens from the stream", async () => {
    await keys("anthropic");
    const r = await post(`${url}/v1/messages`, { model: "claude-haiku-4-5", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "Hi [usage 2000 500]" }] });
    const raw = await r.text();
    expect(raw).toContain("event: message_start");
    const text = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
    expect(text).toBe("Hello from claude-haiku-4-5.");
    expect(ledger()[0]).toMatchObject({ source: "anthropic", in_tokens: 2000, out_tokens: 500, status: "ok" });
    expect(ledger()[0].cost.toFixed(8)).toBe("0.00450000");
  });
  test("refuses other makers' models, in Anthropic's error format", async () => {
    await keys("openai");
    const r = await post(`${url}/v1/messages`, { model: "gpt-5-mini", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.type).toBe("error");
    expect(j.error.message).toContain("Claude models only");
  });
});

describe("budget", () => {
  test("50 requests at once cannot pass the budget", async () => {
    await keys("openai");
    // GPT-5 mini, max_tokens 1000: reservation = 100 tokens in at $0.25 + 1000 out at $2 ≈ $0.002
    await reset({ ticked: ["openai/gpt-5-mini"], budget: 0.05, atLimit: "stop" });
    await keys("openai");
    const body = (i: number) => ({ model: "openai/gpt-5-mini", max_tokens: 1000, messages: [{ role: "user", content: `Question ${i} [usage 10 1000] [slow 200]` }] });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => post(`${url}/v1/chat/completions`, body(i))));
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 402).length;
    expect(ok + refused).toBe(50);
    expect(refused).toBeGreaterThan(0);
    const spent = ledger().reduce((a, r) => a + (r.cost ?? 0), 0);
    expect(spent).toBeLessThanOrEqual(0.05 + 1e-12);
    // Each reservation: about 50 bytes of input at $0.25 plus 1,000 answer tokens at $2, a little over $0.002.
    expect(ok).toBe(24); // as many as fit, no more
    const msg = (await results.find((r) => r.status === 402)!.json()).error.message;
    expect(msg).toContain("would pass your monthly budget of $0.05");
  });

  test("set to keep going: past the budget, requests move to the cheapest ticked model", async () => {
    await reset({ ticked: ["anthropic/claude-sonnet-4-6", "openai/gpt-5-mini"], budget: 0.001, atLimit: "cheapest" });
    await keys("anthropic", "openai");
    const r = await chat("anthropic/claude-sonnet-4-6", "Hi [usage 100 100]");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-model")).toBe("openai/gpt-5-mini");
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("which would pass your monthly budget of $0.001 ($0 spent), so Leanfare used the cheapest model you ticked, GPT-5 mini.");
  });

  test("warning at 80%, shown on screen", async () => {
    await reset({ ticked: ["openai/gpt-5-mini"], budget: 0.002, atLimit: "cheapest" });
    await keys("openai");
    await chat("openai/gpt-5-mini", "Hi [usage 2000 500]"); // $0.0015 = 75%
    let st = (await ui(url, "/api/state")).json;
    expect(st.budget.warn).toBe(false);
    await chat("openai/gpt-5-mini", "Hi [usage 800 0]"); // +$0.0002 = 85%
    st = (await ui(url, "/api/state")).json;
    expect(st.budget.warn).toBe(true);
    expect(st.notices.some((n: any) => n.kind === "budget" && n.text.includes("85%"))).toBe(true);
  });
});

describe("retirement", () => {
  test("a retired model is replaced by its successor, with a note", async () => {
    await reset({ ticked: ["openai/gpt-4o", "openai/gpt-4.1"] });
    await keys("openai");
    const r = await chat("openai/gpt-4o", "hi");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-model")).toBe("openai/gpt-4.1");
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("GPT-4o retired on 2026-10-01, so Leanfare used its successor, GPT-4.1");
    expect(ledger()[0].switched_from).toBe("openai/gpt-4o");
  });
  test("a notice 30 days ahead, naming the successor", async () => {
    await keys("anthropic");
    setNow("2026-10-20T12:00:00Z"); // Sonnet 4.5 retires 2026-11-10: 21 days
    const st = (await ui(url, "/api/state")).json;
    const n = st.notices.find((x: any) => x.kind === "retire" && x.model === "anthropic/claude-sonnet-4-5");
    expect(n.text).toBe("Claude Sonnet 4.5 retires on 2026-11-10, in 21 days. On that day Leanfare will switch to Claude Sonnet 4.6.");
    setNow("2026-09-01T12:00:00Z"); // 70 days ahead: no notice yet
    expect((await ui(url, "/api/state")).json.notices.some((x: any) => x.model === "anthropic/claude-sonnet-4-5")).toBe(false);
  });
  test("your own successor choice wins", async () => {
    await reset({ ticked: ["openai/gpt-4o", "openai/gpt-5-mini"], successors: { "openai/gpt-4o": "openai/gpt-5-mini" } });
    await keys("openai");
    expect((await chat("openai/gpt-4o", "hi")).headers.get("x-leanfare-model")).toBe("openai/gpt-5-mini");
  });
});

describe("Stop, Pause, Start again", () => {
  test("a client that goes away mid-answer stops the provider call, and the partial answer is recorded as stopped", async () => {
    await keys("openai");
    const ac = new AbortController();
    const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5-mini", stream: true, messages: [{ role: "user", content: "long one [chunks 40]" }] }) });
    const reader = r.body!.getReader();
    await reader.read(); await reader.read();
    ac.abort();
    await Bun.sleep(400);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("stopped");
    expect(fake.seen.find((s) => s.path.endsWith("/chat/completions"))!.aborted).toBe(true);
  });

  test("Pause holds new requests until Start again; answers already running are not cut", async () => {
    await keys("openai");
    setPaused(true);
    let done = false;
    const p = chat("openai/gpt-5-mini", "hi").then((r) => { done = true; return r; });
    await Bun.sleep(300);
    expect(done).toBe(false);
    expect((await ui(url, "/api/state")).json.pause).toEqual({ paused: true, waiting: 1 });
    await ui(url, "/api/pause", { paused: false });
    expect((await p).status).toBe(200);
  });

  test("Stop from the screen ends every running answer", async () => {
    await keys("openai");
    const p = chat("openai/gpt-5-mini", "long one [chunks 40]", { stream: true }).then((r) => r.text());
    await Bun.sleep(150);
    const st = (await ui(url, "/api/state")).json;
    expect(st.running).toHaveLength(1);
    await ui(url, "/api/running/stop", {});
    await p;
    await Bun.sleep(100);
    expect(ledger()[0].status).toBe("stopped");
  });
});

describe("the chat screen's own API", () => {
  test("streams events: chat, meta (model and reason), text, done (cost); keeps the history", async () => {
    await keys("google");
    const r = await fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "What is 2 + 2? [usage 2000 500]" }], model: "auto" }) });
    const { events } = await readSSE(r);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("chat");
    expect(types[1]).toBe("meta");
    expect(types).toContain("delta");
    expect(types.at(-2)).toBe("done");
    expect(types.at(-1)).toBe("saved");
    const meta = events.find((e) => e.type === "meta").plan;
    expect(meta.model.id).toBe("google/gemini-3.8-flash");
    expect(meta.task).toBe("math");
    const done = events.find((e) => e.type === "done").result;
    expect(done.cost.toFixed(8)).toBe(((2000 * 0.75 + 500 * 3.75) / 1e6).toFixed(8));
    expect(done.priceSource).toContain("LiteLLM");
    const chatId = events[0].chatId;
    const saved = (await ui(url, `/api/chats/${chatId}`)).json;
    expect(saved.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(saved.messages[1].meta.model.id).toBe("google/gemini-3.8-flash");
  });

  test("history off: nothing you write is stored anywhere on disk", async () => {
    await reset({ ticked: ALL_TICKED, history: false });
    await keys("google");
    const question = "my-very-private-question-7731";
    const r = await fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: question }] }) });
    await r.text();
    const { db } = await import("../src/db");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(paths.db).includes(Buffer.from(question))).toBe(false);
    expect(ledger()).toHaveLength(1);
  });

  test("the free plan counts as $0 but keeps the list price", async () => {
    await keys("google");
    await ui(url, "/api/providers/google", { free: true });
    await chat("google/gemini-3.8-flash", "hi [usage 2000 500]");
    expect(ledger()[0]).toMatchObject({ cost: 0, price_status: "free plan" });
    expect(ledger()[0].list_cost).toBeGreaterThan(0);
  });

  test("estimates do not wait while paused and hold no budget", async () => {
    await keys("google");
    setPaused(true);
    const r = await ui(url, "/api/estimate", { messages: [{ role: "user", content: "hello" }], model: "auto" });
    expect(r.json.plan.model.id).toBe("google/gemini-3.8-flash");
    expect(r.json.estimate).toBeGreaterThan(0);
  });

  test("removing a chat can be undone", async () => {
    await keys("google");
    const { events } = await readSSE(await fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) }));
    const id = events[0].chatId;
    expect((await ui(url, `/api/chats/${id}`, undefined, "DELETE")).json.chats).toHaveLength(0);
    expect((await ui(url, `/api/chats/${id}/restore`, {})).json.chats).toHaveLength(1);
  });
});

describe("keys", () => {
  test("a good key is tested, saved in a file only you can read, and sent only to its own provider", async () => {
    const r = await ui(url, "/api/keys", { provider: "openai", key: KEYS.openai });
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toContain("accepted the key");
    expect(statSync(paths.keys).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(r.json.state)).not.toContain(KEYS.openai);
    expect(r.json.state.providers.find((p: any) => p.id === "openai").key.hint).toBe("…0001");
    await keys("anthropic");
    await chat("openai/gpt-5-mini", "hi");
    await chat("anthropic/claude-haiku-4-5", "hi");
    for (const s of fake.seen.filter((x) => x.auth)) expect(s.auth).toBe(KEYS[s.provider]);
  });
  test("a wrong key is refused in plain words and never echoed back", async () => {
    const wrong = "sk-wrong-key-123456789";
    const r = await ui(url, "/api/keys", { provider: "openai", key: wrong });
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toContain("OpenAI rejected the key");
    expect(JSON.stringify(r.json)).not.toContain(wrong);
    expect(r.json.state.providers.find((p: any) => p.id === "openai").key.saved).toBe(false);
  });
  test("saving a key ticks that provider's short list", async () => {
    await reset({ ticked: [] });
    const r = await ui(url, "/api/keys", { provider: "anthropic", key: KEYS.anthropic });
    expect(r.json.state.settings.ticked.sort()).toEqual(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"]);
  });
  test("a removed key can be put back within 30 seconds", async () => {
    await keys("openai");
    await ui(url, "/api/keys/openai", undefined, "DELETE");
    expect((await ui(url, "/api/state")).json.providers.find((p: any) => p.id === "openai").key.saved).toBe(false);
    const r = await ui(url, "/api/keys/openai/restore", {});
    expect(r.json.state.providers.find((p: any) => p.id === "openai").key.saved).toBe(true);
  });
});

describe("security", () => {
  test("answers only to its own host name (no DNS rebinding)", async () => {
    const r = await fetch(`${url}/api/state`, { headers: { host: "attacker.example", "x-leanfare": "1" } });
    expect(r.status).toBe(403);
  });
  test("web pages from other sites are refused, unless you allow them", async () => {
    await keys("openai");
    let r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: JSON.stringify({ model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }) });
    expect(r.status).toBe(403);
    expect(ledger()).toHaveLength(0);
    r = await fetch(`${url}/api/state`, { headers: { origin: "https://evil.example", "x-leanfare": "1" } });
    expect(r.status).toBe(403);
    await ui(url, "/api/settings", { allowOrigins: ["http://localhost:3000"] });
    r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
  test("the screens' API needs Leanfare's own header", async () => {
    expect((await fetch(`${url}/api/state`)).status).toBe(403);
  });
  test("the page carries a content security policy and loads nothing from the internet", async () => {
    const r = await fetch(`${url}/`);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await r.text();
    expect(html).not.toMatch(/(src|href)="https?:/);
  });
  test("the stop command needs the control token", async () => {
    const r = await fetch(`${url}/api/control/stop`, { method: "POST", headers: { "x-leanfare-token": "wrong" } });
    expect(r.status).toBe(403);
  });
});

describe("data and privacy", () => {
  test("a fresh catalogue is fetched and kept; a failed fetch keeps the last good copy and says what was tried", async () => {
    fake.setData(syntheticData());
    let r = await ui(url, "/api/refresh", { what: "data" });
    expect(r.json.status.state).toBe("ok");
    expect(r.json.state.data.from).toBe("downloaded");
    fake.setData(null, 503);
    r = await ui(url, "/api/refresh", { what: "data" });
    expect(r.json.status).toMatchObject({ state: "failed", error: "HTTP 503" });
    expect(r.json.status.tried).toContain("/data.json");
    expect(r.json.state.data.from).toBe("downloaded");
  });
  test("Ollama is found on this computer and its models are ticked", async () => {
    const r = await ui(url, "/api/refresh", { what: "ollama" });
    expect(r.json.status.state).toBe("ok");
    expect(r.json.state.settings.ticked).toContain("ollama/llama3.2:latest");
    const c = await chat("ollama/llama3.2:latest", "hi");
    expect(c.status).toBe(200);
    expect(ledger()[0]).toMatchObject({ cost: 0, price_status: "local" });
  });
  test("OpenRouter: one key, its own price list, the exact cost it reports", async () => {
    await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter });
    const c = await chat("openrouter/acme/acme-large", "hi");
    expect(c.status).toBe(200);
    expect(ledger()[0]).toMatchObject({ price_status: "provider", cost: 0.00042 });
    expect(fake.seen.find((s) => s.path.endsWith("/chat/completions"))!.body.usage).toEqual({ include: true });
  });
  test("Leanfare reached no address except the providers and the data file (no telemetry)", () => {
    const hosts = new Set(outgoing.map((u) => new URL(u).host));
    expect([...hosts].every((h) => h.startsWith("127.0.0.1:"))).toBe(true);
  });
});

describe("savings", () => {
  test("a known ledger gives known numbers", async () => {
    await reset({ ticked: ALL_TICKED, usual: "anthropic/claude-sonnet-4-6", subscription: 20 });
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    await chat("auto-save", "What is the capital of Australia? [usage 2000 500]"); // DeepSeek V4 Flash
    await chat("anthropic/claude-sonnet-4-6", "Hi [usage 2000 500]"); // the usual model, by hand
    const s = (await ui(url, "/api/savings")).json;
    const deepseek = (2000 * 0.3 + 500 * 1.2) / 1e6; // 0.0012
    const sonnet = 0.0135;
    expect(s.spent).toBeCloseTo(deepseek + sonnet, 12);
    expect(s.answers).toBe(2);
    expect(s.autoAnswers).toBe(1);
    expect(s.saved.amount).toBeCloseTo(sonnet - deepseek, 12); // Saved by Auto: only the Auto answer counts
    expect(s.more.ratio).toBeCloseTo((2 * sonnet) / (deepseek + sonnet), 9); // more for your money
    expect(s.gap).toBeCloseTo(20 - (deepseek + sonnet), 12); // the gap to the subscription
    expect(s.top.answers).toBe(1);
    expect(s.byTask.find((t: any) => t.task === "overall").answers).toBe(2);
    for (const k of ["spent", "saved", "more", "gap", "answers", "budget", "top"]) expect(s.definitions[k]).toBeString();
  });
});

describe("the database heals itself", () => {
  test("a healthy database is left alone when Leanfare starts again", async () => {
    const { openDb } = await import("../src/db");
    const { readdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    openDb(paths.db);
    openDb(paths.db);
    expect(readdirSync(dirname(paths.db)).filter((f) => f.startsWith("leanfare.db.damaged"))).toEqual([]);
    expect(ledger()).toBeArray();
  });
  test("a damaged file is moved aside, never deleted, and the app starts again", async () => {
    const { openDb, lastRepair } = await import("../src/db");
    const p = paths.db.replace(/\.db$/, "-heal-test.db");
    writeFileSync(p, "this is not a database ".repeat(200));
    openDb(p);
    const { lastRepair: after } = await import("../src/db");
    expect(after?.moved).toContain("-heal-test.db.damaged-");
    expect(readFileSync(after!.moved, "utf8")).toContain("this is not a database");
    openDb(paths.db); // back to the test database
    expect(lastRepair === null || typeof lastRepair === "object").toBe(true);
  });
});
