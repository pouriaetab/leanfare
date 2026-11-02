// Free models, ready to connect (0.13). A list Leanfare ships and keeps up to date with each release: the providers whose
// free plans it has read the terms of, what each gives for free, what it may do with what you send, where its key is
// made, and which of its models are ticked once it is connected. Connecting one takes its key (or, for OpenRouter, a
// sign in), marks its key as a free plan, and ticks its free models, so the share planner can spread work over them.
// Making the account is the person's part, on the provider's own page.
//
// Providers models.dev lists with free models that are not on this list are shown apart, as found but not reviewed:
// Leanfare adds one only when the person asks for it by name.
import { PROVIDERS, provider, type ProviderId } from "./config";
import { allModels } from "./data";
import { getKey } from "./keys";
import { registry, type Registry } from "./providers";
import { saveSettings, settings } from "./settings";

export interface FreeEntry {
  id: string; name: string; free: string; data: string; keyUrl: string;
  how: "key" | "signin" | "account"; // a key; a sign in (OpenRouter); a key and an account ID (Cloudflare)
  tick: RegExp | null; // its free models, ticked once connected
  registry?: string; // for one added through models.dev's list (Cloudflare)
}
// As read on 31 Oct 2026.
export const FREE_LIST: FreeEntry[] = [
  { id: "google", name: "Google Gemini", free: "Gemini Flash (about 20 a day) and Flash-Lite (about 500 a day)", data: "Google may use what you send on the free plan to improve its products", keyUrl: "https://aistudio.google.com/apikey", how: "key", tick: /gemini-3(\.\d+)?-flash(-lite)?$|gemma-4/i },
  { id: "groq", name: "Groq", free: "gpt-oss-120b and more, 1,000 requests a day each, very fast", data: "Groq does not train on what you send", keyUrl: "https://console.groq.com/keys", how: "key", tick: /gpt-oss-(120b|20b)|qwen3/i },
  { id: "openrouter", name: "OpenRouter", free: "about 20 free models, 50 requests a day in all (1,000 after a one-time $10)", data: "training is off unless you turn it on in OpenRouter", keyUrl: "https://openrouter.ai/settings/keys", how: "signin", tick: /:free$/i },
  { id: "mistral", name: "Mistral", free: "its free plan, with limits Mistral does not publish", data: "Mistral may train on what you send on the free plan (you can opt out)", keyUrl: "https://console.mistral.ai/api-keys", how: "key", tick: null },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", free: "about 10,000 units a day of open models", data: "Cloudflare does not train on what you send", keyUrl: "https://dash.cloudflare.com/profile/api-tokens", how: "account", tick: null, registry: "cloudflare-workers-ai" },
];

// Connected: its key is in Leanfare (a built in provider), or it was added (Cloudflare, through models.dev's list).
export function freeConnected(e: FreeEntry): boolean {
  if (e.registry) return (settings().custom ?? []).some((c) => c.registry === e.registry && (!c.needsKey || !!getKey(c.id as ProviderId)));
  return !!provider(e.id as ProviderId) && !!getKey(e.id as ProviderId);
}

// After a key is saved for a built in provider of the list: its key is marked as a free plan where Leanfare knows that
// plan's terms, and its free models are ticked.
export function afterFreeKey(id: string): string[] {
  const e = FREE_LIST.find((x) => x.id === id);
  if (!e) return [];
  const s = settings();
  saveSettings({ providers: { ...s.providers, [id]: { ...(s.providers[id] ?? {}), on: true, ...(["google", "groq", "mistral"].includes(id) ? { free: true } : {}) } } });
  const add = e.tick ? allModels().filter((m) => m.provider === id && e.tick!.test(m.apiId ?? m.id) && !m.retire).map((m) => m.id) : [];
  const ticked = settings().ticked;
  const fresh = add.filter((m) => !ticked.includes(m));
  if (fresh.length) saveSettings({ ticked: [...ticked, ...fresh] });
  return fresh;
}

// Providers models.dev lists with free models (input and output at $0) that speak OpenAI's format, are not built in or on
// this list, and are not a subscription's own endpoint (a coding or token plan): found, not reviewed.
const PLAN_ENDPOINT = /coding|token-plan|plan$|copilot|subscription|(^|[-\s])go$/i;
export function foundFree(r: Registry | null, max = 6): { id: string; name: string; free: number; doc: string | null }[] {
  if (!r) return [];
  const known = new Set([...PROVIDERS.map((p) => p.id), ...FREE_LIST.map((e) => e.registry ?? e.id), ...(settings().custom ?? []).map((c) => c.registry ?? "")]);
  return Object.entries(r.providers)
    .filter(([id, p]) => !!p.api && /^https:\/\//.test(p.api) && !known.has(id) && !PLAN_ENDPOINT.test(id) && !PLAN_ENDPOINT.test(p.name))
    .map(([id, p]) => ({ id, name: p.name, free: Object.values(p.models).filter((m) => m.input === 0 && m.output === 0).length, doc: p.doc }))
    .filter((x) => x.free > 0)
    .sort((a, b) => b.free - a.free || a.name.localeCompare(b.name))
    .slice(0, max);
}

export async function freeView() {
  let r: Registry | null = null;
  try { r = await registry(); } catch {}
  return {
    list: FREE_LIST.map((e) => ({ id: e.id, name: e.name, free: e.free, data: e.data, keyUrl: e.keyUrl, how: e.how, connected: freeConnected(e) })),
    found: foundFree(r),
  };
}
