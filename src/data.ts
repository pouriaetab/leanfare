// The model catalogue: prices, retirement dates and quality ratings.
//
// Prices and retirement dates come from llmledger's daily data.json (built from
// LiteLLM's public price list, MIT); ratings from the Arena leaderboard
// (CC BY 4.0). A copy ships with every release so Leanfare works offline; a
// fresh one is fetched at start and once a day. OpenRouter's models come from
// OpenRouter's own public list, and Ollama's from the Ollama app on this
// computer, both read at run time.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { BUILT_IN_CATALOG, DATA_URL, PROVIDERS, baseOf, paths, type ProviderId } from "./config";
import { localDay, now } from "./util";

export interface Prices {
  input: number | null; // US dollars per 1M tokens
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null; // writes kept 5 minutes (Claude); the only kind elsewhere
  cacheWrite1h?: number | null; // Claude's writes kept an hour; when not listed, twice the input price
  above200k?: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } | null; // a request of more than 200k input tokens, when listed
}

export interface Model extends Prices {
  id: string; // "<provider>/<id the provider knows>"
  provider: ProviderId;
  apiId: string;
  source: string; // the catalogue row the price came from
  maker: string;
  name: string;
  label: string;
  context: number | null;
  skills: string[];
  effort?: string[]; // thinking effort levels the model takes, from llmledger ("low", "medium", "high"...)
  added: string | null;
  retire: string | null; // YYYY-MM-DD
  ratings: Record<string, number>; // task -> Arena rating
  ratingFrom?: string; // ratings borrowed from this older model until Arena rates this one
  top?: boolean; // on its provider's short list
  free?: boolean; // costs nothing (OpenRouter ":free" models)
  local?: boolean; // runs on this computer
}

export interface Catalog {
  schema: 1;
  built: string; // when llmledger built the data
  litellmCommit: string | null;
  ratingsDate: string | null;
  credits: Record<string, string>;
  tasks: [string, string][];
  models: Model[];
}

// The tasks Leanfare can guess and keeps ratings for.
export const TASKS: [string, string][] = [
  ["overall", "Everyday questions"],
  ["coding", "Coding"],
  ["math", "Math"],
  ["creative_writing", "Creative writing"],
  ["longer_query", "Long prompts"],
  ["multi_turn", "Long conversations"],
  ["business", "Business and finance"],
  ["legal", "Legal"],
  ["medicine", "Health and medicine"],
  ["instruction_following", "Detailed instructions"],
  ["hard_prompts", "Hard prompts"],
  ["expert", "Expert questions"],
];
const TASK_IDS = new Set(TASKS.map(([t]) => t));

const HOST_TO_PROVIDER: Record<string, ProviderId> = Object.fromEntries(
  PROVIDERS.filter((p) => p.host).map((p) => [p.host!, p.id]),
);

// OpenRouter names makers differently from the Arena list.
const MAKER_ALIASES: Record<string, string> = {
  "x-ai": "xai", mistralai: "mistral", "meta-llama": "meta", moonshotai: "moonshot", "z-ai": "zhipu", qwen: "alibaba",
};

const KEEP_RETIRED_DAYS = 90; // keep recently retired models so old answers and successors still resolve

// Listed as chat models but made for music, images, speech, search agents or
// computer control, not for a conversation.
const NOT_CHAT = /lyria|imagen|veo|tts|embed|image|audio|realtime|transcri|native-audio|live|robotics|computer-use|deep-research|guard|moderation|ocr|search/i;

export function prettyName(name: string): string {
  const words = name.split("-").map((w) => {
    if (/^gpt$/i.test(w)) return "GPT";
    if (/^deepseek$/i.test(w)) return "DeepSeek";
    if (/^(glm|it|vl|moe)$/i.test(w)) return w.toUpperCase();
    if (/^v\d/i.test(w)) return w.toUpperCase();
    if (/^a?\d+(\.\d+)?[bmk]$/i.test(w)) return w.toUpperCase(); // 31b -> 31B, a4b -> A4B
    if (/^\d/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return words.join(" ").replace(/^GPT (\d)/, "GPT-$1").replace(/^O(\d)/, "o$1");
}

const cleanLabel = (arenaName: string) => arenaName.replace(/\s*\([^)]*\)\s*$/, "").trim();

// A family is a model name without its version numbers and dates:
// claude-sonnet-4.6 and claude-sonnet-5.5 are both "claude-sonnet".
const VERSIONISH = /^(v?\d+([._]\d+)*[a-z]?|\d{4,}|latest|preview|exp|experimental)$/i;
export function family(name: string): string {
  return name.toLowerCase().split("-").filter((t) => t && !VERSIONISH.test(t)).join("-");
}

// A new model often has no Arena rating yet. Until it does, it borrows the
// ratings of the newest older model of its own family and says so.
export function inheritRatings(models: Model[]) {
  for (const m of models) {
    if (m.ratings.overall !== undefined || m.apiId.endsWith("-latest")) continue;
    const fam = family(m.name);
    const older = models
      .filter((o) => o !== m && o.provider === m.provider && o.maker === m.maker && o.ratings.overall !== undefined && !o.ratingFrom && family(o.name) === fam && (o.added ?? "") < (m.added ?? ""))
      .sort((a, b) => (b.added ?? "").localeCompare(a.added ?? ""));
    if (older[0]) { m.ratings = { ...older[0].ratings }; m.ratingFrom = older[0].label; }
  }
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

interface RatingIndex { byKey: Map<string, Record<string, number>>; labels: Map<string, string> }

function indexRatings(raw: any): RatingIndex {
  const byKey = new Map<string, Record<string, number>>();
  const labels = new Map<string, string>();
  const tasks = raw?.ratings?.tasks ?? {};
  for (const [task, rows] of Object.entries<any>(tasks)) {
    if (!TASK_IDS.has(task) || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const [key, arenaName, rating] = row;
      if (typeof key !== "string" || typeof rating !== "number") continue;
      const r = byKey.get(key) ?? {};
      r[task] = Math.max(r[task] ?? -Infinity, rating); // a model rated at several effort levels keeps its best
      byKey.set(key, r);
      if (task === "overall" || !labels.has(key)) labels.set(key, cleanLabel(String(arenaName)));
    }
  }
  return { byKey, labels };
}

// Typical price per 1M tokens, three parts input to one part output: the usual
// shape of a chat. Used only to rank models against each other.
export const typicalPrice = (m: Prices) => (m.input === null || m.output === null ? null : (3 * m.input + m.output) / 4);

export const isRetired = (m: Model, day: string) => !!m.retire && m.retire <= day;
export const retiresWithin = (m: Model, day: string, days: number) =>
  !!m.retire && m.retire > day && Date.parse(m.retire) - Date.parse(day) <= days * 86_400_000;

// A provider's short list: the models no other model of that provider beats on
// both price and rating (the cost/quality frontier), at most `cap` of them.
export function markTop(models: Model[], day: string, cap = 5) {
  const byProvider = new Map<string, Model[]>();
  for (const m of models) {
    m.top = false;
    if (m.ratings.overall === undefined || typicalPrice(m) === null || isRetired(m, day) || retiresWithin(m, day, 30)) continue;
    (byProvider.get(m.provider) ?? byProvider.set(m.provider, []).get(m.provider)!).push(m);
  }
  for (const list of byProvider.values()) {
    const beats = (o: Model, m: Model) => {
      const po = typicalPrice(o)!, pm = typicalPrice(m)!, ro = o.ratings.overall, rm = m.ratings.overall;
      if (po > pm || ro < rm) return false;
      if (po < pm || ro > rm) return true;
      return (o.added ?? "") > (m.added ?? ""); // a dead heat goes to the newer model
    };
    const front = list.filter((m) => !list.some((o) => o !== m && beats(o, m)));
    front.sort((a, b) => b.ratings.overall - a.ratings.overall);
    let keep = front;
    if (front.length > cap) {
      keep = [front[0]];
      for (let i = 1; i < cap - 1; i++) keep.push(front[Math.round((i * (front.length - 1)) / (cap - 1))]);
      keep.push(front[front.length - 1]);
    }
    for (const m of keep) m.top = true;
  }
}

// Turn llmledger's data.json into Leanfare's catalogue.
export function buildCatalog(raw: any, asOf = now()): Catalog {
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.models) || raw.models.length < 100) {
    throw new Error("the data file is not llmledger schema 1 with a model list");
  }
  const day = localDay(asOf);
  const oldest = localDay(new Date(asOf.getTime() - KEEP_RETIRED_DAYS * 86_400_000));
  const ratings = indexRatings(raw);
  const chosen = new Map<string, Model>();
  for (const r of raw.models) {
    const provider = HOST_TO_PROVIDER[r?.host];
    if (!provider || r.mode !== "chat" || typeof r.key !== "string" || typeof r.name !== "string") continue;
    const def = PROVIDERS.find((p) => p.id === provider)!;
    // Some models are listed twice, with and without the provider prefix; both
    // give the same id and the duplicate is dropped below.
    const apiId = def.prefix && r.key.startsWith(def.prefix) ? r.key.slice(def.prefix.length) : r.key;
    if (!apiId || apiId.includes(" ") || apiId.startsWith("ft:") || apiId.includes("/")) continue;
    if (NOT_CHAT.test(r.name)) continue;
    const input = num(r.input), output = num(r.output);
    if (input === null && output === null) continue;
    if (r.retire && r.retire < oldest) continue;
    const rkey = `${r.maker} / ${r.name}`;
    const latest = apiId.endsWith("-latest");
    let label = ratings.labels.get(rkey) ?? prettyName(r.name);
    if (!/preview/i.test(apiId)) label = label.replace(/\s+Preview\b/i, "");
    if (latest) label = `${prettyName(r.name)} (latest)`;
    const m: Model = {
      id: `${provider}/${apiId}`,
      provider,
      apiId,
      source: r.key,
      maker: String(r.maker ?? ""),
      name: r.name,
      label,
      input, output,
      cacheRead: num(r.cache_read),
      cacheWrite: num(r.cache_write),
      ...(num(r.cache_write_1h) !== null ? { cacheWrite1h: num(r.cache_write_1h) } : {}),
      ...(num(r.input_above_200k) !== null || num(r.output_above_200k) !== null
        ? { above200k: { input: num(r.input_above_200k), output: num(r.output_above_200k), cacheRead: num(r.cache_read_above_200k), cacheWrite: num(r.cache_write_above_200k) } }
        : {}),
      context: num(r.context),
      skills: Array.isArray(r.skills) ? r.skills.filter((s: unknown) => typeof s === "string") : [],
      ...(Array.isArray(r.effort) && r.effort.length ? { effort: r.effort.filter((s: unknown) => typeof s === "string") } : {}),
      added: r.added || null,
      retire: r.retire || null,
      ratings: latest ? {} : ratings.byKey.get(rkey) ?? {}, // a "-latest" alias moves; its name matches old ratings
    };
    // One entry per model and provider: prefer the shortest id (the alias, not a dated copy).
    const k = `${provider}|${latest ? apiId : r.name}`;
    const prev = chosen.get(k);
    if (!prev || apiId.length < prev.apiId.length || (apiId.length === prev.apiId.length && (m.added ?? "") > (prev.added ?? ""))) chosen.set(k, m);
  }
  const models = [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id));
  inheritRatings(models);
  markTop(models, day);
  return {
    schema: 1,
    built: String(raw.built ?? asOf.toISOString()),
    litellmCommit: raw.litellm?.commit ?? null,
    ratingsDate: raw.ratings?.date ?? null,
    credits: raw.credits ?? {},
    tasks: TASKS,
    models,
  };
}

// OpenRouter's public model list -> catalogue entries, matched to Arena
// ratings by maker and name.
// What an OpenRouter model takes, from its own listing.
function openRouterSkills(r: any): string[] {
  const ins: unknown[] = Array.isArray(r?.architecture?.input_modalities) ? r.architecture.input_modalities : [];
  const params: unknown[] = Array.isArray(r?.supported_parameters) ? r.supported_parameters : [];
  const skills: string[] = [];
  if (ins.includes("image")) skills.push("vision");
  if (ins.includes("file")) skills.push("pdf");
  if (params.includes("tools")) skills.push("tools");
  if (params.includes("reasoning") || params.includes("include_reasoning")) skills.push("reasoning");
  return skills;
}

export function buildOpenRouter(list: any, ratingsFrom: Catalog, asOf = now()): Model[] {
  const day = localDay(asOf);
  const byName = new Map<string, Record<string, number>>();
  const labels = new Map<string, string>();
  for (const m of ratingsFrom.models) {
    if (Object.keys(m.ratings).length && !byName.has(`${m.maker} / ${m.name}`)) {
      byName.set(`${m.maker} / ${m.name}`, m.ratings);
      labels.set(`${m.maker} / ${m.name}`, m.label);
    }
  }
  const out: Model[] = [];
  for (const r of Array.isArray(list?.data) ? list.data : []) {
    const id = r?.id;
    if (typeof id !== "string" || id.startsWith("~") || id.startsWith("openrouter/") || /:(batch|extended|nitro|floor|online|thinking)$/.test(id) || id.includes("[")) continue;
    const outs: string[] = r.architecture?.output_modalities ?? ["text"];
    if (!outs.includes("text")) continue;
    const [makerRaw, rest] = id.split("/", 2);
    if (!rest) continue;
    const name = rest.split(":")[0];
    const maker = MAKER_ALIASES[makerRaw] ?? makerRaw;
    const p = r.pricing ?? {};
    const perM = (v: unknown) => (v === undefined || v === null || v === "" || Number(v) < 0 || !Number.isFinite(Number(v)) ? null : Number(v) * 1e6);
    const free = id.endsWith(":free");
    const rkey = `${maker} / ${name}`;
    const exp = typeof r.expiration_date === "string" ? r.expiration_date.slice(0, 10) : null;
    out.push({
      id: `openrouter/${id}`,
      provider: "openrouter",
      apiId: id,
      source: "openrouter",
      maker,
      name,
      label: (labels.get(rkey) ?? String(r.name ?? name).replace(/^[^:]+:\s*/, "")) + (free ? " (free)" : ""),
      input: free ? 0 : perM(p.prompt),
      output: free ? 0 : perM(p.completion),
      cacheRead: free ? 0 : perM(p.input_cache_read),
      cacheWrite: free ? 0 : perM(p.input_cache_write),
      context: typeof r.context_length === "number" ? r.context_length : null,
      skills: openRouterSkills(r),
      ...(openRouterSkills(r).includes("reasoning") ? { effort: ["low", "medium", "high"] } : {}), // OpenRouter maps these for every thinking model
      added: typeof r.created === "number" ? new Date(r.created * 1000).toISOString().slice(0, 10) : null,
      retire: exp,
      ratings: byName.get(rkey) ?? {},
      free,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  inheritRatings(out);
  markTop(out, day, 8);
  return out;
}

export function ollamaModels(tags: any): Model[] {
  const list = Array.isArray(tags?.models) ? tags.models : [];
  return list
    .filter((t: any) => typeof t?.name === "string")
    .map((t: any): Model => ({
      id: `ollama/${t.name}`,
      provider: "ollama",
      apiId: t.name,
      source: "ollama",
      maker: "local",
      name: t.name,
      label: t.name.replace(/:latest$/, ""),
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      context: null,
      skills: [],
      added: typeof t.modified_at === "string" ? t.modified_at.slice(0, 10) : null,
      retire: null,
      ratings: {},
      local: true,
    }));
}

// ---- what is loaded right now -------------------------------------------------

export interface SourceStatus {
  state: "ok" | "failed" | "never";
  at: string | null; // last attempt
  error: string | null;
  tried: string | null; // the address tried, for the screen
}

export const store = {
  catalog: null as unknown as Catalog,
  catalogFrom: "built-in" as "built-in" | "downloaded",
  openrouter: [] as Model[],
  ollama: [] as Model[],
  ollamaFound: false,
  status: {
    data: { state: "never", at: null, error: null, tried: null } as SourceStatus,
    openrouter: { state: "never", at: null, error: null, tried: null } as SourceStatus,
    ollama: { state: "never", at: null, error: null, tried: null } as SourceStatus,
  },
  index: new Map<string, Model>(),
};

function reindex() {
  store.index = new Map();
  for (const m of [...store.catalog.models, ...store.openrouter, ...store.ollama]) store.index.set(m.id, m);
}
export const allModels = (): Model[] => [...store.index.values()];
export const getModel = (id: string) => store.index.get(id);

function readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function writeAtomic(path: string, data: unknown) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

// The newer of the built-in copy and the last downloaded one.
export function loadCatalog(builtInPath = BUILT_IN_CATALOG) {
  const builtIn = readJson(builtInPath) as Catalog | null;
  const saved = existsSync(paths.catalog) ? (readJson(paths.catalog) as Catalog | null) : null;
  const ok = (c: Catalog | null) => !!c && c.schema === 1 && Array.isArray(c.models) && c.models.length > 0;
  if (ok(saved) && (!ok(builtIn) || saved!.built > builtIn!.built)) { store.catalog = saved!; store.catalogFrom = "downloaded"; }
  else if (ok(builtIn)) { store.catalog = builtIn!; store.catalogFrom = "built-in"; }
  else throw new Error(`no model catalogue found at ${builtInPath}`);
  markTop(store.catalog.models, localDay()); // the short list moves as models near retirement
  const or = readJson(paths.openrouter);
  if (or) { try { store.openrouter = buildOpenRouter(or, store.catalog); } catch {} }
  reindex();
}

async function getJson(url: string, timeoutMs: number, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function refreshCatalog(signal?: AbortSignal): Promise<SourceStatus> {
  const st = store.status.data;
  st.at = now().toISOString();
  st.tried = DATA_URL;
  try {
    const raw = await getJson(DATA_URL, 30_000, { signal });
    const cat = buildCatalog(raw);
    if (!store.catalog || cat.built >= store.catalog.built) {
      writeAtomic(paths.catalog, cat);
      store.catalog = cat;
      store.catalogFrom = "downloaded";
      if (store.openrouter.length) {
        const or = readJson(paths.openrouter);
        if (or) store.openrouter = buildOpenRouter(or, cat);
      }
      reindex();
    }
    Object.assign(st, { state: "ok", error: null });
  } catch (e: any) {
    Object.assign(st, { state: "failed", error: e?.name === "TimeoutError" ? "no answer within 30 seconds" : String(e?.message ?? e) });
  }
  return st;
}

export async function refreshOpenRouter(signal?: AbortSignal): Promise<SourceStatus> {
  const st = store.status.openrouter;
  const url = `${baseOf("openrouter")}/models`;
  st.at = now().toISOString();
  st.tried = url;
  try {
    const list = await getJson(url, 30_000, { signal });
    const models = buildOpenRouter(list, store.catalog);
    if (!models.length) throw new Error("the list was empty");
    writeAtomic(paths.openrouter, list);
    store.openrouter = models;
    reindex();
    Object.assign(st, { state: "ok", error: null });
  } catch (e: any) {
    Object.assign(st, { state: "failed", error: e?.name === "TimeoutError" ? "no answer within 30 seconds" : String(e?.message ?? e) });
  }
  return st;
}

export async function refreshOllama(signal?: AbortSignal): Promise<SourceStatus> {
  const st = store.status.ollama;
  const url = `${baseOf("ollama").replace(/\/v1$/, "")}/api/tags`;
  st.at = now().toISOString();
  st.tried = url;
  try {
    const tags = await getJson(url, 3_000, { signal });
    store.ollama = ollamaModels(tags);
    store.ollamaFound = true;
    Object.assign(st, { state: "ok", error: null });
  } catch (e: any) {
    store.ollama = [];
    store.ollamaFound = false;
    Object.assign(st, { state: "failed", error: e?.name === "TimeoutError" ? "no answer within 3 seconds" : "not running" });
  }
  reindex();
  return st;
}
