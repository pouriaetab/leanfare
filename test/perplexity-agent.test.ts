// Perplexity's Agent API (upstream.ts, 0.10): Sonar's chat completions moved there in July 2026. A request goes out in
// OpenAI's Responses shape with web search on, and the answer comes back as chat completions, whole or streamed.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { checkKey, responsesToOpenAI, ResponsesStreamTranslator, toResponses } from "../src/upstream";
import { boot, fake, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset(); });
const SONAR = { id: "perplexity/sonar", provider: "perplexity", apiId: "sonar" } as any;

describe("a request in the Responses shape", () => {
  test("one question: its text as the input; the system message as instructions; web search on; the answer limit", () => {
    expect(toResponses({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "What happened today?" }], max_tokens: 300 }, SONAR, true, null))
      .toEqual({ model: "perplexity/sonar", input: "What happened today?", instructions: "Be brief.", tools: [{ type: "web_search" }], stream: true, max_output_tokens: 300 });
  });
  test("a conversation: its turns as input items; Leanfare's own limit when the request has none", () => {
    const b = toResponses({ messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }, { role: "assistant", content: "Hello." }, { role: "user", content: "And today?" }] }, SONAR, false, 4096);
    expect(b).toMatchObject({ input: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello." }, { role: "user", content: "And today?" }], stream: false, max_output_tokens: 4096 });
    expect("instructions" in b).toBe(false);
  });
});

describe("the answer back as chat completions", () => {
  test("streamed: text, thinking, the end with its usage; cut at the limit; failed", () => {
    const tr = new ResponsesStreamTranslator("perplexity/sonar");
    const ev = (type: string, o: any) => tr.event(type, JSON.stringify({ type, ...o }));
    expect(ev("response.created", { response: { status: "in_progress" } })).toEqual([]);
    expect(ev("response.output_text.delta", { delta: "Hel" })[0].choices[0].delta).toEqual({ content: "Hel" });
    expect(ev("response.reasoning_summary_text.delta", { delta: "Looking." })[0].choices[0].delta).toEqual({ reasoning_content: "Looking." });
    const end = ev("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 5, cost: { total_cost: 0.0027 } } } })[0];
    expect([end.choices[0].finish_reason, end.usage.cost.total_cost, tr.done]).toEqual(["stop", 0.0027, true]);
    const cut = new ResponsesStreamTranslator("x").event("response.incomplete", JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }))[0];
    expect(cut.choices[0].finish_reason).toBe("length");
    const failed = new ResponsesStreamTranslator("x").event("response.failed", JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "Search is down." } } }))[0];
    expect(failed).toEqual({ error: { message: "Search is down.", type: "server_error" } });
    expect(new ResponsesStreamTranslator("x").event("x", "not json")).toEqual([]);
  });
  test("whole: the message's text, its finish and usage", () => {
    const j = responsesToOpenAI({ id: "r1", status: "completed", output: [{ type: "search_results" }, { type: "message", content: [{ type: "output_text", text: "One. " }, { type: "output_text", text: "Two." }] }], usage: { input_tokens: 3 } }, "perplexity/sonar");
    expect([j.choices[0].message.content, j.choices[0].finish_reason, j.usage]).toEqual(["One. Two.", "stop", { input_tokens: 3 }]);
    expect(responsesToOpenAI({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "Cut" }, "m").choices[0]).toMatchObject({ message: { content: "Cut" }, finish_reason: "length" });
  });
});

test("a key is tested at the Agent API's address", async () => {
  const ok = await checkKey("perplexity", "pplx-test-key-0008");
  expect(ok.ok).toBe(true);
  expect(fake.seen.filter((s) => s.provider === "perplexity").at(-1)!.path).toBe("/perplexity/v1/agent");
  const bad = await checkKey("perplexity", "pplx-wrong");
  expect([bad.ok, bad.status]).toEqual([false, 401]);
});
