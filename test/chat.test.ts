// The chat screen's own features, end to end against the fake providers:
// instructions per chat.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, fake, keys, readSSE, reset, ui } from "./app";

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
