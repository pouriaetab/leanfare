// Files attached on the chat screen: what is accepted, what each provider gets,
// what is kept, and how they count in estimates and the budget.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { checkFile, kindOf, prepareMessages, type Attachment } from "../src/files";
import { mediaIn, pdfPages, promptMax, promptTokens } from "../src/cost";
import { ALL_TICKED, boot, fake, keys, ledger, readSSE, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

// A real 1 x 1 PNG, a two-page PDF and a small CSV.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = Buffer.from([
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R >> endobj",
  "4 0 obj << /Type/Page /Parent 2 0 R >> endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF",
].join("\n")).toString("base64");
const CSV = Buffer.from("item,total\nwidgets,12\n").toString("base64");
const png = { name: "chart.png", type: "image/png", data: PNG };
const pdf = { name: "report.pdf", type: "application/pdf", data: PDF };
const csv = { name: "totals.csv", type: "text/csv", data: CSV };

const chatScreen = (body: unknown) => fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
const lastSent = () => [...fake.seen].reverse().find((s) => s.path.endsWith("/chat/completions") || s.path.endsWith("/v1/messages"))!;
const ask = (model: string, files: unknown[], content = "What is in it? [usage 100 10]", extra: Record<string, unknown> = {}) =>
  chatScreen({ messages: [{ role: "user", content, files }], model, ...extra });

describe("which files are accepted", () => {
  test("kinds come from the type or the name", () => {
    expect(kindOf("image/png", "a.png")).toBe("image");
    expect(kindOf("application/pdf", "a")).toBe("pdf");
    expect(kindOf("", "notes.md")).toBe("text");
    expect(kindOf("application/octet-stream", "main.py")).toBe("text");
    expect(kindOf("application/zip", "a.zip")).toBeNull();
    expect(kindOf("image/heic", "photo.heic")).toBeNull();
  });

  test("a file is what its first bytes say, within its size limit", () => {
    expect(checkFile(png)).toMatchObject({ kind: "image", type: "image/png", size: 70 });
    expect(checkFile({ ...png, type: "image/jpeg" })).toContain("does not look like an image of type image/jpeg");
    expect(checkFile(pdf)).toMatchObject({ kind: "pdf", pages: 2 });
    expect(checkFile({ ...pdf, data: PNG })).toContain("does not look like a PDF");
    expect(checkFile({ name: "bin.txt", type: "text/plain", data: Buffer.from("a\u0000b").toString("base64") })).toContain("does not look like a text file");
    const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(6 * 1024 * 1024)]).toString("base64");
    expect(checkFile({ ...png, data: big })).toContain("the most for an image is 5.0 MB");
    expect(checkFile({ ...png, data: "@@@@" })).toMatch(/empty|damaged/);
    expect(checkFile({ name: "x.zip", type: "application/zip", data: PNG })).toContain("Leanfare takes images");
  });

  test("PDF pages are counted from the page objects", () => {
    expect(pdfPages(Buffer.from(PDF, "base64"))).toBe(2);
    expect(pdfPages(Buffer.from("%PDF-1.4 no pages here"))).toBe(1);
  });
});

describe("what each provider gets", () => {
  test("an OpenAI-format model gets the image as an image part, then the question", async () => {
    await keys("openai");
    await readSSE(await ask("openai/gpt-5-mini", [png]));
    const content = lastSent().body.messages[0].content;
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
    expect(content[1]).toEqual({ type: "text", text: "What is in it? [usage 100 10]" });
  });

  test("a PDF goes to GPT as a file part and to Claude as a document block", async () => {
    await keys("openai", "anthropic");
    await readSSE(await ask("openai/gpt-5-mini", [pdf]));
    expect(lastSent().body.messages[0].content[0]).toEqual({ type: "file", file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${PDF}` } });
    await readSSE(await ask("anthropic/claude-haiku-4-5", [png, pdf]));
    const blocks = lastSent().body.messages[0].content;
    expect(blocks[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
    expect(blocks[1]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } });
    expect(blocks[2]).toEqual({ type: "text", text: "What is in it? [usage 100 10]" });
  });

  test("Mistral gets the image as a plain address string", async () => {
    await keys("mistral");
    await readSSE(await ask("mistral/mistral-large-4", [png]));
    expect(lastSent().body.messages[0].content[0]).toEqual({ type: "image_url", image_url: `data:image/png;base64,${PNG}` });
  });

  test("a text file is pasted into the message, so the message stays plain text", async () => {
    await keys("deepseek");
    await readSSE(await ask("deepseek/deepseek-v4-flash", [csv], "Sum the totals [usage 100 10]"));
    expect(lastSent().body.messages[0].content).toBe("Sum the totals [usage 100 10]\n\n[File: totals.csv]\nitem,total\nwidgets,12\n[End of totals.csv]");
  });
});

describe("Auto and chosen models", () => {
  test("Auto with a PDF picks a model that reads PDFs through Leanfare", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    const { events } = await readSSE(await ask("auto", [pdf]));
    const done = events.find((e) => e.type === "done").result;
    expect(["openai", "anthropic"]).toContain(done.model.provider);
    expect(done.task).toBe("longer_query");
    expect(done.why).toBe("a PDF is attached (2 pages)");
  });

  test("Auto with an image skips models that do not see images", async () => {
    await reset({ ticked: ["deepseek/deepseek-v4-flash", "google/gemini-3.8-flash"] });
    await keys("deepseek", "google");
    const { events } = await readSSE(await ask("auto", [png]));
    expect(events.find((e) => e.type === "done").result.model.id).toBe("google/gemini-3.8-flash");
  });

  test("Auto says so when no ticked model takes the file", async () => {
    await reset({ ticked: ["deepseek/deepseek-v4-flash"] });
    await keys("deepseek");
    const { events } = await readSSE(await ask("auto", [png]));
    expect(events.find((e) => e.type === "error").message).toContain("None of the models you ticked takes images");
    expect(ledger()).toHaveLength(0);
  });

  test("a chosen model that cannot take the file says so before anything is sent", async () => {
    await keys("google");
    fake.seen.length = 0;
    const { events } = await readSSE(await ask("google/gemini-3.8-flash", [pdf]));
    expect(events.find((e) => e.type === "error").message).toContain("Gemini 3.8 Flash cannot read PDFs through Leanfare yet");
    expect(fake.seen.filter((s) => s.path.endsWith("/chat/completions"))).toHaveLength(0);
  });

  test("a bad file is refused with its reason", async () => {
    await keys("openai");
    const r = await ask("openai/gpt-5-mini", [{ ...png, type: "image/jpeg" }]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("does not look like an image");
  });

  test("a message can be only a file", async () => {
    await keys("openai");
    const { events } = await readSSE(await ask("openai/gpt-5-mini", [png], ""));
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(lastSent().body.messages[0].content).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }]);
  });
});

describe("keeping files", () => {
  test("with history on, files are kept with the chat and sent again by their id", async () => {
    await keys("openai");
    const first = await readSSE(await ask("openai/gpt-5-mini", [png, csv]));
    const chat = first.events.find((e) => e.type === "chat");
    expect(chat.files.map((f: any) => f.name)).toEqual(["chart.png", "totals.csv"]);
    const saved = (await ui(url, `/api/chats/${chat.chatId}`)).json;
    expect(saved.chat.title).toBe("What is in it? [usage 100 10]");
    const userMsg = saved.messages.find((m: any) => m.role === "user");
    expect(userMsg.files.map((f: any) => [f.name, f.kind])).toEqual([["chart.png", "image"], ["totals.csv", "text"]]);
    const fileId = userMsg.files[0].id;
    expect((await ui(url, `/api/files/${fileId}`)).json).toMatchObject({ name: "chart.png", type: "image/png", data: PNG });
    const answer = saved.messages.find((m: any) => m.role === "assistant");
    await readSSE(await chatScreen({ chatId: chat.chatId, model: "openai/gpt-5-mini", messages: [
      { role: "user", content: "What is in it? [usage 100 10]", files: userMsg.files.map((f: any) => ({ id: f.id, name: f.name })) },
      { role: "assistant", content: answer.content },
      { role: "user", content: "And now? [usage 100 10]" },
    ] }));
    const sent = lastSent().body.messages;
    expect(sent[0].content[0].image_url.url).toBe(`data:image/png;base64,${PNG}`);
    expect(sent[0].content[1].text).toContain("[File: totals.csv]");
    expect(sent[2].content).toBe("And now? [usage 100 10]");
  });

  test("a file id from another chat is not accepted", async () => {
    await keys("openai");
    const first = await readSSE(await ask("openai/gpt-5-mini", [png]));
    const id = first.events.find((e) => e.type === "chat").files[0].id;
    const second = await readSSE(await ask("openai/gpt-5-mini", []));
    const other = second.events.find((e) => e.type === "chat").chatId;
    const r = await chatScreen({ chatId: other, model: "openai/gpt-5-mini", messages: [{ role: "user", content: "x", files: [{ id, name: "chart.png" }] }] });
    expect(r.status).toBe(400);
  });

  test("with history off, files are not kept", async () => {
    await reset({ ticked: ALL_TICKED, history: false });
    await keys("openai");
    await readSSE(await ask("openai/gpt-5-mini", [png, pdf]));
    expect((db.query("SELECT COUNT(*) AS n FROM files").get() as any).n).toBe(0);
  });

  test("when a conversation's files pass what one request carries, the oldest are left out and the model is told", () => {
    const f = (name: string, size: number, kind: Attachment["kind"] = "pdf"): Attachment => ({ name, type: "application/pdf", kind, size, data: "JVBERi0=" });
    const { messages, dropped } = prepareMessages([
      { role: "user", content: "first", files: [f("old.pdf", 80), f("notes.txt", 500, "text")] },
      { role: "assistant", content: "ok", files: [] },
      { role: "user", content: "second", files: [f("new.pdf", 80)] },
    ], 100);
    expect(dropped).toEqual(["old.pdf"]);
    expect(String(messages[0].content)).toContain("[old.pdf was attached here earlier; it is left out now");
    expect(String(messages[0].content)).toContain("[File: notes.txt]");
    expect((messages[2].content as any[])[0].file.filename).toBe("new.pdf");
  });
});

describe("estimates and the budget", () => {
  test("an image counts as tokens, not as its size", () => {
    const photo = "data:image/png;base64," + "A".repeat(2_000_000);
    const msgs = [{ role: "user", content: [{ type: "image_url", image_url: { url: photo } }, { type: "text", text: "hi" }] }];
    expect(mediaIn(msgs)).toMatchObject({ images: 1, est: 1600, max: 3000 });
    expect(promptMax(msgs)).toBeLessThan(3200);
    expect(promptTokens(msgs)).toBe(Math.ceil((2 + 16) / 4) + 1600);
  });

  test("a budget lets a large photo through when its tokens fit", async () => {
    await reset({ ticked: ALL_TICKED, budget: 0.05, atLimit: "stop" });
    await keys("openai");
    const photo = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(1_500_000, 7)]).toString("base64");
    const { events } = await readSSE(await ask("openai/gpt-5-mini", [{ ...png, data: photo }]));
    expect(events.find((e) => e.type === "done").result.status).toBe("ok");
  });

  test("the screen's estimate counts files from their description", async () => {
    await keys("openai");
    const est = async (files: unknown[]) => (await ui(url, "/api/estimate", { messages: [{ role: "user", content: "Hi", files }], model: "openai/gpt-5-mini" })).json.estimate as number;
    const plain = await est([]);
    expect((await est([{ kind: "image" }])) - plain).toBeCloseTo(1600 * 0.25 / 1e6, 8);
    // A PDF also makes the task "long prompts", whose answers run 600 tokens instead of 400.
    expect((await est([{ kind: "pdf", pages: 3 }])) - plain).toBeCloseTo(6000 * 0.25 / 1e6 + 200 * 2 / 1e6, 8);
  });
});
