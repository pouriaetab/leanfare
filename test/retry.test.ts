// An answer that comes back empty, or is cut off on the way, is asked for once
// more, and the answer says so. What is still empty after that is an error you
// can see, with its reason.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, fake, keys, ledger, post, readSSE, reset } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const chatScreen = (body: unknown) => fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
const ask = async (model: string, content: string) => readSSE(await chatScreen({ model, messages: [{ role: "user", content }] }));
const doneOf = (events: any[]) => events.find((e) => e.type === "done")?.result;
const textOf = (events: any[]) => events.filter((e) => e.type === "delta").map((e) => e.text).join("");
const sent = (path: string) => fake.seen.filter((s) => s.path.endsWith(path)).map((s) => s.body);

describe("on the chat screen", () => {
  test("an empty answer is asked for once more, and both tries are in the ledger", async () => {
    await keys("openai");
    const { events } = await ask("openai/gpt-5-mini", "Hi [empty1] [usage 100 10]");
    expect(events.find((e) => e.type === "retry").message).toBe("The first try came back empty, so Leanfare asked GPT-5 mini once more.");
    expect(textOf(events)).toBe("Hello from gpt-5-mini.");
    const done = doneOf(events);
    expect(done).toMatchObject({ status: "ok", retried: true });
    expect(done.notes).toContain("The first try came back empty, so Leanfare asked GPT-5 mini once more.");
    expect(ledger().map((r) => [r.status, r.error])).toEqual([["error", "came back empty"], ["ok", null]]);
  });

  test("an answer cut off on the way is asked for again, and the page is told to start the answer over", async () => {
    await keys("openai");
    const { events } = await ask("openai/gpt-5-mini", "Tell me [cut1] [chunks 6]");
    const types = events.map((e) => e.type);
    expect(types.indexOf("retry")).toBeGreaterThan(types.indexOf("delta")); // some text came first
    expect(events.find((e) => e.type === "retry").message).toMatch(/^The first answer was cut off after about \d+ words, so Leanfare asked again\.$/);
    const after = events.slice(types.indexOf("retry")).filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(after).toBe("Hello from gpt-5-mini.");
    expect(doneOf(events).status).toBe("ok");
    expect(ledger()[0].error).toContain("cut off");
  });

  test("Claude's cut-off stream is asked for again too", async () => {
    await keys("anthropic");
    const { events } = await ask("anthropic/claude-haiku-4-5", "Tell me [cut1] [chunks 6]");
    expect(events.some((e) => e.type === "retry")).toBe(true);
    expect(doneOf(events).status).toBe("ok");
  });

  test("thinking that used the whole answer limit is asked again with twice the limit", async () => {
    await keys("anthropic");
    const { events } = await ask("anthropic/claude-haiku-4-5", "Hard one [thinkall1]");
    expect(events.find((e) => e.type === "retry").message).toBe("Claude Haiku 4.5 spent its whole 8,192-token answer limit thinking and wrote nothing, so Leanfare asked again with 16,384.");
    expect(sent("/v1/messages").map((b) => b.max_tokens)).toEqual([8192, 16384]);
    expect(doneOf(events).status).toBe("ok");
  });

  test("with a budget on, the second try's higher limit is sent and reserved", async () => {
    await reset({ ticked: ALL_TICKED, budget: 5 });
    await keys("openai");
    const { events } = await ask("openai/gpt-5-mini", "Hard one [thinkall1]");
    expect(sent("/chat/completions").map((b) => b.max_completion_tokens)).toEqual([4096, 8192]);
    expect(doneOf(events).status).toBe("ok");
  });

  test("still empty after the second try: an error that says so", async () => {
    await keys("openai");
    const { events } = await ask("openai/gpt-5-mini", "Hi [empty]");
    const done = doneOf(events);
    expect(done.status).toBe("error");
    expect(done.error).toBe("GPT-5 mini sent an empty answer.");
    expect(ledger().map((r) => r.status)).toEqual(["error", "error"]);
  });

  test("a declined answer is not asked again", async () => {
    await keys("openai");
    const { events } = await ask("openai/gpt-5-mini", "Something [filter]");
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(doneOf(events).error).toBe("GPT-5 mini declined to answer this (its safety filter). Try rewording it, or another model.");
    expect(sent("/chat/completions")).toHaveLength(1);
  });

  test("a stopped answer is not asked again", async () => {
    await keys("openai");
    const ac = new AbortController();
    const r = await fetch(`${url}/api/chat`, { method: "POST", signal: ac.signal, headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Long [chunks 40]" }] }) });
    const reader = r.body!.getReader();
    await reader.read();
    await Bun.sleep(300);
    ac.abort();
    await Bun.sleep(400);
    expect(sent("/chat/completions")).toHaveLength(1);
  });
});

describe("for other apps", () => {
  test("an empty whole answer on the OpenAI address is asked for once more", async () => {
    await keys("openai");
    const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "From an app [empty1] [usage 100 10]" }] }); // [empty1]: a prompt the fake has not seen yet
    expect((await r.json()).choices[0].message.content).toBe("Hello from gpt-5-mini.");
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain("The first try came back empty");
    expect(ledger().map((x) => x.status)).toEqual(["error", "ok"]);
  });

  test("an answer that is only a tool call is not empty", async () => {
    await keys("openai");
    const r = await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Hi [usage 10 10]" }] });
    expect(r.status).toBe(200);
    expect(sent("/chat/completions")).toHaveLength(1);
  });
});
