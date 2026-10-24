// Regression tests for defects found before the first release. Each one
// failed before its fix.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { paths } from "../src/config";
import { ALL_TICKED, boot, fake, keys, ledger, post, readSSE, reset } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const spent = () => ledger().reduce((a, r) => a + (r.cost ?? 0), 0);
const chatScreen = (body: unknown) => fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });

// A provider that misbehaves in a chosen way.
function badProvider(kind: "html200" | "cut") {
  const enc = new TextEncoder();
  return Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch() {
      if (kind === "html200") return new Response("<html><body><h1>Sign in to the Wi-Fi</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "The first half of" } }] })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " an answer" } }] })}\n\n`));
          c.close(); // no finish_reason, no usage, no [DONE]
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
}

describe("a budget set to stop holds", () => {
  test("requests without an answer limit get one, so 50 at once stay within the budget", async () => {
    await reset({ ticked: ["openai/gpt-5-mini"], budget: 0.05, atLimit: "stop" });
    await keys("openai");
    const body = (i: number) => ({ model: "openai/gpt-5-mini", messages: [{ role: "user", content: `Q${i} [usage 10 20000] [slow 200]` }] });
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => post(`${url}/v1/chat/completions`, body(i))));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    expect(spent()).toBeLessThanOrEqual(0.05);
    for (const s of fake.seen.filter((x) => x.path.endsWith("/chat/completions"))) expect(s.body.max_completion_tokens).toBe(4096);
  });
  test("the chat screen sends the limit too, and says when an answer reached it", async () => {
    await reset({ ticked: ["openai/gpt-5-mini"], budget: 0.01, atLimit: "stop" });
    await keys("openai");
    const { events } = await readSSE(await chatScreen({ messages: [{ role: "user", content: "hi [usage 10 20000]" }], model: "openai/gpt-5-mini" }));
    expect(fake.seen.find((x) => x.path.endsWith("/chat/completions"))!.body.max_completion_tokens).toBe(4096);
    expect(spent()).toBeLessThanOrEqual(0.01);
    expect(events.find((e) => e.type === "done").result.notes.join(" ")).toContain("stopped at 4,096 tokens");
  });
  test("tool results and tool definitions count toward the reservation", async () => {
    await reset({ ticked: ["anthropic/claude-sonnet-4-6"], budget: 0.05, atLimit: "stop" });
    await keys("anthropic");
    const msgs = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A".repeat(400_000) }] }];
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(`${url}/v1/messages`, { model: "claude-sonnet-4-6", max_tokens: 100, tools: [{ name: "read", description: "x".repeat(50_000), input_schema: { type: "object" } }], messages: msgs })));
    expect(rs.every((r) => r.status === 402)).toBe(true);
    expect(spent()).toBe(0);
  });
  test("Claude through the OpenAI address gets the same limit that was reserved", async () => {
    await reset({ ticked: ["anthropic/claude-sonnet-4-6"], budget: 0.2, atLimit: "stop" });
    await keys("anthropic");
    await Promise.all(Array.from({ length: 20 }, (_, i) => post(`${url}/v1/chat/completions`, { model: "anthropic/claude-sonnet-4-6", messages: [{ role: "user", content: `Q${i} [usage 10 8192] [slow 200]` }] })));
    expect(fake.seen.find((s) => s.path.endsWith("/v1/messages"))!.body.max_tokens).toBe(4096);
    expect(spent()).toBeLessThanOrEqual(0.2);
  });
  test("without a budget, nothing is added to the request", async () => {
    await keys("openai");
    await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] });
    const b = fake.seen.find((x) => x.path.endsWith("/chat/completions"))!.body;
    expect(b.max_tokens).toBeUndefined();
    expect(b.max_completion_tokens).toBeUndefined();
  });
});

describe("Auto with tools on the OpenAI address", () => {
  test("picks a model that takes tools there, not Claude", async () => {
    await reset({ ticked: ["anthropic/claude-sonnet-4-6", "openai/gpt-5-mini", "google/gemini-3.8-flash"], mode: "best" });
    await keys("anthropic", "openai", "google");
    const r = await post(`${url}/v1/chat/completions`, { model: "auto", tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }], messages: [{ role: "user", content: "Fix the bug in my python function" }] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-model")).not.toStartWith("anthropic/");
  });
});

describe("past the budget, the cheapest model is never a retired one", () => {
  test("a retired model is skipped", async () => {
    await reset({ ticked: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"], budget: 0.0001, atLimit: "cheapest" });
    await keys("anthropic", "openai");
    const r = await post(`${url}/v1/chat/completions`, { model: "anthropic/claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-model")).not.toBe("openai/gpt-4o");
  });
});

describe("broken provider answers are reported as broken", () => {
  test("a web page where an answer should be is an error, billed at nothing", async () => {
    const bad = badProvider("html200");
    process.env.LEANFARE_OPENAI_BASE = `http://127.0.0.1:${bad.port}/v1`;
    try {
      await keys("openai");
      const { events } = await readSSE(await chatScreen({ messages: [{ role: "user", content: "hello" }], model: "openai/gpt-5-mini" }));
      expect(events.find((e) => e.type === "done").result.status).toBe("error");
      expect(events.find((e) => e.type === "error").message).toContain("web page");
      const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", stream: true, messages: [{ role: "user", content: "hello" }] });
      expect(r.status).toBe(502);
      expect(ledger().every((x) => x.status === "error" && x.cost === 0)).toBe(true);
    } finally { process.env.LEANFARE_OPENAI_BASE = fake.bases.openai; bad.stop(true); }
  });
  test("a stream cut off half way is an error, to the app and in the ledger", async () => {
    const bad = badProvider("cut");
    process.env.LEANFARE_OPENAI_BASE = `http://127.0.0.1:${bad.port}/v1`;
    try {
      await keys("openai");
      const raw = await (await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", stream: true, messages: [{ role: "user", content: "hello" }] })).text();
      expect(raw).toContain('"type":"incomplete_answer"');
      expect(ledger()[0].status).toBe("error");
      const { events } = await readSSE(await chatScreen({ messages: [{ role: "user", content: "hello" }], model: "openai/gpt-5-mini" }));
      const done = events.find((e) => e.type === "done").result;
      expect(done.status).toBe("error");
      expect(done.error).toContain("stopped before it finished");
    } finally { process.env.LEANFARE_OPENAI_BASE = fake.bases.openai; bad.stop(true); }
  });
});

describe("a locked database does not lose a paid answer", () => {
  test("the answer is returned, and its ledger row is written once the lock is gone", async () => {
    await reset({ ticked: ALL_TICKED, history: false });
    await keys("openai");
    const other = new Database(paths.db);
    other.exec("BEGIN IMMEDIATE");
    const t0 = performance.now();
    const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi [usage 2000 500]" }] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-cost-usd")).toBe("0.00150000");
    expect(performance.now() - t0).toBeLessThan(1500);
    other.exec("ROLLBACK");
    other.close();
    await Bun.sleep(1300);
    expect(ledger().map((x) => x.cost.toFixed(8))).toEqual(["0.00150000"]);
  });
});

describe("Claude's own stream: the final token counts win", () => {
  test("input counts that grow during the answer (server tools) are kept", async () => {
    const enc = new TextEncoder();
    const ev = (name: string, data: any) => enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(ev("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }));
        c.enqueue(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found it." } }));
        c.enqueue(ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 20000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 } }));
        c.enqueue(ev("message_stop", { type: "message_stop" }));
        c.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    } });
    process.env.LEANFARE_ANTHROPIC_BASE = `http://127.0.0.1:${s.port}`;
    try {
      await keys("anthropic");
      await (await post(`${url}/v1/messages`, { model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "search" }] })).text();
      await (await post(`${url}/v1/chat/completions`, { model: "anthropic/claude-sonnet-4-6", stream: true, messages: [{ role: "user", content: "search" }] })).text();
      expect(ledger().map((r) => r.in_tokens)).toEqual([20000, 20000]);
    } finally { process.env.LEANFARE_ANTHROPIC_BASE = fake.bases.anthropic; s.stop(true); }
  });
});
