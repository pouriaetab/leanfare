// Ask about these prompts (0.12): a question over the prompts Savings shows (its span and filters), answered by a
// model on this computer by default (Ollama, or another model app here), so the prompts never leave it. Another model
// answers only when you pick it; where projects' files may go still holds (platforms.ts: mayTake). The question and
// the answer are not kept, and the ask is not a hand off: it adds no row to the report.
import { fitsText, getModel, type Model } from "./data";
import { runDelegate } from "./delegate";
import { usableModels } from "./engine";
import { mayTake, readRisk } from "./platforms";
import { checkReport, report, type Report, type ReportPrompt } from "./report";
import { UserError } from "./upstream";
import { wordsOf } from "./words";

export const ASK_MAX = 2000; // the longest question
const OUT = 1200; // the longest answer, in tokens
const MOST = 120_000; // the most text sent, in characters
const UNKNOWN_ROOM = 24_000; // a model whose context is not known
const TIMEOUT = 100_000; // the page waits up to 120 seconds

// The models that may answer: yours that are ready, those on this computer first. A model that may not take your
// projects' files (Settings) is left out, since kept words can hold them.
export function askModels() {
  return usableModels((m) => mayTake(m, { files: true }))
    .map((m) => ({ id: m.id, label: m.label, local: !!m.local, risk: readRisk(m) }))
    .sort((a, b) => Number(b.local) - Number(a.local) || a.label.localeCompare(b.label));
}

// How much text a model takes beside the question and an answer of OUT tokens: the most characters that still fit.
function roomOf(m: Pick<Model, "provider" | "context">): number {
  if (m.context === null) return UNKNOWN_ROOM;
  let lo = 0, hi = MOST;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fitsText(m, mid + 3000, OUT)) lo = mid; else hi = mid - 1; }
  return lo;
}

const k = (n: number | null | undefined) => (n === null || n === undefined ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const usd = (v: number | null | undefined) => (v === null || v === undefined ? "cost unknown" : v === 0 ? "$0" : `$${v < 0.01 ? v.toPrecision(2) : v.toFixed(4)}`);
const when = (ts: string) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const cut = (t: string, n: number) => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const WHERE: Record<string, string> = { local: "this computer", free: "free", plan: "a ChatGPT plan", paid: "paid" };

function promptLines(p: ReportPrompt): string {
  const head = [p.id ?? "a prompt", when(p.ts), p.app, p.project ? `project ${p.project}` : null, p.model ? `main model ${p.model.label}` : null,
    p.prompt !== null ? `prompt ${k(p.prompt)} tokens` : null, p.own ? `its own work ${k(p.own.fresh)} new tokens` : null,
    p.parts.length ? `kept out ${k(p.kept)}, read back ${k(p.back)}` : "nothing handed off", `cost ${usd(p.cost)}`,
    p.both ? `saved about ${k(p.both.saved.mid)} tokens` : null, p.grade ? `graded ${p.grade}` : null, p.together ? `whole result ${p.together}` : null];
  const lines = [head.filter(Boolean).join(" · ")];
  p.parts.forEach((x, i) => {
    lines.push("  " + [x.ref ?? `part ${i + 1}`, `hand off ${x.id}`, x.kind ?? "part", x.label, WHERE[x.where] ?? x.where, `read ${k(x.read)}`, `back ${k(x.back)}`, usd(x.cost),
      x.ms !== null ? `${(x.ms / 1000).toFixed(1)} s` : null, x.grade ? `graded ${x.grade}${x.gradedBy === "check" ? " by a blind check" : ""}` : "not graded",
      x.fixed ? `fixed by ${x.fixed === "myself" ? "the app" : "Leanfare"}` : null, x.fixOf ? `a fix of hand off ${x.fixOf}` : null, x.level ? `level ${x.level}` : null].filter(Boolean).join(" · "));
    const w = x.words ? wordsOf(x.id) : null;
    if (w) {
      lines.push(`    task: ${cut(w.task, 400)}`);
      if (w.files?.length) lines.push(`    files: ${w.files.map((f) => f.name).join(", ")}`);
      if (w.answer) lines.push(`    answer: ${cut(w.answer, 400)}`);
    }
  });
  return lines.join("\n");
}

// The report as lines a model can read: what it covers, the sums (worked out here, so a small model need not add),
// then each prompt, newest first, as many as fit.
export const CUT_NOTE = "  (cut here: this prompt is longer than the model can read at once)";
export function promptsText(r: Report, room: number): { text: string; shown: number; total: number; cut: boolean } {
  const total = r.prompts.length + r.more;
  const parts = r.prompts.flatMap((p) => p.parts);
  const grades = (g: string) => parts.filter((x) => x.grade === g).length;
  const head = [
    `Leanfare's report from ${when(r.from)} to ${when(r.to)} (this computer's time): ${total} ${total === 1 ? "prompt" : "prompts"}, ${parts.length} ${parts.length === 1 ? "part" : "parts"} handed off.`,
    `Sums: cost ${usd(r.prompts.reduce((n, p) => n + p.cost, 0))}, kept out of the apps ${k(r.prompts.reduce((n, p) => n + p.kept, 0))} tokens, saved about ${k(r.prompts.reduce((n, p) => n + (p.both?.saved.mid ?? 0), 0))} tokens; parts graded good ${grades("good")}, partly ${grades("partly")}, wrong ${grades("wrong")}, not graded ${parts.filter((x) => !x.grade).length}.`,
    "Each prompt: its id, time, app, project, the app's own model, then each part it handed off (where it ran, tokens, cost, grade), with its task and answer when they are kept.",
  ].join("\n");
  const lines: string[] = [];
  let used = head.length + 120, cut = false; // with room for the line that says how many were shown
  for (const p of [...r.prompts].sort((a, b) => b.ts.localeCompare(a.ts))) {
    let t = promptLines(p);
    if (used + t.length + 2 > room) {
      if (lines.length) break;
      // The newest prompt alone is longer than the model can read: its first whole lines that fit, and a note, so the
      // ask still answers (before, it failed as too much text).
      const fit = t.slice(0, Math.max(0, room - used - CUT_NOTE.length - 2));
      t = `${fit.includes("\n") ? fit.slice(0, fit.lastIndexOf("\n")) : fit}\n${CUT_NOTE}`;
      cut = true;
    }
    lines.push(t); used += t.length + 2;
  }
  const more = total - lines.length;
  const shownLine = more > 0 ? `Shown: the newest ${lines.length} ${lines.length === 1 ? "prompt" : "prompts"}${cut ? ", cut to fit" : ""}; ${more} older ${more === 1 ? "one" : "ones"} did not fit.\n` : cut ? "Shown: the prompt, cut to fit.\n" : "";
  return { text: `${head}\n${shownLine}\n${lines.join("\n\n")}\n`, shown: lines.length, total, cut };
}

export function checkAsk(b: any): { question: string; q: URLSearchParams; model: string | null } | string {
  const question = typeof b?.question === "string" ? b.question.trim() : "";
  if (!question) return "Write a question first.";
  if (question.length > ASK_MAX) return `A question can be at most ${ASK_MAX} characters.`;
  const q = new URLSearchParams();
  for (const key of ["range", "from", "to", "app", "provider", "model", "kind", "thread"]) { const v = b?.q?.[key]; if (typeof v === "string" && v) q.set(key, v); }
  const model = typeof b?.model === "string" && b.model ? b.model : null;
  return { question, q, model };
}

export async function askReport(a: { question: string; q: URLSearchParams; model: string | null }, signal: AbortSignal) {
  const q = checkReport(a.q);
  if (typeof q === "string") throw new UserError(400, q);
  let only: ((m: Model) => boolean) | undefined, room: number;
  if (a.model) {
    const m = getModel(a.model);
    if (!m || !askModels().some((x) => x.id === m.id)) throw new UserError(400, `${a.model} is not one of your models that may read these prompts. Pick another, or a model on this computer.`);
    only = (x) => x.id === m.id; room = roomOf(m);
  } else {
    const here = usableModels((m) => !!m.local);
    if (!here.length) throw new UserError(409, "No model on this computer is ready to answer. Open Ollama with a model in it, or pick one of your other models.");
    room = Math.max(...here.map(roomOf));
  }
  const r = await report(q);
  if (!r.prompts.length) throw new UserError(400, "There are no prompts in this span to ask about. Pick a longer span or other filters.");
  const { text, shown, total, cut } = promptsText(r, Math.min(MOST, room));
  const task = `Answer the user's question about their prompts from Leanfare's report in prompts.txt: the numbers, models and grades of each prompt and of the parts it handed off, and their kept words when there are any. Answer only from that file, and say so when it does not hold the answer. Name prompt ids (like PRM-41) when you point to prompts. Keep it short: a few lines or a short list.\n\nThe question: ${a.question}`;
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT);
  try {
    const res = await runDelegate({ task, files: [{ name: "prompts.txt", text }], kind: "read", effort: "low", check: "never", maxOut: OUT, private: !a.model, model: a.model ?? undefined, only, app: "Leanfare", as: "ask" }, ac.signal);
    return { answer: res.answer, model: { id: res.model.id, label: res.model.label }, local: !!getModel(res.model.id)?.local, cost: res.cost, seconds: Math.round(res.seconds * 10) / 10, shown, total, cut };
  } catch (e: any) {
    if (ac.signal.aborted && !signal.aborted) throw new UserError(504, "The model took too long to answer. Ask a shorter question, pick a shorter span, or pick a faster model.");
    throw e;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}
