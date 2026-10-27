// The chat screen's own features, end to end against the fake providers:
// instructions per chat; asking again, asking another model, editing a question.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, fake, keys, ledger, post, readSSE, reset, ui } from "./app";

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

  test("short answers, on by default: said first, then the chat's own instructions; never kept with the chat, nor sent to other apps' requests", async () => {
    const { BRIEF, DEFAULTS } = await import("../src/settings");
    expect(DEFAULTS.brief).toBe(true);
    await reset({ ticked: ALL_TICKED, brief: true });
    await keys("openai");
    const { events } = await readSSE(await chatScreen(url, { messages: [{ role: "user", content: "Hi" }], model: "openai/gpt-5-mini", system: "Answer in French." }));
    expect(lastSent().body.messages[0]).toEqual({ role: "system", content: `${BRIEF}\n\nAnswer in French.` });
    expect((await ui(url, `/api/chats/${chatIdOf(events)}`)).json.chat.system).toBe("Answer in French."); // the chat keeps only its own
    await readSSE(await chatScreen(url, { messages: [{ role: "user", content: "Hi" }], model: "openai/gpt-5-mini" }));
    expect(lastSent().body.messages[0]).toEqual({ role: "system", content: BRIEF });
    await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Hi" }] });
    expect(lastSent().body.messages).toEqual([{ role: "user", content: "Hi" }]); // another app's request goes as it was sent
    expect(BRIEF).toContain("table or a numbered list");
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

describe("what the chat keeps", () => {
  const send = (body: unknown) => chatScreen(url, body);
  const doneOf = (events: any[]) => events.find((e) => e.type === "done")?.result;
  const chatOf = (events: any[]) => events.find((e) => e.type === "chat");

  test("Again replaces the answer only when a new one came: refused, the earlier answer stays", async () => {
    await keys("openai");
    const first = await readSSE(await send({ messages: [{ role: "user", content: "Name a colour [usage 1000 100]" }], model: "openai/gpt-5-mini" }));
    const chatId = chatOf(first.events).chatId;
    const before = (await ui(url, `/api/chats/${chatId}`)).json.messages;
    expect(before.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    await ui(url, "/api/settings", { budget: 0.0001, atLimit: "stop" });
    const again = await readSSE(await send({ chatId, action: "again", target: before[1].id, model: "openai/gpt-5-mini", messages: [{ role: "user", content: before[0].content }] }));
    expect(again.events.find((e) => e.type === "error")?.status).toBe(402);
    const after = (await ui(url, `/api/chats/${chatId}`)).json.messages;
    expect(after.map((m: any) => m.id)).toEqual(before.map((m: any) => m.id));
    // With room again, Again does replace it.
    await ui(url, "/api/settings", { budget: null });
    const ok = await readSSE(await send({ chatId, action: "again", target: before[1].id, model: "openai/gpt-5-mini", messages: [{ role: "user", content: before[0].content }] }));
    expect(doneOf(ok.events).status).toBe("ok");
    const last = (await ui(url, `/api/chats/${chatId}`)).json.messages;
    expect(last).toHaveLength(2);
    expect(last[1].id).not.toBe(before[1].id);
  });

  test("the same words again after a failed send, with a new file: the new file is kept", async () => {
    await keys("openai");
    const a = { name: "jan.csv", type: "text/csv", data: Buffer.from("month,total\njan,1\n").toString("base64") };
    const b = { name: "feb.csv", type: "text/csv", data: Buffer.from("month,total\nfeb,2\n").toString("base64") };
    const first = await readSSE(await send({ model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: "Sum the totals", files: [a] }] })); // no Anthropic key
    const chatId = chatOf(first.events).chatId;
    const fileA = chatOf(first.events).files[0];
    const second = await readSSE(await send({ chatId, model: "openai/gpt-5-mini", messages: [
      { role: "user", content: "Sum the totals", files: [{ id: fileA.id, name: fileA.name }] },
      { role: "user", content: "Sum the totals", files: [b] },
    ] }));
    expect(doneOf(second.events).status).toBe("ok");
    const msgs = (await ui(url, `/api/chats/${chatId}`)).json.messages;
    expect(msgs.flatMap((m: any) => m.files.map((f: any) => f.name))).toContain("feb.csv");
  });

  test("with history turned off, a follow-up in a chat with files still sends", async () => {
    await keys("openai");
    const file = { name: "notes.txt", type: "text/plain", data: Buffer.from("The launch is on Friday.").toString("base64") };
    const first = await readSSE(await send({ model: "openai/gpt-5-mini", messages: [{ role: "user", content: "When is the launch?", files: [file] }] }));
    const { chatId, files } = chatOf(first.events);
    await ui(url, "/api/settings", { history: false });
    const next = await readSSE(await send({ chatId, model: "openai/gpt-5-mini", messages: [
      { role: "user", content: "When is the launch?", files: [{ id: files[0].id, name: files[0].name }] },
      { role: "assistant", content: "Friday." },
      { role: "user", content: "And what day is that?" },
    ] }));
    expect(next.events.find((e) => e.type === "error")).toBeUndefined();
    expect(doneOf(next.events).status).toBe("ok");
  });

  test("a chat saved for the first time keeps what came before its new message", async () => {
    await keys("openai");
    // A question the server never read (stopped at once), then a follow-up; or a chat from before history was on.
    const { events } = await readSSE(await send({ chatId: "firstSave_0001", model: "openai/gpt-5-mini", messages: [
      { role: "user", content: "What is a good name for a bakery?" },
      { role: "assistant", content: "Crumb & Co." },
      { role: "user", content: "Make it shorter please" },
    ] }));
    expect(doneOf(events).status).toBe("ok");
    const msgs = (await ui(url, "/api/chats/firstSave_0001")).json.messages;
    expect(msgs.map((m: any) => `${m.role}: ${m.content}`)).toEqual(["user: What is a good name for a bakery?", "assistant: Crumb & Co.", "user: Make it shorter please", "assistant: Hello from gpt-5-mini."]);
  });

  test("a new chat takes the name the page gave it, if it has that form", async () => {
    await keys("openai");
    const good = await readSSE(await send({ chatId: "pageMade_id-01", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Hi" }] }));
    expect(chatOf(good.events).chatId).toBe("pageMade_id-01");
    expect((await ui(url, "/api/chats/pageMade_id-01")).status).toBe(200);
    const bad = await readSSE(await send({ chatId: "../not a name", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Hi" }] }));
    expect(chatOf(bad.events).chatId).not.toBe("../not a name");
    expect(chatOf(bad.events).chatId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  test("a long pasted file goes through quickly", async () => {
    const dna = Array.from({ length: 250_000 }, (_, i) => "ACGT"[(i * 7 + (i >> 3)) % 4]).join("");
    await keys("openai");
    const t0 = performance.now();
    const r = await ui(url, "/api/estimate", { model: "auto", messages: [{ role: "user", content: "Find the start codons", files: [{ kind: "text", size: dna.length }] }] });
    expect(r.status).toBe(200);
    const file = { name: "genome.txt", type: "text/plain", data: Buffer.from(dna).toString("base64") };
    const { events } = await readSSE(await send({ model: "auto", messages: [{ role: "user", content: "Find the start codons [usage 70000 50]", files: [file] }] }));
    expect(doneOf(events).status).toBe("ok");
    expect(performance.now() - t0).toBeLessThan(3000);
  }, 20000);
});
