// leanfare mcp: Leanfare as an MCP server (stdio), so Claude Desktop and other
// MCP clients can ask a model through Leanfare, check what you spent, list your
// models and estimate a prompt's cost. It is a small door into the running app:
// every call goes to Leanfare at 127.0.0.1 (started if it is not running), so
// the costs, the budget and the ledger are the same as everywhere else.
//
// It speaks both eras of the protocol: the 2026-07-28 revision (each request
// carries its version in _meta; server/discover) and the earlier ones that
// open with initialize (2025-11-25 and before). No SDK: JSON-RPC over stdin and
// stdout, one message per line; anything for a person goes to stderr.
import { existsSync, readFileSync } from "node:fs";
import { PORT, VERSION, paths } from "./config";

const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "leanfare", title: "Leanfare", version: VERSION };
const META = { "io.modelcontextprotocol/serverInfo": SERVER };
const INSTRUCTIONS = "Leanfare runs every top AI model on this computer with the user's own keys, shows what each answer costs, and keeps a monthly budget. Use ask to hand a question to another model (Auto picks the cheapest one that rates well for the task); spend to see what was spent and saved; models to see which models and prices are available; estimate to price a prompt before sending it.";

const TOOLS = [
  {
    name: "ask",
    title: "Ask a model",
    description: "Ask a question through Leanfare and get the answer with its cost. By default Leanfare's Auto picks the cheapest model the user ticked that rates well for the task; name a model to use that one. The cost counts toward the user's budget.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question or task, with everything the model needs to answer it." },
        model: { type: "string", description: "auto (the default), auto-save, auto-balanced, auto-best, or a model id from the models tool, such as google/gemini-3.8-flash." },
        system: { type: "string", description: "Instructions for the model (a system prompt)." },
        max_tokens: { type: "integer", minimum: 1, maximum: 64000, description: "The longest answer to allow, in tokens." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: { title: "Ask a model", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "spend",
    title: "What was spent",
    description: "What the user spent on AI through Leanfare today and this month, the budget left, what Auto saved against their usual model, and the top models.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "What was spent", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "models",
    title: "Models and prices",
    description: "The models the user ticked in Leanfare and can use now, with their prices in US dollars per 1M tokens and their quality rating (Arena).",
    inputSchema: { type: "object", properties: { provider: { type: "string", description: "Only this provider, for example openai, anthropic, google, openrouter." } }, additionalProperties: false },
    annotations: { title: "Models and prices", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "estimate",
    title: "Estimate a cost",
    description: "Estimate what a prompt would cost before sending it: the model Auto would pick, why, and the estimate for it and the other choices. Nothing is sent to a model.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "The prompt to price." }, model: { type: "string", description: "auto (the default) or a model id." } },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: { title: "Estimate a cost", readOnlyHint: true, openWorldHint: false },
  },
];

// ---- reaching the app --------------------------------------------------------------

interface App { base: string; token: string }

function where(): App {
  if (process.env.LEANFARE_URL) return { base: process.env.LEANFARE_URL.replace(/\/+$/, ""), token: process.env.LEANFARE_TOKEN ?? "" };
  let port = PORT;
  try { port = JSON.parse(readFileSync(paths.pid, "utf8")).port ?? PORT; } catch {}
  const token = existsSync(paths.token) ? readFileSync(paths.token, "utf8").trim() : "";
  return { base: `http://127.0.0.1:${port}`, token };
}

async function healthy(base: string): Promise<boolean> {
  try { const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) }); return (await r.json())?.app === "leanfare"; } catch { return false; }
}

// Leanfare is started in the background if it is not running (as `leanfare --no-open` would).
let starting: Promise<App> | null = null;
async function app(): Promise<App> {
  let a = where();
  if (await healthy(a.base)) return a;
  if (process.env.LEANFARE_URL) throw new Error(`Leanfare is not answering at ${a.base}.`);
  starting ??= (async () => {
    const cli = new URL("./cli.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, cli, "--no-open"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, LEANFARE_NO_OPEN: "1" } });
    child.unref();
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(100);
      a = where();
      if (a.token && (await healthy(a.base))) return a;
    }
    throw new Error("Leanfare did not start. Open it once from Terminal with: leanfare");
  })().finally(() => { starting = null; });
  return starting;
}

async function call(path: string, init: RequestInit & { json?: unknown } = {}, signal?: AbortSignal): Promise<any> {
  const a = await app();
  const headers: Record<string, string> = { "x-leanfare": "1", "x-leanfare-token": a.token, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) };
  const r = await fetch(a.base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(j?.error?.message ?? (typeof j?.error === "string" ? j.error : null) ?? `Leanfare answered ${r.status}.`);
  return { j, headers: r.headers };
}

// ---- the tools -------------------------------------------------------------------------

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const text = (t: string, structured?: unknown) => ({ content: [{ type: "text", text: t }], ...(structured !== undefined ? { structuredContent: structured } : {}) });
const failure = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

async function runTool(name: string, args: any, signal: AbortSignal): Promise<any> {
  if (name === "ask") {
    if (typeof args?.prompt !== "string" || !args.prompt.trim()) return failure("ask needs a prompt.");
    const messages = [...(typeof args.system === "string" && args.system.trim() ? [{ role: "system", content: args.system }] : []), { role: "user", content: args.prompt }];
    const body: any = { model: typeof args.model === "string" && args.model ? args.model : "auto", messages };
    if (Number.isInteger(args.max_tokens) && args.max_tokens > 0) body.max_tokens = args.max_tokens;
    const { j, headers } = await call("/v1/chat/completions", { method: "POST", json: body }, signal);
    const answer = String(j?.choices?.[0]?.message?.content ?? "");
    const model = headers.get("x-leanfare-model") ?? "?";
    const costHeader = headers.get("x-leanfare-cost-usd");
    const cost = costHeader && costHeader !== "unknown" ? Number(costHeader) : null;
    const reason = decodeURIComponent(headers.get("x-leanfare-reason") ?? "");
    return text(`${answer}\n\n(Leanfare: ${model}, ${usd(cost)}. ${reason})`, { answer, model, cost_usd: cost, task: headers.get("x-leanfare-task"), reason });
  }
  if (name === "spend") {
    const { j: s } = await call("/api/summary", {}, signal);
    const { j: v } = await call("/api/savings", {}, signal);
    const lines = [
      `Today: ${usd(s.today)}. This month: ${usd(s.month)} over ${s.answers} answers.`,
      s.budget ? `Budget: ${usd(s.budget.amount)} a month, ${usd(s.budget.left)} left (${Math.floor(s.budget.pct ?? 0)}% used).` : "No monthly budget is set.",
      v.saved?.amount ? `Auto saved ${usd(v.saved.amount)} against the usual model this month${v.more?.ratio ? `: ${v.more.ratio.toFixed(1)} times as many answers for the money` : ""}.` : "Auto has not saved anything against the usual model yet this month.",
      v.byModel?.length ? `By model: ${v.byModel.slice(0, 5).map((r: any) => `${r.label} ${usd(r.cost)} (${r.answers})`).join(", ")}.` : "",
      s.paused ? "Leanfare is paused: new requests wait." : "",
    ].filter(Boolean);
    return text(lines.join("\n"), { today_usd: s.today, month_usd: s.month, answers: s.answers, budget: s.budget, saved_usd: v.saved?.amount ?? 0, top: s.top });
  }
  if (name === "models") {
    const { j: st } = await call("/api/state", {}, signal);
    const ticked = new Set<string>(st.settings.ticked);
    const ready = new Set<string>(st.providers.filter((p: any) => p.ready).map((p: any) => p.id));
    const want = typeof args?.provider === "string" ? args.provider.toLowerCase() : null;
    const rows = (Object.values(st.models).flat() as any[]).filter((m) => ticked.has(m.id) && ready.has(m.provider) && !m.retired && (!want || m.provider === want));
    if (!rows.length) return text(want ? `No ticked, ready models from ${want}.` : "No models are ready. Add a key in Leanfare's Settings and tick some models.", { models: [] });
    const per = (v: number | null) => (v === null ? "?" : `$${v}`);
    return text(rows.map((m) => `${m.id}: ${m.label}, ${m.local || m.free ? "free" : `${per(m.input)} in / ${per(m.output)} out per 1M tokens`}${m.rating ? `, rated ${Math.round(m.rating)}` : ""}`).join("\n"),
      { models: rows.map((m) => ({ id: m.id, label: m.label, provider: m.provider, input_per_m: m.input, output_per_m: m.output, rating: m.rating })) });
  }
  if (name === "estimate") {
    if (typeof args?.prompt !== "string" || !args.prompt.trim()) return failure("estimate needs a prompt.");
    const { j } = await call("/api/estimate", { method: "POST", json: { messages: [{ role: "user", content: args.prompt }], model: typeof args.model === "string" && args.model ? args.model : "auto" } }, signal);
    if (!j.plan) return failure(j.error ?? "Leanfare could not estimate this.");
    const p = j.plan;
    const alts = (p.alternatives ?? []).map((a: any) => `${a.label} about ${usd(a.estimate)}`).join(", ");
    return text(`About ${usd(j.estimate)} on ${p.model.label} (an estimate). ${p.reason}${alts ? `\nOther choices: ${alts}.` : ""}`, { estimate_usd: j.estimate, model: p.model.id, task: p.task, reason: p.reason, alternatives: p.alternatives });
  }
  return null;
}

// ---- JSON-RPC over stdio ----------------------------------------------------------------

type Id = string | number;
const out = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + "\n"); };
const reply = (id: Id, result: unknown): void => out({ jsonrpc: "2.0", id, result });
const error = (id: Id | null, code: number, message: string, data?: unknown): void => out({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const inflight = new Map<Id, AbortController>();

export async function handleMessage(msg: any, send = { reply, error }): Promise<void> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && msg.id !== undefined && msg.id !== null) send.error(msg.id, -32600, "Not a JSON-RPC 2.0 request.");
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) { // a notification: never answered
    if (method === "notifications/cancelled") inflight.get(params?.requestId)?.abort();
    return;
  }
  const meta = params?._meta ?? {};
  const version = meta["io.modelcontextprotocol/protocolVersion"];
  const modern = typeof version === "string";
  if (modern) {
    if (!MODERN.includes(version)) return send.error(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested: version });
    if (!meta["io.modelcontextprotocol/clientCapabilities"] || typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object") return send.error(id, -32602, "Every request needs io.modelcontextprotocol/clientCapabilities in its _meta.");
  }
  const done = (result: any) => send.reply(id, modern ? { resultType: "complete", ...result, _meta: META } : result);

  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return send.reply(id, { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
  }
  if (method === "server/discover") return send.reply(id, { resultType: "complete", supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: {} }, _meta: META, instructions: INSTRUCTIONS });
  if (method === "ping") return done({});
  if (method === "tools/list") return done({ tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return send.error(id, -32602, `Leanfare has no tool named ${String(name)}.`);
    const ac = new AbortController();
    inflight.set(id, ac);
    try {
      const result = await runTool(name, params?.arguments ?? {}, ac.signal);
      if (!ac.signal.aborted) done(result);
    } catch (e: any) {
      if (!ac.signal.aborted) done(failure(String(e?.message ?? e)));
    } finally { inflight.delete(id); }
    return;
  }
  return send.error(id, -32601, `Leanfare's MCP door has no method ${method}.`);
}

export async function runMcp() {
  process.stderr.write(`Leanfare ${VERSION} MCP door: waiting on stdin.\n`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { error(null, -32700, "Not JSON."); continue; }
      const job = handleMessage(msg).catch((e) => process.stderr.write(`leanfare mcp: ${String(e?.message ?? e)}\n`));
      pending.add(job);
      job.finally(() => pending.delete(job));
    }
  }
  // A last message with no newline after it still counts.
  const rest = buf.trim();
  if (rest) {
    let msg: any = null;
    try { msg = JSON.parse(rest); } catch { error(null, -32700, "Not JSON."); }
    if (msg) { const job = handleMessage(msg).catch(() => {}); pending.add(job); }
  }
  // stdin closed: the client is done sending. Answer what is still running (at most 60 s), then exit.
  await Promise.race([Promise.all([...pending]), Bun.sleep(60_000)]);
  for (const ac of inflight.values()) ac.abort();
  process.exit(0);
}
const pending = new Set<Promise<unknown>>();
