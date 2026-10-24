// The chat screen's own features, end to end against the fake providers:
// instructions per chat; asking again, asking another model, editing a question.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, fake, keys, ledger, readSSE, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

export const chatScreen = (u: string, body: unknown) => fetch(`${u}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
const lastSent = () => [...fake.seen].reverse().find((s) => s.path.endsWith("/chat/completions") || s.path.endsWith("/v1/messages"))!;
const chatIdOf = (events: any[]) => events.find((e) => e.type === "chat")?.chatId as string;

describe("instructions for a chat (a system prompt)", () => {
  test("they go first as a system message, and Claude gets them as its system field", async () => {
    await keys("openai", "anthropic");
    await readSSE(await chatScreen(url, { messages: [{ role: "user", content: "Hi" }], model: "openai/gpt-5-mini", system: "Answer in one line." }));
    expect(lastSent().body.messages[0]).toEqual({ role: "system", content: "Answer in one line." });
    expect(lastSent().body.messages[1]).toEqual({ role: "user", content: "Hi" });
    await readSSE(await chatScreen(url, { messages: [{ role: "user", content: "Hi" }], model: "anthropic/claude-haiku-4-5", system: "Answer in one line." }));
    expect(lastSent().body.system).toBe("Answer in one line.");
    expect(lastSent().body.messages.map((m: any) => m.role)).toEqual(["user"]);
  });

  test("no instructions: nothing extra is sent", async () => {
    await keys("openai");
    await readSSE(await chatScreen(url, { messages: [{ role: "user", content: "Hi" }], model: "openai/gpt-5-mini", system: "   " }));
    expect(lastSent().body.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  test("they are kept with the chat, come back with it, and can be changed or cleared", async () => {
    await keys("openai");
    const { events } = await readSSE(await chatScreen(url, { messages: [{ role: "user", content: "Hi" }], model: "openai/gpt-5-mini", system: "Be brief." }));
    const id = chatIdOf(events);
    expect((await ui(url, `/api/chats/${id}`)).json.chat.system).toBe("Be brief.");
    expect((await ui(url, `/api/chats/${id}`, { system: "Be detailed." }, "PATCH")).status).toBe(200);
    expect((await ui(url, `/api/chats/${id}`)).json.chat.system).toBe("Be detailed.");
    expect((await ui(url, `/api/chats/${id}`, { system: "x".repeat(20_001) }, "PATCH")).status).toBe(400);
    await ui(url, `/api/chats/${id}`, { system: "" }, "PATCH");
    expect((await ui(url, `/api/chats/${id}`)).json.chat.system).toBeNull();
    // Renaming alone leaves them alone.
    await ui(url, `/api/chats/${id}`, { system: "Keep me." }, "PATCH");
    await ui(url, `/api/chats/${id}`, { title: "Renamed" }, "PATCH");
    expect((await ui(url, `/api/chats/${id}`)).json.chat).toMatchObject({ title: "Renamed", system: "Keep me." });
  });

  test("the default for new chats is a setting, checked for length", async () => {
    expect((await ui(url, "/api/settings", { instructions: "x".repeat(20_001) })).status).toBe(400);
    const r = await ui(url, "/api/settings", { instructions: "  Use British spelling.  " });
    expect(r.json.settings.instructions).toBe("Use British spelling.");
  });

  test("the estimate counts them", async () => {
    await keys("openai");
    const est = async (system: string) => (await ui(url, "/api/estimate", { messages: [{ role: "user", content: "Hi" }], model: "openai/gpt-5-mini", system })).json.estimate as number;
    const plain = await est("");
    const long = await est("x".repeat(19_000)); // about 4,750 tokens at $0.25 per 1M
    expect(long - plain).toBeCloseTo((19_000 / 4) * 0.25 / 1e6, 6);
  });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const doneOf = (events: any[]) => events.find((e) => e.type === "done")?.result;
const messagesOf = async (id: string) => (await ui(url, `/api/chats/${id}`)).json.messages as any[];

describe("asking again, asking another model, editing", () => {
  async function firstTurn(content = "Name a colour [usage 1000 100]", model = "openai/gpt-5-mini", files?: unknown[]) {
    const { events } = await readSSE(await chatScreen(url, { messages: [{ role: "user", content, ...(files ? { files } : {}) }], model }));
    const id = chatIdOf(events);
    const msgs = await messagesOf(id);
    return { id, question: msgs[0], answer: msgs[1] };
  }

  test("again: the answer is replaced, and both tries are in the ledger", async () => {
    await keys("openai");
    const t = await firstTurn();
    await readSSE(await chatScreen(url, { chatId: t.id, action: "again", target: t.answer.id, model: "openai/gpt-5-mini", messages: [{ role: "user", content: t.question.content }] }));
    const msgs = await messagesOf(t.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].id).not.toBe(t.answer.id);
    expect(ledger()).toHaveLength(2);
  });

  test("another model: both answers stay, and the new one carries the comparison", async () => {
    await keys("openai", "anthropic");
    const t = await firstTurn();
    const { events } = await readSSE(await chatScreen(url, { chatId: t.id, action: "another", target: t.answer.id, model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: t.question.content }] }));
    const done = doneOf(events);
    expect(done.model.id).toBe("anthropic/claude-haiku-4-5");
    expect(done.compare).toEqual({ model: { id: "openai/gpt-5-mini", label: t.answer.meta.model.label }, cost: t.answer.meta.cost });
    expect(done.cost).toBeCloseTo((1000 * 1 + 100 * 5) / 1e6, 10); // Haiku: $1 in, $5 out
    expect(t.answer.meta.cost).toBeCloseTo((1000 * 0.25 + 100 * 2) / 1e6, 10);
    const msgs = await messagesOf(t.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(msgs[2].meta.compare.model.id).toBe("openai/gpt-5-mini");
    // Nothing new was saved for the question.
    expect(fake.seen.filter((x) => x.path.endsWith("/v1/messages")).at(-1)!.body.messages).toEqual([{ role: "user", content: t.question.content }]);
  });

  test("another model with history off: the page says what it is compared with", async () => {
    await reset({ ticked: ALL_TICKED, history: false });
    await keys("openai", "anthropic");
    const { events } = await readSSE(await chatScreen(url, { action: "another", model: "anthropic/claude-haiku-4-5", compare: { model: { id: "openai/gpt-5-mini", label: "GPT-5 mini" }, cost: 0.00045 }, messages: [{ role: "user", content: "Name a colour [usage 1000 100]" }] }));
    expect(doneOf(events).compare).toEqual({ model: { id: "openai/gpt-5-mini", label: "GPT-5 mini" }, cost: 0.00045 });
  });

  test("edit: the question and everything after it go; its kept files stay with the new question", async () => {
    await keys("openai");
    const t = await firstTurn("What is in it? [usage 100 10]", "openai/gpt-5-mini", [{ name: "chart.png", type: "image/png", data: PNG }]);
    const fileId = t.question.files[0].id;
    await readSSE(await chatScreen(url, { chatId: t.id, model: "openai/gpt-5-mini", messages: [
      { role: "user", content: t.question.content, files: [{ id: fileId, name: "chart.png" }] }, { role: "assistant", content: t.answer.content }, { role: "user", content: "And the second? [usage 100 10]" },
    ] }));
    expect((await messagesOf(t.id)).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const { events } = await readSSE(await chatScreen(url, { chatId: t.id, action: "edit", target: t.question.id, model: "openai/gpt-5-mini", messages: [
      { role: "user", content: "What colour is it? [usage 100 10]", files: [{ id: fileId, name: "chart.png" }] },
    ] }));
    expect(events.find((e) => e.type === "chat").userMessageId).toBeGreaterThan(t.question.id);
    const msgs = await messagesOf(t.id);
    expect(msgs.map((m) => [m.role, m.content.slice(0, 17)])).toEqual([["user", "What colour is it"], ["assistant", "Hello from gpt-5-"]]);
    expect(msgs[0].files.map((f: any) => f.id)).toEqual([fileId]);
    expect(lastSent().body.messages[0].content[0].image_url.url).toBe(`data:image/png;base64,${PNG}`);
  });

  test("edit of a question that is not there any more is sent as a new one", async () => {
    await keys("openai");
    const t = await firstTurn();
    await readSSE(await chatScreen(url, { chatId: t.id, action: "edit", target: 999_999, model: "openai/gpt-5-mini", messages: [{ role: "user", content: t.question.content }, { role: "assistant", content: t.answer.content }, { role: "user", content: "More [usage 10 10]" }] }));
    expect((await messagesOf(t.id)).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
