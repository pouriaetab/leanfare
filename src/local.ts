// Local models: what Ollama (the free app that runs open models on this
// computer) has installed and loaded, removing one, and downloading one with
// progress.
//
// Leanfare only asks Ollama; Ollama does the work. A download is one job kept in
// memory here (so it goes on if the page is closed and the page can pick it up
// again), and it stops when you press Stop. Ollama keeps what it already
// downloaded, so pressing Download again continues where it stopped.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, statfsSync, symlinkSync } from "node:fs";
import { homedir, totalmem, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { baseOf } from "./config";
import { LOCAL_PENALTY, allModels, refreshOllama, store, twinOf, type Model } from "./data";
import { chargeOf, usableModels } from "./engine";
import { passed, testResults, type TestResult } from "./localpass";
import { rating } from "./router";
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
  // Where attached drives are: each folder inside one of these is a drive (on Windows, drive letters).
  roots(): string[] {
    if (process.platform === "darwin") return ["/Volumes"];
    if (process.platform !== "linux") return [];
    let u = "";
    try { u = userInfo().username; } catch {}
    return [...(u ? [`/media/${u}`, `/run/media/${u}`] : []), "/mnt"];
  },
};
export const probe = { ...realProbe };

const host = () => baseOf("ollama").replace(/\/v1$/, "");
// Where Ollama keeps its files. Only meaningful when Ollama runs on this computer.
// HOME first, as Ollama itself and your shell use it (Bun's homedir() does not follow a HOME set later, so a
// test's own home would not be used).
const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
export const modelsDir = () => process.env.OLLAMA_MODELS || join(home(), ".ollama", "models");
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

// ---- where the models are ----------------------------------------------------------------------------
// Ollama's models folder, followed through a link (a models folder moved to another drive is linked from
// ~/.ollama/models), the drive it is on, and that drive's free space. Ollama downloads into this folder, so
// a new model lands on that drive too, and the free space checked before a download is that drive's.
export interface Where { dir: string; real: string | null; drive: string | null; free: number | null; linked: boolean; missing: boolean }
// The drive a path is on: a folder in one of the drive roots (not this computer's own disk), or a drive letter.
export function driveOf(path: string): string | null {
  const win = /^([A-Za-z]):[\\/]/.exec(path);
  if (win) return win[1].toUpperCase() === (process.env.SystemDrive ?? "C:").charAt(0).toUpperCase() ? null : `${win[1].toUpperCase()}:`;
  for (const root of probe.roots()) {
    if (!path.startsWith(root + sep)) continue;
    const name = path.slice(root.length + 1).split(sep)[0];
    try { if (realpathSync(join(root, name)) === sep) return null; } catch {} // the Mac's own disk shows up in /Volumes too
    return name || null;
  }
  return null;
}
export function whereModels(): Where {
  const dir = modelsDir();
  let linked = false, real: string | null = null, missing = false;
  try { linked = lstatSync(dir).isSymbolicLink(); } catch {}
  try { real = realpathSync(dir); } catch {
    if (linked) { missing = true; try { real = resolve(dirname(dir), readlinkSync(dir)); } catch {} }
  }
  return { dir, real, drive: driveOf(real ?? dir), free: missing ? null : probe.free(real ?? dir), linked, missing };
}

// ---- models on a drive that Ollama does not use ---------------------------------------------------
// Ollama keeps a model as a manifest (manifests/<registry>/<namespace>/<model>/<tag>) and its pieces (blobs/).
// Leanfare looks for such folders on the attached drives, at most three folders deep, so models copied to a
// drive can be used where they are. Only when Ollama runs on this computer.
export interface Found { path: string; drive: string; models: number; size: number }
const SKIP = /^(\.(?!ollama$).*|\$RECYCLE\.BIN|System Volume Information|Backups\.backupdb|node_modules|Library|System|Applications|private|usr|bin|sbin|cores|dev)$/;
const isModelsFolder = (d: string) => { try { return statSync(join(d, "manifests")).isDirectory() && statSync(join(d, "blobs")).isDirectory(); } catch { return false; } };
function countManifests(d: string, depth = 0): number {
  if (depth > 5) return 0;
  let n = 0;
  try { for (const e of readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? countManifests(join(d, e.name), depth + 1) : e.isFile() && depth >= 3 ? 1 : 0; } catch {}
  return n;
}
function blobsSize(d: string): number {
  let n = 0;
  try { for (const e of readdirSync(join(d, "blobs"), { withFileTypes: true })) if (e.isFile()) { try { n += statSync(join(d, "blobs", e.name)).size; } catch {} } } catch {}
  return n;
}
export function foundElsewhere(): Found[] {
  if (!onThisComputer()) return [];
  const w = whereModels();
  const out: Found[] = [];
  let seen = 0;
  const walk = (d: string, depth: number, drive: string) => {
    if (seen++ > 3000) return; // a drive full of folders: stop looking, it is only a convenience
    if (isModelsFolder(d)) {
      let real = d;
      try { real = realpathSync(d); } catch {}
      if (real !== w.real && !out.some((f) => f.path === real)) { const models = countManifests(join(d, "manifests")); if (models) out.push({ path: real, drive, models, size: blobsSize(d) }); }
      return;
    }
    if (depth >= 3) return;
    let kids: string[] = [];
    try { kids = readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.test(e.name)).map((e) => e.name); } catch { return; }
    for (const k of kids) walk(join(d, k), depth + 1, drive);
  };
  for (const root of probe.roots()) {
    let drives: string[] = [];
    try { drives = readdirSync(root); } catch { continue; }
    for (const name of drives) {
      const top = join(root, name);
      try { if (realpathSync(top) === sep || !statSync(top).isDirectory()) continue; } catch { continue; }
      walk(top, 0, name);
    }
  }
  return out.sort((a, b) => b.models - a.models || a.path.localeCompare(b.path));
}

// Ollama's models folder becomes a link to one found on a drive, the way a folder moved to another drive is
// linked. What was there is kept under another name; Leanfare never deletes it. Not when Ollama has models
// of its own there (they would be hidden), and not on Windows, where a link needs more rights: there, setting
// OLLAMA_MODELS for Ollama does the same.
export async function useFolder(path: unknown): Promise<{ text: string; models: number }> {
  if (!onThisComputer()) throw new UserError(400, "Ollama runs on another computer, so Leanfare cannot change where it keeps its models.");
  if (typeof path !== "string" || !path) throw new UserError(400, "Say which folder to use.");
  const f = foundElsewhere().find((x) => x.path === path);
  if (!f) throw new UserError(404, "Leanfare does not find Ollama models in that folder (any more). Is the drive attached?");
  if (process.platform === "win32") throw new UserError(400, `On Windows, set OLLAMA_MODELS to ${f.path} in your environment variables, then quit Ollama and open it again.`);
  if (process.env.OLLAMA_MODELS) throw new UserError(409, `OLLAMA_MODELS says where Ollama keeps its models (${process.env.OLLAMA_MODELS}). Set it to ${f.path} instead, then quit Ollama and open it again.`);
  const w = whereModels();
  const own = w.missing ? 0 : countManifests(join(w.real ?? w.dir, "manifests"));
  if (own) throw new UserError(409, `Ollama has ${own} model${own === 1 ? "" : "s"} of its own in ${w.real ?? w.dir}. Leanfare leaves them as they are: move them to ${f.path} yourself (or remove the ones you do not need), then press Use them again.`);
  let kept: string | null = null;
  if (w.linked || existsSync(w.dir)) {
    kept = `${w.dir}-before-leanfare`;
    for (let i = 2; existsSync(kept) || (() => { try { lstatSync(kept!); return true; } catch { return false; } })(); i++) kept = `${w.dir}-before-leanfare-${i}`;
    renameSync(w.dir, kept);
  }
  mkdirSync(dirname(w.dir), { recursive: true });
  symlinkSync(f.path, w.dir, "dir");
  await refreshOllama();
  const n = store.ollama.length;
  const keptText = kept ? ` What was in ${basename(w.dir)} before is kept as ${basename(kept)}.` : "";
  return n
    ? { text: `Ollama now uses the ${n} model${n === 1 ? "" : "s"} on ${f.drive}, and new downloads go there too.${keptText}`, models: n }
    : { text: `Ollama's models folder now points to ${f.path}.${keptText} Quit Ollama and open it again (or start ollama serve again), then press Look again.`, models: 0 };
}

// ---- one suggested for each kind of work -------------------------------------------------------------
// Reading, drafting and working things out, each rated by its own Arena task. A model Arena rates (through
// its cloud twin) is suggested as rated: the one you have, or a download that is rated higher and fits.
// Arena rates few small models, so for reading a model you have can be tested here instead (localtest.ts):
// one that passed is used first; one not tested yet is offered for the test. Drafting and working out have
// no test questions, so they take rated models only; with none that fits, the kind says who does it.
export type WorkKind = "read" | "write" | "reason";
export const KIND_TASK: Record<WorkKind, string> = { read: "longer_query", write: "instruction_following", reason: "hard_prompts" };
export const KIND_TITLE: Record<WorkKind, string> = { read: "Reading and pulling out facts", write: "Drafting text", reason: "Working things out" };
export interface KindPick {
  kind: WorkKind; title: string;
  pick: { name: string; id: string | null; size: number; have: boolean; fit: Fit; rating: number | null; like: string | null; test: (TestResult & { passed: boolean }) | null; act: "use" | "download" | "test" | "download-test" } | null;
  why: string;
}
function otherFor(task: string): string {
  const free = usableModels((m) => !m.local && rating(m, task) !== null && chargeOf(m, 1).cost === 0).sort((a, b) => rating(b, task)! - rating(a, task)!)[0];
  return free ? `${free.label} (free) does it.` : "Your other models do it.";
}
export function kindsFor(installed: Installed[], mem: number, free: number | null, found: Found[] = []): KindPick[] {
  const catalogue = allModels().filter((m) => !m.local);
  const tests = testResults();
  const byName = new Map(store.ollama.map((m) => [m.apiId, m] as [string, Model]));
  const runs = (size: number) => fit(size, mem) !== "too big";
  const room = (size: number) => free === null || free - size >= MIN_FREE;
  const machine = process.platform === "darwin" ? "Mac" : "computer";
  return (["read", "write", "reason"] as WorkKind[]).map((kind): KindPick => {
    const task = KIND_TASK[kind];
    const title = KIND_TITLE[kind];
    // What you have: rated ones, and for reading the ones that passed the test or were not tested yet.
    const have = installed.filter((i) => runs(i.size)).map((i) => {
      const m = byName.get(i.name) ?? null;
      const t = m ? tests[m.id] ?? null : null;
      return { i, m, rating: m ? rating(m, task) : null, like: m?.ratingFrom?.split(",")[0] ?? null, test: t ? { ...t, passed: passed(t) } : null };
    });
    const ratedHave = have.filter((x) => x.rating !== null).sort((a, b) => b.rating! - a.rating!)[0] ?? null;
    const ratedGet = SUGGESTED.map((c) => ({ c, twin: twinOf(c.name, catalogue) }))
      .filter((x) => x.twin && rating(x.twin, task) !== null && runs(x.c.size) && room(x.c.size) && !installed.some((i) => i.name === x.c.name))
      .map((x) => ({ ...x, rating: rating(x.twin!, task)! - LOCAL_PENALTY })).sort((a, b) => b.rating - a.rating || a.c.size - b.c.size)[0] ?? null;
    const how = (f: Fit) => (f === "fits" ? `runs comfortably in this ${machine}'s ${gb(mem)} of memory` : `runs in this ${machine}'s ${gb(mem)} of memory, but tightly: other apps may slow down while it answers`);
    if (kind === "read") {
      const good = have.filter((x) => x.test?.passed).sort((a, b) => b.test!.right / b.test!.asked - a.test!.right / a.test!.asked || b.i.size - a.i.size)[0];
      if (good) return { kind, title, pick: { name: good.i.name, id: good.m?.id ?? null, size: good.i.size, have: true, fit: good.i.fit, rating: good.rating, like: good.like, test: good.test, act: "use" },
        why: `It passed this ${machine}'s test, ${good.test!.right} of ${good.test!.asked} right, so plans and the delegate send reading here first: it is free. A stronger model of yours still checks a sample of its answers.` };
    }
    if (ratedGet && (!ratedHave || ratedGet.rating > ratedHave.rating!)) {
      const f = fit(ratedGet.c.size, mem);
      return { kind, title, pick: { name: ratedGet.c.name, id: null, size: ratedGet.c.size, have: false, fit: f, rating: Math.round(ratedGet.rating), like: ratedGet.twin!.label, test: null, act: "download" },
        why: `Rated like ${ratedGet.twin!.label} for this (${Math.round(ratedGet.rating)}), it ${how(f)}${ratedHave ? `, and is rated above ${ratedHave.i.name}, which you have` : ""}. Apache 2.0: free to use for work.` };
    }
    if (ratedHave) return { kind, title, pick: { name: ratedHave.i.name, id: ratedHave.m?.id ?? null, size: ratedHave.i.size, have: true, fit: ratedHave.i.fit, rating: Math.round(ratedHave.rating!), like: ratedHave.like, test: ratedHave.test, act: "use" },
      why: `You have it, rated like ${ratedHave.like ?? "its twin"} for this (${Math.round(ratedHave.rating!)}): Auto and plans can use it.` };
    if (kind === "read") {
      // Models on a drive that Ollama does not use come first: no download while they are there.
      if (!installed.length && found.length) return { kind, title, pick: null, why: `Ollama has no models of its own here. Use the ${found[0].models} model${found[0].models === 1 ? "" : "s"} on ${found[0].drive} first (above): then Leanfare can test one.` };
      // Not tested yet, the biggest that runs comfortably first; then one that missed, to say so.
      const fresh = have.filter((x) => x.m && !x.test).sort((a, b) => (a.i.fit === "fits" ? 0 : 1) - (b.i.fit === "fits" ? 0 : 1) || b.i.size - a.i.size)[0];
      if (fresh) return { kind, title, pick: { name: fresh.i.name, id: fresh.m!.id, size: fresh.i.size, have: true, fit: fresh.i.fit, rating: null, like: null, test: null, act: "test" },
        why: `You have it. Arena does not rate it, so Leanfare tests it here first: ${TEST_SIZE} questions with known answers about made up files, free, a few minutes, and nothing leaves this ${machine}.` };
      const missed = have.filter((x) => x.test && !x.test.passed).sort((a, b) => b.test!.right / b.test!.asked - a.test!.right / a.test!.asked)[0];
      const small = SUGGESTED.filter((c) => !twinOf(c.name, catalogue) && fit(c.size, mem) === "fits" && room(c.size) && !installed.some((i) => i.name === c.name)).sort((a, b) => b.size - a.size)[0];
      if (small) return { kind, title, pick: { name: small.name, id: null, size: small.size, have: false, fit: "fits", rating: null, like: null, test: null, act: "download-test" },
        why: `${missed ? `${missed.i.name} missed ${missed.test!.asked - missed.test!.right} of ${missed.test!.asked} on this ${machine}'s test. ` : ""}Arena does not rate ${small.name}${missed ? " either" : ""}: after the download, Leanfare tests it here. Apache 2.0: free to use for work.` };
      if (missed) return { kind, title, pick: null, why: `${missed.i.name} missed ${missed.test!.asked - missed.test!.right} of ${missed.test!.asked} on this ${machine}'s test, so Leanfare gives it no reading. ${otherFor(task)}` };
    }
    return { kind, title, pick: null, why: `No rated open model fits this ${machine}'s ${gb(mem)} of memory. ${otherFor(task)}` };
  });
}
export const TEST_SIZE = 8; // the test's questions that fit 16,000 tokens of context (localtest.ts)

export async function overview() {
  const memory = probe.memory();
  const here = onThisComputer();
  const where = here ? whereModels() : null;
  const free = where ? where.free : null;
  const base = { tried: `${host()}/api/tags`, installUrl: INSTALL_URL, memory: { total: memory, usable: Math.round(memory * 0.7) }, disk: { free, minFree: MIN_FREE, known: free !== null }, remote: !here, pull: pullView(), suggest: suggestLocal(), where, found: here ? foundElsewhere() : [], machine: process.platform === "darwin" ? "Mac" : "computer" };
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
    return { ...base, running: true, installed, total: installed.reduce((n, m) => n + m.size, 0), kinds: here ? kindsFor(installed, memory, free, base.found) : [] };
  } catch {
    return { ...base, running: false, installed: [] as Installed[], total: 0, kinds: [] as KindPick[] };
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
    j.message = `Downloaded ${made.label}${j.size ? ` (${gb(j.size)})` : ""}. It is ticked${rated ? `, and rated like ${made.ratingFrom?.split(",")[0] ?? "its twin"}, so Auto and plans can use it` : ". Arena does not rate it, so Auto does not pick it: test it here (Settings, Local models), and if it passes it takes reading in plans and the delegate"}.`;
  } catch (e: any) {
    if (e?.name === "AbortError" || !active(j)) return;
    fail(j, "Leanfare lost touch with Ollama. Open the Ollama app, then press Download to continue where it stopped.");
  } finally { clearTimeout(idle); }
}
