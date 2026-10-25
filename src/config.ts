// Where Leanfare keeps its files, which address it listens on, and the
// providers it can talk to. Environment variables override the defaults; the
// tests use them to point Leanfare at a throwaway folder and a fake provider.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const VERSION = "0.3.0";
export const BUN_TESTED = "1.4"; // the Bun minor version this release is tested on
export const HOST = "127.0.0.1";
export const PORT = Number(process.env.LEANFARE_PORT ?? 4747);
export const runtime = { port: PORT }; // the port actually in use, set when the server starts
export const DATA_DIR = process.env.LEANFARE_DATA_DIR ?? join(homedir(), ".leanfare");
export const DATA_URL = process.env.LEANFARE_DATA_URL ?? "https://pouriaetab.github.io/llmledger/data.json";
export const BUILT_IN_CATALOG = new URL("../data/catalog.json", import.meta.url).pathname;
export const UI_DIR = new URL("../ui/", import.meta.url).pathname;

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export const paths = {
  db: join(DATA_DIR, "leanfare.db"),
  keys: join(DATA_DIR, "keys.json"),
  catalog: join(DATA_DIR, "catalog.json"),
  openrouter: join(DATA_DIR, "openrouter-models.json"),
  pid: join(DATA_DIR, "leanfare.pid"),
  token: join(DATA_DIR, "control.token"),
};

export type ProviderId = "openai" | "anthropic" | "google" | "openrouter" | "deepseek" | "xai" | "mistral" | "ollama";

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
}

export const PROVIDERS: ProviderDef[] = [
  { id: "openai", name: "OpenAI", kind: "openai", defaultBase: "https://api.openai.com/v1", host: "openai", prefix: "", needsKey: true, envKeys: ["OPENAI_API_KEY"], keyUrl: "https://platform.openai.com/api-keys", streamUsage: "ask" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", defaultBase: "https://api.anthropic.com", host: "anthropic", prefix: "", needsKey: true, envKeys: ["ANTHROPIC_API_KEY"], keyUrl: "https://console.anthropic.com/settings/keys", streamUsage: "own" },
  { id: "google", name: "Google Gemini", kind: "openai", defaultBase: "https://generativelanguage.googleapis.com/v1beta/openai", host: "gemini", prefix: "gemini/", needsKey: true, envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], keyUrl: "https://aistudio.google.com/apikey", streamUsage: "own", note: "Free keys work. On Google's free plan, Google may use your messages to improve its products." },
  { id: "openrouter", name: "OpenRouter", kind: "openai", defaultBase: "https://openrouter.ai/api/v1", prefix: "", needsKey: true, envKeys: ["OPENROUTER_API_KEY"], keyUrl: "https://openrouter.ai/settings/keys", streamUsage: "ask", note: "One key for models from many makers. Models whose name ends in :free cost nothing." },
  { id: "deepseek", name: "DeepSeek", kind: "openai", defaultBase: "https://api.deepseek.com", host: "deepseek", prefix: "deepseek/", needsKey: true, envKeys: ["DEEPSEEK_API_KEY"], keyUrl: "https://platform.deepseek.com/api_keys", streamUsage: "ask" },
  { id: "xai", name: "xAI", kind: "openai", defaultBase: "https://api.x.ai/v1", host: "xai", prefix: "xai/", needsKey: true, envKeys: ["XAI_API_KEY"], keyUrl: "https://console.x.ai", streamUsage: "ask" },
  { id: "mistral", name: "Mistral", kind: "openai", defaultBase: "https://api.mistral.ai/v1", host: "mistral", prefix: "mistral/", needsKey: true, envKeys: ["MISTRAL_API_KEY"], keyUrl: "https://console.mistral.ai/api-keys", streamUsage: "own" },
  { id: "ollama", name: "Ollama", kind: "openai", defaultBase: "http://127.0.0.1:11434/v1", prefix: "", needsKey: false, envKeys: [], keyUrl: "https://ollama.com/download", streamUsage: "ask", note: "Models on this computer. Free to run, and your messages never leave it." },
];

export const provider = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id);

// LEANFARE_<ID>_BASE changes a provider's address. Read on every call so a
// test can start a fake provider first and point Leanfare at it afterwards.
export function baseOf(id: ProviderId): string {
  const def = provider(id)!;
  return (process.env[`LEANFARE_${id.toUpperCase()}_BASE`] ?? def.defaultBase).replace(/\/+$/, "");
}
