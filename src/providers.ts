// Providers that are not built in, so any model can be used with no setup:
//
// 1. Model apps running on this computer that speak OpenAI's format (LM Studio, Jan,
//    llama.cpp, vLLM, LocalAI, KoboldCpp, GPT4All, Lemonade): found by asking each one's
//    usual address for its model list. Their models cost nothing.
// 2. Providers you add: a name and an address that speaks OpenAI's format (a key if it needs
//    one). Its models come from its own /models list.
// 3. models.dev (MIT, by SST): a public list of 200+ providers with their addresses, key
//    variable names and model prices. A provider you add is matched to it for prices, and a
//    key variable Leanfare does not know (NVIDIA_API_KEY, HF_TOKEN...) is matched to its
//    provider, so it can be offered with one click. Fetched only when needed, kept a day.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PROVIDERS, baseOf, provider, setExtraProviders, type ProviderDef, type ProviderId } from "./config";
import { setExtraModels, store, type Model } from "./data";
import { getKey } from "./keys";
import { saveSettings, settings } from "./settings";
import { now } from "./util";

// ---- model apps on this computer -------------------------------------------------------

export interface LocalApp { id: string; name: string; ports: number[]; url: string }
export const LOCAL_APPS: LocalApp[] = [
  { id: "lmstudio", name: "LM Studio", ports: [1234], url: "https://lmstudio.ai" },
  { id: "jan", name: "Jan", ports: [1337], url: "https://jan.ai" },
  { id: "llamacpp", name: "llama.cpp", ports: [9931, 8080], url: "https://github.com/ggml-org/llama.cpp" },
  { id: "vllm", name: "vLLM", ports: [8000], url: "https://docs.vllm.ai" },
  { id: "localai", name: "LocalAI", ports: [8080], url: "https://localai.io" },
  { id: "koboldcpp", name: "KoboldCpp", ports: [5001], url: "https://github.com/LostRuins/koboldcpp" },
  { id: "gpt4all", name: "GPT4All", ports: [4891], url: "https://www.nomic.ai/gpt4all" },
  { id: "lemonade", name: "Lemonade", ports: [13305], url: "https://lemonade-server.ai" },
];

export interface Found { app: LocalApp; port: number; base: string; models: string[] }
export const localState = { found: [] as Found[], at: null as string | null, looking: false };

// The ports to try: each app's usual one, or LEANFARE_LOCAL_PORTS for tests ("lmstudio=5555,jan=5556";
// "none" tries nothing).
function portsToTry(): { app: LocalApp; port: number }[] {
  const env = process.env.LEANFARE_LOCAL_PORTS;
  if (env === "none") return [];
  if (env) {
    return env.split(",").map((p) => p.split("=")).flatMap(([id, port]) => {
      const app = LOCAL_APPS.find((a) => a.id === id?.trim());
      return app && Number(port) > 0 ? [{ app, port: Number(port) }] : [];
    });
  }
  return LOCAL_APPS.flatMap((app) => app.ports.map((port) => ({ app, port })));
}

async function modelList(base: string, key: string | null, ms: number): Promise<{ ids: string[]; owners: string[]; server: string | null } | null> {
  try {
    const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const rows: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const ids = rows.map((r) => String(r?.id ?? r?.name ?? "")).filter(Boolean);
    return { ids, owners: rows.map((r) => String(r?.owned_by ?? "")), server: res.headers.get("server") };
  } catch { return null; }
}

// Look at every usual address at once (each gets under a second). Two apps share 8080
// (llama.cpp's old port and LocalAI's): llama.cpp says "owned_by": "llamacpp".
export async function refreshLocalServers(): Promise<Found[]> {
  localState.looking = true;
  const tries = portsToTry();
  const seen = new Map<number, Awaited<ReturnType<typeof modelList>>>();
  await Promise.all([...new Set(tries.map((t) => t.port))].map(async (port) => { seen.set(port, await modelList(`http://127.0.0.1:${port}/v1`, null, 900)); }));
  const found: Found[] = [];
  const used = new Set<number>();
  for (const { app, port } of tries) {
    const r = seen.get(port);
    if (!r || used.has(port) || found.some((f) => f.app.id === app.id)) continue;
    if (port === 8080 && app.id === "llamacpp" && !r.owners.includes("llamacpp")) continue;
    if (port === 8080 && app.id === "localai" && r.owners.includes("llamacpp")) continue;
    used.add(port);
    found.push({ app, port, base: `http://127.0.0.1:${port}/v1`, models: r.ids });
  }
  localState.found = found;
  localState.at = now().toISOString();
  localState.looking = false;
  const defs: ProviderDef[] = found.map((f) => ({
    id: f.app.id, name: f.app.name, kind: "openai", defaultBase: f.base, prefix: "", needsKey: false, envKeys: [],
    keyUrl: f.app.url, streamUsage: "own", local: true, note: `Running on this computer at ${f.base.replace(/\/v1$/, "")}. Free, and your messages never leave this computer.`,
  }));
  setExtraProviders(defs, "local");
  setExtraModels(found.flatMap((f) => f.models.map((id) => localModel(f.app.id, id))), new Set(LOCAL_APPS.map((a) => a.id)));
  return found;
}

function localModel(pid: string, apiId: string): Model {
  return {
    id: `${pid}/${apiId}`, provider: pid, apiId, source: pid, maker: "local", name: apiId,
    label: apiId.replace(/\.gguf$/i, "").replace(/:latest$/, ""),
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null, skills: [], added: null, retire: null, ratings: {}, local: true,
  };
}

// ---- providers you add -----------------------------------------------------------------

export interface CustomProvider { id: string; name: string; base: string; needsKey: boolean; keyUrl?: string; registry?: string }
export const customState = new Map<string, { at: string; error: string | null; models: number }>();

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "provider";

function customDef(c: CustomProvider): ProviderDef {
  return {
    id: c.id, name: c.name, kind: "openai", defaultBase: c.base, prefix: "", needsKey: c.needsKey, envKeys: [],
    keyUrl: c.keyUrl ?? c.base, streamUsage: "own", custom: true, note: `Added by you: ${c.base}.`,
  };
}

// The providers you added become providers at start (before keys are read).
export function loadCustomProviders() {
  setExtraProviders((settings().custom ?? []).map(customDef), "custom");
}

// Checks an address before it is added: it must answer /models in OpenAI's shape.
export function checkCustomInput(b: any): { name: string; base: string; key: string | null; registry: string | null } | string {
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 40) : "";
  const base = typeof b?.base === "string" ? b.base.trim().replace(/\/+$/, "") : "";
  const key = typeof b?.key === "string" && b.key.trim() ? b.key.trim() : null;
  if (!name) return "Give the provider a name.";
  let u: URL;
  try { u = new URL(base); } catch { return "The address must start with https:// (or http:// for one on this computer or your network)."; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "The address must start with https:// (or http:// for one on this computer or your network).";
  if (u.username || u.password) return "Leave any name or password out of the address; put the key in the key box.";
  if (u.search || u.hash) return "The address should end at its path (most end in /v1), with nothing after a ? or #.";
  if (u.protocol === "http:" && !onThisNetwork(u.hostname)) return "Use https:// for an address on the internet, so your key is not sent in the clear.";
  if (key && (key.length < 8 || /\s/.test(key))) return "That does not look like a key: it should be one word with no spaces.";
  if (PROVIDERS.some((p) => p.name.toLowerCase() === name.toLowerCase())) return `${name} is built in: add its key in its own card.`;
  return { name, base, key, registry: typeof b?.registry === "string" ? b.registry : null };
}

// This computer or your own network, by the exact host name: http:// is allowed only there.
export function onThisNetwork(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)?.slice(1).map(Number);
  if (!ip || ip.some((n) => n > 255)) return false;
  return ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31);
}

// The provider you already added for a models.dev entry (by its id, or the same address), if any.
export function customFor(registryId: string | null, base: string): CustomProvider | null {
  const b = base.replace(/\/+$/, "");
  return (settings().custom ?? []).find((c) => (registryId && c.registry === registryId) || c.base.replace(/\/+$/, "") === b) ?? null;
}

export async function addCustomProvider(input: { name: string; base: string; key: string | null; registry: string | null }): Promise<{ ok: true; id: string; models: number } | { ok: false; message: string }> {
  let list = await modelList(input.base, input.key, 15_000);
  // A provider from models.dev's list whose address gives no model list in OpenAI's shape (Cloudflare Workers AI): its
  // models come from that list (0.13).
  if (!list && input.registry) { try { const ids = Object.keys((await registry())?.providers[input.registry]?.models ?? {}); if (ids.length) list = { ids } as any; } catch {} }
  if (!list) return { ok: false, message: `${input.base}/models did not answer with a model list in OpenAI's format. Check the address (most end in /v1) and the key.` };
  if (!list.ids.length) return { ok: false, message: `${input.name} answered, but its model list is empty.` };
  const all = settings().custom ?? [];
  let id = `custom-${slug(input.name)}`;
  for (let i = 2; all.some((c) => c.id === id) || PROVIDERS.some((p) => p.id === id); i++) id = `custom-${slug(input.name)}-${i}`;
  const c: CustomProvider = { id, name: input.name, base: input.base, needsKey: !!input.key, ...(input.registry ? { registry: input.registry } : {}) };
  saveSettings({ custom: [...all, c] });
  loadCustomProviders();
  await applyCustomModels(c, list.ids);
  return { ok: true, id, models: list.ids.length };
}

export function removeCustomProvider(id: string): boolean {
  const all = settings().custom ?? [];
  if (!all.some((c) => c.id === id)) return false;
  const s = settings();
  saveSettings({ custom: all.filter((c) => c.id !== id), ticked: s.ticked.filter((m) => !m.startsWith(`${id}/`)) });
  loadCustomProviders();
  setExtraModels([], new Set([id]));
  customState.delete(id);
  return true;
}

export async function refreshCustom(): Promise<void> {
  for (const c of settings().custom ?? []) {
    const list = await modelList(baseOf(c.id), getKey(c.id), 15_000);
    if (!list) { customState.set(c.id, { at: now().toISOString(), error: "did not answer with a model list", models: 0 }); continue; }
    await applyCustomModels(c, list.ids);
  }
}

async function applyCustomModels(c: CustomProvider, ids: string[]) {
  const reg = await registry().catch(() => null);
  const models = ids.map((apiId) => customModel(c, apiId, reg));
  setExtraModels(models, new Set([c.id]));
  customState.set(c.id, { at: now().toISOString(), error: null, models: models.length });
}

function customModel(c: CustomProvider, apiId: string, reg: Registry | null): Model {
  const p = reg ? priceFor(reg, c, apiId) : null;
  return {
    id: `${c.id}/${apiId}`, provider: c.id, apiId, source: p ? `models.dev ${p.from}` : c.id, maker: "", name: apiId, label: apiId,
    input: p?.input ?? null, output: p?.output ?? null, cacheRead: p?.cacheRead ?? null, cacheWrite: p?.cacheWrite ?? null,
    context: p?.context ?? null, skills: [], added: null, retire: null, ratings: {},
  };
}

// ---- models.dev ------------------------------------------------------------------------

interface RegModel { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; context: number | null }
interface RegProvider { name: string; env: string[]; api: string | null; doc: string | null; models: Record<string, RegModel> }
export interface Registry { at: string; providers: Record<string, RegProvider> }

const REG_FILE = () => join(DATA_DIR, "models-dev.json");
const REG_URL = () => process.env.LEANFARE_MODELSDEV_URL ?? "https://models.dev/api.json";
let reg: Registry | null = null;
let regLoading: Promise<Registry | null> | null = null;
export const forgetRegistry = () => { reg = null; regLoading = null; };

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// Only what Leanfare uses is kept: about a tenth of the 6 MB file.
export function trimRegistry(raw: any): Registry {
  const providers: Record<string, RegProvider> = {};
  for (const [id, p] of Object.entries<any>(raw ?? {})) {
    if (!p || typeof p !== "object") continue;
    const api = typeof p.api === "string" && !p.api.includes("${") ? p.api.replace(/\/+$/, "") : null;
    const models: Record<string, RegModel> = {};
    for (const [mid, m] of Object.entries<any>(p.models ?? {})) {
      models[mid] = { input: n(m?.cost?.input), output: n(m?.cost?.output), cacheRead: n(m?.cost?.cache_read), cacheWrite: n(m?.cost?.cache_write), context: n(m?.limit?.context) };
    }
    providers[id] = { name: String(p.name ?? id), env: Array.isArray(p.env) ? p.env.filter((e: unknown) => typeof e === "string") : [], api, doc: typeof p.doc === "string" ? p.doc : null, models };
  }
  return { at: now().toISOString(), providers };
}

export async function registry(refresh = false): Promise<Registry | null> {
  if (reg && !refresh && Date.now() - Date.parse(reg.at) < 86_400_000) return reg;
  if (!reg && existsSync(REG_FILE())) {
    try { reg = JSON.parse(readFileSync(REG_FILE(), "utf8")); if (!refresh && reg && Date.now() - Date.parse(reg.at) < 86_400_000) return reg; } catch { reg = null; }
  }
  regLoading ??= (async () => {
    try {
      const res = await fetch(REG_URL(), { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = trimRegistry(await res.json());
      if (!Object.keys(next.providers).length) throw new Error("the list was empty");
      const tmp = `${REG_FILE()}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, REG_FILE());
      reg = next;
    } catch { /* keep the copy we have, if any */ }
    return reg;
  })().finally(() => { regLoading = null; });
  return regLoading;
}

// A model's price for a provider you added: from the models.dev provider with the same address,
// then the one it was picked from, then any provider listing that exact model id.
export function priceFor(r: Registry, c: { base: string; registry?: string }, apiId: string): (RegModel & { from: string }) | null {
  const sameBase = Object.entries(r.providers).find(([, p]) => p.api && p.api === c.base.replace(/\/+$/, ""));
  const order = [sameBase?.[0], c.registry].filter(Boolean) as string[];
  for (const id of order) { const m = r.providers[id]?.models[apiId]; if (m && m.input !== null) return { ...m, from: id }; }
  for (const [id, p] of Object.entries(r.providers)) { const m = p.models[apiId]; if (m && m.input !== null) return { ...m, from: id }; }
  return null;
}

// The providers that speak OpenAI's format at a known address: offered when you add a provider.
export function registryChoices(r: Registry): { id: string; name: string; api: string; env: string[]; doc: string | null; models: number }[] {
  return Object.entries(r.providers)
    .filter(([id, p]) => p.api && /^https:\/\//.test(p.api) && !PROVIDERS.some((b) => b.id === id || b.name.toLowerCase() === p.name.toLowerCase()))
    .map(([id, p]) => ({ id, name: p.name, api: p.api!, env: p.env, doc: p.doc, models: Object.keys(p.models).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The models.dev provider whose key lives in this environment variable (NVIDIA_API_KEY -> nvidia).
// Only *_API_KEY names: general tokens (GITHUB_TOKEN, ..._ACCESS_TOKEN) are never guessed at. Plan
// endpoints (a coding plan, a token plan, Copilot, "Go") take a subscription's key, so they are
// skipped; and when several providers name the same variable, Leanfare does not guess.
const PLAN_ENDPOINT = /coding|plan|copilot|subscription|(^|[-\s])go$/i;
export function registryForEnv(r: Registry, name: string): { id: string; name: string; api: string } | null {
  if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(name)) return null;
  const hits = Object.entries(r.providers).filter(([id, p]) => p.env.includes(name) && !!p.api && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(p.api) && !PLAN_ENDPOINT.test(id) && !PLAN_ENDPOINT.test(p.name));
  return hits.length === 1 ? { id: hits[0][0], name: hits[0][1].name, api: hits[0][1].api! } : null;
}

// What the Settings screen shows about the apps found and the providers added.
export function extraView() {
  return {
    local: { at: localState.at, looking: localState.looking, found: localState.found.map((f) => ({ id: f.app.id, name: f.app.name, base: f.base, models: f.models.length })), apps: LOCAL_APPS.map((a) => ({ id: a.id, name: a.name, ports: a.ports, url: a.url })) },
    custom: (settings().custom ?? []).map((c) => ({ ...c, state: customState.get(c.id) ?? null, key: c.needsKey ? !!getKey(c.id) : null })),
  };
}
export const isLocalFound = (id: ProviderId) => localState.found.some((f) => f.app.id === id) || (id === "ollama" && store.ollamaFound);
export const knownProvider = (id: ProviderId) => !!provider(id);
