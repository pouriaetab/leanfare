// A fake of every provider Leanfare talks to, on one local port, so the tests
// never reach the internet and every token count is known in advance.
//
// Each provider lives under its own path: /openai/v1, /anthropic, /google/v1beta/openai,
// /openrouter/api/v1, /deepseek, /xai/v1, /mistral/v1, /ollama/v1 (and /ollama/api/tags).
// A message can steer the answer:
//   [usage 2000 500]        report exactly 2,000 input and 500 output tokens
//   [cached 1500]           of the input, 1,500 came from the cache
//   [nousage]               report no token counts at all
//   [slow 3000]             wait 3 seconds before answering
//   [chunks 40]             stream the answer in 40 pieces, 50 ms apart
//   [fail 429]              answer with this HTTP status
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
          { id: "acme/acme-large", name: "Acme: Large", pricing: { prompt: "0.000001", completion: "0.000004" }, context_length: 100000, created: 1790000000, architecture: { output_modalities: ["text"] } },
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
      const capped = (u?.[1] ?? 12) > limit;
      const cached = directive(text, "cached")?.[0] ?? 0;
      const nousage = !!directive(text, "nousage");
      const pieces = directive(text, "chunks")?.[0] ?? 3;
      const answer = text.includes("[md]") ? MARKDOWN : `Hello from ${body?.model ?? "?"}.`;
      const split = Array.from({ length: pieces }, (_, i) => answer.slice(Math.floor((i * answer.length) / pieces), Math.floor(((i + 1) * answer.length) / pieces)));
      const gap = pieces > 3 ? 50 : 0;
      const enc = new TextEncoder();

      if (provider === "anthropic" && url.pathname.endsWith("/v1/messages")) {
        const usage = { input_tokens: inTok - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: outTok };
        if (!body.stream) {
          return Response.json({ id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: answer }], stop_reason: capped ? "max_tokens" : "end_turn", usage: nousage ? undefined : usage });
        }
        const events: [string, any][] = [
          ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], usage: nousage ? undefined : { ...usage, output_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ...split.map((t): [string, any] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }]),
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: capped ? "max_tokens" : "end_turn" }, usage: nousage ? undefined : { output_tokens: outTok } }],
          ["message_stop", { type: "message_stop" }],
        ];
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
          return Response.json({ id: "chatcmpl-fake", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: capped ? "length" : "stop" }], ...(nousage ? {} : { usage }) });
        }
        const wantsUsage = body.stream_options?.include_usage === true || provider === "mistral" || provider === "google";
        return new Response(new ReadableStream({
          async start(c) {
            const send = (o: any) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            try {
              send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
              for (const t of split) {
                if (rec.aborted) return;
                send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
                if (gap) await Bun.sleep(gap);
              }
              send({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : "stop" }] });
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
