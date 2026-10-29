// Models on this computer that think before they answer (upstream.ts: toOllama). Ollama lists "thinking" among
// their capabilities, and their thinking counts toward the answer's limit: at low effort Leanfare asks them to answer
// without thinking, and otherwise gives them room for it. Before this, qwen3.5 4B and 9B failed the reading test
// (6 and 5 of 8 missed): each answer had 1,024 tokens, and thinking took them all.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getModel, type Model } from "../src/data";
import { runDelegate } from "../src/delegate";
import { setSwitch } from "../src/switch";
import { QUESTIONS, truths } from "../src/trial";
import { LOCAL_THINK_ROOM, toOllama } from "../src/upstream";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => setSwitch(true));
const QWEN = "ollama/qwen3.5:9b";
const T = truths();
const right = (q: (typeof QUESTIONS)[number]) => { const v = T[QUESTIONS.indexOf(q)]; return Array.isArray(v) ? v.join(", ") : String(v); };
function answers() {
  fake.hooks.answer = (prompt, provider) => {
    if (provider !== "ollama") return null;
    const q = QUESTIONS.find((x) => prompt.includes(x.task));
    return q ? right(q) : "The errors are at 10:01.";
  };
}
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  setSwitch(true);
  fake.ollama.models.push({ name: "qwen3.5:9b", model: "qwen3.5:9b", modified_at: "2026-10-01T00:00:00Z", size: 6.6e9, digest: "think1", details: { family: "qwen35", parameter_size: "9B", quantization_level: "Q4_K_M" } });
  fake.ollama.contexts["qwen3.5:9b"] = 16384;
  fake.ollama.thinkers["qwen3.5:9b"] = 2000; // it thinks for 2,000 tokens unless asked not to (its own digest: Leanfare keeps what /api/show said per model file)
  await ui(url, "/api/refresh", { what: "ollama" });
  await keys("openai", "google", "deepseek");
});
const chats = () => fake.seen.filter((s) => s.path === "/ollama/api/chat");

describe("a model on this computer that thinks first", () => {
  test("Leanfare knows it thinks, from Ollama, and the one that does not stays as it was", () => {
    expect(getModel(QWEN)!.skills).toContain("reasoning");
    expect(getModel("ollama/llama3.2:latest")!.skills).not.toContain("reasoning");
  });

  test("the test asks it to answer without thinking, and it passes", async () => {
    answers();
    await ui(url, "/api/local/test", { model: QWEN });
    let v: any = null;
    for (let i = 0; i < 400; i++) { v = (await ui(url, "/api/local/test")).json; if (!v.running) break; await Bun.sleep(50); }
    expect(v.results[QWEN]).toMatchObject({ right: 8, asked: 8, passed: true });
    const asked = chats().filter((s) => s.body?.model === "qwen3.5:9b");
    expect(asked.length).toBe(8);
    for (const s of asked) expect(s.body.think).toBe(false);
    fake.hooks.answer = null;
  }, 30_000);

  test("at medium effort it thinks, with room for it on top of the answer, so the answer is not lost", async () => {
    answers();
    const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };
    const r = await runDelegate({ task: "List the errors.", files: [LOG], kind: "read", effort: "medium", check: "never", maxOut: 1024, model: QWEN, only: (m) => m.id === QWEN, trial: true }, new AbortController().signal);
    expect(r.model?.id).toBe(QWEN);
    expect(r.answer).toContain("10:01");
    const sent = chats().at(-1)!.body;
    expect(sent.think).toBeUndefined(); // as the model likes it: thinking
    expect(sent.options.num_predict).toBe(1024 + LOCAL_THINK_ROOM);
    fake.hooks.answer = null;
  });
});

describe("the request to Ollama", () => {
  const m = (over: Partial<Model> = {}): Model => ({ id: "ollama/q:9b", provider: "ollama", apiId: "q:9b", source: "ollama", maker: "local", name: "q:9b", label: "q:9b", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 16_384, skills: ["reasoning"], added: null, retire: null, ratings: {}, local: true, ...over });
  const ask = { messages: [{ role: "user", content: "Hi" }], max_tokens: 500 };
  test("low effort: no thinking, the answer's own limit", () => {
    expect(toOllama(ask, m(), false, null, "low")).toMatchObject({ think: false, options: { num_predict: 500 } });
    expect(toOllama({ ...ask, reasoning_effort: "minimal" }, m(), false, null)).toMatchObject({ think: false, options: { num_predict: 500 } }); // from an app on the OpenAI address
  });
  test("medium, high or none said: it thinks, with room on top of the answer, and the context holds both", () => {
    for (const e of ["medium", "high", null]) {
      const b = toOllama(ask, m(), false, null, e);
      expect(b.think).toBeUndefined();
      expect(b.options.num_predict).toBe(500 + LOCAL_THINK_ROOM);
      expect(b.options.num_ctx).toBeGreaterThanOrEqual(500 + LOCAL_THINK_ROOM);
    }
    expect(toOllama({ messages: ask.messages }, m(), false, null, "medium").options.num_predict).toBeUndefined(); // no limit asked: none set
  });
  test("a model that does not think is sent as before", () => {
    const b = toOllama(ask, m({ skills: [] }), false, null, "low");
    expect(b.think).toBeUndefined();
    expect(b.options.num_predict).toBe(500);
  });
});
