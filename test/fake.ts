// A fake of every provider Leanfare talks to, on one local port, so the tests
// never reach the internet and every token count is known in advance.
//
// Each provider lives under its own path: /openai/v1, /anthropic, /google/v1beta/openai,
// /openrouter/api/v1, /deepseek, /xai/v1, /mistral/v1, /ollama/v1 (and /ollama/api/tags).
// A message can steer the answer:
//   [usage 2000 500]        report exactly 2,000 input and 500 output tokens
//   [cached 1500]           of the input, 1,500 came from the cache
//   [write1h 1000]          of the input, 1,000 were written to Claude's cache for an hour
//   [nousage]               report no token counts at all
//   [slow 3000]             wait 3 seconds before answering
//   [chunks 40]             stream the answer in 40 pieces, 50 ms apart
//   [fail 429]              answer with this HTTP status
//   [think]                 think first ("Let me think."), in each provider's own way
//   [empty] [empty1]        answer nothing (always, or only the first time this prompt is seen)
//   [cut1]                  the first time: stop sending after one piece, with no end marker
//   [thinkall1]             the first time: only think, and stop at the answer limit
//   [filter]                decline (finish_reason content_filter), with no text
export const KEYS: Record<string, string> = {
  openai: "sk-test-openai-0001", anthropic: "sk-ant-test-0002", google: "AIzaTestGoogleKey0000000000003", openrouter: "sk-or-test-0004",
  deepseek: "sk-test-deepseek-05", xai: "xai-test-key-000006", mistral: "test-mistral-key-07",
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

const directive = (text: string, name: string) => {
  const m = new RegExp(`\\[${name}(?: ([\\d ]+))?\\]`).exec(text);
  return m ? (m[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number) : null;
};

function promptText(body: any): string {
  const parts: string[] = [];
  if (typeof body?.system === "string") parts.push(body.system);
  for (const m of body?.messages ?? []) parts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  return parts.join("\n");
}

export function startFake() {
  const seen: Seen[] = [];
  const onceSeen = new Set<string>();
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
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? req.headers.get("x-api-key");
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { if (k !== "authorization" && k !== "x-api-key") headers[k] = v; });
      const rec: Seen = { provider, path: url.pathname, method: req.method, auth, body, aborted: false, headers };
      seen.push(rec);
      req.signal.addEventListener("abort", () => { rec.aborted = true; });

      if (url.pathname === "/data.json") return dataStatus === 200 && dataJson ? Response.json(dataJson) : new Response("down", { status: dataStatus });
      if (provider === "ollama" && url.pathname.endsWith("/api/tags")) return Response.json({ models: [{ name: "llama3.2:latest", modified_at: "2026-10-01T00:00:00Z" }] });

      const keyOk = provider === "ollama" || auth === KEYS[provider];
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
      const fail = directive(text, "fail");
      if (fail?.[0]) return Response.json({ error: { message: `fake failure ${fail[0]}` } }, { status: fail[0] });
      const slow = directive(text, "slow");
      if (slow?.[0]) await Bun.sleep(slow[0]);
      const u = directive(text, "usage");
      const inTok = u?.[0] ?? Math.ceil(text.length / 4);
      // Like a real provider, never write more than the request allows.
      const limit = body?.max_completion_tokens ?? body?.max_tokens ?? Infinity;
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
      const answer = empty ? "" : text.includes("[md]") ? MARKDOWN : `Hello from ${body?.model ?? "?"}.`;
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

      if (url.pathname.endsWith("/chat/completions")) {
        const usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok, prompt_tokens_details: { cached_tokens: cached }, ...(provider === "openrouter" ? { cost: 0.00042 } : {}) };
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
      if (url.pathname.endsWith("/v1/messages/count_tokens")) return Response.json({ input_tokens: inTok });
      return new Response("fake: no such path " + url.pathname, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const bases: Record<string, string> = {
    openai: `${base}/openai/v1`, anthropic: `${base}/anthropic`, google: `${base}/google/v1beta/openai`, openrouter: `${base}/openrouter/api/v1`,
    deepseek: `${base}/deepseek`, xai: `${base}/xai/v1`, mistral: `${base}/mistral/v1`, ollama: `${base}/ollama/v1`,
  };
  return {
    server, base, bases, seen,
    setData(j: any, status = 200) { dataJson = j; dataStatus = status; },
    pointEnv() { for (const [id, b] of Object.entries(bases)) process.env[`LEANFARE_${id.toUpperCase()}_BASE`] = b; },
  };
}
