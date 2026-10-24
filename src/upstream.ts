// Talking to providers: building each provider's request, testing a key, and
// translating between OpenAI's chat format and Anthropic's Messages format so
// Claude models work behind the OpenAI address and in the chat.
import { baseOf, provider, type ProviderDef, type ProviderId } from "./config";
import type { Model } from "./data";
import { fromAnthropicUsage, type Usage } from "./cost";
import { providerMessage, redact } from "./util";

export class UserError extends Error {
  constructor(public status: number, message: string, public type = "leanfare_error") { super(message); }
}

export const ANTHROPIC_VERSION = "2023-06-01";

export function headersFor(def: ProviderDef, key: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (def.kind === "anthropic") {
    if (key) h["x-api-key"] = key;
    h["anthropic-version"] = ANTHROPIC_VERSION;
  } else if (key) h.authorization = `Bearer ${key}`;
  return h;
}

// An OpenAI-format body for any OpenAI-compatible provider. Streams ask for
// token counts where the provider needs asking; the engine hides that extra
// last chunk from clients that did not ask for it themselves.
export function openaiBody(m: Model, body: any, stream: boolean): any {
  const def = provider(m.provider)!;
  const out: any = { ...body, model: m.apiId, stream };
  if (!stream) delete out.stream_options;
  else if (def.streamUsage === "ask") out.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  if (m.provider === "openrouter") out.usage = { include: true }; // OpenRouter then reports the exact cost
  return out;
}

// ---- OpenAI chat format -> Anthropic Messages ----------------------------------

function anthropicContent(content: unknown): any[] | string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: any[] = [];
  for (const part of content as any[]) {
    if (typeof part === "string") blocks.push({ type: "text", text: part });
    else if (part?.type === "text") blocks.push({ type: "text", text: String(part.text ?? "") });
    else if (part?.type === "image_url") {
      const url: string = typeof part.image_url === "string" ? part.image_url : part.image_url?.url ?? "";
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      blocks.push(m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } });
    }
  }
  return blocks;
}

export function toAnthropic(body: any, m: Model, stream: boolean): any {
  if (body.tools || body.functions || body.tool_choice) {
    throw new UserError(400, "In Leanfare 0.1, tools with Claude models work through the Anthropic address (/v1/messages), not the OpenAI one.");
  }
  const system: string[] = [];
  const messages: any[] = [];
  for (const msg of body.messages ?? []) {
    if (msg.role === "system" || msg.role === "developer") {
      const t = typeof msg.content === "string" ? msg.content : (msg.content ?? []).map((p: any) => p?.text ?? "").join("\n");
      if (t) system.push(t);
    } else if (msg.role === "user" || msg.role === "assistant") {
      if (msg.tool_calls) throw new UserError(400, "In Leanfare 0.1, tool calls with Claude models work through /v1/messages only.");
      messages.push({ role: msg.role, content: anthropicContent(msg.content) });
    } else if (msg.role === "tool" || msg.role === "function") {
      throw new UserError(400, "In Leanfare 0.1, tool results with Claude models work through /v1/messages only.");
    }
  }
  const out: any = {
    model: m.apiId,
    messages,
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 8192,
    stream,
  };
  if (system.length) out.system = system.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = Math.min(1, Math.max(0, body.temperature));
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (typeof body.user === "string") out.metadata = { user_id: body.user };
  return out;
}

const FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls", refusal: "content_filter", pause_turn: "stop" };

// cache_write_tokens is not part of OpenAI's format; Leanfare adds it so a
// Claude answer's cache writes keep their own price on the way through.
function openaiUsage(u: Usage) {
  const prompt = u.uncached + u.cacheRead + u.cacheWrite;
  return { prompt_tokens: prompt, completion_tokens: u.output, total_tokens: prompt + u.output, prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite } };
}

// A whole Anthropic answer -> a whole OpenAI answer.
export function anthropicToOpenAI(j: any, modelId: string): any {
  const text = (j.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  const usage = fromAnthropicUsage(j.usage) ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return {
    id: j.id ?? "chatcmpl-leanfare",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: FINISH[j.stop_reason] ?? "stop" }],
    usage: openaiUsage(usage),
  };
}

// A streamed Anthropic answer -> OpenAI stream chunks, one event at a time.
export class AnthropicStreamTranslator {
  usage: Usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private id = "chatcmpl-leanfare";
  private created = Math.floor(Date.now() / 1000);
  private started = false;
  finish: string | null = null;
  stopped = false; // Claude said message_stop: the answer is complete
  constructor(private modelId: string, private includeUsage: boolean) {}

  private chunk(delta: any, finish: string | null = null) {
    return `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  }

  // Returns the OpenAI-format text to send for one Anthropic event.
  event(name: string, data: string): string {
    let j: any;
    try { j = JSON.parse(data); } catch { return ""; }
    const type = j.type ?? name;
    if (type === "message_start") {
      this.id = j.message?.id ?? this.id;
      const u = fromAnthropicUsage(j.message?.usage);
      if (u) this.usage = { ...u, output: u.output };
      this.started = true;
      return this.chunk({ role: "assistant", content: "" });
    }
    if (type === "content_block_delta" && j.delta?.type === "text_delta") return this.chunk({ content: j.delta.text ?? "" });
    if (type === "message_delta") {
      if (j.usage?.output_tokens !== undefined) this.usage.output = j.usage.output_tokens;
      // Anthropic may repeat the input counts at the end; keep the larger.
      const u = fromAnthropicUsage(j.usage);
      if (u) { this.usage.uncached = Math.max(this.usage.uncached, u.uncached); this.usage.cacheRead = Math.max(this.usage.cacheRead, u.cacheRead); this.usage.cacheWrite = Math.max(this.usage.cacheWrite, u.cacheWrite); }
      this.finish = FINISH[j.delta?.stop_reason] ?? "stop";
      return this.chunk({}, this.finish);
    }
    if (type === "message_stop") {
      this.stopped = true;
      let out = "";
      if (this.includeUsage) out += `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.modelId, choices: [], usage: openaiUsage(this.usage) })}\n\n`;
      return out;
    }
    if (type === "error") {
      const msg = j.error?.message ?? "the provider stopped with an error";
      return `data: ${JSON.stringify({ error: { message: msg, type: j.error?.type ?? "provider_error" } })}\n\n`;
    }
    return "";
  }
  get hasStarted() { return this.started; }
}

// ---- keys -------------------------------------------------------------------

export interface KeyCheck { ok: boolean; status: number; message: string; models: string[] | null }

function plainError(def: ProviderDef, status: number, body: string, key: string | null): string {
  const said = redact(providerMessage(body), key ? [key] : []);
  if (status === 401 || status === 403 || (status === 400 && /key/i.test(said))) return `${def.name} rejected the key: ${said}`;
  if (status === 402) return `${def.name} says the account has no credit left: ${said}`;
  if (status === 429) return `${def.name} says too many requests or the plan's limit is reached: ${said}. Wait a minute, or check your plan.`;
  if (status === 404) return `${def.name} does not know this: ${said}`;
  if (status >= 500) return `${def.name} had a problem on its side (${status}): ${said}. Try again, or pick another model.`;
  return `${def.name} answered ${status}: ${said}`;
}
export { plainError };

export function networkError(def: ProviderDef, e: any): string {
  const host = (() => { try { return new URL(baseOf(def.id)).host; } catch { return baseOf(def.id); } })();
  if (e?.name === "TimeoutError") return `${def.name} did not answer within the time limit (${host}).`;
  if (e?.name === "AbortError") return "Stopped.";
  if (def.id === "ollama") return `Ollama is not running on this computer (nothing answered at ${host}). Open the Ollama app, then try again.`;
  return `Could not reach ${def.name} at ${host}: ${String(e?.message ?? e).slice(0, 160)}`;
}

// A key is tested with the provider's free model list (no tokens are used).
export async function checkKey(id: ProviderId, key: string | null, signal?: AbortSignal): Promise<KeyCheck> {
  const def = provider(id)!;
  const base = baseOf(id);
  let url = `${base}/models`;
  if (id === "anthropic") url = `${base}/v1/models?limit=1000`;
  if (id === "openrouter") url = `${base}/key`;
  if (id === "ollama") url = `${base.replace(/\/v1$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { headers: headersFor(def, key), signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, message: plainError(def, res.status, text, key), models: null };
    let models: string[] | null = null;
    try {
      const j = JSON.parse(text);
      const list = id === "ollama" ? j.models?.map((m: any) => m.name) : j.data?.map((m: any) => String(m.id ?? "").replace(/^models\//, ""));
      if (Array.isArray(list)) models = list.filter(Boolean);
    } catch {}
    const message = id === "openrouter" ? "OpenRouter accepted the key." : models ? `${def.name} accepted the key: ${models.length} models available to it.` : `${def.name} accepted the key.`;
    return { ok: true, status: res.status, message, models };
  } catch (e: any) {
    return { ok: false, status: 0, message: networkError(def, e), models: null };
  }
}
