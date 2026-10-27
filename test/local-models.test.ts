// Models on this computer that Auto and plans can use. Each borrows the rating of the same model in the
// catalogue, a little lower for the lighter copy Ollama runs; takes the context Ollama says it has, at
// most 16k tokens; and a plain request goes to Ollama's own /api/chat with room for it (num_ctx), since
// Ollama's OpenAI-style address runs every model at 4,096 tokens and cuts a longer prompt without a word.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_CONTEXT, LOCAL_PENALTY, getModel, nameParts, store, twinOf, type Model } from "../src/data";
import { ollamaChunks, ollamaPlain, ollamaToOpenAI, toOllama } from "../src/upstream";
import { ALL_TICKED, boot, fake, keys, ledger, post, readSSE, reset, ui } from "./app";

const model = (over: Partial<Model>): Model => ({
  id: "x/y", provider: "openrouter", apiId: "y", source: "test", maker: "m", name: "y", label: "Y", input: 1, output: 1, cacheRead: null, cacheWrite: null,
  context: 128_000, skills: [], added: "2026-01-01", retire: null, ratings: {}, ...over,
}) as Model;

describe("the same model in the catalogue", () => {
  const cat = [
    model({ id: "a/gemma-4-31b", name: "gemma-4-31b", label: "Gemma 4 31B", ratings: { overall: 1452, coding: 1400 } }),
    model({ id: "b/gemma-4-31b-it", name: "gemma-4-31b-it", label: "Gemma 4 31B IT (borrowed)", ratings: { overall: 1365 }, ratingFrom: "Gemma 3 27B IT" }),
    model({ id: "c/qwen3.8-27b", name: "qwen3.8-27b", label: "Qwen3.8-27B", ratings: { overall: 1437 } }),
    model({ id: "d/qwen3-30b-a3b", name: "qwen3-30b-a3b", label: "Qwen3-30B-A3B", ratings: { overall: 1327 } }),
    model({ id: "e/qwen3-coder-30b-a3b-instruct", name: "qwen3-coder-30b-a3b-instruct", label: "Qwen3 Coder 30B", ratings: { overall: 1350 } }),
    model({ id: "f/gpt-oss-20b", name: "gpt-oss-20b", label: "gpt-oss-20b", ratings: { overall: 1317 } }),
    model({ id: "g/gemma-4-26b-a4b-it", name: "gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", ratings: {} }),
    model({ id: "h/qwen3-vl-30b-a3b-instruct", name: "qwen3-vl-30b-a3b-instruct", label: "Qwen3 VL 30B", ratings: { overall: 1340 } }),
    model({ id: "ollama/gemma4:31b", provider: "ollama", name: "gemma4:31b", label: "gemma4:31b", ratings: { overall: 1437 }, local: true }),
  ];
  test("an Ollama name finds its twin by family and size, and only one rated on its own", () => {
    expect(twinOf("gemma4:31b", cat)?.label).toBe("Gemma 4 31B"); // not the one whose rating is borrowed, not a local one
    expect(twinOf("gemma4:31b-it-qat", cat)?.label).toBe("Gemma 4 31B");
    expect(twinOf("qwen3.8:27b", cat)?.label).toBe("Qwen3.8-27B");
    expect(twinOf("qwen3:30b", cat)?.label).toBe("Qwen3-30B-A3B"); // its active size (a3b) does not make it another model
    expect(twinOf("qwen3-coder:30b", cat)?.label).toBe("Qwen3 Coder 30B");
    expect(twinOf("gpt-oss:20b", cat)?.label).toBe("gpt-oss-20b");
    expect(twinOf("hf.co/someone/Qwen3.8-27B-GGUF:Q4_K_M", cat)?.label).toBe("Qwen3.8-27B");
  });
  test("no twin: no size in the name, another size, another kind of model, a twin with no rating, extra words", () => {
    expect(twinOf("llama3.2:latest", cat)).toBeNull();
    expect(twinOf("gemma4:12b", cat)).toBeNull();
    expect(twinOf("qwen3-vl:8b", cat)).toBeNull();
    expect(twinOf("qwen3:30b-coder", cat)).toBeNull(); // a word that may make it another model
    expect(twinOf("gemma4:26b", cat)).toBeNull(); // the twin is not rated yet
    expect(twinOf("deepseek-r1:14b", cat)).toBeNull();
  });
  test("a name's family, size and the words after it", () => {
    expect(nameParts("gemma-4-31b-it")).toEqual({ fam: "gemma4", size: "31b", extra: ["it"] });
    expect(nameParts("qwen3.8:27b")).toEqual({ fam: "qwen38", size: "27b", extra: [] });
    expect(nameParts("gemma4:e2b-it-qat")).toEqual({ fam: "gemma4", size: "e2b", extra: ["it", "qat"] });
    expect(nameParts("llama3.2:latest")).toEqual({ fam: "llama32latest", size: null, extra: [] });
  });
});

describe("Ollama's own chat API, in OpenAI's shape", () => {
  const m = model({ id: "ollama/gemma4:31b", provider: "ollama", apiId: "gemma4:31b", local: true, context: 16_384 });
  test("plain text requests go there; tools, images and other roles keep the OpenAI-style address", () => {
    expect(ollamaPlain({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "Hi" }] }] })).toBe(true);
    expect(ollamaPlain({ messages: [{ role: "user", content: "Hi" }], tools: [{ type: "function" }] })).toBe(false);
    expect(ollamaPlain({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] })).toBe(false);
    expect(ollamaPlain({ messages: [{ role: "tool", content: "42", tool_call_id: "1" }] })).toBe(false);
    expect(ollamaPlain({ messages: [{ role: "user", content: "Hi" }], response_format: { type: "json_object" } })).toBe(false);
  });
  test("the context asked for holds the prompt and the answer, in steps of 1024, between 4096 and the model's own", () => {
    const small = toOllama({ messages: [{ role: "user", content: "Hi" }], max_tokens: 500, temperature: 0.2, stop: "END" }, m, true, null);
    expect(small).toEqual({ model: "gemma4:31b", messages: [{ role: "user", content: "Hi" }], stream: true, options: { num_ctx: 4096, num_predict: 500, temperature: 0.2, stop: ["END"] } });
    const mid = toOllama({ messages: [{ role: "user", content: "x".repeat(24_000) }] }, m, false, 1000); // 8,000 tokens and an answer of 1,000
    expect(mid.options.num_ctx).toBe(10_240);
    expect(mid.options.num_predict).toBe(1000);
    const big = toOllama({ messages: [{ role: "user", content: "x".repeat(90_000) }] }, m, false, null);
    expect(big.options.num_ctx).toBe(16_384); // never past the model's context
    expect(toOllama({ messages: [{ role: "user", content: "x".repeat(90_000) }] }, { ...m, context: 8192 }, false, null).options.num_ctx).toBe(8192);
  });
  test("a whole answer and a streamed one, with thinking, the reason it stopped, and Ollama's own token counts", () => {
    expect(ollamaToOpenAI({ message: { role: "assistant", content: "Hello.", thinking: "Hm." }, done: true, done_reason: "length", prompt_eval_count: 20, eval_count: 5 }, "gemma4:31b")).toMatchObject({
      object: "chat.completion", model: "gemma4:31b", choices: [{ message: { role: "assistant", content: "Hello.", reasoning: "Hm." }, finish_reason: "length" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
    expect(ollamaToOpenAI({ error: "model 'x' not found" }, "x")).toEqual({ error: { message: "model 'x' not found" } });
    expect(ollamaChunks({ message: { content: "He" }, done: false }, "g")).toMatchObject([{ choices: [{ delta: { content: "He" }, finish_reason: null }] }]);
    expect(ollamaChunks({ message: { content: "", thinking: "Hm" }, done: false }, "g")).toMatchObject([{ choices: [{ delta: { reasoning: "Hm" } }] }]);
    expect(ollamaChunks({ message: { content: "" }, done: false }, "g")).toEqual([]);
    const end = ollamaChunks({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 }, "g");
    expect(end).toMatchObject([{ choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }]);
    expect(ollamaChunks({ error: "out of memory" }, "g")).toEqual([{ error: { message: "out of memory" } }]);
  });
});

describe("in Leanfare", () => {
  let url = "";
  beforeAll(async () => { url = (await boot()).url; });
  const GEMMA = { name: "gemma4:31b-it-qat", model: "gemma4:31b-it-qat", modified_at: "2026-10-20T00:00:00Z", size: 19e9, digest: "gemmadigest01", details: { family: "gemma4", parameter_size: "31B", quantization_level: "Q4_0" } };
  const ID = "ollama/gemma4:31b-it-qat";
  beforeEach(async () => {
    await reset({ ticked: [...ALL_TICKED, ID], mode: "save" });
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    fake.ollama.models = [...fake.ollama.models, GEMMA];
    fake.ollama.contexts[GEMMA.name] = 262_144;
    // The catalogue has its twin, rated on its own (Gemma 4 31B, as one provider serves it).
    store.catalog.models.push(model({ id: "cerebras/gemma-4-31b", provider: "cerebras" as any, apiId: "gemma-4-31b", name: "gemma-4-31b", label: "Gemma 4 31B", ratings: { overall: 1452, longer_query: 1460 } }));
    await ui(url, "/api/refresh", { what: "ollama" });
  });

  test("a local model has its twin's ratings, lower by the penalty, and the context Ollama says, at most 16k", async () => {
    const m = getModel(ID)!;
    expect(m.ratings).toEqual({ overall: 1452 - LOCAL_PENALTY, longer_query: 1460 - LOCAL_PENALTY });
    expect(m.ratingFrom).toBe(`Gemma 4 31B, ${LOCAL_PENALTY} lower for the lighter copy on this computer`);
    expect(m.context).toBe(LOCAL_CONTEXT);
    const listed = (await ui(url, "/api/state")).json.models.ollama.find((x: any) => x.id === ID);
    expect(listed.rating).toBe(1452 - LOCAL_PENALTY); // the model list shows it rated (no longer "unrated: Auto does not pick it")
    expect(getModel("ollama/llama3.2:latest")!.ratings).toEqual({}); // a name with no size stays unrated
  });

  test("a model Ollama says less of keeps its own context; one it says nothing of gets 8k; /api/show is asked once per model file", async () => {
    fake.ollama.contexts[GEMMA.name] = 8192;
    fake.ollama.models = fake.ollama.models.map((x) => (x.name === GEMMA.name ? { ...x, digest: "gemmadigest02" } : x)); // a new copy: asked again
    await ui(url, "/api/refresh", { what: "ollama" });
    expect(getModel(ID)!.context).toBe(8192);
    fake.ollama.contexts["llama3.2:latest"] = null;
    fake.ollama.models = fake.ollama.models.map((x) => (x.name === "llama3.2:latest" ? { ...x, digest: "llamadigest02" } : x));
    const before = fake.seen.filter((s) => s.path === "/ollama/api/show").length;
    await ui(url, "/api/refresh", { what: "ollama" });
    expect(getModel("ollama/llama3.2:latest")!.context).toBe(8192);
    expect(fake.seen.filter((s) => s.path === "/ollama/api/show").length - before).toBe(1); // only the new copy was asked
  });

  test("when /api/show fails, the context is the safe 8k, and it is asked again next time", async () => {
    fake.ollama.showFails = true;
    fake.ollama.models = fake.ollama.models.map((x) => (x.name === GEMMA.name ? { ...x, digest: "gemmadigest03" } : x));
    await ui(url, "/api/refresh", { what: "ollama" });
    expect(getModel(ID)!.context).toBe(8192);
    fake.ollama.showFails = false;
    await ui(url, "/api/refresh", { what: "ollama" });
    expect(getModel(ID)!.context).toBe(LOCAL_CONTEXT);
  });

  test("Auto picks the local model when it is rated well enough (Save more: within 80 of the best), and it runs through /api/chat with room for the prompt", async () => {
    const r = await post(`${url}/v1/chat/completions`, { model: "auto", messages: [{ role: "user", content: `Summarize: ${"word ".repeat(4000)} [usage 6000 300]` }] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-model")).toBe(ID);
    const j = await r.json() as any;
    expect(j.choices[0].message.content).toBe("Hello from gemma4:31b-it-qat.");
    expect(j.usage).toMatchObject({ prompt_tokens: 6000, completion_tokens: 300 });
    const sent = fake.seen.find((s) => s.path === "/ollama/api/chat")!;
    expect(sent.body.options.num_ctx).toBeGreaterThan(4096); // about 6,700 tokens of prompt: Ollama's 4,096 would have cut it
    expect(sent.body.options.num_ctx % 1024).toBe(0);
    expect(fake.seen.some((s) => s.path === "/ollama/v1/chat/completions")).toBe(false);
    expect(ledger().at(-1)).toMatchObject({ model: ID, cost: 0 });
  });

  test("a prompt bigger than the local model's context goes to another model", async () => {
    const r = await post(`${url}/v1/chat/completions`, { model: "auto", messages: [{ role: "user", content: `Summarize: ${"word ".repeat(20_000)}` }] }); // about 33k tokens
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-model")).not.toBe(ID);
  });

  test("Balanced (within 40 of the best) does not pick it: Gemini 3.8 Flash is rated 1496", async () => {
    const r = await post(`${url}/v1/chat/completions`, { model: "auto-balanced", messages: [{ role: "user", content: "Summarize this page." }] });
    expect(r.headers.get("x-leanfare-model")).not.toBe(ID);
  });

  test("streamed through Leanfare: OpenAI chunks with thinking, the end, and the token counts for the ledger", async () => {
    const r = await post(`${url}/v1/chat/completions`, { model: ID, stream: true, messages: [{ role: "user", content: "Hi [think] [usage 40 12]" }] });
    const { events, raw } = await readSSE(r);
    const text = events.filter((e: any) => e?.choices?.[0]?.delta?.content).map((e: any) => e.choices[0].delta.content).join("");
    expect(text).toBe("Hello from gemma4:31b-it-qat.");
    expect(events.some((e: any) => e?.choices?.[0]?.delta?.reasoning === "Let me think.")).toBe(true);
    expect(events.some((e: any) => e?.choices?.[0]?.finish_reason === "stop")).toBe(true);
    expect(raw.trim().endsWith("data: [DONE]")).toBe(true);
    expect(ledger().at(-1)).toMatchObject({ model: ID, in_tokens: 40, out_tokens: 12, status: "ok" });
  });

  test("a stream that drops before Ollama says it is done is told as cut off, not as an answer", async () => {
    const r = await post(`${url}/v1/chat/completions`, { model: ID, stream: true, messages: [{ role: "user", content: "Hi there [cut1] [chunks 3]" }] });
    const { raw } = await readSSE(r);
    expect(raw).toContain("incomplete_answer");
    expect(ledger().at(-1)).toMatchObject({ model: ID, status: "error" });
  });

  test("a request with tools to a local model keeps the OpenAI-style address", async () => {
    await post(`${url}/v1/chat/completions`, { model: ID, messages: [{ role: "user", content: "Weather?" }], tools: [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: {} } } }] });
    expect(fake.seen.some((s) => s.path === "/ollama/v1/chat/completions")).toBe(true);
    expect(fake.seen.some((s) => s.path === "/ollama/api/chat")).toBe(false);
  });
});

describe("a download that has a twin", () => {
  let url = "";
  beforeAll(async () => { url = (await boot()).url; });
  beforeEach(async () => { await reset({ ticked: ALL_TICKED }); await ui(url, "/api/refresh", { what: "ollama" }); });
  test("says it is rated like its twin, so Auto and plans can use it", async () => {
    fake.ollama.library["gpt-oss:20b"] = 14e9;
    store.catalog.models.push(model({ id: "groq/openai/gpt-oss-20b", provider: "groq" as any, apiId: "openai/gpt-oss-20b", name: "gpt-oss-20b", label: "gpt-oss-20b", ratings: { overall: 1317 } }));
    Object.assign((await import("../src/local")).probe, { memory: () => 64e9 });
    expect((await ui(url, "/api/local/pull", { name: "gpt-oss:20b" })).status).toBe(200);
    let p: any = null;
    for (let i = 0; i < 400 && (!p || p.active); i++) { await Bun.sleep(10); p = (await ui(url, "/api/local/pull")).json.pull; }
    expect(p.message).toBe("Downloaded gpt-oss:20b (14 GB). It is ticked, and rated like gpt-oss-20b, so Auto and plans can use it.");
  });
});
