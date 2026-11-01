// A fake of every provider Leanfare talks to, on one local port, so the tests
// never reach the internet and every token count is known in advance.
//
// Each provider lives under its own path: /openai/v1, /anthropic, /google/v1beta/openai,
// /openrouter/api/v1, /deepseek, /xai/v1, /mistral/v1, /ollama/v1 (and Ollama's own /ollama/api/tags,
// /api/ps, /api/pull, /api/delete: see the `ollama` switches below).
// A message can steer the answer:
//   [usage 2000 500]        report exactly 2,000 input and 500 output tokens
//   [cached 1500]           of the input, 1,500 came from the cache
//   [write1h 1000]          of the input, 1,000 were written to Claude's cache for an hour
//   [nousage]               report no token counts at all
//   [reasoning 300]         of the output, 300 were thinking: said as OpenAI does (completion_tokens_details.reasoning_tokens)
//   [hidden 300]            300 thinking tokens left out of completion_tokens but in total_tokens (as some providers do)
//   [slow 3000]             wait 3 seconds before answering
//   [chunks 40]             stream the answer in 40 pieces, 50 ms apart
//   [fail 429]              answer with this HTTP status ([fail@xai 400]: only that provider; [slow@...] too)
//   [quota0@google argon]   answer 429 as Google's free tier does for a model it gives no quota ("... limit: 0, model: ..."),
//                           only for models whose name has "argon" in it (no name: every model)
//   [gone@google flash]     answer 404 as Google does for a model it no longer serves to new keys ("This model ... is no
//                           longer available to new users"), only for models whose name has "flash" in it (no name: every model)
//   [think]                 think first ("Let me think."), in each provider's own way
//   [empty] [empty1]        answer nothing (always, or only the first time this prompt is seen)
//   [cut1]                  the first time: stop sending after one piece, with no end marker
//   [thinkall1]             the first time: only think, and stop at the answer limit
//   [thought1]              the first time: hand back thinking as the answer, under a first line "thought", cut at the limit
//   [filter]                decline (finish_reason content_filter), with no text
//   [reply@xai FAIL: x]     answer with this text, only when the request goes to that provider
//                           ([reply PASS] for any provider; the one for the provider wins)
// A test can also answer by code: hooks.answer(prompt, provider, model) returns the text, or null for the usual;
// hooks.fail(prompt, provider) returns an HTTP status to fail with, or null; hooks.slow(prompt, provider)
// the milliseconds to wait first.
import { createHash } from "node:crypto";

// The key OpenRouter's sign in hands out. It works on the fake like the paste key does.
export const OAUTH_KEY = "sk-or-test-oauth";

export const KEYS: Record<string, string> = {
  openai: "sk-test-openai-0001", anthropic: "sk-ant-test-0002", google: "AIzaTestGoogleKey0000000000003", openrouter: "sk-or-test-0004",
  deepseek: "sk-test-deepseek-05", xai: "xai-test-key-000006", mistral: "test-mistral-key-07",
  perplexity: "pplx-test-key-0008", groq: "gsk_test_key_0009", cerebras: "csk-test-key-0010", together: "tgp_v1_test_key_0011", fireworks: "fw_test_key_0012",
  custom: "custom-test-key-0013",
};
// Keys in each provider's real shape, so a pasted key can be recognized (findkeys.ts recognize()).
export const SHAPED: Record<string, string> = {
  openai: "sk-proj-" + "a1".repeat(10) + "T3BlbkFJ" + "b2".repeat(10), anthropic: "sk-ant-api03-" + "c".repeat(93) + "AA",
  google: "AIza" + "D".repeat(35), openrouter: "sk-or-v1-" + "e".repeat(64), deepseek: "sk-" + "0f".repeat(16), xai: "xai-" + "G".repeat(80),
  perplexity: "pplx-" + "h".repeat(48), groq: "gsk_" + "I".repeat(52), cerebras: "csk-" + "j".repeat(48), together: "tgp_v1_" + "K".repeat(43),
  fireworks: "fw_" + "L".repeat(24), mistral: "M".repeat(32),
};

// A longer answer with the usual markdown, for screenshots ("[md]").
const MARKDOWN = [
  "Here is a short way to do it:",
  "",
  "1. **Read** the file row by row.",
  "2. Take the third column as a number.",
  "3. Add it up and print the total.",
  "",
  "```python",
  "import csv",
  "",
  "total = 0.0",
  "with open(\"orders.csv\", newline=\"\") as f:",
  "    for row in csv.reader(f):",
  "        total += float(row[2])",
  "print(f\"Total: {total:.2f}\")",
  "```",
  "",
  "| Rows | Time |",
  "|---|---|",
  "| 10,000 | 18 ms |",
  "| 1,000,000 | 1.6 s |",
  "",
  "For files larger than memory, the same loop works unchanged, since `csv.reader` reads one row at a time.",
].join("\n");

export interface Seen { provider: string; path: string; method: string; auth: string | null; body: any; aborted: boolean; headers: Record<string, string> }

// [name 1 2], or [name@provider 1 2] for one provider only.
const directive = (text: string, name: string, provider?: string) => {
  for (const m of text.matchAll(new RegExp(`\\[${name}(?:@(\\w+))?(?: ([\\d ]+))?\\]`, "g"))) {
    if (m[1] && m[1] !== provider) continue;
    return (m[2] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  }
  return null;
};

function replyFor(text: string, provider: string): string | null {
  let any: string | null = null;
  for (const m of text.matchAll(/\[reply(?:@(\w+))? ([^\]]*)\]/g)) {
    if (m[1] === provider) return m[2];
    if (!m[1] && any === null) any = m[2];
  }
  return any;
}

function promptText(body: any): string {
  const parts: string[] = [];
  if (typeof body?.system === "string") parts.push(body.system);
  if (typeof body?.instructions === "string") parts.push(body.instructions); // OpenAI's Responses shape (Perplexity's Agent API)
  if (typeof body?.input === "string") parts.push(body.input);
  for (const m of [...(body?.messages ?? []), ...(Array.isArray(body?.input) ? body.input : [])]) parts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  return parts.join("\n");
}

export function startFake() {
  const seen: Seen[] = [];
  const hooks = {
    answer: null as null | ((prompt: string, provider: string, model: string) => string | null),
    fail: null as null | ((prompt: string, provider: string) => number | null),
    slow: null as null | ((prompt: string, provider: string) => number), // milliseconds to wait before answering
    refuse: null as null | ((body: any, provider: string) => { status: number; message: string } | null), // an error with the provider's own words
  };
  const onceSeen = new Set<string>();
  // OpenRouter's sign in: /openrouter/auth shows the "Authorize" step and sends the browser back with a
  // one time code; /openrouter/api/v1/auth/keys trades the code for a key and checks the PKCE proof
  // (the verifier must hash to the challenge). The switches steer the unhappy paths.
  const oauth = { n: 0, codes: new Map<string, { challenge: string; method: string; expired: boolean }>(), expireNext: false, deny: false, failExchange: 0, failMessage: "fake failure", badKey: false, credits: true };
  // Ollama's own addresses: what is installed and loaded, a download that streams its progress as
  // JSON lines (and can fail, be cut off or be held for a Stop), and a removal. Sizes are bytes.
  const GB = 1e9;
  const llama = () => ({ name: "llama3.2:latest", model: "llama3.2:latest", modified_at: "2026-10-01T00:00:00Z", size: 2_019_393_189, digest: "a80c4f17acd5", details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" } });
  const ollama = {
    models: [llama()] as any[], loaded: [] as string[], down: false,
    library: { "tiny:1b": 1 * GB, "gemma3:12b": 8.1 * GB, "gemma3:27b": 17.4 * GB, "hf.co/acme/small-GGUF:Q4_K_M": 4.4 * GB } as Record<string, number>,
    steps: 8, gap: 10,
    error: null as string | null, // a line {"error": ...} after errorAfter steps
    errorAfter: 3,
    http: 0, httpMessage: "", // answer the pull with this HTTP status
    cut: false, // close the stream after errorAfter steps, with no success line
    holding: false, // wait after errorAfter steps until released (or aborted)
    deleteStatus: 0,
    partial: {} as Record<string, number>, // bytes already there for a name (kept when a pull is stopped)
    pulls: 0,
    contexts: {} as Record<string, number | null>, // what /api/show says of a model's context (null: says nothing); 131072 when not set
    showFails: false, // /api/show answers 500
    // Models that think before they answer: name -> the tokens they think for. Ollama lists "thinking" among their
    // capabilities, and their thinking counts toward num_predict: with too little room the answer comes back empty.
    thinkers: {} as Record<string, number>,
    thinkAsked: [] as unknown[], // the "think" of each chat request, as sent
    reset() {
      Object.assign(this, { models: [llama()], loaded: [], down: false, steps: 8, gap: 10, error: null, errorAfter: 3, http: 0, httpMessage: "", cut: false, holding: false, deleteStatus: 0, partial: {}, pulls: 0, contexts: {}, showFails: false, thinkers: {}, thinkAsked: [] });
    },
  };
  let dataJson: any = null;
  let dataStatus = 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(req, srv) {
      srv.timeout(req, 0);
      const url = new URL(req.url);
      const provider = url.pathname.split("/")[1];
      const body = req.method === "POST" || req.method === "DELETE" ? await req.json().catch(() => null) : null;
      const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? req.headers.get("x-api-key");
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { if (k !== "authorization" && k !== "x-api-key") headers[k] = v; });
      const rec: Seen = { provider, path: url.pathname, method: req.method, auth, body, aborted: false, headers };
      seen.push(rec);
      req.signal.addEventListener("abort", () => { rec.aborted = true; });

      if (provider === "openrouter" && url.pathname === "/openrouter/auth" && req.method === "GET") {
        const back = new URL(url.searchParams.get("callback_url") ?? "http://127.0.0.1:1/");
        if (!oauth.deny) {
          const code = `code-${++oauth.n}`;
          oauth.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", method: url.searchParams.get("code_challenge_method") ?? "", expired: oauth.expireNext });
          oauth.expireNext = false;
          back.searchParams.set("code", code);
          const st = url.searchParams.get("state");
          if (st) back.searchParams.set("state", st);
        }
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (provider === "openrouter" && url.pathname === "/openrouter/api/v1/auth/keys") {
        const no = (status: number, message: string) => Response.json({ error: { message } }, { status });
        if (req.method !== "POST") return no(405, "Method Not Allowed");
        if (oauth.failExchange) return no(oauth.failExchange, oauth.failMessage);
        const c = oauth.codes.get(String(body?.code));
        if (body?.code_challenge_method !== "S256" || (c && c.method !== "S256")) return no(400, "Invalid code_challenge_method");
        if (!c) return no(403, "Invalid code or code_verifier");
        if (c.expired) return no(403, "Authorization code expired");
        if (createHash("sha256").update(String(body?.code_verifier ?? "")).digest("base64url") !== c.challenge) return no(403, "Invalid code or code_verifier");
        oauth.codes.delete(String(body.code)); // single use
        return Response.json({ key: oauth.badKey ? "sk-or-test-rejected" : OAUTH_KEY, user_id: "user_fake" });
      }
      if (provider === "openrouter" && url.pathname.endsWith("/credits")) {
        if (auth !== KEYS.openrouter && auth !== OAUTH_KEY) return Response.json({ error: { message: "invalid key" } }, { status: 401 });
        if (!oauth.credits) return Response.json({ error: { message: "this key cannot read credits" } }, { status: 403 });
        return Response.json({ data: { total_credits: 10, total_usage: 2.5 } });
      }
      if (url.pathname === "/data.json") return dataStatus === 200 && dataJson ? Response.json(dataJson) : new Response("down", { status: dataStatus });
      // models.dev's list, as small as the tests need (providers.test.ts serves its own).
      if (url.pathname === "/models-dev/api.json") return Response.json({ nvidia: { id: "nvidia", name: "Nvidia", env: ["NVIDIA_API_KEY"], api: "https://integrate.api.nvidia.com/v1", npm: "@ai-sdk/openai-compatible", models: {} } });
      if (provider === "ollama" && url.pathname.endsWith("/api/tags")) return ollama.down ? new Response("not running", { status: 500 }) : Response.json({ models: ollama.models });
      if (provider === "ollama" && url.pathname === "/ollama/api/ps") return Response.json({ models: ollama.loaded.map((name) => ({ name, model: name, size: ollama.models.find((m) => m.name === name)?.size ?? 0, size_vram: 0, expires_at: "2026-10-22T12:00:00Z" })) });
      if (provider === "ollama" && url.pathname === "/ollama/api/delete" && req.method === "DELETE") {
        if (ollama.deleteStatus) return Response.json({ error: "fake delete failure" }, { status: ollama.deleteStatus });
        const name = String(body?.model ?? body?.name ?? "");
        if (!ollama.models.some((m) => m.name === name)) return Response.json({ error: `model '${name}' not found` }, { status: 404 });
        ollama.models = ollama.models.filter((m) => m.name !== name);
        ollama.loaded = ollama.loaded.filter((n) => n !== name);
        return new Response(null, { status: 200 });
      }
      // Ollama's /api/show: the model's facts, its context among them.
      if (provider === "ollama" && url.pathname === "/ollama/api/show" && req.method === "POST") {
        if (ollama.showFails) return Response.json({ error: "fake show failure" }, { status: 500 });
        const name = String(body?.model ?? body?.name ?? "");
        const m = ollama.models.find((x) => x.name === name);
        if (!m) return Response.json({ error: `model '${name}' not found` }, { status: 404 });
        const ctx = name in ollama.contexts ? ollama.contexts[name] : 131072;
        return Response.json({ details: m.details, model_info: { "general.architecture": "fake", ...(ctx === null ? {} : { "fake.context_length": ctx }) }, capabilities: ["completion", ...(name in ollama.thinkers ? ["thinking"] : [])] });
      }
      if (provider === "ollama" && url.pathname === "/ollama/api/pull" && req.method === "POST") {
        ollama.pulls++;
        if (ollama.http) return Response.json({ error: ollama.httpMessage }, { status: ollama.http });
        const name = String(body?.model ?? body?.name ?? "");
        const size = ollama.library[name];
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          async start(c) {
            const send = (o: any) => { try { c.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
            send({ status: "pulling manifest" });
            if (!size) { send({ error: "pull model manifest: file does not exist" }); c.close(); return; }
            const digest = `sha256:${Buffer.from(name).toString("hex").slice(0, 24)}`;
            const from = Math.min(ollama.partial[name] ?? 0, size);
            for (let i = 1; i <= ollama.steps; i++) {
              const done = Math.max(from, Math.floor((size * i) / ollama.steps));
              if (rec.aborted) { ollama.partial[name] = done; try { c.close(); } catch {} return; }
              send({ status: `pulling ${digest.slice(7, 19)}`, digest, total: size, completed: done });
              ollama.partial[name] = done;
              if (i === ollama.errorAfter) {
                if (ollama.error) { send({ error: ollama.error }); c.close(); return; }
                if (ollama.cut) { c.close(); return; }
                while (ollama.holding && !rec.aborted) await Bun.sleep(10);
              }
              await Bun.sleep(ollama.gap);
            }
            send({ status: "pulling 4f1a8b2c9d0e", digest: "sha256:4f1a8b2c9d0e", total: 487, completed: 487 });
            send({ status: "verifying sha256 digest" });
            send({ status: "writing manifest" });
            send({ status: "success" });
            delete ollama.partial[name];
            if (!ollama.models.some((m) => m.name === name || m.name === `${name}:latest`)) {
              const full = /[:@]/.test(name.replace(/^hf\.co\//, "")) ? name : `${name}:latest`;
              ollama.models = [...ollama.models, { name: full, model: full, modified_at: "2026-10-22T00:00:00Z", size, digest: "fakedigest00", details: { family: "fake", parameter_size: "?", quantization_level: "Q4_K_M" } }];
            }
            c.close();
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      }

      const keyOk = provider === "ollama" || auth === KEYS[provider] || auth === SHAPED[provider] || (provider === "openrouter" && auth === OAUTH_KEY);
      // Perplexity has no model list: a request naming a model that does not exist answers 400 to a good key.
      if (provider === "perplexity" && body?.model === "leanfare-key-check") return keyOk ? Response.json({ error: { message: "Invalid model" } }, { status: 400 }) : Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
      // Sonar's old chat completions address is gone (July 2026): Perplexity answers only through its Agent API.
      if (provider === "perplexity" && url.pathname.endsWith("/chat/completions")) return Response.json({ error: { message: "Sonar Chat Completions is now Agent API" } }, { status: 410 });
      if (url.pathname.endsWith("/models") || url.pathname.endsWith("/key") || url.pathname.includes("/v1/models")) {
        if (provider === "openrouter" && url.pathname.endsWith("/models")) return Response.json({ data: [
          { id: "acme/acme-large", name: "Acme: Large", pricing: { prompt: "0.000001", completion: "0.000004" }, context_length: 100000, created: 1790000000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"] },
          { id: "acme/acme-small:free", name: "Acme: Small (free)", pricing: { prompt: "0", completion: "0" }, context_length: 32000, created: 1790000000, architecture: { output_modalities: ["text"] } },
        ] });
        if (!keyOk) return provider === "anthropic"
          ? Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
          : Response.json({ error: { message: `Incorrect API key provided: ${String(auth).slice(0, 6)}***. You can find your API key at the dashboard.`, code: "invalid_api_key" } }, { status: 401 });
        if (provider === "openrouter") return Response.json({ data: { label: "test", usage: 0, limit: null } });
        return Response.json({ object: "list", data: [{ id: "model-a" }, { id: "model-b" }] });
      }
      if (!keyOk) return Response.json({ error: { message: "wrong key for this provider" } }, { status: 401 });

      const text = promptText(body);
      const refused = hooks.refuse?.(body, provider);
      if (refused) return Response.json({ error: { message: refused.message } }, { status: refused.status });
      const fail = hooks.fail?.(text, provider) ? [hooks.fail(text, provider)!] : directive(text, "fail", provider);
      if (fail?.[0]) return Response.json({ error: { message: `fake failure ${fail[0]}` } }, { status: fail[0] });
      const zero = /\[quota0(?:@([a-z]+))?(?: ([\w.:\/-]+))?\]/.exec(text);
      if (zero && (!zero[1] || zero[1] === provider) && (!zero[2] || String(body?.model ?? "").includes(zero[2]))) return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: ${String(body?.model ?? "x").replace(/^models\//, "")}` } }, { status: 429 });
      const gone = /\[gone(?:@([a-z]+))?(?: ([\w.:\/-]+))?\]/.exec(text);
      if (gone && (!gone[1] || gone[1] === provider) && (!gone[2] || String(body?.model ?? "").includes(gone[2]))) return Response.json({ error: { code: 404, status: "NOT_FOUND", message: `This model models/${String(body?.model ?? "x").replace(/^models\//, "")} is no longer available to new users. Please update your code to use a newer model.` } }, { status: 404 });
      const slow = directive(text, "slow", provider);
      if (slow?.[0]) await Bun.sleep(slow[0]);
      const slowHook = hooks.slow?.(text, provider) ?? 0;
      if (slowHook > 0) await Bun.sleep(slowHook);
      const u = directive(text, "usage");
      const inTok = u?.[0] ?? Math.ceil(text.length / 4);
      // Like a real provider, never write more than the request allows.
      const limit = body?.max_completion_tokens ?? body?.max_tokens ?? body?.max_output_tokens ?? body?.options?.num_predict ?? Infinity;
      const outTok = Math.min(u?.[1] ?? 12, limit);
      let capped = (u?.[1] ?? 12) > limit;
      const cached = directive(text, "cached")?.[0] ?? 0;
      const nousage = !!directive(text, "nousage");
      const pieces = directive(text, "chunks")?.[0] ?? 3;
      const firstTime = !onceSeen.has(provider + "|" + text);
      onceSeen.add(provider + "|" + text);
      const filtered = text.includes("[filter]");
      const thinkAll = text.includes("[thinkall1]") && firstTime;
      const empty = text.includes("[empty]") || (text.includes("[empty1]") && firstTime) || thinkAll || filtered;
      const cut = text.includes("[cut1]") && firstTime;
      if (thinkAll) capped = true; // it stopped at the limit
      const thought = text.includes("[thought1]") && firstTime;
      if (thought) capped = true;
      const answer = thought ? "thought\nWait. Let me look at the files again before I answer." : empty ? "" : hooks.answer?.(text, provider, String(body?.model ?? "")) ?? replyFor(text, provider) ?? (text.includes("[md]") ? MARKDOWN : `Hello from ${body?.model ?? "?"}.`);
      const stopReason = filtered ? "refusal" : capped ? "max_tokens" : "end_turn";
      const finishReason = filtered ? "content_filter" : capped ? "length" : "stop";
      const think = text.includes("[think]") || thinkAll ? "Let me think." : "";
      const split = Array.from({ length: pieces }, (_, i) => answer.slice(Math.floor((i * answer.length) / pieces), Math.floor(((i + 1) * answer.length) / pieces)));
      const gap = pieces > 3 ? 50 : 0;
      const enc = new TextEncoder();

      if (provider === "anthropic" && url.pathname.endsWith("/v1/messages")) {
        const hour = directive(text, "write1h")?.[0] ?? 0;
        const usage = { input_tokens: inTok - cached - hour, cache_read_input_tokens: cached, cache_creation_input_tokens: hour, ...(hour ? { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: hour } } : {}), output_tokens: outTok };
        if (!body.stream) {
          return Response.json({ id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [...(think ? [{ type: "thinking", thinking: think, signature: "sig" }] : []), ...(answer ? [{ type: "text", text: answer }] : [])], stop_reason: stopReason, usage: nousage ? undefined : usage });
        }
        const events: [string, any][] = [
          ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], usage: nousage ? undefined : { ...usage, output_tokens: 1 } } }],
          ...(think ? [
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: think } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ] as [string, any][] : []),
          ["content_block_start", { type: "content_block_start", index: think ? 1 : 0, content_block: { type: "text", text: "" } }],
          ...split.filter((t) => t).map((t): [string, any] => ["content_block_delta", { type: "content_block_delta", index: think ? 1 : 0, delta: { type: "text_delta", text: t } }]),
          ["content_block_stop", { type: "content_block_stop", index: think ? 1 : 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: nousage ? undefined : { output_tokens: outTok } }],
          ["message_stop", { type: "message_stop" }],
        ];
        if (cut) events.splice(events.findIndex(([e, d]) => e === "content_block_delta" && d.delta.type === "text_delta") + 1); // the connection drops after one piece
        return new Response(new ReadableStream({
          async start(c) {
            for (const [ev, data] of events) {
              if (rec.aborted) break;
              try { c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { break; }
              if (ev === "content_block_delta" && gap) await Bun.sleep(gap);
            }
            try { c.close(); } catch {}
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }

      // Ollama's own chat: a whole answer, or JSON lines as it streams them, with its own token counts.
      if (provider === "ollama" && url.pathname === "/ollama/api/chat") {
        ollama.thinkAsked.push(body.think);
        const thinkFor = ollama.thinkers[String(body.model)];
        let said = answer, thought = think, stopped = capped, wrote = outTok;
        if (thinkFor !== undefined && body.think !== false) { // it thinks first, and that counts toward num_predict
          const lim = body?.options?.num_predict ?? Infinity;
          thought = "Let me think. ".repeat(Math.max(1, Math.ceil(thinkFor / 3)));
          wrote = Math.min(lim, thinkFor + outTok);
          if (thinkFor + Math.ceil(answer.length / 4) > lim) { said = ""; stopped = true; }
        }
        const last = { model: body.model, created_at: "2026-10-21T12:00:00Z", message: { role: "assistant", content: "" }, done: true, done_reason: stopped ? "length" : "stop", ...(nousage ? {} : { prompt_eval_count: inTok, eval_count: wrote }) };
        if (!body.stream) return Response.json({ ...last, message: { role: "assistant", content: said, ...(thought ? { thinking: thought } : {}) } });
        return new Response(new ReadableStream({
          async start(c) {
            const send = (o: any) => c.enqueue(enc.encode(JSON.stringify(o) + "\n"));
            try {
              if (thought) send({ model: body.model, message: { role: "assistant", content: "", thinking: thought }, done: false });
              for (const t of said === answer ? split : [said]) {
                if (rec.aborted) return;
                if (!t) continue;
                send({ model: body.model, message: { role: "assistant", content: t }, done: false });
                if (cut) { c.close(); return; } // the connection drops after one piece
                if (gap) await Bun.sleep(gap);
              }
              send(last);
              c.close();
            } catch {}
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        // OpenRouter reports its cost as a number; Perplexity as an object with its search fee in it.
        const reasoning = directive(text, "reasoning")?.[0], hidden = directive(text, "hidden")?.[0] ?? 0;
        const usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok + hidden, prompt_tokens_details: { cached_tokens: cached }, ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}), ...(provider === "openrouter" ? { cost: 0.00042 } : {}), ...(provider === "perplexity" ? { search_context_size: "low", cost: { input_tokens_cost: 0.0001, output_tokens_cost: 0.0001, request_cost: 0.005, total_cost: 0.0052 } } : {}) };
        if (!body.stream) {
          return Response.json({ id: "chatcmpl-fake", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: answer, ...(think ? { reasoning_content: think } : {}) }, finish_reason: finishReason }], ...(nousage ? {} : { usage }) });
        }
        const wantsUsage = body.stream_options?.include_usage === true || provider === "mistral" || provider === "google";
        return new Response(new ReadableStream({
          async start(c) {
            const send = (o: any) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            try {
              send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
              // Thinking, the way each provider sends it: Mistral as content parts, OpenRouter and Ollama as "reasoning", the rest as "reasoning_content".
              if (think) send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: provider === "mistral" ? { content: [{ type: "thinking", thinking: [{ type: "text", text: think }] }] } : provider === "openrouter" || provider === "ollama" ? { reasoning: think } : { reasoning_content: think }, finish_reason: null }] });
              for (const t of split) {
                if (rec.aborted) return;
                if (!t) continue;
                send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: provider === "mistral" && think ? { content: [{ type: "text", text: t }] } : { content: t }, finish_reason: null }] });
                if (cut) { c.close(); return; } // the connection drops after one piece
                if (gap) await Bun.sleep(gap);
              }
              send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
              if (wantsUsage && !nousage) send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage });
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            } catch {}
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (provider === "perplexity" && url.pathname.endsWith("/v1/agent")) {
        const usage = { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok, input_tokens_details: { cached_tokens: cached }, output_tokens_details: { reasoning_tokens: 0 },
          cost: { currency: "USD", input_cost: 0.0001, output_cost: 0.0001, tool_calls_cost: 0.0025, total_cost: 0.0027 }, tool_calls_details: { web_search: 1 } };
        const status = capped ? "incomplete" : "completed";
        const whole = { id: "resp_fake", object: "response", model: body.model, status, ...(capped ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: [{ type: "search_results", results: [{ url: "https://example.com/a", title: "A page" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [] }] }], ...(nousage ? {} : { usage }) };
        if (!body.stream) return Response.json(whole);
        return new Response(new ReadableStream({
          async start(c) {
            const send = (type: string, o: any) => c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`));
            try {
              send("response.created", { response: { id: "resp_fake", status: "in_progress" } });
              for (const t of split) {
                if (rec.aborted) return;
                if (!t) continue;
                send("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: t });
                if (cut) { c.close(); return; }
                if (gap) await Bun.sleep(gap);
              }
              send(capped ? "response.incomplete" : "response.completed", { response: whole });
              c.close();
            } catch {}
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/v1/messages/count_tokens")) return Response.json({ input_tokens: inTok });
      return new Response("fake: no such path " + url.pathname, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const bases: Record<string, string> = {
    openai: `${base}/openai/v1`, anthropic: `${base}/anthropic`, google: `${base}/google/v1beta/openai`, openrouter: `${base}/openrouter/api/v1`,
    deepseek: `${base}/deepseek`, xai: `${base}/xai/v1`, mistral: `${base}/mistral/v1`, ollama: `${base}/ollama/v1`,
    perplexity: `${base}/perplexity`, groq: `${base}/groq/openai/v1`, cerebras: `${base}/cerebras/v1`, together: `${base}/together/v1`, fireworks: `${base}/fireworks/inference/v1`,
  };
  return {
    server, base, bases, seen, oauth, ollama, hooks,
    setData(j: any, status = 200) { dataJson = j; dataStatus = status; },
    pointEnv() { for (const [id, b] of Object.entries(bases)) process.env[`LEANFARE_${id.toUpperCase()}_BASE`] = b; },
  };
}
