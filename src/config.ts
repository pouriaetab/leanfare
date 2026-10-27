// Where Leanfare keeps its files, which address it listens on, and the
// providers it can talk to. Environment variables override the defaults; the
// tests use them to point Leanfare at a throwaway folder and a fake provider.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { CATALOG_FILE } from "./assets";

export const VERSION = "0.5.0";
export const BUN_TESTED = "1.4"; // the Bun minor version this release is tested on
export const HOST = "127.0.0.1";
export const PORT = Number(process.env.LEANFARE_PORT ?? 4747);
export const runtime = { port: PORT }; // the port actually in use, set when the server starts
export const DATA_DIR = process.env.LEANFARE_DATA_DIR ?? join(homedir(), ".leanfare");
export const DATA_URL = process.env.LEANFARE_DATA_URL ?? "https://pouriaetab.github.io/llmledger/data.json";
export const BUILT_IN_CATALOG = CATALOG_FILE; // the price list this release ships with (assets.ts)

// A data folder that cannot be made is said where it matters (starting Leanfare), not at every import:
// the quick commands Claude Code runs (the status line, the prompt hook) must never fail out loud.
export let DATA_DIR_PROBLEM: string | null = null;
try { mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); } catch (e: any) { DATA_DIR_PROBLEM = `Leanfare cannot make its data folder ${DATA_DIR} (${String(e?.code ?? e?.message ?? e)}).`; }

// A short fingerprint of the data folder (never its path), on /healthz: a command that finds a Leanfare
// at a port acts on it only when it uses this folder (leanfare stop, status, a second start).
const realDir = () => { try { return realpathSync(DATA_DIR); } catch { return DATA_DIR; } };
export const DATA_ID = createHash("sha256").update(realDir()).digest("hex").slice(0, 12);

export const paths = {
  db: join(DATA_DIR, "leanfare.db"),
  keys: join(DATA_DIR, "keys.json"),
  catalog: join(DATA_DIR, "catalog.json"),
  openrouter: join(DATA_DIR, "openrouter-models.json"),
  pid: join(DATA_DIR, "leanfare.pid"),
  token: join(DATA_DIR, "control.token"),
};

// Built-in providers, the model apps Leanfare finds running on this computer, and providers
// you add yourself (any address that speaks OpenAI's format): all named by a short id.
export type ProviderId = string;

export interface ProviderDef {
  id: ProviderId;
  name: string;
  kind: "openai" | "anthropic"; // the wire format it speaks
  defaultBase: string;
  host?: string; // the host name llmledger uses for its prices
  prefix: string; // prefix of its keys in llmledger's catalogue
  needsKey: boolean;
  envKeys: string[]; // environment variables that may already hold a key
  keyUrl: string;
  // How a streamed answer reports its token counts: "ask" adds
  // stream_options.include_usage, "own" means the provider adds usage itself
  // or we read whatever comes back.
  streamUsage: "ask" | "own";
  note?: string;
  keyShape?: RegExp; // how its keys look, so a pasted key finds its provider
  only?: RegExp; // the catalogue's rows it still serves (some keep rows for long gone models)
  skip?: RegExp; // catalogue rows that are not models (price tiers and the like)
  slashIds?: boolean; // its model ids hold slashes (openai/gpt-oss-120b)
  more?: boolean; // listed under More providers until it has a key
  local?: boolean; // runs on this computer
  custom?: boolean; // added by you (see providers.ts)
  noModelList?: boolean; // has no list of models to test a key against
}

export const PROVIDERS: ProviderDef[] = [
  { id: "openai", name: "OpenAI", kind: "openai", defaultBase: "https://api.openai.com/v1", host: "openai", prefix: "", needsKey: true, envKeys: ["OPENAI_API_KEY"], keyUrl: "https://platform.openai.com/api-keys", streamUsage: "ask", keyShape: /^sk-(proj|svcacct|admin)-|T3BlbkFJ/ },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", defaultBase: "https://api.anthropic.com", host: "anthropic", prefix: "", needsKey: true, envKeys: ["ANTHROPIC_API_KEY"], keyUrl: "https://console.anthropic.com/settings/keys", streamUsage: "own", keyShape: /^sk-ant-api\d\d-/ },
  { id: "google", name: "Google Gemini", kind: "openai", defaultBase: "https://generativelanguage.googleapis.com/v1beta/openai", host: "gemini", prefix: "gemini/", needsKey: true, envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], keyUrl: "https://aistudio.google.com/apikey", streamUsage: "own", note: "Free keys work. On Google's free plan, Google may use your messages to improve its products.", keyShape: /^(AIza[\w-]{35}|AQ\.[\w-]{20,})$/ },
  { id: "openrouter", name: "OpenRouter", kind: "openai", defaultBase: "https://openrouter.ai/api/v1", prefix: "", needsKey: true, envKeys: ["OPENROUTER_API_KEY"], keyUrl: "https://openrouter.ai/settings/keys", streamUsage: "ask", note: "One key for models from many makers. Models whose name ends in :free cost nothing.", keyShape: /^sk-or-v1-/ },
  { id: "deepseek", name: "DeepSeek", kind: "openai", defaultBase: "https://api.deepseek.com", host: "deepseek", prefix: "deepseek/", needsKey: true, envKeys: ["DEEPSEEK_API_KEY"], keyUrl: "https://platform.deepseek.com/api_keys", streamUsage: "ask", keyShape: /^sk-[0-9a-f]{32}$/ },
  { id: "xai", name: "xAI", kind: "openai", defaultBase: "https://api.x.ai/v1", host: "xai", prefix: "xai/", needsKey: true, envKeys: ["XAI_API_KEY"], keyUrl: "https://console.x.ai", streamUsage: "ask", keyShape: /^xai-/ },
  { id: "mistral", name: "Mistral", kind: "openai", defaultBase: "https://api.mistral.ai/v1", host: "mistral", prefix: "mistral/", needsKey: true, envKeys: ["MISTRAL_API_KEY"], keyUrl: "https://console.mistral.ai/api-keys", streamUsage: "own", keyShape: /^[A-Za-z0-9]{32}$/ },
  { id: "perplexity", name: "Perplexity", kind: "openai", defaultBase: "https://api.perplexity.ai", host: "perplexity", prefix: "perplexity/", needsKey: true, envKeys: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"], keyUrl: "https://www.perplexity.ai/account/api/keys", streamUsage: "own", note: "Answers from a live web search, with the pages it used. Each request also has a small search fee, counted in its cost.", keyShape: /^pplx-/, only: /^sonar(-pro|-reasoning-pro)?$/, more: true, noModelList: true },
  { id: "groq", name: "Groq", kind: "openai", defaultBase: "https://api.groq.com/openai/v1", host: "groq", prefix: "groq/", needsKey: true, envKeys: ["GROQ_API_KEY"], keyUrl: "https://console.groq.com/keys", streamUsage: "own", note: "Open models served very fast.", keyShape: /^gsk_/, slashIds: true, skip: /guard/i, more: true },
  { id: "cerebras", name: "Cerebras", kind: "openai", defaultBase: "https://api.cerebras.ai/v1", host: "cerebras", prefix: "cerebras/", needsKey: true, envKeys: ["CEREBRAS_API_KEY"], keyUrl: "https://cloud.cerebras.ai", streamUsage: "own", note: "Open models served very fast.", keyShape: /^csk[-_]/, more: true },
  { id: "together", name: "Together AI", kind: "openai", defaultBase: "https://api.together.xyz/v1", host: "together_ai", prefix: "together_ai/", needsKey: true, envKeys: ["TOGETHER_API_KEY"], keyUrl: "https://api.together.ai/settings/api-keys", streamUsage: "own", keyShape: /^tgp_v1_/, slashIds: true, skip: /^together-ai-/, more: true },
  { id: "fireworks", name: "Fireworks AI", kind: "openai", defaultBase: "https://api.fireworks.ai/inference/v1", host: "fireworks_ai", prefix: "fireworks_ai/", needsKey: true, envKeys: ["FIREWORKS_API_KEY"], keyUrl: "https://app.fireworks.ai/settings/users/api-keys", streamUsage: "own", keyShape: /^fw_/, slashIds: true, more: true },
  { id: "ollama", name: "Ollama", kind: "openai", defaultBase: "http://127.0.0.1:11434/v1", prefix: "", needsKey: false, envKeys: [], keyUrl: "https://ollama.com/download", streamUsage: "ask", note: "Models on this computer. Free to run, and your messages never leave it.", local: true },
];

// The providers that are not built in: model apps found running on this computer, and
// the ones you added (providers.ts keeps both up to date).
const extra = new Map<ProviderId, ProviderDef>();
export function setExtraProviders(defs: ProviderDef[], which: "local" | "custom") {
  for (const [id, d] of extra) if ((which === "local" ? d.local : d.custom)) extra.delete(id);
  for (const d of defs) if (!PROVIDERS.some((p) => p.id === d.id)) extra.set(d.id, d);
}
export const allProviders = (): ProviderDef[] => [...PROVIDERS, ...extra.values()];
export const provider = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id) ?? extra.get(id);

// LEANFARE_<ID>_BASE changes a provider's address. Read on every call so a
// test can start a fake provider first and point Leanfare at it afterwards.
export function baseOf(id: ProviderId): string {
  const def = provider(id);
  const env = process.env[`LEANFARE_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE`];
  return (env ?? def?.defaultBase ?? "").replace(/\/+$/, "");
}
