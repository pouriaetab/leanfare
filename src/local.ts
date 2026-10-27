// Local models: what Ollama (the free app that runs open models on this
// computer) has installed and loaded, removing one, and downloading one with
// progress.
//
// Leanfare only asks Ollama; Ollama does the work. A download is one job kept in
// memory here (so it goes on if the page is closed and the page can pick it up
// again), and it stops when you press Stop. Ollama keeps what it already
// downloaded, so pressing Download again continues where it stopped.
import { existsSync, statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { baseOf } from "./config";
import { LOCAL_PENALTY, allModels, refreshOllama, store, twinOf } from "./data";
import { saveSettings, settings } from "./settings";
import { UserError } from "./upstream";
import { providerMessage } from "./util";

export const INSTALL_URL = "https://ollama.com/download";
// The disk keeps this much free after a download: a full disk breaks far more than Leanfare.
export const MIN_FREE = 10e9;

// What this computer has. `probe` is what the code asks; a test swaps it for fixed numbers
// and checks `realProbe` on its own.
export const realProbe = {
  free(path: string): number | null {
    try {
      let p = path;
      while (!existsSync(p) && dirname(p) !== p) p = dirname(p); // the models folder may not exist yet
      const s = statfsSync(p);
      return s.bavail * s.bsize;
    } catch { return null; }
  },
  memory: (): number => totalmem(),
};
export const probe = { ...realProbe };

const host = () => baseOf("ollama").replace(/\/v1$/, "");
// Where Ollama keeps its files. Only meaningful when Ollama runs on this computer.
export const modelsDir = () => process.env.OLLAMA_MODELS || join(homedir(), ".ollama", "models");
const onThisComputer = () => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|\/|$)/.test(host());

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0)} GB`;

// ---- will it run here ---------------------------------------------------------------------
// A model needs its file in memory plus room for the conversation (about a fifth more). Apple
// chips let a model use about 70% of the memory. Up to half the memory is comfortable ("fits",
// other apps keep working); up to 70% is "tight"; past that it is "too big".
export type Fit = "fits" | "tight" | "too big";
export function fit(sizeBytes: number, memoryBytes: number): Fit {
  const need = sizeBytes * 1.2;
  if (need <= memoryBytes * 0.5) return "fits";
  if (need <= memoryBytes * 0.7) return "tight";
  return "too big";
}

// ---- what Ollama has ------------------------------------------------------------------------

async function ask(path: string, init: RequestInit = {}, timeoutMs = 3_000): Promise<Response> {
  return fetch(`${host()}${path}`, { ...init, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]) });
}

export interface Installed { name: string; size: number; params: string | null; quant: string | null; family: string | null; modified: string | null; loaded: boolean; fit: Fit }

// ---- the model to suggest for this computer ---------------------------------------------------------
// Open models anyone may use for work (Apache 2.0), in the sizes Ollama serves (download sizes, rounded
// up). Leanfare suggests the best rated one that runs comfortably here, has room on the disk and is
// better than what is installed, and downloads it only on a yes. A model Leanfare cannot rate yet (no
// twin in the catalogue) is not suggested: Auto would not pick it. One that only runs tightly is
// suggested when none runs comfortably, and says so.
// source: the maker's own copy on Hugging Face, whose licence scripts/licences.ts checks before a release.
export const SUGGESTED: { name: string; size: number; source: string }[] = [
  { name: "gemma4:e2b-it-qat", size: 4.3e9, source: "google/gemma-4-E2B-it" },
  { name: "gemma4:e4b-it-qat", size: 6.1e9, source: "google/gemma-4-E4B-it" },
  { name: "gemma4:12b-it-qat", size: 7.2e9, source: "google/gemma-4-12B-it" },
  { name: "gpt-oss:20b", size: 14e9, source: "openai/gpt-oss-20b" },
  { name: "gemma4:26b-a4b-it-qat", size: 16e9, source: "google/gemma-4-26B-A4B-it" },
  { name: "qwen3.8:27b", size: 18e9, source: "Qwen/Qwen3.8-27B" },
  { name: "gemma4:31b-it-qat", size: 19e9, source: "google/gemma-4-31B-it" },
  { name: "gpt-oss:120b", size: 65e9, source: "openai/gpt-oss-120b" },
];
export interface Suggestion { name: string; size: number; fit: Fit; rating: number; like: string; license: "Apache-2.0" }
export function suggestLocal(): { suggestion: Suggestion | null; why: string } {
  if (!onThisComputer()) return { suggestion: null, why: "Ollama runs on another computer, so Leanfare cannot tell what fits there." };
  const mem = probe.memory();
  const free = probe.free(modelsDir());
  const catalogue = allModels().filter((m) => !m.local);
  const have = store.ollama;
  const haveBest = have.reduce<{ rating: number; label: string } | null>((b, m) => (m.ratings.overall !== undefined && (!b || m.ratings.overall > b.rating) ? { rating: m.ratings.overall, label: m.label } : b), null);
  const haveTwins = new Set(have.map((m) => twinOf(m.apiId, catalogue)?.id).filter(Boolean));
  const rated = SUGGESTED.map((c) => ({ c, twin: twinOf(c.name, catalogue) })).filter((x) => x.twin);
  if (!rated.length) return { suggestion: null, why: "Leanfare has no rating yet for the open models on its list, so it suggests none." };
  const runs = rated.map((x) => ({ ...x, fit: fit(x.c.size, mem), rating: x.twin!.ratings.overall! - LOCAL_PENALTY })).filter((x) => x.fit !== "too big");
  if (!runs.length) return { suggestion: null, why: `None of the rated open models on Leanfare's list runs in ${gb(mem)} of memory.` };
  const roomy = runs.filter((x) => free === null || free - x.c.size >= MIN_FREE);
  if (!roomy.length) return { suggestion: null, why: `The disk has ${gb(free ?? 0)} free; the models that run here need more, and Leanfare keeps ${gb(MIN_FREE)} free.` };
  const fresh = roomy.filter((x) => !haveTwins.has(x.twin!.id) && (!haveBest || x.rating > haveBest.rating));
  if (!fresh.length) return { suggestion: null, why: `${haveBest?.label ?? "What you have"} is already as good as what runs here.` };
  const comfy = fresh.filter((x) => x.fit === "fits");
  const top = (comfy.length ? comfy : fresh).sort((a, b) => b.rating - a.rating || a.c.size - b.c.size)[0];
  const how = top.fit === "fits" ? `runs comfortably in this computer's ${gb(mem)} of memory` : `runs in this computer's ${gb(mem)} of memory, but tightly: other apps may slow down while it answers`;
  return {
    suggestion: { name: top.c.name, size: top.c.size, fit: top.fit, rating: Math.round(top.rating), like: top.twin!.label, license: "Apache-2.0" },
    why: `${top.c.name} (${gb(top.c.size)}) ${how}, and is rated like ${top.twin!.label}. It runs free, on this computer, and Leanfare's Auto and plans can use it for reading and drafting. Apache 2.0: free to use for work.`,
  };
}

export async function overview() {
  const memory = probe.memory();
  const here = onThisComputer();
  const free = here ? probe.free(modelsDir()) : null;
  const base = { tried: `${host()}/api/tags`, installUrl: INSTALL_URL, memory: { total: memory, usable: Math.round(memory * 0.7) }, disk: { free, minFree: MIN_FREE, known: free !== null }, remote: !here, pull: pullView(), suggest: suggestLocal() };
  try {
    const tags = await (await ask("/api/tags")).json() as any;
    let ps: any = { models: [] };
    try { ps = await (await ask("/api/ps")).json(); } catch {}
    const loaded = new Set<string>((ps?.models ?? []).map((m: any) => String(m?.name ?? m?.model)));
    const installed: Installed[] = (Array.isArray(tags?.models) ? tags.models : [])
      .filter((t: any) => typeof t?.name === "string")
      .map((t: any): Installed => {
        const size = Number.isFinite(Number(t.size)) ? Number(t.size) : 0;
        return { name: t.name, size, params: t.details?.parameter_size ?? null, quant: t.details?.quantization_level ?? null, family: t.details?.family ?? null, modified: typeof t.modified_at === "string" ? t.modified_at : null, loaded: loaded.has(t.name), fit: fit(size, memory) };
      })
      .sort((a: Installed, b: Installed) => a.name.localeCompare(b.name));
    return { ...base, running: true, installed, total: installed.reduce((n, m) => n + m.size, 0) };
  } catch {
    return { ...base, running: false, installed: [] as Installed[], total: 0 };
  }
}

// ---- removing a model ---------------------------------------------------------------------------

export async function remove(name: string): Promise<{ name: string; freed: number }> {
  let tags: any;
  try { tags = await (await ask("/api/tags")).json(); } catch { throw new UserError(503, `Ollama is not running on this computer, so nothing was removed. Open the Ollama app and try again.`); }
  const have = (Array.isArray(tags?.models) ? tags.models : []).find((t: any) => t?.name === name);
  if (!have) throw new UserError(404, "Ollama does not have that model (any more).");
  let res: Response;
  try { res = await ask("/api/delete", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, name }) }, 15_000); }
  catch { throw new UserError(503, "Ollama did not answer, so nothing was removed. Try again."); }
  if (!res.ok) throw new UserError(502, `Ollama would not remove it: ${providerMessage(await res.text())}`);
  const id = `ollama/${name}`;
  await refreshOllama();
  const s = settings();
  if (s.ticked.includes(id) || s.usual === id) saveSettings({ ticked: s.ticked.filter((x) => x !== id), ...(s.usual === id ? { usual: null } : {}) });
  return { name, freed: Number(have.size) || 0 };
}

// ---- downloading a model ------------------------------------------------------------------------

// What can be typed: an Ollama name (gemma3:12b), a Hugging Face name Ollama reads
// (hf.co/user/repo:Q4_K_M), or the Hugging Face page's address, which becomes that name.
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  const page = /^https?:\/\/(?:www\.)?huggingface\.co\/([\w.-]+\/[\w.-]+)(?:\/.*)?$/i.exec(t);
  if (page) t = `hf.co/${page[1]}`;
  t = t.replace(/^ollama run\s+/i, "").replace(/^ollama pull\s+/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/.test(t)) return null;
  if (/\.\.|\/\/|^hf\.co\/?$/.test(t)) return null;
  if (/^hf\.co\//.test(t) && !/^hf\.co\/[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(t)) return null;
  return t;
}

type Step = "starting" | "downloading" | "finishing" | "done" | "failed" | "stopped";
interface Job {
  name: string; status: Step; step: string; layers: Map<string, { total: number; completed: number }>;
  size: number | null; fit: Fit | null; message: string | null; model: string | null; started: number; ended: number | null; ac: AbortController;
}
let job: Job | null = null;
const active = (j: Job | null): j is Job => !!j && (j.status === "starting" || j.status === "downloading" || j.status === "finishing");

const sum = (j: Job, key: "total" | "completed") => [...j.layers.values()].reduce((n, l) => n + l[key], 0);

export function pullView() {
  if (!job) return null;
  const total = sum(job, "total"), completed = Math.min(total, sum(job, "completed"));
  return {
    name: job.name, status: job.status, active: active(job), step: job.step, total, completed,
    percent: total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null,
    size: job.size, fit: job.fit, message: job.message, model: job.model,
  };
}

export function dismissPull() { if (job && !active(job)) job = null; }

export function stopPull() {
  if (!active(job)) return;
  job.status = "stopped";
  job.message = "Stopped. What was downloaded is kept; press Download to continue.";
  job.ended = Date.now();
  job.ac.abort();
}

// Is there room? `more` is what is still to come (bytes). null: yes (or not knowable).
function roomFor(more: number): string | null {
  if (!onThisComputer()) return null;
  const free = probe.free(modelsDir());
  if (free === null) return null;
  if (free - more >= MIN_FREE) return null;
  return `This needs about ${gb(more)} more, and the disk has ${gb(free)} free. Leanfare keeps ${gb(MIN_FREE)} free for the computer itself, so free up at least ${gb(MIN_FREE + more - free)} first.`;
}
function sizeProblem(name: string, size: number): string | null {
  const mem = probe.memory();
  if (fit(size, mem) !== "too big") return null;
  return `${name} is about ${gb(size)}, which is too big for this computer's memory (${gb(mem)}). Choose a smaller model or a lighter version (a smaller number of billions, or a name ending in :Q4_K_M).`;
}

export async function startPull(rawName: unknown, sizeBytes?: unknown): Promise<ReturnType<typeof pullView>> {
  const name = normalizeName(rawName);
  if (!name) throw new UserError(400, "That is not a model name. Use an Ollama name such as gemma3:12b, or a Hugging Face name such as hf.co/user/repo:Q4_K_M.");
  if (active(job)) throw new UserError(409, `${job.name} is still downloading. Stop it first, or wait until it is done.`);
  const known = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null;
  if (known) {
    const bad = sizeProblem(name, known) ?? roomFor(known);
    if (bad) throw new UserError(400, bad);
  }
  const up = await ask("/api/tags").then((r) => r.ok, () => false);
  if (!up) throw new UserError(503, `Ollama is not running on this computer. Open the Ollama app (${INSTALL_URL} if you do not have it), then press Download again.`);
  job = { name, status: "starting", step: "Looking it up…", layers: new Map(), size: known, fit: known ? fit(known, probe.memory()) : null, message: null, model: null, started: Date.now(), ended: null, ac: new AbortController() };
  void run(job);
  return pullView();
}

// Ollama's own error sentences, in plain words.
function explain(name: string, said: string): string {
  if (/file does not exist|not found|no such (manifest|model)|unknown model/i.test(said)) return `Ollama has no model called ${name}. Check the name (for Hugging Face: hf.co/user/repo:quantization).`;
  if (/unauthorized|forbidden|\b40[13]\b|gated|access to model/i.test(said)) return `${name} needs a sign in on Hugging Face (it is a gated model), which Leanfare cannot do. Choose another model.`;
  if (/no space left|disk full|not enough space/i.test(said)) return "The disk is full. Free some space, then press Download to continue.";
  if (/timeout|connection (refused|reset)|\bEOF\b|dial tcp|no such host|TLS|network/i.test(said)) return "The download was cut off (Ollama could not reach the download server). Check your internet connection, then press Download to continue where it stopped.";
  return `Ollama said: ${said.replace(/\s+/g, " ").trim().slice(0, 200) || "no details"}`;
}

function fail(j: Job, message: string) {
  if (!active(j)) return; // Stop already ended it
  j.status = "failed"; j.message = message; j.ended = Date.now();
  j.ac.abort();
}

async function run(j: Job) {
  let idle: ReturnType<typeof setTimeout> | undefined;
  let success = false; // Ollama's last line says "success" only when the model is complete
  const watch = () => { clearTimeout(idle); idle = setTimeout(() => fail(j, "Ollama stopped answering for 2 minutes. Check the Ollama app, then press Download to continue where it stopped."), 120_000); };
  try {
    watch();
    const res = await fetch(`${host()}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: j.name, name: j.name, stream: true }), signal: j.ac.signal });
    if (!res.ok) { fail(j, explain(j.name, providerMessage(await res.text()))); return; }
    const dec = new TextDecoder();
    let buf = "";
    const line = (l: string) => {
      if (!l.trim()) return;
      let o: any;
      try { o = JSON.parse(l); } catch { return; }
      if (typeof o.error === "string") { fail(j, explain(j.name, o.error)); return; }
      const status = String(o.status ?? "");
      if (status === "success") { success = true; return; }
      if (typeof o.digest === "string" && Number(o.total) > 0) {
        j.layers.set(o.digest, { total: Number(o.total), completed: Number(o.completed) || 0 });
        j.status = "downloading"; j.step = "Downloading";
        // The biggest piece is the model itself: now its size is known, check memory and disk.
        const biggest = Math.max(...[...j.layers.values()].map((l) => l.total));
        if (j.size === null || biggest > j.size) {
          j.size = biggest; j.fit = fit(biggest, probe.memory());
          const bad = sizeProblem(j.name, biggest) ?? roomFor(sum(j, "total") - sum(j, "completed"));
          if (bad) fail(j, bad);
        }
      } else if (/verifying/i.test(status)) { j.status = "finishing"; j.step = "Checking the download…"; }
      else if (/writing manifest|removing/i.test(status)) { j.status = "finishing"; j.step = "Finishing…"; }
      else if (/manifest/i.test(status) && !j.layers.size) j.step = "Looking it up…";
    };
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      watch();
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (!active(j)) return;
    }
    line(buf);
    if (!active(j)) return;
    // The stream ended: it is done only when Ollama said "success". A model that was already
    // installed (an update) is listed whether or not the new copy arrived, so the list alone proves nothing.
    if (!success) { fail(j, "The download stopped before it was finished (Ollama closed the connection). Press Download to continue where it stopped."); return; }
    const before = new Set(store.ollama.map((m) => m.apiId));
    await refreshOllama();
    const lower = j.name.toLowerCase();
    const fresh = store.ollama.filter((m) => !before.has(m.apiId));
    const made = store.ollama.find((m) => { const a = m.apiId.toLowerCase(); return a === lower || a === `${lower}:latest`; }) ?? (fresh.length === 1 ? fresh[0] : undefined);
    if (!made) { // complete, but not found under that name: say so rather than tick a guess
      j.status = "done"; j.step = "Done"; j.ended = Date.now();
      j.message = `Downloaded ${j.name}. Press Look again in the model list if it does not show yet.`;
      return;
    }
    for (const l of j.layers.values()) l.completed = l.total;
    j.model = made.id;
    const s = settings();
    if (!s.ticked.includes(made.id)) saveSettings({ ticked: [...s.ticked, made.id] }); // you asked for it, so it is ready to pick
    j.status = "done"; j.step = "Done"; j.ended = Date.now();
    const rated = made.ratings.overall !== undefined;
    j.message = `Downloaded ${made.label}${j.size ? ` (${gb(j.size)})` : ""}. It is ticked${rated ? `, and rated like ${made.ratingFrom?.split(",")[0] ?? "its twin"}, so Auto and plans can use it` : ". Leanfare has no rating for this name, so Auto does not pick it: choose it by name in the chat"}.`;
  } catch (e: any) {
    if (e?.name === "AbortError" || !active(j)) return;
    fail(j, "Leanfare lost touch with Ollama. Open the Ollama app, then press Download to continue where it stopped.");
  } finally { clearTimeout(idle); }
}
