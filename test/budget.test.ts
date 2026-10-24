// Requests that could slip past a budget set to stop: several answers in one
// request, second tries, text that looks like a file, a fallback past the
// limit. Each one is held, and a refused message says why.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ALL_TICKED, boot, keys, ledger, post, readSSE, reset } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const chatScreen = (body: unknown) => fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
const spent = () => ledger().reduce((a, r) => a + (r.cost ?? 0), 0);
const doneOf = (events: any[]) => events.find((e) => e.type === "done")?.result;

describe("a budget set to stop holds", () => {
  test("OpenAI's n: several answers in one request are reserved, and billed, as several", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const b: any = await req.json();
      const n = b.n ?? 1, each = b.max_completion_tokens ?? b.max_tokens ?? 100;
      return Response.json({ id: "x", object: "chat.completion", created: 1, model: b.model, choices: Array.from({ length: n }, (_, i) => ({ index: i, message: { role: "assistant", content: "ok" }, finish_reason: "length" })), usage: { prompt_tokens: 10, completion_tokens: n * each, total_tokens: 10 + n * each } });
    } });
    const saved = process.env.LEANFARE_OPENAI_BASE;
    process.env.LEANFARE_OPENAI_BASE = `http://127.0.0.1:${server.port}/v1`;
    try {
      await reset({ ticked: ALL_TICKED, budget: 1, atLimit: "stop" });
      await keys("openai");
      // One answer of 100,000 tokens at $8 per million is $0.80; five are $4.
      const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-4.1", n: 5, max_tokens: 100000, messages: [{ role: "user", content: "Five takes on this" }] });
      expect(r.status).toBe(402);
      const one = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-4.1", n: 1, max_tokens: 100000, messages: [{ role: "user", content: "One take" }] });
      expect(one.status).toBe(200);
      expect(spent()).toBeLessThanOrEqual(1);
    } finally { process.env.LEANFARE_OPENAI_BASE = saved; server.stop(true); }
  });

  test("the second try after an empty answer (no streaming) needs room in the budget of its own", async () => {
    await reset({ ticked: ALL_TICKED, budget: 1, atLimit: "stop" });
    await keys("openai");
    // $0.80 reserved and spent by the first, empty, try; a second one would pass $1.
    const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-4.1", max_tokens: 100000, messages: [{ role: "user", content: "Think hard [empty1] [usage 10 100000]" }] });
    expect(r.status).toBe(200);
    expect(ledger()).toHaveLength(1);
    expect(spent()).toBeLessThanOrEqual(1);
    expect(r.headers.get("x-leanfare-cost-usd")).toBe("0.80002000");
  });

  test("text that starts like a data: address counts in full", async () => {
    await reset({ ticked: ALL_TICKED, budget: 0.5, atLimit: "stop" });
    await keys("openai");
    const blob = randomBytes(750_000).toString("base64"); // a million characters, sent as text
    const control = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-4.1", messages: [{ role: "user", content: `What is this? ${blob} [usage 350000 10]` }] });
    expect(control.status).toBe(402);
    const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-4.1", messages: [{ role: "user", content: `data:text/plain;base64,${blob} [usage 350000 10]` }] });
    expect(r.status).toBe(402);
    expect(spent()).toBe(0);
  });

  test("past the budget, keep going on the cheapest: a second try never forces an expensive model through", async () => {
    await reset({ ticked: ALL_TICKED, budget: 0.9, atLimit: "cheapest" });
    await keys("openai", "deepseek");
    const content = "word ".repeat(80_000) + " [empty1] [usage 260000 10]"; // about 400,000 bytes
    const { events } = await readSSE(await chatScreen({ model: "openai/gpt-4.1", messages: [{ role: "user", content }] }));
    // The empty first try is billed once; asking GPT-4.1 again would pass the budget, so it is not asked.
    const rows = ledger();
    expect(rows.map((r) => r.model)).toEqual(["openai/gpt-4.1"]);
    expect(spent()).toBeLessThanOrEqual(0.9);
    expect(doneOf(events)).toMatchObject({ status: "error" });
    expect(doneOf(events).notes.join(" ")).toContain("does not leave room to ask again");
  });

  test("a refused message says why and how it ended (an error, then done)", async () => {
    await reset({ ticked: ALL_TICKED, budget: 0.0001, atLimit: "stop" });
    await keys("openai");
    const { events } = await readSSE(await chatScreen({ messages: [{ role: "user", content: "Hello" }], model: "openai/gpt-4.1" }));
    const types = events.map((e) => e.type);
    expect(types.indexOf("error")).toBeGreaterThan(-1);
    expect(types.at(-1)).toBe("done");
    expect(doneOf(events)).toMatchObject({ status: "error", refused: true });
    expect(doneOf(events).error).toContain("budget");
  });
});
