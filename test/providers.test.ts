// Setting up with no typing: a pasted key finds its provider, keys already on the computer are
// offered (never subscription logins), model apps on this computer are found, and any provider
// that speaks OpenAI's format can be added, with prices from models.dev. Plus the new built in
// providers: Perplexity (its own cost report and search fee) and ids with slashes (Groq).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { paths } from "../src/config";
import { allModels, getModel, store } from "../src/data";
import { dotenv, aiderYaml, recognize } from "../src/findkeys";
import { getKey, keyWhere, loadKeys } from "../src/keys";
import * as extra from "../src/providers";
import { forgetShellEnv, parseEnv, shellEnv } from "../src/shellenv";
import { ALL_TICKED, boot, fake, keys, ledger, post, reset, ui } from "./app";
import { KEYS, SHAPED } from "./fake";

let url = "";
const servers: ReturnType<typeof Bun.serve>[] = [];
// A small server that speaks OpenAI's format, for the model apps and the providers you add.
function openaiLike(ids: string[], opts: { owner?: string; key?: string } = {}) {
  const seen: any[] = [];
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (opts.key && auth !== opts.key) return Response.json({ error: { message: "bad key" } }, { status: 401 });
    if (u.pathname === "/v1/models") return Response.json({ object: "list", data: ids.map((id) => ({ id, owned_by: opts.owner ?? "someone" })) });
    if (u.pathname === "/v1/chat/completions") { const body = await req.json(); seen.push(body); return Response.json({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Hi from the little server." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }); }
    return new Response("no", { status: 404 });
  } });
  servers.push(s);
  return { port: s.port, base: `http://127.0.0.1:${s.port}/v1`, seen, stop: () => s.stop(true) };
}
// models.dev, as far as Leanfare reads it.
let regBody: any = {};
const reg = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(regBody) });
const keepModelsDev = process.env.LEANFARE_MODELSDEV_URL; // setup.ts's stand in, put back after
process.env.LEANFARE_MODELSDEV_URL = `http://127.0.0.1:${reg.port}/api.json`;

beforeAll(async () => { url = (await boot()).url; });
afterAll(() => { for (const s of servers) s.stop(true); reg.stop(true); process.env.LEANFARE_MODELSDEV_URL = keepModelsDev; });
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED, custom: [] });
  extra.loadCustomProviders();
  store.live.clear();
  regBody = {};
  extra.forgetRegistry();
  rmSync(join(paths.db, "..", "models-dev.json"), { force: true });
});

const state = async () => (await ui(url, "/api/state")).json;
const prov = async (id: string) => ((await state()).providers as any[]).find((p) => p.id === id);

describe("a pasted key finds its provider", () => {
  test("by how each provider's keys look", () => {
    expect(recognize(SHAPED.openai).providers).toEqual(["openai"]);
    expect(recognize(SHAPED.anthropic).providers).toEqual(["anthropic"]);
    expect(recognize(SHAPED.google).providers).toEqual(["google"]);
    expect(recognize("AQ.Ab8RN6" + "x".repeat(44)).providers).toEqual(["google"]); // Google's newer keys
    expect(recognize(SHAPED.openrouter).providers).toEqual(["openrouter"]);
    expect(recognize(SHAPED.perplexity).providers).toEqual(["perplexity"]);
    expect(recognize(SHAPED.xai).providers).toEqual(["xai"]);
    expect(recognize(SHAPED.groq).providers).toEqual(["groq"]);
    expect(recognize(SHAPED.cerebras).providers).toEqual(["cerebras"]);
    expect(recognize(SHAPED.together).providers).toEqual(["together"]);
    expect(recognize(SHAPED.fireworks).providers).toEqual(["fireworks"]);
    // Shapes several providers share are tried in turn: DeepSeek's sk- + 32 hex first, OpenAI's old sk- first.
    expect(recognize(SHAPED.deepseek).providers).toEqual(["deepseek", "openai"]);
    expect(recognize("sk-" + "Ab1".repeat(16)).providers).toEqual(["openai", "deepseek"]);
    expect(recognize(SHAPED.mistral).providers).toEqual(["mistral"]);
    expect(recognize("something-else-entirely-1234").providers).toEqual([]);
  });
  test("a Claude login, its refresh token, a claude.ai session and an admin key are refused, and never tested anywhere", () => {
    for (const k of ["sk-ant-oat01-", "sk-ant-ort01-", "sk-ant-sid01-", "sk-ant-anything-"]) {
      const r = recognize(k + "z".repeat(80));
      expect(r.refuse).toContain("Claude login or session token");
      expect(r.providers).toEqual([]);
    }
    expect(recognize("sk-ant-admin01-" + "z".repeat(80)).refuse).toContain("admin key");
    expect(recognize(SHAPED.anthropic)).toEqual({ providers: ["anthropic"], refuse: null });
  });
  test("Add key tests it with its provider and saves it there", async () => {
    const r = (await ui(url, "/api/keys/recognize", { key: SHAPED.perplexity })).json;
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("perplexity");
    expect(r.message).toContain("A Perplexity key. Perplexity accepted the key.");
    expect(getKey("perplexity")).toBe(SHAPED.perplexity);
    // Perplexity has no model list: Leanfare asked for a model that does not exist, which costs nothing.
    expect(fake.seen.filter((s) => s.provider === "perplexity").at(-1)!.body.model).toBe("leanfare-key-check");
    expect((await prov("perplexity")).ready).toBe(true);
  });
  test("a key that fits two providers is tried with each until one takes it", async () => {
    const r = (await ui(url, "/api/keys/recognize", { key: SHAPED.deepseek })).json;
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("deepseek");
    const bad = (await ui(url, "/api/keys/recognize", { key: "sk-" + "9a".repeat(16) })).json; // looks right, works nowhere
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("It looks like a DeepSeek or OpenAI key, but it did not work.");
    expect(bad.message).not.toContain("9a9a9a9a"); // the key never comes back on screen
  });
  test("an unknown key opens Add a provider; a refused one says why; junk is not a key", async () => {
    expect((await ui(url, "/api/keys/recognize", { key: "zzzz-unknown-key-1234567" })).json).toMatchObject({ ok: false, unknown: true });
    expect((await ui(url, "/api/keys/recognize", { key: "sk-ant-oat01-" + "z".repeat(80) })).json.message).toContain("Claude login or session token");
    expect((await ui(url, "/api/keys/recognize", { key: "two words" })).status).toBe(400);
  });
});

describe("the new built in providers", () => {
  test("Perplexity: through its Agent API with web search on; its own cost report (search fee included) is what counts", async () => {
    await reset({ ticked: ["perplexity/sonar"] });
    await keys("perplexity");
    const r = await post(`${url}/v1/chat/completions`, { model: "perplexity/sonar", max_tokens: 500, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "What happened today?" }] });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-leanfare-cost-usd")).toBe("0.00270000");
    const j = await r.json();
    expect([j.object, j.choices[0].message.content, j.choices[0].finish_reason]).toEqual(["chat.completion", "Hello from perplexity/sonar.", "stop"]);
    const last = fake.seen.filter((s) => s.provider === "perplexity").at(-1)!;
    expect(last.path).toBe("/perplexity/v1/agent"); // Sonar's chat completions address moved to the Agent API
    expect(last.body).toMatchObject({ model: "perplexity/sonar", input: "What happened today?", instructions: "Be brief.", tools: [{ type: "web_search" }], max_output_tokens: 500, stream: false });
    expect(ledger().at(-1)).toMatchObject({ model: "perplexity/sonar", price_status: "provider" });
  });
  test("Perplexity, streamed: its answer as chat completions chunks, then its cost", async () => {
    await reset({ ticked: ["perplexity/sonar"] });
    await keys("perplexity");
    const r = await post(`${url}/v1/chat/completions`, { model: "perplexity/sonar", stream: true, messages: [{ role: "user", content: "What happened today? [usage 3000 400]" }] });
    const raw = await r.text();
    const chunks = raw.split("\n\n").filter((b) => b.startsWith("data: {")).map((b) => JSON.parse(b.slice(6)));
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")).toBe("Hello from perplexity/sonar.");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(raw).toContain("cost_usd=0.00270000");
    expect(ledger().at(-1)).toMatchObject({ model: "perplexity/sonar", in_tokens: 3000, out_tokens: 400, status: "ok" });
  });
  test("Groq: a model id with a slash goes to Groq as it is", async () => {
    await reset({ ticked: ["groq/openai/gpt-oss-120b"] });
    await keys("groq");
    const r = await post(`${url}/v1/chat/completions`, { model: "groq/openai/gpt-oss-120b", messages: [{ role: "user", content: "Hi" }] });
    expect(r.status).toBe(200);
    const last = fake.seen.filter((s) => s.provider === "groq").at(-1)!;
    expect(last.path).toBe("/groq/openai/v1/chat/completions");
    expect(last.body.model).toBe("openai/gpt-oss-120b");
  });
  test("a provider whose catalogue rows can outlive the model: its own list decides what shows", async () => {
    expect(getModel("groq/openai/gpt-oss-120b")).toBeTruthy();
    const r = (await ui(url, "/api/keys/recognize", { key: SHAPED.groq })).json; // the fake's list is model-a, model-b
    expect(r.ok).toBe(true);
    const s = await state();
    expect((s.models.groq ?? []).map((m: any) => m.id)).not.toContain("groq/openai/gpt-oss-120b");
  });
  test("More providers wait under one heading until they have a key", async () => {
    const s = await state();
    const more = s.providers.filter((p: any) => p.more).map((p: any) => p.id);
    expect(more).toEqual(["perplexity", "groq", "cerebras", "together", "fireworks"]);
  });
});

describe("providers you add", () => {
  test("any address that speaks OpenAI's format, priced from models.dev when it lists the model", async () => {
    const tiny = openaiLike(["tiny-1", "gpt-4o-mini"], { key: "tiny-key-123456" });
    regBody = { someone: { name: "Someone", env: ["SOMEONE_KEY"], models: { "gpt-4o-mini": { cost: { input: 0.15, output: 0.6 }, limit: { context: 128000 } } } } };
    const r = (await ui(url, "/api/providers/custom", { name: "Tiny Cloud", base: tiny.base, key: "tiny-key-123456" })).json;
    expect(r).toMatchObject({ ok: true, id: "custom-tiny-cloud", message: "Tiny Cloud added: 2 models." });
    const p = await prov("custom-tiny-cloud");
    expect(p).toMatchObject({ name: "Tiny Cloud", custom: true, ready: true, key: { saved: true } });
    expect(getModel("custom-tiny-cloud/gpt-4o-mini")).toMatchObject({ input: 0.15, output: 0.6, context: 128000, source: "models.dev someone" });
    expect(getModel("custom-tiny-cloud/tiny-1")).toMatchObject({ input: null, output: null });
    // It works like any other: tick a model and ask.
    await ui(url, "/api/models/tick", { ids: ["custom-tiny-cloud/gpt-4o-mini"], on: true });
    const a = await post(`${url}/v1/chat/completions`, { model: "custom-tiny-cloud/gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] });
    expect(a.status).toBe(200);
    expect((await a.json()).choices[0].message.content).toBe("Hi from the little server.");
    expect(tiny.seen.at(-1).model).toBe("gpt-4o-mini");
    // Remove takes it away, with its key and its ticks.
    expect((await ui(url, "/api/providers/custom/remove", { id: "custom-tiny-cloud" })).json.ok).toBe(true);
    expect(await prov("custom-tiny-cloud")).toBeUndefined();
    expect(getKey("custom-tiny-cloud")).toBeNull();
    expect((await state()).settings.ticked).not.toContain("custom-tiny-cloud/gpt-4o-mini");
    tiny.stop();
  });
  test("what is checked before anything is added", async () => {
    const bad = async (b: any) => (await ui(url, "/api/providers/custom", b));
    expect((await bad({ name: "", base: "https://x.example/v1" })).json.error).toBe("Give the provider a name.");
    expect((await bad({ name: "X", base: "ftp://x" })).json.error).toContain("must start with https://");
    expect((await bad({ name: "X", base: "http://example.com/v1" })).json.error).toContain("Use https://"); // a key would travel in the clear
    for (const sly of ["http://localhost.evil.example/v1", "http://10.evil.example/v1", "http://127.0.0.1.nip.io/v1", "http://192.168.1.5.evil.example/v1"]) expect((await bad({ name: "X", base: sly })).json.error).toContain("Use https://");
    expect((await bad({ name: "X", base: "http://127.0.0.1@evil.example/v1" })).json.error).toContain("Leave any name or password out");
    expect((await bad({ name: "X", base: "https://x.example/v1?key=1" })).json.error).toContain("nothing after a ? or #");
    for (const home of ["localhost", "127.0.0.1", "[::1]", "10.0.0.7", "192.168.1.5", "172.20.0.2", "box.local"]) expect(extra.onThisNetwork(new URL(`http://${home}:8000/v1`).hostname)).toBe(true);
    for (const away of ["172.32.0.1", "11.0.0.1", "example.com", "localhost.evil.example"]) expect(extra.onThisNetwork(away)).toBe(false);
    expect((await bad({ name: "OpenAI", base: "https://x.example/v1" })).json.error).toContain("is built in");
    const none = (await ui(url, "/api/providers/custom", { name: "Nobody", base: "http://127.0.0.1:9/v1" })).json;
    expect(none.ok).toBe(false);
    expect(none.message).toContain("did not answer with a model list");
  });
  test("the list to pick from: models.dev's providers that speak OpenAI's format, not the built in ones", async () => {
    regBody = {
      nvidia: { name: "Nvidia", env: ["NVIDIA_API_KEY"], api: "https://integrate.api.nvidia.com/v1", doc: "https://docs.nvidia.com", models: { a: {}, b: {} } },
      openai: { name: "OpenAI", env: ["OPENAI_API_KEY"], models: {} },
      weird: { name: "Weird", env: [], api: "https://x/${PRODUCT}/v1", models: {} },
    };
    const r = (await ui(url, "/api/providers/registry")).json;
    expect(r.choices).toEqual([{ id: "nvidia", name: "Nvidia", api: "https://integrate.api.nvidia.com/v1", env: ["NVIDIA_API_KEY"], doc: "https://docs.nvidia.com", models: 2 }]);
  });
});

describe("which models.dev provider a variable's key goes to", () => {
  const r: any = { at: new Date().toISOString(), providers: {
    nvidia: { name: "Nvidia", env: ["NVIDIA_API_KEY"], api: "https://integrate.api.nvidia.com/v1", doc: null, models: {} },
    "github-copilot": { name: "GitHub Copilot", env: ["GITHUB_TOKEN"], api: "https://api.githubcopilot.com", doc: null, models: {} },
    "zhipuai-coding-plan": { name: "Zhipu AI Coding Plan", env: ["ZHIPU_API_KEY"], api: "https://open.bigmodel.cn/api/coding/paas/v4", doc: null, models: {} },
    "opencode-go": { name: "OpenCode Go", env: ["OPENCODE_API_KEY"], api: "https://opencode.ai/zen/go/v1", doc: null, models: {} },
    moonshotai: { name: "Moonshot AI", env: ["MOONSHOT_API_KEY"], api: "https://api.moonshot.ai/v1", doc: null, models: {} },
    "moonshotai-cn": { name: "Moonshot AI (China)", env: ["MOONSHOT_API_KEY"], api: "https://api.moonshot.cn/v1", doc: null, models: {} },
    digitalocean: { name: "DigitalOcean", env: ["DIGITALOCEAN_ACCESS_TOKEN"], api: "https://inference.do-ai.run/v1", doc: null, models: {} },
  } };
  test("only *_API_KEY names, never a plan endpoint or a general token, and no guess when several share it", () => {
    expect(extra.registryForEnv(r, "NVIDIA_API_KEY")).toEqual({ id: "nvidia", name: "Nvidia", api: "https://integrate.api.nvidia.com/v1" });
    expect(extra.registryForEnv(r, "GITHUB_TOKEN")).toBeNull();
    expect(extra.registryForEnv(r, "DIGITALOCEAN_ACCESS_TOKEN")).toBeNull();
    expect(extra.registryForEnv(r, "ZHIPU_API_KEY")).toBeNull();
    expect(extra.registryForEnv(r, "OPENCODE_API_KEY")).toBeNull();
    expect(extra.registryForEnv(r, "MOONSHOT_API_KEY")).toBeNull();
  });
});

describe("model apps on this computer", () => {
  test("LM Studio and llama.cpp are found and listed as free local providers; a shared port is told apart", async () => {
    const lm = openaiLike(["qwen3-8b"]);
    const lc = openaiLike(["gemma-4-e4b.gguf"], { owner: "llamacpp" });
    process.env.LEANFARE_LOCAL_PORTS = `lmstudio=${lm.port},llamacpp=${lc.port},localai=${lc.port},jan=9`;
    const r = (await ui(url, "/api/refresh", { what: "local" })).json;
    const found = r.state.extra.local.found.map((f: any) => [f.id, f.models]);
    expect(found).toEqual([["lmstudio", 1], ["llamacpp", 1]]); // llama.cpp, not LocalAI, on the shared port; no Jan
    const p = r.state.providers.find((x: any) => x.id === "lmstudio");
    expect(p).toMatchObject({ name: "LM Studio", local: true, ready: true });
    expect(getModel("lmstudio/qwen3-8b")).toMatchObject({ input: 0, output: 0, local: true });
    expect(getModel("llamacpp/gemma-4-e4b.gguf")!.label).toBe("gemma-4-e4b");
    // A chat goes to the app on this computer.
    await ui(url, "/api/models/tick", { ids: ["lmstudio/qwen3-8b"], on: true });
    const a = await post(`${url}/v1/chat/completions`, { model: "lmstudio/qwen3-8b", messages: [{ role: "user", content: "Hi" }] });
    expect(a.status).toBe(200);
    expect(lm.seen.at(-1).model).toBe("qwen3-8b");
    // Closed: gone at the next look.
    lm.stop(); lc.stop();
    const r2 = (await ui(url, "/api/refresh", { what: "local" })).json;
    expect(r2.state.extra.local.found).toEqual([]);
    expect(getModel("lmstudio/qwen3-8b")).toBeUndefined();
    process.env.LEANFARE_LOCAL_PORTS = "none";
  });
});

describe("Find my keys", () => {
  let home = "";
  const realHome = process.env.HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leanfare-home-"));
    process.env.HOME = home;
  });
  afterAll(() => { process.env.HOME = realHome; });
  const put = (rel: string, text: string) => { const f = join(home, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text); };

  test("keys in other AI tools' files are found; subscription logins never are", async () => {
    const llmDir = process.platform === "darwin" ? "Library/Application Support/io.datasette.llm" : ".config/io.datasette.llm";
    put(`${llmDir}/keys.json`, JSON.stringify({ openai: SHAPED.openai, unknown: "x".repeat(30) }));
    put(".codex/auth.json", JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "sk-proj-from-a-chatgpt-sign-in-1234567890", tokens: { access_token: "a", refresh_token: "r" } }));
    put(".local/share/opencode/auth.json", JSON.stringify({ groq: { type: "api", key: SHAPED.groq }, anthropic: { type: "oauth", access: "oauth-token-123456789012", refresh: "r" } }));
    put(".gemini/.env", `# Gemini\nGEMINI_API_KEY="${SHAPED.google}"\n`);
    put(".aider.conf.yml", `openai-api-key: ${SHAPED.openai}\napi-key:\n  - deepseek=${SHAPED.deepseek}\n`);
    put(".continue/.env", `NVIDIA_API_KEY=nvapi-${"n".repeat(64)}\n`);
    const tiny = openaiLike(["nv-model"], { key: `nvapi-${"n".repeat(64)}` });
    regBody = { nvidia: { name: "Nvidia", env: ["NVIDIA_API_KEY"], api: tiny.base, models: { "nv-model": { cost: { input: 0.5, output: 1 } } } } };
    const found = (await ui(url, "/api/keys/found")).json.keys as any[];
    const rows = found.map((k) => [k.label, k.hint, k.status, k.ref.split(":")[0]]);
    expect(rows).toContainEqual(["OpenAI", `…${SHAPED.openai.slice(-4)}`, "new", "llm"]);
    expect(rows).toContainEqual(["Groq", `…${SHAPED.groq.slice(-4)}`, "new", "opencode"]);
    expect(rows).toContainEqual(["Google Gemini", `…${SHAPED.google.slice(-4)}`, "new", "gemini"]);
    expect(rows).toContainEqual(["DeepSeek", `…${SHAPED.deepseek.slice(-4)}`, "new", "aider"]);
    expect(rows).toContainEqual(["Nvidia", "…nnnn", "new", "continue"]);
    expect(found.filter((k) => k.label === "OpenAI")).toHaveLength(1); // the same key in two places shows once
    const all = JSON.stringify(found);
    expect(all).not.toContain("from-a-chatgpt-sign-in"); // Codex's ChatGPT sign in
    expect(all).not.toContain("oauth-token"); // OpenCode's sign in
    expect(all).not.toContain(SHAPED.openai); // only the last four characters reach the screen
    // Ticked keys are tested and saved; a models.dev provider is added with its address.
    const refs = found.filter((k) => ["OpenAI", "Groq", "Nvidia"].includes(k.label)).map((k) => k.ref);
    const imp = (await ui(url, "/api/keys/import", { refs })).json;
    expect(imp.results.map((r: any) => r.ok)).toEqual([true, true, true]);
    expect(getKey("openai")).toBe(SHAPED.openai);
    expect(getKey("groq")).toBe(SHAPED.groq);
    expect(imp.state.providers.find((p: any) => p.id === "custom-nvidia")).toMatchObject({ custom: true, ready: true });
    expect(getModel("custom-nvidia/nv-model")).toMatchObject({ input: 0.5, output: 1 });
    // Found again: now the same as what Leanfare has, the added provider too; using it again adds no second one.
    const again = (await ui(url, "/api/keys/found")).json.keys as any[];
    expect(again.find((k) => k.label === "OpenAI").status).toBe("same");
    expect(again.find((k) => k.label === "Nvidia").status).toBe("same");
    const twice = (await ui(url, "/api/keys/import", { refs: [again.find((k) => k.label === "Nvidia").ref] })).json;
    expect(twice.results[0]).toMatchObject({ ok: true, message: "Nvidia: key saved." });
    expect(twice.state.settings.custom.map((c: any) => c.id)).toEqual(["custom-nvidia"]);
    tiny.stop();
  });
  test("the .env and aider readers", () => {
    expect(dotenv('export A_KEY="x1"\n# B_KEY=no\nC_KEY=y2 # note\nD_KEY=\'z3\'\n')).toEqual({ A_KEY: "x1", C_KEY: "y2", D_KEY: "z3" });
    expect(aiderYaml("anthropic-api-key: 'k1'\napi-key: gemini=k2\n")).toEqual({ ANTHROPIC_API_KEY: "k1", GEMINI_API_KEY: "k2" });
  });
});

describe("your login shell's keys (for the Mac app)", () => {
  const dir = mkdtempSync(join(tmpdir(), "leanfare-shell-"));
  const fakeShell = (body: string) => { const f = join(dir, `sh-${Math.random().toString(36).slice(2)}`); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  afterAll(() => { process.env.LEANFARE_SHELL_ENV = "off"; process.env.SHELL = "/bin/sh"; forgetShellEnv(); rmSync(dir, { recursive: true, force: true }); });

  test("only what is between the markers counts: banners and noise are dropped", () => {
    expect(parseEnv("Welcome!\nMARKA_KEY=1\0B_API_KEY=two words\0C_KEY=x=y\0MARK more noise", "MARK")).toEqual({ A_KEY: "1", B_API_KEY: "two words", C_KEY: "x=y" });
    expect(parseEnv("no markers here", "MARK")).toEqual({});
  });
  test("only key variables (and PATH) are kept; an env without -0 is read line by line", () => {
    expect(parseEnv("MARKHOME=/home/me\0SECRET_TOKEN=t\0GROQ_API_KEY=g\0PATH=/bin\0MARK", "MARK")).toEqual({ GROQ_API_KEY: "g", PATH: "/bin" });
    expect(parseEnv("MARKGROQ_API_KEY=g\nNOTES=line one\nline two\nOPENAI_API_KEY=o\nMARK", "MARK")).toEqual({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o" });
  });
  test("a key exported by the shell is picked up and marked as from your shell", async () => {
    process.env.LEANFARE_SHELL_ENV = "on";
    process.env.SHELL = fakeShell(`echo "a banner the shell prints"; export GROQ_API_KEY="${SHAPED.groq}"; /bin/sh -c "$2"`);
    forgetShellEnv();
    expect((await shellEnv())["GROQ_API_KEY"]).toBe(SHAPED.groq);
    await loadKeys();
    expect(getKey("groq")).toBe(SHAPED.groq);
    expect(keyWhere("groq")).toBe("shell");
  });
  test("a key from your shell's settings is not removed by Remove: the screen says where it comes from", async () => {
    process.env.LEANFARE_SHELL_ENV = "on";
    process.env.SHELL = fakeShell(`export GROQ_API_KEY="${SHAPED.groq}"; /bin/sh -c "$2"`);
    forgetShellEnv();
    await loadKeys();
    expect(keyWhere("groq")).toBe("shell");
    const r = (await ui(url, "/api/keys/groq", undefined, "DELETE")).json;
    expect(r).toMatchObject({ ok: true, env: "GROQ_API_KEY", from: "shell" });
    process.env.LEANFARE_SHELL_ENV = "off";
    forgetShellEnv();
    await loadKeys({ shell: false });
  });
  test("a key saved or removed while the shell is slow to answer stays saved or removed", async () => {
    const { saveKey, removeKey } = await import("../src/keys");
    process.env.LEANFARE_SHELL_ENV = "on";
    process.env.SHELL = fakeShell(`sleep 1; /bin/sh -c "$2"`);
    forgetShellEnv();
    await saveKey("cerebras", SHAPED.cerebras);
    const loading = loadKeys();
    await Bun.sleep(200);
    await saveKey("fireworks", SHAPED.fireworks);
    await removeKey("cerebras");
    await loading;
    expect(getKey("fireworks")).toBe(SHAPED.fireworks);
    expect(getKey("cerebras")).toBeNull();
    process.env.LEANFARE_SHELL_ENV = "off";
    forgetShellEnv();
    await removeKey("fireworks");
    await loadKeys({ shell: false });
  });
  test("a shell that hangs gives nothing after the time limit, and never blocks", async () => {
    process.env.LEANFARE_SHELL_ENV = "on";
    process.env.SHELL = fakeShell("sleep 30");
    forgetShellEnv();
    const t0 = Date.now();
    expect(await shellEnv(400)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(3000);
    process.env.LEANFARE_SHELL_ENV = "off";
    forgetShellEnv();
    await loadKeys({ shell: false });
  });
});
