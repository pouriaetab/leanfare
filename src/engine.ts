// The engine. Every request, from the chat screen or from another app, takes
// the same steps: wait while paused, choose the model, reserve the budget,
// send, count the tokens, record the cost.
import { baseOf, provider, runtime, type ProviderId } from "./config";
import { LOCAL_CONTEXT, allModels, getModel, isRetired, localNeed, served, store, type Model } from "./data";
import { isLocalFound } from "./providers";
import { ZERO, costOf, fromAnthropicUsage, fromOpenAIUsage, mediaIn, promptChars, promptMax, promptTokens, type Usage } from "./cost";
import { db } from "./db";
import { getKey } from "./keys";
import { MODES, saveSettings, settings, type Mode } from "./settings";
import { estimateFor, expectedOutput, guessTask, ledgerWhy, pickModel, resolveModel, type Candidate, type Guess, type Msg } from "./router";
import { forgetSpeeds, parseSpeed, secondsFor, speedOf, type SpeedChoice } from "./speed";
import { successor } from "./retire";
import { addSpent, budgetState, release, tryReserve, wouldFit } from "./budget";
import { failOfStatus, failOfText, type FailKind } from "./fails";
import { noteFailure, restOf, restText } from "./rest";
import { SAYS_GONE, noQuota, noQuotaNow, noQuotaText, noteRefusal } from "./quota";
import { fitsFree, onFreePlan } from "./freeplans";
import { learnedShift } from "./learn";
import { RESPONSES_PATH, ResponsesStreamTranslator, responsesToOpenAI, toResponses } from "./upstream";
import { AnthropicStreamTranslator, UserError, anthropicDefaultMax, anthropicToOpenAI, effortFor, headersFor, networkError, ollamaChunks, ollamaPlain, ollamaToOpenAI, openaiBody, plainError, thinkRoom, toAnthropic, toOllama } from "./upstream";
import { SSEParser, dollars, localDay, localMonth, median, now, providerMessage, randomId, redact, usd8 } from "./util";
import { takesImages, takesPdfs } from "./files";

// ---- which models can be used right now ---------------------------------------

export function providerReady(id: ProviderId): boolean {
  const def = provider(id);
  if (!def) return false;
  if (settings().providers[id]?.on === false) return false;
  if (id === "ollama") return store.ollamaFound;
  if (def.local) return isLocalFound(id);
  return def.needsKey ? !!getKey(id) : true;
}

export function notReadyMessage(id: ProviderId): string {
  const def = provider(id);
  if (!def) return `Leanfare does not know the provider ${id} any more. Pick another model.`;
  if (settings().providers[id]?.on === false) return `${def.name} is switched off in Leanfare's Settings.`;
  if (id === "ollama") return `Ollama is not running on this computer (Leanfare tried ${baseOf("ollama").replace(/\/v1$/, "")}). Open the Ollama app, then try again.`;
  if (def.local) return `${def.name} is not running on this computer any more. Open it and start its server, then press Look again in Settings.`;
  return `There is no ${def.name} key in Leanfare yet. Add one in Settings at http://127.0.0.1:${runtime.port}.`;
}

// The models Auto, plans, checks and side by side may use: ticked, their provider ready, still served, and not one your key
// has no quota for (quota.ts). A model you name yourself is asked anyway.
export function usableModels(only?: (m: Model) => boolean): Model[] {
  return settings().ticked.map((id) => getModel(id)).filter((m): m is Model => !!m && providerReady(m.provider) && served(m) && !noQuota(m.id) && (!only || only(m)));
}

// A provider you have but ticked none of the models of (a key just added, Ollama just found, or Set up's
// first run): its short list is ticked, or every model it has on this computer, since those are free.
export function firstPicks(pid: ProviderId): Model[] {
  const all = allModels().filter((m) => m.provider === pid);
  const ticked = new Set(settings().ticked);
  if (all.some((m) => ticked.has(m.id))) return []; // you already chose for this provider
  const mine = all.filter((m) => served(m));
  return pid === "ollama" || provider(pid)?.local ? mine : mine.filter((m) => m.top);
}
export function tickTop(pid: ProviderId): Model[] {
  const pick = firstPicks(pid);
  if (pick.length) saveSettings({ ticked: [...settings().ticked, ...pick.map((m) => m.id)] });
  return pick;
}

// The "usual model" savings are measured against: your choice, or the best rated model you ticked.
export function usualModel(): Model | null {
  const s = settings();
  if (s.usual) { const m = getModel(s.usual); if (m) return m; }
  // A model on this computer or a free one costs nothing, so it is never the one savings are measured against.
  const rated = usableModels().filter((m) => m.ratings.overall !== undefined && m.input !== null && !m.local && !m.free);
  return rated.sort((a, b) => b.ratings.overall - a.ratings.overall)[0] ?? null;
}

// What an answer costs you, which is not always its list price.
export function chargeOf(m: Model, listCost: number | null): { cost: number | null; status: string } {
  if (m.local) return { cost: 0, status: "local" };
  if (m.free) return { cost: 0, status: "free" };
  if (onFreePlan(m.provider)) return { cost: 0, status: "free plan" }; // a free key, as you said in Settings (freeplans.ts)
  if (listCost === null) return { cost: null, status: "unknown" };
  return { cost: listCost, status: "listed" };
}

// ---- answer lengths seen before (for estimates) --------------------------------

// Answers sent with a thinking effort are compared with answers at the same effort first.
// Lengths are kept apart by the kind of work: the delegate's short hand off answers, the checks'
// verdicts and the trial's one word answers would make every chat estimate too low, and the other
// way round. "main" is everything else (the chat and your other apps).
export type LengthGroup = "main" | "delegate" | "check" | "trial" | "sidebyside";
export const lengthGroup = (source: string | undefined): LengthGroup => (source === "ask" ? "delegate" : source === "delegate" || source === "check" || source === "trial" || source === "sidebyside" ? source : "main"); // an ask about the prompts answers like a hand off
let hist = { at: 0, map: new Map<string, number | null>() };
export function outputHistory(task: string, model: string | null, effort: string | null = null, group: LengthGroup = "main"): number | null {
  if (effort) { const v = lengthsSeen(task, model, effort, group); if (v !== null) return v; }
  return lengthsSeen(task, model, null, group);
}
function lengthsSeen(task: string, model: string | null, effort: string | null, group: LengthGroup): number | null {
  if (Date.now() - hist.at > 60_000) hist = { at: Date.now(), map: new Map() };
  const k = `${task}|${model ?? ""}|${effort ?? ""}|${group}`;
  if (hist.map.has(k)) return hist.map.get(k)!;
  const since = new Date(now().getTime() - 30 * 86_400_000).toISOString();
  const where = ["task = ?", "status = 'ok'", "ts >= ?", group === "main" ? "source NOT IN ('delegate', 'check', 'trial', 'sidebyside')" : "source = ?", ...(model ? ["model = ?"] : []), ...(effort ? ["effort = ?"] : [])].join(" AND ");
  const args = [task, since, ...(group === "main" ? [] : [group]), ...(model ? [model] : []), ...(effort ? [effort] : [])];
  const rows = db.query(`SELECT out_tokens AS o FROM ledger WHERE ${where} ORDER BY id DESC LIMIT 200`).all(...args) as { o: number }[];
  const v = rows.length >= 5 ? median(rows.map((r) => r.o)) : null;
  hist.map.set(k, v);
  return v;
}
export const forgetHistoryCache = () => { hist = { at: 0, map: new Map() }; };

// ---- Pause and the list of running requests --------------------------

let paused = false;
const waiters = new Set<() => void>();
export const pauseState = () => ({ paused, waiting: waiters.size });
export function setPaused(p: boolean) {
  paused = p;
  if (!p) for (const w of [...waiters]) w();
}
async function gate(signal: AbortSignal) {
  while (paused) {
    await new Promise<void>((resolve, reject) => {
      const done = () => { waiters.delete(done); signal.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => { waiters.delete(done); reject(new UserError(499, "Stopped while waiting for Start again.", "stopped")); };
      waiters.add(done);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

interface Running { id: string; source: string; label: string; started: number; ac: AbortController }
const running = new Map<string, Running>();
export const runningList = () => [...running.values()].map((r) => ({ id: r.id, source: r.source, label: r.label, seconds: Math.round((Date.now() - r.started) / 1000) }));
export function stopRunning(id?: string) {
  for (const r of running.values()) if (!id || r.id === id) r.ac.abort();
}
export const idle = () => running.size === 0;

// How long a try may take to start answering (its first word, or its thinking), before Leanfare gives up on it and
// Auto passes the work on: six times its usual wait here, from its own answers, at least 30 seconds and at most 4
// minutes. A model not timed yet: a minute, or 3 for one that thinks first or runs on this computer (it may load
// first). Once it has started, it may go quiet for at most 90 seconds between two pieces. (Tests set start, in ms.)
export const ANSWER_TIME = { start: 0, idle: 90_000 };
export function startWait(m: Model, effort: string | null): number {
  if (ANSWER_TIME.start) return ANSWER_TIME.start;
  const s = speedOf(m, effort);
  if (s.measured) return Math.round(Math.min(240_000, Math.max(30_000, s.latency * 6000)));
  return m.local || m.skills.includes("reasoning") ? 180_000 : 60_000;
}
const waitWords = (ms: number) => { const n = ms < 1000 ? ms : ms < 90_000 ? Math.round(ms / 1000) : Math.round(ms / 60_000); return `${n} ${ms < 1000 ? "ms" : ms < 90_000 ? `second${n === 1 ? "" : "s"}` : "minutes"}`; };

// One controller per request, aborted by the client going away or by Stop.
function linked(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", () => ac.abort(), { once: true });
  return ac;
}

// ---- planning a request ----------------------------------------------------------

export interface PlanInput {
  source: "chat" | "openai" | "anthropic";
  asked: string | null;
  messages: Msg[];
  system?: unknown;
  maxOut: number | null;
  mode?: Mode;
  signal: AbortSignal;
  dry?: boolean; // an estimate for the screen: no waiting, nothing reserved
  tools?: unknown; // tool definitions: counted in the budget reservation
  hasTools?: boolean; // the request uses tools (Claude takes those only through /v1/messages)
  plain?: boolean; // false: tools, functions or a response format (Ollama's models take such a request only at its 4,096 tokens)
  effort?: string | null; // thinking effort asked for (the chat screen); sent only to models that take it
  copies?: number; // answers asked for at once (OpenAI's n): each is billed
  guess?: Guess; // the task, when the caller knows it (the delegate): used instead of the guess
  only?: (m: Model) => boolean; // a further limit on the models Auto may pick (the delegate: long enough, stronger)
  onlyWhy?: string; // what to say when that limit leaves no model
  optional?: boolean; // work that can be skipped (the delegate's check): never sent past the budget
  speed?: SpeedChoice; // cheapest, fastest or within N seconds (speed.ts); default: Settings
  ledgerSource?: string; // where the ledger will say it came from ("delegate", "check", "trial"...): its answer lengths are its own
  tokens?: number; // a dry plan's input tokens, when the caller knows them without the text (the planner): counted, never built
}

export interface Choice { id: string; label: string; estimate: number | null; seconds: number | null; measured: boolean }

export interface Plan {
  model: Model;
  auto: boolean;
  mode: Mode;
  guess: Guess;
  reason: string;
  estimate: number | null;
  candidates: Model[];
  alternatives: { id: string; label: string; estimate: number | null; rating: number | null; seconds: number | null }[];
  seconds: number | null; // about how long the answer takes (speed.ts)
  secondsMeasured: boolean; // from this model's own answers here, or a rough guess
  speed: SpeedChoice;
  // Auto only: at the same quality, the cheapest and the fastest (the pick is one of them, or the cheapest within a time).
  choices: { cheapest: Choice; fastest: Choice | null } | null;
  usual: Model | null;
  switchedFrom: string | null;
  notes: string[];
  reservation: string | null;
  inTok: number; // estimated input tokens (shown on screen)
  inMax: number; // the most input tokens it can be (used for the budget)
  maxOut: number | null;
  capped: boolean; // a budget is set and the request has no answer limit of its own: Leanfare sends one
  asked: string | null;
  effortAsked: string | null;
  capOverride?: number | null; // a second try with a higher answer limit (the first one spent it thinking)
  copies: number;
  cheapestId: string | null; // the cheapest model this request could use (the only one allowed past the budget)
  optional?: boolean; // never sent past the budget, not even on the cheapest model
  job?: string | null; // the hand off this request is for (delegate.ts): each of its calls is marked with it in the ledger
  startWithin?: number | null; // ms: each try must start answering within this, when shorter than its own wait (a plan's split)
}

const AUTO = /^(leanfare\/)?(auto|leanfare)(-(save|balanced|best))?$/i;
export function autoMode(asked: string | null, fallback: Mode): Mode | null {
  if (!asked || !asked.trim()) return fallback;
  const m = AUTO.exec(asked.trim());
  if (!m) return null;
  return ((m[4]?.toLowerCase() as Mode) ?? fallback);
}

function chargeable(m: Model) { return chargeOf(m, 1).cost !== 0; }

// The answer limit Leanfare sends when a budget is set and the request has
// none of its own: 4,096 tokens, 8,192 for thinking models.
export const outCap = (m: Model) => (m.skills.includes("reasoning") ? 8192 : 4096);

// The most a request can cost: everything it sends at one token per byte, plus
// the longest answer it can get.
export function reserveFor(m: Model, inMax: number, maxOut: number | null, copies = 1): number {
  if (!chargeable(m)) return 0;
  return estimateFor(m, inMax, (maxOut ?? outCap(m)) * Math.max(1, copies)) ?? 0;
}

// A new try (Auto's next pick, or a second try) needs room in the budget of its
// own, and is never forced past it: with "keep going on the cheapest model",
// only the cheapest model may go past the budget, as for a first try.
function reserveAgain(p: Plan, m: Model, maxOut: number | null): boolean {
  release(p.reservation);
  p.reservation = null;
  const s = settings();
  if (s.budget === null) return true;
  const amount = reserveFor(m, p.inMax, maxOut, p.copies);
  p.reservation = tryReserve(amount);
  if (!p.reservation && !p.optional && s.atLimit === "cheapest" && p.cheapestId === m.id) p.reservation = tryReserve(amount, true);
  return !!p.reservation;
}

function cheapest(only: ((m: Model) => boolean) | undefined, inTok: number): Model | null {
  const day = localDay();
  const list = usableModels(only).filter((m) => !isRetired(m, day)).map((m) => ({ m, c: chargeOf(m, estimateFor(m, inTok, 400)).cost }));
  list.sort((a, b) => (a.c ?? Infinity) - (b.c ?? Infinity) || (b.m.ratings.overall ?? 0) - (a.m.ratings.overall ?? 0));
  return list[0]?.m ?? null;
}

export async function plan(input: PlanInput): Promise<Plan> {
  if (!input.dry) await gate(input.signal);
  const s = settings();
  const notes: string[] = [];
  const isClaude = (m: Model) => m.provider === "anthropic";
  // The Anthropic address takes Claude only; on the OpenAI address, Claude does not take tools in 0.1.
  const byAddress = input.source === "anthropic" ? isClaude : input.hasTools ? (m: Model) => !isClaude(m) : undefined;
  // Images and PDFs go only to models that take them.
  const media = mediaIn(input.messages as any);
  const takes = (m: Model) => (!media.images || takesImages(m)) && (!media.pdfs || takesPdfs(m));
  // A model in Ollama runs with the context Leanfare asks of it (at most 16k tokens), so Auto sends it only
  // a plain request whose prompt fits there with room for the answer (data.ts: localNeed). A request with
  // tools or a response format goes to Ollama's OpenAI address, at its 4,096 tokens: Auto leaves those out.
  const inTok = input.tokens ?? promptTokens(input.messages as any, input.system);
  const inChars = input.tokens !== undefined ? input.tokens * 4 : promptChars(input.messages as any, input.system);
  const need = localNeed(inChars, input.maxOut);
  const plainAsk = input.plain !== false && !input.hasTools;
  const roomy = (m: Model) => (m.provider !== "ollama" || (plainAsk && (m.context === null || m.context >= need))) && fitsFree(m, inChars, input.maxOut ?? 1000); // a free plan's tokens a minute
  const base = (m: Model) => (!byAddress || byAddress(m)) && (!(media.images || media.pdfs) || takes(m));
  const extra = input.only;
  const only = (m: Model) => base(m) && roomy(m) && (!extra || extra(m));
  const mediaWords = [media.images ? "images" : "", media.pdfs ? "PDFs" : ""].filter(Boolean).join(" and ");
  const amode = autoMode(input.asked, input.mode ?? s.mode);
  const mode = amode ?? input.mode ?? s.mode;
  const inMax = input.tokens !== undefined ? input.tokens * 4 : promptMax(input.messages, input.system, input.tools); // the most: a token per byte
  const capped = s.budget !== null && input.maxOut === null;
  const speed: SpeedChoice = input.speed ?? s.speed ?? "cheapest";
  const group = lengthGroup(input.ledgerSource ?? input.source);
  const copies = Math.max(1, Math.min(128, Math.floor(input.copies ?? 1)));
  let model: Model, guess: Guess, reason: string, candidates: Model[] = [];
  let alternatives: Plan["alternatives"] = [];
  let choices: Plan["choices"] = null;
  let inMargin: Model[] = []; // Auto: the models at the same quality, cheapest first, for when the pick would pass the budget
  if (amode) {
    const all = usableModels(only);
    // A model resting after failing too often is left out while another can take it (rest.ts).
    const awake = all.filter((m) => !restOf(m.id));
    const usable = awake.length ? awake : all;
    if (!usable.length && extra && usableModels(base).length) throw new UserError(400, input.onlyWhy ?? "None of the models you ticked can take this request.", "no_model_fits");
    if (!usable.length && usableModels(base).length) {
      throw new UserError(400, plainAsk
        ? `This is too long for the models on this computer you ticked: they run with at most ${LOCAL_CONTEXT.toLocaleString("en-US")} tokens of context here. Tick a model in the cloud for it.`
        : "A request with tools or a response format goes to Ollama's models at only 4,096 tokens of context, so Auto does not send it there. Tick a model in the cloud for it.", "no_model_fits");
    }
    if (!usable.length && mediaWords && usableModels(byAddress).length) {
      throw new UserError(400, `None of the models you ticked takes ${mediaWords} through Leanfare. In Settings, tick one that does: ${media.pdfs ? "a Claude or GPT model reads PDFs" : "most Claude, GPT and Gemini models see images"}.`, "unsupported_attachment");
    }
    // Every model that could take it is one your key has no quota for: say which, and what to do.
    const leftOut = usable.length ? [] : noQuotaNow().filter((q) => settings().ticked.includes(q.model)).filter((q) => { const m = getModel(q.model); return !!m && (!only || only(m)); });
    if (leftOut.length) throw new UserError(400, `${noQuotaText(leftOut[0], provider(leftOut[0].provider as ProviderId)?.name)}. Tick another model, or press Try again next to it in Settings.`, "no_model_ready");
    if (!usable.length) {
      throw new UserError(400, input.source === "anthropic"
        ? "No Claude model is ready. Add an Anthropic key in Leanfare's Settings and tick a Claude model."
        : input.hasTools
          ? "No model that takes tools on this address is ready. Claude models take tools through /v1/messages; tick a model from another provider for this address."
          : `No model is ready yet. Open Leanfare at http://127.0.0.1:${runtime.port}, add a key and tick a model, or start Ollama.`, "no_model_ready");
    }
    const effortAsked = input.effort ?? null;
    // A hand off's kind: your own grades for it move each model's rating (learn.ts).
    const kind = input.guess?.kind ?? null;
    const learn = kind ? (m: Model) => learnedShift(m.id, kind)?.points ?? 0 : undefined;
    const pick = (list: Model[]) => pickModel(input.messages, list, amode, (t, mid) => outputHistory(t, mid, effortAsked && mid ? effortFor(getModel(mid)!, effortAsked) : null, group), input.system, input.guess,
      speed, (m, out, tin) => secondsFor(m, out, effortAsked ? effortFor(m, effortAsked) : null, tin), input.tokens, learn);
    const p = pick(usable);
    // Say so when a resting model would have been the pick, or when all of them rest and Auto tries them anyway.
    if (p && awake.length && awake.length < all.length) {
      const would = pick(all);
      const r = would && would.model.id !== p.model.id ? restOf(would.model.id) : null;
      if (r) notes.push(`${restText(r)}, so Auto picked ${p.model.label}.`);
    } else if (p && !awake.length) notes.push("Every model you ticked for this is resting after failing too often lately, so Auto tries them anyway.");
    if (p) {
      model = p.model; guess = p.guess; reason = p.reason;
      candidates = p.candidates.map((c) => c.model);
      alternatives = p.candidates.slice(1, 4).map((c) => ({ id: c.model.id, label: c.model.label, estimate: chargeOf(c.model, c.estimate).cost, rating: c.rating === null ? null : Math.round(c.rating), seconds: c.seconds ?? null }));
      inMargin = p.candidates.slice(0, p.eligible).sort((a, b) => (a.estimate ?? Infinity) - (b.estimate ?? Infinity)).map((c) => c.model);
      const choice = (c: Candidate): Choice => ({ id: c.model.id, label: c.model.label, estimate: chargeOf(c.model, c.estimate).cost, seconds: c.seconds ?? null, measured: !!c.measured });
      choices = { cheapest: choice(p.cheapest), fastest: p.fastest ? choice(p.fastest) : null };
    } else {
      guess = input.guess ?? guessTask(input.messages);
      const u = usualModel();
      model = u && usable.includes(u) ? u : usable[0];
      reason = `None of the models you ticked has both a rating and a price, so Auto used ${model.label}.`;
      candidates = [model];
    }
  } else {
    const m = resolveModel(input.asked!);
    if (!m) throw new UserError(404, `Leanfare does not know the model "${input.asked}". The models it knows are listed at /v1/models; "auto" lets Leanfare choose.`, "model_not_found");
    if (input.source === "anthropic" && !isClaude(m)) throw new UserError(400, "In Leanfare 0.1 the Anthropic address (/v1/messages) works with Claude models only. Use /v1/chat/completions for other models.", "wrong_address");
    if (!providerReady(m.provider)) throw new UserError(400, notReadyMessage(m.provider), "provider_not_ready");
    // On the chat screen, say so before sending; other apps get the provider's own answer.
    if (input.source === "chat" && !takes(m)) {
      const what = media.pdfs && !takesPdfs(m) ? (m.provider === "google" ? "cannot read PDFs through Leanfare yet" : "does not read PDFs") : "does not take images";
      throw new UserError(400, `${m.label} ${what}. Pick Auto, or a model that does${media.pdfs ? " (a Claude or GPT model reads PDFs)" : ""}.`, "unsupported_attachment");
    }
    model = m; guess = input.guess ?? guessTask(input.messages); reason = "You chose this model."; candidates = [m];
    // A model in Ollama you chose by name: say when the start of a long prompt will be left out.
    if (m.provider === "ollama") {
      const most = plainAsk ? Math.min(m.context ?? LOCAL_CONTEXT, LOCAL_CONTEXT) : 4096;
      if (need > most) notes.push(`${m.label} runs here with ${most.toLocaleString("en-US")} tokens of context${plainAsk ? "" : " (a request with tools or a response format)"}, so Ollama leaves out the start of a prompt this long.`);
    }
  }

  // A retired model is replaced by its successor.
  let switchedFrom: string | null = null;
  const day = localDay();
  if (isRetired(model, day)) {
    const succ = successor(model, day);
    if (!succ || !providerReady(succ.provider)) {
      throw new UserError(410, `${model.label} retired on ${model.retire}, and Leanfare has no ready successor for it. Pick another model.`, "model_retired");
    }
    notes.push(`${model.label} retired on ${model.retire}, so Leanfare used its successor, ${succ.label}.`);
    switchedFrom = model.id;
    model = succ;
    candidates = [succ, ...candidates.filter((c) => c.id !== succ.id && c.id !== switchedFrom)];
  }

  // The budget.
  let reservation: string | null = null;
  if (s.budget !== null) {
    const most = reserveFor(model, inMax, input.maxOut, copies);
    let fits = input.dry ? wouldFit(most) : !!(reservation = tryReserve(most));
    // Before anything cheaper in quality: another model at the same quality that fits (a speed
    // choice may have picked a dearer one).
    if (!fits && !isRetired(model, day)) for (const m of inMargin) {
      if (m.id === model.id) continue;
      const need = reserveFor(m, inMax, input.maxOut, copies);
      if (input.dry ? wouldFit(need) : !!(reservation = tryReserve(need))) {
        notes.push(`${model.label} could pass your budget (up to ${dollars(most)}), so Auto took ${m.label}, at the same quality.`);
        model = m;
        candidates = [m, ...candidates.filter((c) => c.id !== m.id)];
        fits = true;
        break;
      }
    }
    if (!fits) {
      const b = budgetState();
      const why = b.reached
        ? `Your monthly budget of ${dollars(s.budget)} is used up (${dollars(b.spent)} spent)`
        : `This request could cost up to ${dollars(most)} with ${model.label} (its longest possible answer), which would pass your monthly budget of ${dollars(s.budget)} (${dollars(b.spent)} spent${b.reserved > 0 ? `, ${dollars(b.reserved)} held by requests still running` : ""})`;
      if (s.atLimit === "stop") {
        throw new UserError(402, `${why}. Raise the budget in Settings, or set it to keep going on the cheapest model.`, "budget_reached");
      }
      if (input.optional) throw new UserError(402, `${why}. Work Leanfare can skip, like a check, never goes past the budget.`, "budget_reached");
      const cheap = cheapest(only, inTok);
      if (cheap && cheap.id !== model.id) {
        notes.push(`${why}, so Leanfare used the cheapest model you ticked, ${cheap.label}.`);
        model = cheap;
        candidates = [cheap];
      }
      if (!input.dry) reservation = tryReserve(reserveFor(model, inMax, input.maxOut, copies), true);
    }
  }
  const effortAsked = input.effort && input.effort !== "auto" ? input.effort : null;
  const outGuess = expectedOutput(guess.task, model, (t, mid) => outputHistory(t, mid, effortFor(model, effortAsked), group));
  const estimate = chargeOf(model, estimateFor(model, inTok, outGuess)).cost;
  const time = secondsFor(model, outGuess, effortFor(model, effortAsked), inTok); // its first token later for a longer input
  const cheapestId = s.budget !== null ? cheapest(only, inTok)?.id ?? null : null;
  return { model, auto: !!amode, mode, guess, reason, estimate, seconds: time.seconds, secondsMeasured: time.measured, speed, choices, candidates, alternatives, usual: usualModel(), switchedFrom, notes, reservation, inTok, inMax, maxOut: input.maxOut, capped, asked: input.asked, effortAsked, copies, cheapestId, optional: input.optional };
}

// ---- the ledger --------------------------------------------------------------

export interface LedgerResult { cost: number | null; listCost: number | null; priceStatus: string; usage: Usage; usualCost: number | null }

const INSERT = `INSERT INTO ledger(ts, month, day, source, provider, model, asked, task, mode, auto, reason, usual, usual_cost,
    in_tokens, cached, cache_write, out_tokens, cost, list_cost, price_status, usage_status, status, error, ms, first_ms, switched_from, effort,
    job, think_tokens, think_source, fail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
// Rows that could not be written yet (another program had the database
// locked): kept in memory and written as soon as it is free, in order.
const unwritten: any[][] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
function writeRows() {
  retryTimer = null;
  while (unwritten.length) {
    try { db.query(INSERT).run(...unwritten[0]); unwritten.shift(); }
    catch { retryTimer = setTimeout(writeRows, 1000); return; }
  }
}
export const unwrittenRows = () => unwritten.length;

// Of an answer's output, the thinking: as the provider said; else from the thinking it sent, about four characters a
// token (an estimate); a model that does not think, none; else not known (null).
export function thinkingOf(m: Model, u: Usage | null, chars: number): { tokens: number | null; source: "reported" | "text" | "none" | null } {
  if (u?.thinking !== undefined) return { tokens: u.thinking, source: "reported" };
  if (chars > 0) return { tokens: Math.min(Math.ceil(chars / 4), u?.output ?? Infinity), source: "text" };
  if (!m.skills.includes("reasoning")) return { tokens: 0, source: "none" };
  return { tokens: null, source: null };
}

export function record(p: Plan, m: Model, source: string, usage: Usage | null, o: { status: "ok" | "stopped" | "error"; error?: string; ms: number; firstMs?: number | null; reportedCost?: number | null; estimated?: boolean; thinkingChars?: number; fail?: FailKind }): LedgerResult {
  const u = usage ?? ZERO;
  const think = usage || o.thinkingChars ? thinkingOf(m, usage, o.thinkingChars ?? 0) : { tokens: null, source: null }; // a call that failed before any answer: nothing to split
  // A failed request costs nothing unless the provider had already written part of an answer.
  const billed = o.status !== "error" || u.output > 0;
  const list = typeof o.reportedCost === "number" ? o.reportedCost : costOf(m, u);
  const charge = chargeOf(m, list);
  const priceStatus = typeof o.reportedCost === "number" && charge.status === "listed" ? "provider" : charge.status;
  const usualCost = p.usual ? chargeOf(p.usual, costOf(p.usual, u)).cost : null;
  const d = now();
  const month = localMonth(d);
  const row = [
    d.toISOString(), month, localDay(d), source, m.provider, m.id, p.asked ?? "auto", p.guess.task, p.auto ? p.mode : null, p.auto ? 1 : 0,
    p.auto ? `${p.guess.task}: ${ledgerWhy(p.guess)}` : null, p.usual?.id ?? null, usualCost,
    u.uncached + u.cacheRead + u.cacheWrite + (u.cacheWrite1h ?? 0), u.cacheRead, u.cacheWrite + (u.cacheWrite1h ?? 0), u.output,
    billed ? charge.cost : 0, billed ? list : 0, priceStatus, o.estimated ? "estimated" : "reported",
    o.status, o.error ? redact(o.error).slice(0, 300) : null, Math.round(o.ms), o.firstMs == null ? null : Math.round(o.firstMs), p.switchedFrom,
    effortFor(m, p.effortAsked), p.job ?? null, think.tokens, think.source, o.status === "error" ? o.fail ?? failOfText(o.error ?? null) : null,
  ];
  unwritten.push(row);
  if (!retryTimer) writeRows();
  if (o.status === "error" && !unwritten.length) {
    noteFailure(m.id); // too many failures lately: it rests (rest.ts)
    noteRefusal(m.id, m.provider, o.error ?? null, o.fail ?? null); // a key with no quota for it: left out (quota.ts)
  }
  forgetSpeeds(m.id); // this answer's time counts in the next estimate
  if (unwritten.length && !retryTimer) retryTimer = setTimeout(writeRows, 1000);
  if (unwritten.length === 1 && retryTimer) console.error("leanfare: the database is busy; the cost ledger will be written when it is free.");
  if (billed) addSpent(charge.cost, month);
  return { cost: billed ? charge.cost : 0, listCost: billed ? list : 0, priceStatus, usage: u, usualCost };
}

// ---- sending -------------------------------------------------------------------

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
// Answers from Ollama's own /api/chat (upstream.ts says why): read as JSON lines and turned into OpenAI's shape.
const OLLAMA_NATIVE = new WeakSet<Response>();

function send(m: Model, body: any, stream: boolean, signal: AbortSignal, native: boolean, extraHeaders: Record<string, string>, cap: number | null, effortAsked: string | null = null): Promise<Response> {
  const def = provider(m.provider)!;
  const effort = effortFor(m, effortAsked);
  const base = baseOf(m.provider);
  let url: string, payload: any;
  if (native) {
    url = `${base}/v1/messages`;
    payload = { ...body, model: m.apiId };
    if (cap && payload.max_tokens == null) payload.max_tokens = cap;
  } else if (def.kind === "responses") { // Perplexity's Agent API (upstream.ts)
    url = `${base}${RESPONSES_PATH}`;
    payload = toResponses(body, m, stream, cap);
  } else if (def.kind === "anthropic") {
    url = `${base}/v1/messages`;
    payload = toAnthropic(cap && body.max_tokens == null && body.max_completion_tokens == null ? { ...body, max_tokens: cap } : body, m, stream, effort);
  } else if (m.provider === "ollama" && ollamaPlain(body)) {
    url = `${base.replace(/\/v1\/?$/, "")}/api/chat`;
    payload = toOllama(body, m, stream, cap, effortAsked);
  } else {
    url = `${base}/chat/completions`;
    payload = openaiBody(m, body, stream, effort);
    // OpenAI's newer models take only max_completion_tokens; the others take max_tokens. Leanfare's own limit (not an
    // app's) has room for a thinking model's thinking on top (upstream.ts: thinkRoom).
    if (cap && payload.max_tokens == null && payload.max_completion_tokens == null) payload[m.provider === "openai" ? "max_completion_tokens" : "max_tokens"] = Math.min(cap + thinkRoom(m, effort ?? effortAsked), Math.max(cap, 64000));
  }
  const sig = stream ? signal : AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
  const sent = fetch(url, { method: "POST", headers: { ...headersFor(def, getKey(m.provider)), ...extraHeaders }, body: JSON.stringify(payload), signal: sig });
  return url.endsWith("/api/chat") ? sent.then((res) => { OLLAMA_NATIVE.add(res); return res; }) : sent;
}

// Sends to the planned model. For Auto, a busy or unreachable provider (before
// any answer arrives) passes the request to the next pick, at most twice.
async function sendWithFallback(p: Plan, source: string, body: any, stream: boolean, signal: AbortSignal, native = false, extraHeaders: Record<string, string> = {}): Promise<{ res: Response; model: Model; t0: number }> {
  const tries = p.auto ? p.candidates.slice(0, 3) : [p.model];
  if (tries[0]?.id !== p.model.id) tries.unshift(p.model);
  let last: UserError | null = null;
  for (let i = 0; i < Math.min(tries.length, 3); i++) {
    const m = tries[i];
    if (i > 0) {
      if (!reserveAgain(p, m, p.maxOut)) break;
      p.model = m;
    }
    const t0 = performance.now();
    try {
      const res = await send(m, body, stream, signal, native, extraHeaders, p.capOverride ?? (p.capped ? outCap(m) : null), p.effortAsked);
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && !/text\/html/i.test(type)) return { res, model: m, t0 };
      const text = await res.text();
      const def = provider(m.provider)!;
      const page = res.ok; // a 200 web page (a sign-in page or proxy in the way), not an answer
      const msg = page ? `${def.name} sent a web page instead of an answer; a sign-in page or a proxy may be in the way.` : plainError(def, res.status, text, getKey(m.provider));
      record(p, m, source, null, { status: "error", error: msg, ms: performance.now() - t0, fail: page ? "other" : failOfStatus(res.status) });
      last = new UserError(page ? 502 : res.status === 401 || res.status === 403 ? 502 : res.status, msg, "provider_error");
      const gone = !page && (res.status === 404 || res.status === 400) && SAYS_GONE.test(msg); // no longer served to this key (quota.ts)
      if ((!page && !RETRYABLE.has(res.status) && !gone) || i === tries.length - 1) throw last;
      p.notes.push(`${m.label} ${page ? "sent a web page instead of an answer" : gone ? `is no longer served to your ${def.name} key` : `answered ${res.status}`}, so Auto passed the request to its next pick.`);
    } catch (e: any) {
      if (e instanceof UserError) throw e;
      if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
      const msg = networkError(provider(m.provider)!, e);
      record(p, m, source, null, { status: "error", error: msg, ms: performance.now() - t0, fail: e?.name === "TimeoutError" ? "timeout" : "unreachable" });
      last = new UserError(502, msg, "provider_unreachable");
      if (!p.auto || i === tries.length - 1) throw last;
      p.notes.push(`${m.label} could not be reached, so Auto passed the request to its next pick.`);
    }
  }
  throw last ?? new UserError(402, "The budget does not leave room to try another model.", "budget_reached");
}

// ---- reading a stream ------------------------------------------------------------

async function* sseEvents(res: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = res.body!.getReader();
  const out: { event: string; data: string }[] = [];
  const parser = new SSEParser((event, data) => out.push({ event, data }));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { parser.end(); yield* out.splice(0); return; }
      parser.push(value);
      if (out.length) yield* out.splice(0);
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

// A stream of JSON lines (Ollama's /api/chat), one line at a time.
async function* jsonLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buf += dec.decode(); if (buf.trim()) yield buf; return; }
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) yield line; }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

// Any provider's stream as OpenAI-format chunks (Claude's and Ollama's own are translated).
async function* openaiChunks(res: Response, m: Model, modelName: string): AsyncGenerator<{ data: string; j: any }> {
  if (OLLAMA_NATIVE.has(res)) {
    for await (const line of jsonLines(res)) {
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      for (const j of ollamaChunks(o, modelName)) yield { data: JSON.stringify(j), j };
      if (o?.done === true) { yield { data: "[DONE]", j: null }; return; }
    }
    return;
  }
  if (provider(m.provider)!.kind === "responses") {
    const tr = new ResponsesStreamTranslator(modelName);
    for await (const ev of sseEvents(res)) for (const j of tr.event(ev.event, ev.data)) yield { data: JSON.stringify(j), j };
    if (tr.done) yield { data: "[DONE]", j: null };
    return;
  }
  if (provider(m.provider)!.kind === "anthropic") {
    const tr = new AnthropicStreamTranslator(modelName, true);
    for await (const ev of sseEvents(res)) {
      for (const block of tr.event(ev.event, ev.data).split("\n\n")) {
        if (block.startsWith("data: ")) { const d = block.slice(6); yield { data: d, j: JSON.parse(d) }; }
      }
    }
    if (tr.stopped) yield { data: "[DONE]", j: null };
    return;
  }
  for await (const ev of sseEvents(res)) {
    if (ev.data === "[DONE]") { yield { data: ev.data, j: null }; continue; }
    let j: any = null;
    try { j = JSON.parse(ev.data); } catch {}
    yield { data: ev.data, j };
  }
}

// The cost a provider reports itself: OpenRouter's usage.cost (a number), Perplexity's
// usage.cost.total_cost (its search fee included).
export function reportedCost(usage: any): number | null {
  const c = usage?.cost;
  if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  if (c && typeof c === "object" && typeof c.total_cost === "number" && Number.isFinite(c.total_cost) && c.total_cost >= 0) return c.total_cost;
  return null;
}

// What a chunk adds: text, token counts, a provider-reported cost, an error.
// Thinking arrives as reasoning_content (DeepSeek, Grok, Claude through
// Leanfare), reasoning (OpenRouter, Ollama), or as "thinking" parts of the
// content (Mistral's thinking models).
function contentParts(c: unknown): { text: string; thinking: string } {
  if (typeof c === "string") return { text: c, thinking: "" };
  if (!Array.isArray(c)) return { text: "", thinking: "" };
  let text = "", thinking = "";
  for (const p of c as any[]) {
    if (p?.type === "text" && typeof p.text === "string") text += p.text;
    else if (p?.type === "thinking") thinking += Array.isArray(p.thinking) ? p.thinking.map((t: any) => (typeof t?.text === "string" ? t.text : "")).join("") : typeof p.thinking === "string" ? p.thinking : "";
  }
  return { text, thinking };
}

function readChunk(j: any) {
  const delta = j?.choices?.[0]?.delta ?? {};
  const parts = contentParts(delta.content);
  const text: string = parts.text;
  const thinking: string = (typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "") + parts.thinking;
  return {
    text, thinking,
    usage: j?.usage ? fromOpenAIUsage(j.usage) : null,
    cost: reportedCost(j?.usage),
    error: j?.error ? providerMessage(JSON.stringify(j)) : null,
    usageOnly: !!j?.usage && (!Array.isArray(j?.choices) || j.choices.length === 0),
    finish: (j?.choices?.[0]?.finish_reason ?? null) as string | null,
  };
}

const incomplete = (m: Model) => `${provider(m.provider)!.name}'s answer stopped before it finished.`;

function estimatedUsage(p: Plan, outChars: number): Usage {
  return { uncached: p.inTok, cacheRead: 0, cacheWrite: 0, output: Math.ceil(outChars / 4) };
}

const enc = new TextEncoder();

// ---- the response headers every engine answer carries ---------------------------

function leanHeaders(p: Plan, m: Model): Record<string, string> {
  const h: Record<string, string> = {
    "x-leanfare-model": m.id,
    "x-leanfare-auto": p.auto ? MODES[p.mode].label : "no",
    "x-leanfare-task": p.guess.task,
    "x-leanfare-estimate-usd": p.estimate === null ? "unknown" : usd8(p.estimate),
    "x-leanfare-estimate-seconds": p.seconds === null ? "unknown" : p.seconds.toFixed(1),
  };
  const reason = [p.reason, ...p.notes].join(" ").slice(0, 600);
  h["x-leanfare-reason"] = encodeURIComponent(reason);
  return h;
}

export function errorResponse(e: any, kind: "openai" | "anthropic" = "openai"): Response {
  const status = e instanceof UserError ? e.status : 500;
  const message = e instanceof UserError ? e.message : `Leanfare hit an unexpected problem: ${String(e?.message ?? e)}`;
  const type = e instanceof UserError ? e.type : "leanfare_error";
  const body = kind === "anthropic" ? { type: "error", error: { type, message } } : { error: { message, type, code: type } };
  return new Response(JSON.stringify(body), { status: status === 499 ? 499 : status, headers: { "content-type": "application/json" } });
}

const toNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const headerMode = (req: Request): Mode | undefined => {
  const v = req.headers.get("x-leanfare-mode")?.toLowerCase();
  return v === "save" || v === "balanced" || v === "best" ? v : undefined;
};
// x-leanfare-speed: cheapest, balanced, fastest, or a number of seconds to answer within.
const headerSpeed = (req: Request): SpeedChoice | undefined => parseSpeed(req.headers.get("x-leanfare-speed")?.toLowerCase() ?? null) ?? undefined;

function register(source: string, label: string, ac: AbortController) {
  const id = randomId(6);
  running.set(id, { id, source, label, started: Date.now(), ac });
  return id;
}

// ---- POST /v1/chat/completions ---------------------------------------------------

export async function handleOpenAI(req: Request, body: any): Promise<Response> {
  if (!Array.isArray(body?.messages) || !body.messages.length) return errorResponse(new UserError(400, "The request needs a non-empty messages list.", "invalid_request"));
  const ac = linked(req.signal);
  const stream = body.stream === true;
  const clientWantsUsage = body.stream_options?.include_usage === true;
  let p: Plan;
  try {
    const hasTools = !!(body.tools || body.functions || body.tool_choice || body.messages.some((m: any) => m?.role === "tool" || m?.role === "function" || m?.tool_calls));
    p = await plan({ source: "openai", asked: typeof body.model === "string" ? body.model : null, messages: body.messages, tools: body.tools ?? body.functions, hasTools, plain: ollamaPlain(body), maxOut: toNum(body.max_completion_tokens ?? body.max_tokens), mode: headerMode(req), speed: headerSpeed(req), signal: ac.signal, copies: toNum(body.n) ?? 1 });
  } catch (e) { return errorResponse(e); }
  const rid = register("openai", p.model.label, ac);
  let sent: { res: Response; model: Model; t0: number };
  try {
    sent = await sendWithFallback(p, "openai", body, stream, ac.signal);
  } catch (e) {
    release(p.reservation); running.delete(rid);
    return errorResponse(e);
  }
  const { res, model, t0 } = sent;
  const def = provider(model.provider)!;
  const headers = leanHeaders(p, model);
  const name = typeof body.model === "string" && !autoMode(body.model, p.mode) ? body.model : model.apiId;

  if (!stream) {
    try {
      // One whole answer; an empty one (no text, no tool call, not declined) is asked for once more, and one still
      // empty goes to Auto's next pick, once (0.11.2), as it does on the chat screen and for the delegate.
      const read = async (r: Response, t: number, m: Model = model) => {
        const d = provider(m.provider)!, as = m === model ? name : m.apiId; // the next pick answers in its own way
        const text = await r.text();
        let j: any;
        try { j = JSON.parse(text); } catch { throw new UserError(502, `${d.name} sent an answer Leanfare could not read.`, "bad_provider_answer"); }
        const native = OLLAMA_NATIVE.has(r);
        const oj = d.kind === "anthropic" ? anthropicToOpenAI(j, as) : d.kind === "responses" ? responsesToOpenAI(j, as) : native ? ollamaToOpenAI(j, as) : j;
        const msg = oj.choices?.[0]?.message ?? {};
        const answer = typeof msg.content === "string" ? msg.content : "";
        const empty = !answer.trim() && !msg.tool_calls?.length && !msg.function_call && oj.choices?.[0]?.finish_reason !== "content_filter";
        const usage = d.kind === "anthropic" ? fromAnthropicUsage(j.usage) : fromOpenAIUsage(oj.usage);
        return { out: d.kind === "anthropic" || d.kind === "responses" || native ? JSON.stringify(oj) : text, answer, empty, usage, reported: reportedCost(oj.usage), t };
      };
      const picks = p.auto ? [...p.candidates] : []; // Auto's picks in order, to pass the request on
      let a = await read(res, t0);
      let answered = model; // the model whose answer goes back
      if (a.empty && !ac.signal.aborted) {
        const firstTry = record(p, model, "openai", a.usage ?? estimatedUsage(p, 0), { status: "error", error: "came back empty", ms: performance.now() - a.t, reportedCost: a.reported, estimated: !a.usage });
        if (reserveAgain(p, model, p.maxOut)) {
          p.notes.push(`The first try came back empty, so Leanfare asked ${model.label} once more.`);
          p.candidates = [model];
          const again = await sendWithFallback(p, "openai", body, false, ac.signal);
          a = await read(again.res, again.t0);
          const at = picks.findIndex((m) => m.id === model.id);
          const next = a.empty && !ac.signal.aborted ? picks.slice(at + 1).find((m) => m.id !== model.id) : undefined;
          if (next && reserveAgain(p, next, p.maxOut)) {
            record(p, model, "openai", a.usage ?? estimatedUsage(p, 0), { status: "error", error: "came back empty", ms: performance.now() - a.t, reportedCost: a.reported, estimated: !a.usage });
            p.notes.push(`${model.label} came back empty again, so Auto passed the request to its next pick.`);
            p.model = next; p.candidates = picks.slice(picks.indexOf(next));
            const other = await sendWithFallback(p, "openai", body, false, ac.signal);
            answered = other.model;
            a = await read(other.res, other.t0, other.model);
          }
        } else {
          // The empty answer goes back as it came (it is already in the ledger, at what it cost).
          p.notes.push("The answer came back empty, and the budget does not leave room to ask again.");
          Object.assign(headers, leanHeaders(p, model));
          headers["x-leanfare-cost-usd"] = firstTry.cost === null ? "unknown" : usd8(firstTry.cost);
          return new Response(a.out, { status: 200, headers: { ...headers, "content-type": "application/json" } });
        }
        Object.assign(headers, leanHeaders(p, answered));
      }
      const r = record(p, answered, "openai", a.usage ?? estimatedUsage(p, a.answer.length), { status: "ok", ms: performance.now() - a.t, reportedCost: a.reported, estimated: !a.usage });
      headers["x-leanfare-cost-usd"] = r.cost === null ? "unknown" : usd8(r.cost);
      return new Response(a.out, { status: 200, headers: { ...headers, "content-type": "application/json" } });
    } catch (e) {
      return errorResponse(e);
    } finally {
      release(p.reservation); running.delete(rid);
    }
  }

  // Streaming: pass each chunk on as it arrives, counting as it goes.
  let usage: Usage | null = null, reported: number | null = null, chars = 0, firstMs: number | null = null, failed: string | null = null;
  let finished = false, ended = false;
  const finish = (status: "ok" | "stopped" | "error") => {
    if (finished) return null;
    finished = true;
    release(p.reservation); running.delete(rid);
    return record(p, model, "openai", usage ?? estimatedUsage(p, chars), { status: failed ? "error" : status, error: failed ?? undefined, ms: performance.now() - t0, firstMs, reportedCost: reported, estimated: !usage });
  };
  const chunks = openaiChunks(res, model, name);
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await chunks.next();
          if (done) {
            // An answer that ends without saying so was cut off: say that, to the client and in the ledger.
            const cut = !ended && !failed;
            if (cut) failed = incomplete(model);
            const r = finish("ok");
            const cost = r?.cost === null || r?.cost === undefined ? "unknown" : usd8(r.cost);
            const err = cut ? `data: ${JSON.stringify({ error: { message: failed, type: "incomplete_answer" } })}\n\n` : "";
            controller.enqueue(enc.encode(`${err}: leanfare model=${model.id} cost_usd=${cost}\n\ndata: [DONE]\n\n`));
            controller.close();
            return;
          }
          if (value.j === null && value.data === "[DONE]") { ended = true; continue; } // sent once, at the end, after the cost line
          const c = readChunk(value.j);
          if (c.finish) ended = true;
          if (c.usage) usage = c.usage;
          if (c.cost !== null) reported = c.cost;
          if (c.error) failed = c.error;
          if ((c.text || c.thinking) && firstMs === null) firstMs = performance.now() - t0;
          chars += c.text.length + c.thinking.length;
          if (c.usageOnly && !clientWantsUsage) continue;
          controller.enqueue(enc.encode(`data: ${value.data}\n\n`));
          return;
        }
      } catch (e: any) {
        finish(ac.signal.aborted ? "stopped" : "error");
        try { controller.close(); } catch {}
      }
    },
    cancel() { ac.abort(); finish("stopped"); },
  });
  return new Response(out, { status: 200, headers: { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

// ---- POST /v1/messages (Anthropic's format, Claude models) -------------------------

export async function handleAnthropic(req: Request, body: any): Promise<Response> {
  if (!Array.isArray(body?.messages) || !body.messages.length) return errorResponse(new UserError(400, "The request needs a non-empty messages list.", "invalid_request_error"), "anthropic");
  const ac = linked(req.signal);
  const stream = body.stream === true;
  let p: Plan;
  try {
    p = await plan({ source: "anthropic", asked: typeof body.model === "string" ? body.model : null, messages: body.messages, system: body.system, tools: body.tools, maxOut: toNum(body.max_tokens), mode: headerMode(req), speed: headerSpeed(req), signal: ac.signal });
  } catch (e) { return errorResponse(e, "anthropic"); }
  const rid = register("anthropic", p.model.label, ac);
  // Pass through the client's beta flags (Claude Code uses them).
  const extra: Record<string, string> = {};
  const beta = req.headers.get("anthropic-beta");
  if (beta) extra["anthropic-beta"] = beta;
  let sent: { res: Response; model: Model; t0: number };
  try {
    sent = await sendWithFallback(p, "anthropic", body, stream, ac.signal, true, extra);
  } catch (e) {
    release(p.reservation); running.delete(rid);
    return errorResponse(e, "anthropic");
  }
  const { res, model, t0 } = sent;
  const headers = leanHeaders(p, model);
  if (!stream) {
    try {
      const text = await res.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch {}
      const usage = fromAnthropicUsage(j?.usage);
      const r = record(p, model, "anthropic", usage ?? estimatedUsage(p, text.length), { status: "ok", ms: performance.now() - t0, estimated: !usage });
      headers["x-leanfare-cost-usd"] = r.cost === null ? "unknown" : usd8(r.cost);
      return new Response(text, { status: 200, headers: { ...headers, "content-type": "application/json" } });
    } finally {
      release(p.reservation); running.delete(rid);
    }
  }
  let usage: Usage = { ...ZERO }, gotUsage = false, chars = 0, firstMs: number | null = null, failed: string | null = null, finished = false, stopped = false;
  const parser = new SSEParser((event, data) => {
    let j: any; try { j = JSON.parse(data); } catch { return; }
    const t = j.type ?? event;
    if (t === "message_start") { const u = fromAnthropicUsage(j.message?.usage); if (u) { usage = u; gotUsage = true; } }
    else if (t === "message_delta" && j.usage) {
      // The final counts are running totals; server tools (web search) can add input on the way.
      const u = fromAnthropicUsage(j.usage)!;
      usage = { uncached: Math.max(usage.uncached, u.uncached), cacheRead: Math.max(usage.cacheRead, u.cacheRead), cacheWrite: Math.max(usage.cacheWrite, u.cacheWrite), cacheWrite1h: Math.max(usage.cacheWrite1h ?? 0, u.cacheWrite1h ?? 0), output: typeof j.usage.output_tokens === "number" ? j.usage.output_tokens : usage.output };
      gotUsage = true;
    }
    else if (t === "message_stop") stopped = true;
    else if (t === "content_block_delta") { const s = j.delta?.text ?? j.delta?.thinking ?? j.delta?.partial_json ?? ""; if (s && firstMs === null) firstMs = performance.now() - t0; chars += String(s).length; }
    else if (t === "error") failed = j.error?.message ?? "the provider stopped with an error";
  });
  const finish = (status: "ok" | "stopped" | "error") => {
    if (finished) return;
    finished = true;
    release(p.reservation); running.delete(rid);
    record(p, model, "anthropic", gotUsage ? usage : estimatedUsage(p, chars), { status: failed ? "error" : status, error: failed ?? undefined, ms: performance.now() - t0, firstMs, estimated: !gotUsage });
  };
  const reader = res.body!.getReader();
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          parser.end();
          const cut = !stopped && !failed;
          if (cut) failed = incomplete(model);
          finish("ok");
          if (cut) controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: failed } })}\n\n`));
          controller.close();
          return;
        }
        parser.push(value);
        controller.enqueue(value);
      } catch {
        finish(ac.signal.aborted ? "stopped" : "error");
        try { controller.close(); } catch {}
      }
    },
    cancel() { ac.abort(); finish("stopped"); try { reader.cancel(); } catch {} },
  });
  return new Response(out, { status: 200, headers: { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

// ---- the chat screen --------------------------------------------------------------

export type ChatEvent =
  | { type: "waiting"; message: string }
  | { type: "meta"; plan: ReturnType<typeof planView> }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "retry"; message: string }
  | { type: "done"; result: any }
  | { type: "error"; message: string; status: number };

export function planView(p: Plan) {
  return {
    model: { id: p.model.id, label: p.model.label, provider: p.model.provider },
    auto: p.auto,
    mode: p.mode,
    modeLabel: MODES[p.mode].label,
    task: p.guess.task,
    why: p.guess.why,
    alt: p.guess.alt,
    reason: p.reason,
    notes: p.notes,
    estimate: p.estimate,
    seconds: p.seconds,
    secondsMeasured: p.secondsMeasured,
    speed: p.speed,
    choices: p.choices,
    alternatives: p.alternatives,
    usual: p.usual ? { id: p.usual.id, label: p.usual.label } : null,
    switchedFrom: p.switchedFrom,
    effort: effortFor(p.model, p.effortAsked),
  };
}

export interface ChatOptions {
  effort?: string | null; // thinking effort (auto: each model's default)
  system?: string; // the chat's instructions, sent first as a system message
  meta?: Record<string, unknown>; // added to the answer's details (the answer it is compared with)
  source?: string; // where the ledger says it came from (default "chat"; the delegate's work is "delegate", its checks "check", the trial's "trial")
  guess?: Guess; // the task, when the caller knows it
  only?: (m: Model) => boolean; // a further limit on the models Auto may pick
  onlyWhy?: string; // what to say when that limit leaves no model
  maxOut?: number | null; // the answer limit, in tokens (the chat has none of its own)
  optional?: boolean; // work that can be skipped: never sent past the budget
  speed?: SpeedChoice; // cheapest, fastest or within N seconds (the delegate passes its own)
  job?: string; // the hand off this is for: the ledger marks each of its calls with it (delegate.ts)
  startWithin?: number; // ms: each try must start answering within this, or Auto passes it to the next pick (a plan's split)
}

// The chat's instructions go first, as a system message (Claude's translation moves it to "system").
export const withSystem = (messages: Msg[], system?: string): Msg[] => (system ? [{ role: "system", content: system }, ...messages] : messages);

export async function runChat(messages: Msg[], asked: string | null, signal: AbortSignal, emit: (e: ChatEvent) => void, label = "Chat", opts: ChatOptions = {}): Promise<{ text: string; meta: any; status: "ok" | "stopped" | "error" }> {
  const ac = linked(signal);
  const source = opts.source ?? "chat";
  if (paused) emit({ type: "waiting", message: "Paused. This message goes out when you press Start again." });
  let p: Plan;
  try {
    p = await plan({ source: "chat", asked, messages, system: opts.system || undefined, maxOut: opts.maxOut ?? null, signal: ac.signal, effort: opts.effort ?? null, guess: opts.guess, only: opts.only, onlyWhy: opts.onlyWhy, optional: opts.optional, speed: opts.speed, ledgerSource: opts.source });
  } catch (e: any) {
    const status = e instanceof UserError ? e.status : 500;
    const message = e instanceof UserError ? e.message : String(e?.message ?? e);
    const meta = { error: message, status: status === 499 ? "stopped" : "error", refused: true };
    emit({ type: "error", message, status });
    emit({ type: "done", result: meta }); // the page always learns how it ended
    return { text: "", meta, status: status === 499 ? "stopped" : "error" };
  }
  p.job = opts.job ?? null;
  p.startWithin = opts.startWithin ?? null;
  const picks = p.auto ? [...p.candidates] : []; // Auto's picks in order, to pass the request on
  const rid = register(source, `${label} · ${p.model.label}`, ac);
  emit({ type: "meta", plan: planView(p) });
  const body = { messages: withSystem(messages, opts.system) };

  // One try: send, then read the stream into text and thinking.
  // timedOut: "start", no first word in time (a failed try of its own: Auto passes it on); "idle", it went quiet part
  // way (cut off: asked again).
  interface Try { text: string; thinking: string; usage: Usage | null; reported: number | null; firstMs: number | null; failed: string | null; ended: boolean; finish: string | null; model: Model; t0: number; answered: boolean; timedOut: "start" | "idle" | null }
  const attempt = async (cap: number | null): Promise<Try> => {
    const t: Try = { text: "", thinking: "", usage: null, reported: null, firstMs: null, failed: null, ended: false, finish: null, model: p.model, t0: performance.now(), answered: false, timedOut: null };
    const notesBefore = p.notes.length;
    p.capOverride = cap;
    const tc = linked(ac.signal); // this try's own stop: Stop, or its time running out
    const wait = Math.min(startWait(p.model, effortFor(p.model, p.effortAsked)), p.startWithin ?? Infinity);
    let timer = setTimeout(() => { t.timedOut = "start"; tc.abort(); }, wait);
    const quiet = () => { clearTimeout(timer); timer = setTimeout(() => { t.timedOut = "idle"; tc.abort(); }, ANSWER_TIME.idle); };
    try {
      const sent = await sendWithFallback(p, source, body, true, tc.signal);
      t.model = sent.model; t.t0 = sent.t0; t.answered = true;
      if (p.notes.length > notesBefore) emit({ type: "meta", plan: planView(p) }); // Auto passed it on: say so
      for await (const { j, data } of openaiChunks(sent.res, t.model, t.model.apiId)) {
        if (!j) { if (data === "[DONE]") t.ended = true; continue; }
        const c = readChunk(j);
        if (c.finish) { t.ended = true; t.finish = c.finish; }
        if (c.usage) t.usage = c.usage;
        if (c.cost !== null) t.reported = c.cost;
        if (c.error) { t.failed = c.error; break; }
        if ((c.text || c.thinking) && t.firstMs === null) t.firstMs = performance.now() - t.t0;
        if (t.firstMs !== null) quiet(); // started: from now on, only a long silence ends it
        if (c.thinking) { t.thinking += c.thinking; emit({ type: "thinking", text: c.thinking }); }
        if (c.text) { t.text += c.text; emit({ type: "delta", text: c.text }); }
      }
      if (!t.ended && !t.failed && !ac.signal.aborted) t.failed = incomplete(t.model);
    } catch (e: any) {
      if (!ac.signal.aborted) t.failed = e instanceof UserError ? e.message : String(e?.message ?? e);
    } finally { clearTimeout(timer); }
    if (t.timedOut === "start") { t.model = p.model; t.failed = `${t.model.label} did not start answering within ${waitWords(wait)}.`; }
    else if (t.timedOut === "idle" && !ac.signal.aborted) t.failed = `${t.model.label} stopped sending for ${waitWords(ANSWER_TIME.idle)}.`;
    return t;
  };
  // The answer limit a try had: Leanfare's own, or the one Claude is always sent.
  // A cloud thinking model's room for thinking on top of Leanfare's own limit (send adds it; upstream.ts: thinkRoom).
  const room = (m: Model) => (m.provider === "ollama" || provider(m.provider)!.kind === "anthropic" ? 0 : thinkRoom(m, effortFor(m, p.effortAsked) ?? p.effortAsked));
  const limitOf = (m: Model): number | null => {
    const own = p.capOverride ?? (p.capped ? outCap(m) : null);
    if (own !== null) return Math.min(own + room(m), Math.max(own, 64000));
    return provider(m.provider)!.kind === "anthropic" ? anthropicDefaultMax(effortFor(m, p.effortAsked)) : null;
  };
  const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  // A try that failed before the provider answered was written down where it failed (sendWithFallback).
  const recordTry = (t: Try, status: "ok" | "stopped" | "error", error?: string, fail?: FailKind) =>
    status !== "error" || t.answered || t.usage
      ? record(p, t.model, source, t.usage ?? estimatedUsage(p, t.text.length + t.thinking.length), { status, error, ms: performance.now() - t.t0, firstMs: t.firstMs, reportedCost: t.reported, estimated: !t.usage, thinkingChars: t.thinking.length, fail })
      : null;

  // A model that ran out of room while thinking can hand its thinking back as the answer, under a first line "thought"
  // (29 Oct, Gemini through its OpenAI address). Cut off like that, it is thinking, not an answer: it is asked again
  // with more room, as one that wrote nothing.
  const leaked = (x: Try) => { if (x.finish === "length" && /^\s*thought\s*\n/i.test(x.text)) { x.thinking += x.text; x.text = ""; } return x; };
  // A try that did not start answering in time failed (timed out): it is kept as such, and Auto passes the work to its
  // next pick, at most twice; a model you named is not swapped.
  const recordStart = (x: Try) => record(p, x.model, source, null, { status: "error", error: x.failed ?? "timed out", ms: performance.now() - x.t0, fail: "timeout" });
  let t = leaked(await attempt(opts.maxOut ?? null));
  const passedOver = new Set<string>();
  for (let pass = 0; t.timedOut === "start" && p.auto && !ac.signal.aborted && pass < 2; pass++) {
    passedOver.add(t.model.id);
    const next = p.candidates.find((m) => !passedOver.has(m.id));
    if (!next || !reserveAgain(p, next, p.maxOut)) break;
    recordStart(t);
    p.notes.push(`${t.failed!.replace(/\.$/, "")}, so Auto passed the request to its next pick.`);
    p.model = next; p.candidates = p.candidates.filter((m) => !passedOver.has(m.id));
    emit({ type: "meta", plan: planView(p) });
    t = leaked(await attempt(opts.maxOut ?? null));
  }
  let retried = false;
  let written: ReturnType<typeof recordTry> | undefined; // the first try, when it was not asked again (already in the ledger)
  let firstSpent: number | null = 0; // a first try that was asked again: charged in the ledger too
  // An answer that came back empty, or was cut off on the way, is asked once more (noted on the answer).
  if (t.answered && !ac.signal.aborted && t.timedOut !== "start") {
    let why: { note: string; ledger: string; cap: number | null } | null = null;
    const name = t.model.label;
    if (t.failed) why = { note: t.text ? `The first answer was cut off after about ${words(t.text).toLocaleString("en-US")} words, so Leanfare asked again.` : `The first try stopped before ${name} answered, so Leanfare asked again.`, ledger: `cut off: ${t.failed}`, cap: null };
    else if (!t.text.trim() && t.finish === "length") {
      const limit = limitOf(t.model);
      const next = limit ? Math.min(2 * limit, 64000) : 0;
      if (limit) why = { note: `${name} spent its whole ${limit.toLocaleString("en-US")}-token answer limit thinking and wrote nothing, so Leanfare asked again with ${next.toLocaleString("en-US")}.`, ledger: "spent the answer limit thinking", cap: Math.max(1, next - room(t.model)) };
    } else if (!t.text.trim() && t.finish !== "content_filter") why = { note: `The first try came back empty, so Leanfare asked ${name} once more.`, ledger: "came back empty", cap: null };
    if (why) {
      const first = recordTry(t, "error", why.ledger, "cut"); // it answered, then was cut off or came back empty
      if (reserveAgain(p, t.model, why.cap ?? p.maxOut)) {
        firstSpent = first ? first.cost : 0;
        p.notes.push(why.note);
        p.model = t.model; p.candidates = [t.model]; // the same model again: the first try did reach it
        emit({ type: "retry", message: why.note });
        emit({ type: "meta", plan: planView(p) });
        retried = true;
        t = leaked(await attempt(why.cap ?? opts.maxOut ?? null));
      } else {
        p.notes.push(`${why.note.replace(/, so Leanfare .*$/, ".")} The budget does not leave room to ask again.`);
        written = first;
      }
    }
  }
  // Still empty, or cut off again, after the same model was asked once more (0.11.1): Auto passes the request to its
  // next pick, once, as it does a try that does not start in time, so a hand off is not lost to one model's empty
  // answers. A model you named is not swapped.
  if (retried && p.auto && !ac.signal.aborted && t.answered && t.timedOut !== "start" && (t.failed || (!t.text.trim() && t.finish !== "content_filter"))) {
    passedOver.add(t.model.id);
    const at = picks.findIndex((m) => m.id === t.model.id);
    const next = picks.slice(at + 1).find((m) => !passedOver.has(m.id));
    if (next && reserveAgain(p, next, p.maxOut)) {
      const again = recordTry(t, "error", t.failed ? `cut off: ${t.failed}` : t.finish === "length" ? "spent the answer limit thinking" : "came back empty", "cut");
      const cost = again ? again.cost : 0;
      firstSpent = firstSpent === null || cost === null ? null : firstSpent + cost;
      const note = `${t.model.label} ${t.failed ? "was cut off again" : "came back empty again"}, so Auto passed the request to its next pick.`;
      p.notes.push(note);
      p.model = next; p.candidates = picks.slice(picks.indexOf(next)).filter((m) => !passedOver.has(m.id));
      emit({ type: "retry", message: note });
      emit({ type: "meta", plan: planView(p) });
      t = leaked(await attempt(opts.maxOut ?? null));
    }
  }
  let { text, thinking, usage, firstMs, failed, finish: finishReason, model, t0 } = t;
  // What is still empty after that is an error you can see, with Try again.
  if (!failed && !ac.signal.aborted && t.answered && !text.trim()) {
    failed = finishReason === "content_filter" ? `${model.label} declined to answer this (its safety filter). Try rewording it, or another model.`
      : finishReason === "length" ? `${model.label} spent its whole answer limit thinking and wrote nothing. Lower the thinking effort${p.capped ? ", or raise the budget" : ""}, and try again.`
      : `${model.label} sent an empty answer.`;
  }
  if (finishReason === "length" && p.capped && text.trim()) p.notes.push(`The answer stopped at ${(p.capOverride ?? outCap(model)).toLocaleString("en-US")} tokens, the limit Leanfare sets while a budget is on. Ask it to continue, or raise the budget.`);
  const status: "ok" | "stopped" | "error" = ac.signal.aborted ? "stopped" : failed ? "error" : "ok";
  release(p.reservation);
  running.delete(rid);
  const r = written !== undefined ? written : t.timedOut === "start" && !ac.signal.aborted ? recordStart(t) : recordTry(t, status, failed ?? undefined);
  const cat = store.catalog;
  const meta = {
    ...planView(p),
    status,
    error: failed,
    usage: r?.usage ?? null,
    cost: r?.cost ?? null,
    listCost: r?.listCost ?? null,
    usualCost: r?.usualCost ?? null,
    priceStatus: r?.priceStatus ?? null,
    estimatedUsage: !usage,
    ms: Math.round(performance.now() - t0),
    firstMs: firstMs === null ? null : Math.round(firstMs),
    price: { input: model.input, output: model.output, cacheRead: model.cacheRead, cacheWrite: model.cacheWrite, cacheWrite1h: model.cacheWrite1h ?? null, above200k: model.above200k ?? null },
    priceSource: model.source === "openrouter" ? "OpenRouter's model list" : model.local ? "runs on this computer" : `llmledger data built ${cat.built.slice(0, 10)} (LiteLLM price list${cat.litellmCommit ? ` at ${cat.litellmCommit.slice(0, 7)}` : ""})`,
    priceCommit: model.source === "openrouter" || model.local ? null : cat.litellmCommit,
    thinkingChars: thinking.length,
    thinking: thinking ? thinking.slice(0, 200_000) : undefined,
    effort: effortFor(model, p.effortAsked),
    retried,
    finish: finishReason, // why the answer ended, as the provider said ("length": at the answer limit)
    spent: firstSpent === null || r?.cost === null ? null : firstSpent + (r?.cost ?? 0), // every try of this message, as charged
    ...(opts.meta ?? {}),
  };
  if (status === "error") emit({ type: "error", message: failed ?? "The answer failed.", status: 502 });
  emit({ type: "done", result: meta });
  return { text, meta, status };
}
