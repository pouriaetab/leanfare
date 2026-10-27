// The local model Leanfare suggests for this computer: from a short list of open models anyone may use
// for work (Apache 2.0), the best rated one that runs comfortably in its memory (or, when none does,
// tightly, and it says so), fits on its disk and beats what is installed. It is downloaded only on a
// yes: Download in Settings or the Plan tab, or local_model in an app, which asks the user first.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { store, twinOf, type Model } from "../src/data";
import { probe, SUGGESTED } from "../src/local";
import { forgetPlans } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

const GB = 1e9;
const twin = (provider: string, name: string, label: string, overall: number): Model => ({
  id: `${provider}/${name}`, provider: provider as any, apiId: name, source: "test", maker: "m", name, label, input: 0.2, output: 0.6, cacheRead: null, cacheWrite: null,
  context: 128_000, skills: [], added: "2026-06-01", retire: null, ratings: { overall },
});
// The catalogue's twins of four models on the list, rated as the real catalogue has them (27 Oct).
const TWINS = () => [twin("cerebras", "gemma-4-31b", "Gemma 4 31B", 1452), twin("groq", "qwen3.8-27b", "Qwen3.8-27B", 1437), twin("groq", "gpt-oss-20b", "gpt-oss-20b", 1317), twin("groq", "gpt-oss-120b", "gpt-oss-120b", 1352)];
const computer = (memory: number, free = 200 * GB) => Object.assign(probe, { memory: () => memory, free: () => free });

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  forgetPlans();
  await reset({ ticked: ALL_TICKED });
  store.catalog.models.push(...TWINS());
  await ui(url, "/api/refresh", { what: "ollama" });
  for (const s of SUGGESTED) fake.ollama.library[s.name] = s.size;
});
const suggest = async () => (await ui(url, "/api/local/suggest")).json;

describe("which model", () => {
  test("64 GB: the best rated that runs comfortably (Gemma 4 31B, 19 GB), with why and its licence", async () => {
    computer(64 * GB);
    const s = await suggest();
    expect(s.suggestion).toEqual({ name: "gemma4:31b-it-qat", size: 19 * GB, fit: "fits", rating: 1437, like: "Gemma 4 31B", license: "Apache-2.0" });
    expect(s.why).toBe("gemma4:31b-it-qat (19 GB) runs comfortably in this computer's 64 GB of memory, and is rated like Gemma 4 31B. It runs free, on this computer, and Leanfare's Auto and plans can use it for reading and drafting. Apache 2.0: free to use for work.");
  });
  test("32 GB: none runs comfortably, so the best that runs tightly, and it says so", async () => {
    computer(32 * GB);
    const s = await suggest();
    expect(s.suggestion).toMatchObject({ name: "qwen3.8:27b", fit: "tight", rating: 1422 });
    expect(s.why).toContain("runs in this computer's 32 GB of memory, but tightly: other apps may slow down while it answers");
  });
  test("16 GB: none of the rated ones runs here", async () => {
    computer(16 * GB);
    expect(await suggest()).toEqual({ suggestion: null, why: "None of the rated open models on Leanfare's list runs in 16 GB of memory." });
  });
  test("the disk keeps 10 GB free: with 25 GB free, the one that leaves that much (gpt-oss 20b, 14 GB)", async () => {
    computer(64 * GB, 25 * GB);
    expect((await suggest()).suggestion).toMatchObject({ name: "gpt-oss:20b", size: 14 * GB, fit: "fits" });
    computer(64 * GB, 20 * GB);
    expect(await suggest()).toEqual({ suggestion: null, why: "The disk has 20 GB free; the models that run here need more, and Leanfare keeps 10 GB free." });
  });
  test("nothing better than what is installed: none (the same model in another copy counts as installed)", async () => {
    computer(64 * GB);
    fake.ollama.models = [...fake.ollama.models, { name: "gemma4:31b", model: "gemma4:31b", modified_at: "2026-10-20T00:00:00Z", size: 20 * GB, digest: "g31", details: { family: "gemma4" } }];
    await ui(url, "/api/refresh", { what: "ollama" });
    expect(await suggest()).toEqual({ suggestion: null, why: "gemma4:31b is already as good as what runs here." });
  });
  test("with no rating for any model on the list, none: Auto would not pick it", async () => {
    computer(64 * GB);
    store.catalog.models = store.catalog.models.filter((m) => !SUGGESTED.some((s) => twinOf(s.name, [m])));
    await ui(url, "/api/refresh", { what: "ollama" });
    expect(await suggest()).toEqual({ suggestion: null, why: "Leanfare has no rating yet for the open models on its list, so it suggests none." });
  });
  test("Ollama on another computer: nothing, since this computer's memory says nothing about that one", async () => {
    const was = process.env.LEANFARE_OLLAMA_BASE;
    process.env.LEANFARE_OLLAMA_BASE = "http://10.0.0.5:11434/v1";
    try { expect(await suggest()).toEqual({ suggestion: null, why: "Ollama runs on another computer, so Leanfare cannot tell what fits there." }); }
    finally { process.env.LEANFARE_OLLAMA_BASE = was; }
  });
  test("Settings' Local models card has it too", async () => {
    computer(64 * GB);
    expect((await ui(url, "/api/local")).json.suggest.suggestion.name).toBe("gemma4:31b-it-qat");
  });
  test("every model on the list is one Ollama serves under that name, in the sizes listed (the download checks the real size again)", () => {
    for (const s of SUGGESTED) {
      expect(s.name).toMatch(/^(gemma4|gpt-oss|qwen3\.8):[a-z0-9.-]+$/); // Apache 2.0 families only
      expect(s.size).toBeGreaterThan(1 * GB);
    }
  });
});

describe("in a plan", () => {
  test("a reading part that goes to pay per use: the plan names the local model, and the table says how to get it", async () => {
    computer(64 * GB);
    await keys("openai");
    const r = await ui(url, "/api/plan", { task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 40_000 }], manager: "Claude Code", split: "rules" });
    expect(r.status).toBe(200);
    expect(r.json.parts.some((p: any) => p.where === "paid")).toBe(true);
    expect(r.json.local).toEqual({ name: "gemma4:31b-it-qat", size: 19 * GB, like: "Gemma 4 31B", rating: 1437, fit: "fits" });
    expect(r.json.table).toContain("A local model fits this computer: gemma4:31b-it-qat (19 GB), rated like Gemma 4 31B, free to run. Download it in Settings, Local models (in your app: local_model).");
  });
  test("no reading or drafting part to take: no local model is named", async () => {
    computer(64 * GB);
    await keys("openai");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Fix the parser", kind: "code", effort: "high", needs: [], size: "small", task: "Fix it and run the tests." },
      { title: "Open the pull request", kind: "act", effort: "low", needs: [1], size: "none", task: "Open it." },
    ] }) : null);
    const r = await ui(url, "/api/plan", { task: "Fix the bug in the parser and open a pull request", files: [], manager: "Claude Code" });
    expect(r.json.split.by).toBe("model");
    expect(r.json.local).toBeNull();
    expect(r.json.table).not.toContain("A local model fits");
  });
  test("a part that stays with you only because Leanfare has no model for it: the local model is named", async () => {
    computer(64 * GB);
    fake.ollama.models = []; // nothing on this computer yet, and no key: no model of Leanfare's for any part
    await ui(url, "/api/refresh", { what: "ollama" });
    const r = await ui(url, "/api/plan", { task: "Find the errors in these logs and list them", files: [{ name: "logs/app.log", size: 20_000 }], manager: "Claude Code", split: "rules" });
    expect(r.json.parts.some((p: any) => p.where === "you" && p.why.startsWith("Leanfare has no model"))).toBe(true);
    expect(r.json.local?.name).toBe("gemma4:31b-it-qat");
  });
  test("a part too big for any model on this computer (16k tokens at most): no local model is named for it", async () => {
    computer(64 * GB);
    await keys("openai");
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Read the log", kind: "read", effort: "low", needs: [], size: "large", task: "Find the errors in the log." },
      { title: "Fix the cause", kind: "code", effort: "high", needs: [1], size: "small", task: "Fix it." },
    ] }) : null);
    const r = await ui(url, "/api/plan", { task: "Find the errors in this log and fix them", files: [{ name: "logs/big.log", size: 400_000 }], manager: "Claude Code" });
    fake.hooks.answer = null;
    expect(r.json.parts.filter((p: any) => p.where === "paid").map((p: any) => [p.kind, p.tokens > 50_000])).toEqual([["read", true]]);
    expect(r.json.local).toBeNull();
  });
});

describe("local_model, in an app", () => {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let buffer = "";
  const lines: any[] = [];
  const waiting = new Map<number | string, (m: any) => void>();
  let nextId = 1;
  let onAsk: ((msg: any) => void) | null = null;
  beforeAll(() => {
    child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token", LEANFARE_ASK_WAIT_MS: "2000" },
    });
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
        buffer += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
          lines.push(msg);
          if (msg.method === "elicitation/create") { onAsk?.(msg); continue; }
          if (!msg.method) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
        }
      }
    })();
  });
  afterAll(() => { try { child?.kill(); } catch {} });
  const write = (msg: unknown) => { (child!.stdin as any).write(JSON.stringify(msg) + "\n"); (child!.stdin as any).flush?.(); };
  function rpc(method: string, params?: unknown, ms = 15000): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, resolve);
      write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${method}`)); } }, ms);
    });
  }
  const pulls = () => fake.seen.filter((s) => s.path === "/ollama/api/pull").length;
  // The download starts in the background: wait until Ollama is asked (at most 3 seconds).
  const pulled = async (n: number) => { for (let i = 0; i < 300 && pulls() < n; i++) await Bun.sleep(10); return pulls(); };
  const tool = async (args: unknown) => (await rpc("tools/call", { name: "local_model", arguments: args })).result;

  test("suggest says which and why, and how to download it", async () => {
    computer(64 * GB);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    const r = await tool({});
    expect(r.content[0].text).toContain("gemma4:31b-it-qat (19 GB) runs comfortably");
    expect(r.content[0].text).toContain("To download it: local_model with action download (the user is asked first).");
    expect(r.structuredContent.suggestion.name).toBe("gemma4:31b-it-qat");
  });
  test("an app that cannot ask: download without the yes only says to ask; with yes it starts", async () => {
    computer(64 * GB);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
    const before = pulls();
    const ask = await tool({ action: "download" });
    expect(ask.content[0].text).toBe("Ask the user first: download gemma4:31b-it-qat (19 GB) with Ollama, to run free on this computer? If they agree, call local_model with action download and yes yes.");
    expect(pulls()).toBe(before);
    const go = await tool({ action: "download", yes: "yes" });
    expect(go.structuredContent.downloading).toBe(true);
    expect(await pulled(before + 1)).toBe(before + 1);
    expect(fake.seen.filter((s) => s.path === "/ollama/api/pull").at(-1)!.body.model).toBe("gemma4:31b-it-qat");
    let st: any = null;
    for (let i = 0; i < 400 && (!st || st.pull?.active); i++) { await Bun.sleep(10); st = (await tool({ action: "status" })).structuredContent; }
    expect(st.pull.status).toBe("done");
  });
  test("an app that can ask: the user's yes downloads it, a no downloads nothing", async () => {
    computer(64 * GB);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "2.1" } });
    const before = pulls();
    let asked: any = null;
    onAsk = (msg) => { asked = msg; write({ jsonrpc: "2.0", id: msg.id, result: { action: "decline" } }); };
    const no = await tool({ action: "download" });
    expect(asked.params.message).toBe("Download gemma4:31b-it-qat (19 GB) with Ollama? It runs free, on this computer, and Leanfare's Auto and plans can then use it for reading and drafting. Apache-2.0: free to use for work.");
    expect(no.content[0].text).toBe("Nothing was downloaded: the user did not say yes to gemma4:31b-it-qat.");
    expect(pulls()).toBe(before);
    asked = null;
    const claimed = await tool({ action: "download", yes: "yes" }); // a yes from the model is not the user's: the app still asks
    expect(asked?.params?.message).toContain("Download gemma4:31b-it-qat");
    expect(claimed.content[0].text).toBe("Nothing was downloaded: the user did not say yes to gemma4:31b-it-qat.");
    expect(pulls()).toBe(before);
    onAsk = (msg) => write({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: { download: true } } });
    const yes = await tool({ action: "download" });
    expect(yes.structuredContent.downloading).toBe(true);
    expect(await pulled(before + 1)).toBe(before + 1);
    onAsk = null;
  });
  test("with nothing to suggest, download is refused with the reason; a wrong action is refused", async () => {
    computer(16 * GB);
    const r = await tool({ action: "download", yes: "yes" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("None of the rated open models on Leanfare's list runs in 16 GB of memory.");
    expect((await tool({ action: "fly" })).isError).toBe(true);
  });
});
