// The engine. Every request, from the chat screen or from another app, takes
// the same steps: wait while paused, choose the model, reserve the budget,
// send, count the tokens, record the cost.
import { baseOf, provider, runtime, type ProviderId } from "./config";
import { getModel, isRetired, served, store, type Model } from "./data";
import { isLocalFound } from "./providers";
import { ZERO, costOf, fromAnthropicUsage, fromOpenAIUsage, mediaIn, promptMax, promptTokens, type Usage } from "./cost";
import { db } from "./db";
import { getKey } from "./keys";
import { MODES, settings, type Mode } from "./settings";
import { estimateFor, expectedOutput, guessTask, ledgerWhy, pickModel, resolveModel, type Candidate, type Guess, type Msg } from "./router";
import { forgetSpeeds, parseSpeed, secondsFor, type SpeedChoice } from "./speed";
import { successor } from "./retire";
import { addSpent, budgetState, release, tryReserve, wouldFit } from "./budget";
import { AnthropicStreamTranslator, UserError, anthropicDefaultMax, anthropicToOpenAI, effortFor, headersFor, networkError, openaiBody, plainError, toAnthropic } from "./upstream";
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

export function usableModels(only?: (m: Model) => boolean): Model[] {
  return settings().ticked.map((id) => getModel(id)).filter((m): m is Model => !!m && providerReady(m.provider) && served(m) && (!only || only(m)));
}

// The "usual model" savings are measured against: your choice, or the best rated model you ticked.
export function usualModel(): Model | null {
  const s = settings();
  if (s.usual) { const m = getModel(s.usual); if (m) return m; }
  const rated = usableModels().filter((m) => m.ratings.overall !== undefined && m.input !== null);
  return rated.sort((a, b) => b.ratings.overall - a.ratings.overall)[0] ?? null;
}

// What an answer costs you, which is not always its list price.
export function chargeOf(m: Model, listCost: number | null): { cost: number | null; status: string } {
  if (m.local) return { cost: 0, status: "local" };
  if (m.free) return { cost: 0, status: "free" };
  if (m.provider === "google" && settings().providers.google?.free) return { cost: 0, status: "free plan" };
  if (listCost === null) return { cost: null, status: "unknown" };
  return { cost: listCost, status: "listed" };
}

// ---- answer lengths seen before (for estimates) --------------------------------

// Answers sent with a thinking effort are compared with answers at the same effort first.
let hist = { at: 0, map: new Map<string, number | null>() };
export function outputHistory(task: string, model: string | null, effort: string | null = null): number | null {
  if (effort) { const v = lengthsSeen(task, model, effort); if (v !== null) return v; }
  return lengthsSeen(task, model, null);
}
function lengthsSeen(task: string, model: string | null, effort: string | null): number | null {
  if (Date.now() - hist.at > 60_000) hist = { at: Date.now(), map: new Map() };
  const k = `${task}|${model ?? ""}|${effort ?? ""}`;
  if (hist.map.has(k)) return hist.map.get(k)!;
  const since = new Date(now().getTime() - 30 * 86_400_000).toISOString();
  const where = ["task = ?", "status = 'ok'", "ts >= ?", ...(model ? ["model = ?"] : []), ...(effort ? ["effort = ?"] : [])].join(" AND ");
  const args = [task, since, ...(model ? [model] : []), ...(effort ? [effort] : [])];
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
  effort?: string | null; // thinking effort asked for (the chat screen); sent only to models that take it
  copies?: number; // answers asked for at once (OpenAI's n): each is billed
  guess?: Guess; // the task, when the caller knows it (the delegate): used instead of the guess
  only?: (m: Model) => boolean; // a further limit on the models Auto may pick (the delegate: long enough, stronger)
  onlyWhy?: string; // what to say when that limit leaves no model
  optional?: boolean; // work that can be skipped (the delegate's check): never sent past the budget
  speed?: SpeedChoice; // cheapest, fastest or within N seconds (speed.ts); default: Settings
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
  const base = media.images || media.pdfs ? (m: Model) => (!byAddress || byAddress(m)) && takes(m) : byAddress;
  const extra = input.only;
  const only = extra ? (m: Model) => (!base || base(m)) && extra(m) : base;
  const mediaWords = [media.images ? "images" : "", media.pdfs ? "PDFs" : ""].filter(Boolean).join(" and ");
  const amode = autoMode(input.asked, input.mode ?? s.mode);
  const mode = amode ?? input.mode ?? s.mode;
  const inTok = promptTokens(input.messages as any, input.system);
  const inMax = promptMax(input.messages, input.system, input.tools);
  const capped = s.budget !== null && input.maxOut === null;
  const speed: SpeedChoice = input.speed ?? s.speed ?? "cheapest";
  const copies = Math.max(1, Math.min(128, Math.floor(input.copies ?? 1)));
  let model: Model, guess: Guess, reason: string, candidates: Model[] = [];
  let alternatives: Plan["alternatives"] = [];
  let choices: Plan["choices"] = null;
  if (amode) {
    const usable = usableModels(only);
    if (!usable.length && extra && usableModels(base).length) throw new UserError(400, input.onlyWhy ?? "None of the models you ticked can take this request.", "no_model_fits");
    if (!usable.length && mediaWords && usableModels(byAddress).length) {
      throw new UserError(400, `None of the models you ticked takes ${mediaWords} through Leanfare. In Settings, tick one that does: ${media.pdfs ? "a Claude or GPT model reads PDFs" : "most Claude, GPT and Gemini models see images"}.`, "unsupported_attachment");
    }
    if (!usable.length) {
      throw new UserError(400, input.source === "anthropic"
        ? "No Claude model is ready. Add an Anthropic key in Leanfare's Settings and tick a Claude model."
        : input.hasTools
          ? "No model that takes tools on this address is ready. Claude models take tools through /v1/messages; tick a model from another provider for this address."
          : `No model is ready yet. Open Leanfare at http://127.0.0.1:${runtime.port}, add a key and tick a model, or start Ollama.`, "no_model_ready");
    }
    const effortAsked = input.effort ?? null;
    const p = pickModel(input.messages, usable, amode, (t, mid) => outputHistory(t, mid, effortAsked && mid ? effortFor(getModel(mid)!, effortAsked) : null), input.system, input.guess,
      speed, (m, out) => secondsFor(m, out, effortAsked ? effortFor(m, effortAsked) : null));
    if (p) {
      model = p.model; guess = p.guess; reason = p.reason;
      candidates = p.candidates.map((c) => c.model);
      alternatives = p.candidates.slice(1, 4).map((c) => ({ id: c.model.id, label: c.model.label, estimate: chargeOf(c.model, c.estimate).cost, rating: c.rating === null ? null : Math.round(c.rating), seconds: c.seconds ?? null }));
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
    const fits = input.dry ? wouldFit(most) : !!(reservation = tryReserve(most));
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
  const outGuess = expectedOutput(guess.task, model, (t, mid) => outputHistory(t, mid, effortFor(model, effortAsked)));
  const estimate = chargeOf(model, estimateFor(model, inTok, outGuess)).cost;
  const time = secondsFor(model, outGuess, effortFor(model, effortAsked));
  const cheapestId = s.budget !== null ? cheapest(only, inTok)?.id ?? null : null;
  return { model, auto: !!amode, mode, guess, reason, estimate, seconds: time.seconds, secondsMeasured: time.measured, speed, choices, candidates, alternatives, usual: usualModel(), switchedFrom, notes, reservation, inTok, inMax, maxOut: input.maxOut, capped, asked: input.asked, effortAsked, copies, cheapestId, optional: input.optional };
}

// ---- the ledger --------------------------------------------------------------

export interface LedgerResult { cost: number | null; listCost: number | null; priceStatus: string; usage: Usage; usualCost: number | null }

const INSERT = `INSERT INTO ledger(ts, month, day, source, provider, model, asked, task, mode, auto, reason, usual, usual_cost,
    in_tokens, cached, cache_write, out_tokens, cost, list_cost, price_status, usage_status, status, error, ms, first_ms, switched_from, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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

export function record(p: Plan, m: Model, source: string, usage: Usage | null, o: { status: "ok" | "stopped" | "error"; error?: string; ms: number; firstMs?: number | null; reportedCost?: number | null; estimated?: boolean }): LedgerResult {
  const u = usage ?? ZERO;
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
    effortFor(m, p.effortAsked),
  ];
  unwritten.push(row);
  if (!retryTimer) writeRows();
  forgetSpeeds(m.id); // this answer's time counts in the next estimate
  if (unwritten.length && !retryTimer) retryTimer = setTimeout(writeRows, 1000);
  if (unwritten.length === 1 && retryTimer) console.error("leanfare: the database is busy; the cost ledger will be written when it is free.");
  if (billed) addSpent(charge.cost, month);
  return { cost: billed ? charge.cost : 0, listCost: billed ? list : 0, priceStatus, usage: u, usualCost };
}

// ---- sending -------------------------------------------------------------------

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function send(m: Model, body: any, stream: boolean, signal: AbortSignal, native: boolean, extraHeaders: Record<string, string>, cap: number | null, effortAsked: string | null = null): Promise<Response> {
  const def = provider(m.provider)!;
  const effort = effortFor(m, effortAsked);
  const base = baseOf(m.provider);
  let url: string, payload: any;
  if (native) {
    url = `${base}/v1/messages`;
    payload = { ...body, model: m.apiId };
    if (cap && payload.max_tokens == null) payload.max_tokens = cap;
  } else if (def.kind === "anthropic") {
    url = `${base}/v1/messages`;
    payload = toAnthropic(cap && body.max_tokens == null && body.max_completion_tokens == null ? { ...body, max_tokens: cap } : body, m, stream, effort);
  } else {
    url = `${base}/chat/completions`;
    payload = openaiBody(m, body, stream, effort);
    // OpenAI's newer models take only max_completion_tokens; the others take max_tokens.
    if (cap && payload.max_tokens == null && payload.max_completion_tokens == null) payload[m.provider === "openai" ? "max_completion_tokens" : "max_tokens"] = cap;
  }
  const sig = stream ? signal : AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
  return fetch(url, { method: "POST", headers: { ...headersFor(def, getKey(m.provider)), ...extraHeaders }, body: JSON.stringify(payload), signal: sig });
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
      record(p, m, source, null, { status: "error", error: msg, ms: performance.now() - t0 });
      last = new UserError(page ? 502 : res.status === 401 || res.status === 403 ? 502 : res.status, msg, "provider_error");
      if ((!page && !RETRYABLE.has(res.status)) || i === tries.length - 1) throw last;
      p.notes.push(`${m.label} ${page ? "sent a web page instead of an answer" : `answered ${res.status}`}, so Auto passed the request to its next pick.`);
    } catch (e: any) {
      if (e instanceof UserError) throw e;
      if (signal.aborted) throw new UserError(499, "Stopped.", "stopped");
      const msg = networkError(provider(m.provider)!, e);
      record(p, m, source, null, { status: "error", error: msg, ms: performance.now() - t0 });
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

// Any provider's stream as OpenAI-format chunks (Claude's is translated).
async function* openaiChunks(res: Response, m: Model, modelName: string): AsyncGenerator<{ data: string; j: any }> {
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
// x-leanfare-speed: cheapest, fastest, or a number of seconds to answer within.
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
    p = await plan({ source: "openai", asked: typeof body.model === "string" ? body.model : null, messages: body.messages, tools: body.tools ?? body.functions, hasTools, maxOut: toNum(body.max_completion_tokens ?? body.max_tokens), mode: headerMode(req), speed: headerSpeed(req), signal: ac.signal, copies: toNum(body.n) ?? 1 });
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
      // One whole answer; an empty one (no text, no tool call, not declined) is asked for once more.
      const read = async (r: Response, t: number) => {
        const text = await r.text();
        let j: any;
        try { j = JSON.parse(text); } catch { throw new UserError(502, `${def.name} sent an answer Leanfare could not read.`, "bad_provider_answer"); }
        const oj = def.kind === "anthropic" ? anthropicToOpenAI(j, name) : j;
        const msg = oj.choices?.[0]?.message ?? {};
        const answer = typeof msg.content === "string" ? msg.content : "";
        const empty = !answer.trim() && !msg.tool_calls?.length && !msg.function_call && oj.choices?.[0]?.finish_reason !== "content_filter";
        const usage = def.kind === "anthropic" ? fromAnthropicUsage(j.usage) : fromOpenAIUsage(j.usage);
        return { out: def.kind === "anthropic" ? JSON.stringify(oj) : text, answer, empty, usage, reported: reportedCost(j.usage), t };
      };
      let a = await read(res, t0);
      if (a.empty && !ac.signal.aborted) {
        const firstTry = record(p, model, "openai", a.usage ?? estimatedUsage(p, 0), { status: "error", error: "came back empty", ms: performance.now() - a.t, reportedCost: a.reported, estimated: !a.usage });
        if (reserveAgain(p, model, p.maxOut)) {
          p.notes.push(`The first try came back empty, so Leanfare asked ${model.label} once more.`);
          p.candidates = [model];
          const again = await sendWithFallback(p, "openai", body, false, ac.signal);
          a = await read(again.res, again.t0);
        } else {
          // The empty answer goes back as it came (it is already in the ledger, at what it cost).
          p.notes.push("The answer came back empty, and the budget does not leave room to ask again.");
          Object.assign(headers, leanHeaders(p, model));
          headers["x-leanfare-cost-usd"] = firstTry.cost === null ? "unknown" : usd8(firstTry.cost);
          return new Response(a.out, { status: 200, headers: { ...headers, "content-type": "application/json" } });
        }
        Object.assign(headers, leanHeaders(p, model));
      }
      const r = record(p, model, "openai", a.usage ?? estimatedUsage(p, a.answer.length), { status: "ok", ms: performance.now() - a.t, reportedCost: a.reported, estimated: !a.usage });
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
}

// The chat's instructions go first, as a system message (Claude's translation moves it to "system").
export const withSystem = (messages: Msg[], system?: string): Msg[] => (system ? [{ role: "system", content: system }, ...messages] : messages);

export async function runChat(messages: Msg[], asked: string | null, signal: AbortSignal, emit: (e: ChatEvent) => void, label = "Chat", opts: ChatOptions = {}): Promise<{ text: string; meta: any; status: "ok" | "stopped" | "error" }> {
  const ac = linked(signal);
  const source = opts.source ?? "chat";
  if (paused) emit({ type: "waiting", message: "Paused. This message goes out when you press Start again." });
  let p: Plan;
  try {
    p = await plan({ source: "chat", asked, messages, system: opts.system || undefined, maxOut: opts.maxOut ?? null, signal: ac.signal, effort: opts.effort ?? null, guess: opts.guess, only: opts.only, onlyWhy: opts.onlyWhy, optional: opts.optional, speed: opts.speed });
  } catch (e: any) {
    const status = e instanceof UserError ? e.status : 500;
    const message = e instanceof UserError ? e.message : String(e?.message ?? e);
    const meta = { error: message, status: status === 499 ? "stopped" : "error", refused: true };
    emit({ type: "error", message, status });
    emit({ type: "done", result: meta }); // the page always learns how it ended
    return { text: "", meta, status: status === 499 ? "stopped" : "error" };
  }
  const rid = register(source, `${label} · ${p.model.label}`, ac);
  emit({ type: "meta", plan: planView(p) });
  const body = { messages: withSystem(messages, opts.system) };

  // One try: send, then read the stream into text and thinking.
  interface Try { text: string; thinking: string; usage: Usage | null; reported: number | null; firstMs: number | null; failed: string | null; ended: boolean; finish: string | null; model: Model; t0: number; answered: boolean }
  const attempt = async (cap: number | null): Promise<Try> => {
    const t: Try = { text: "", thinking: "", usage: null, reported: null, firstMs: null, failed: null, ended: false, finish: null, model: p.model, t0: performance.now(), answered: false };
    const notesBefore = p.notes.length;
    p.capOverride = cap;
    try {
      const sent = await sendWithFallback(p, source, body, true, ac.signal);
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
        if (c.thinking) { t.thinking += c.thinking; emit({ type: "thinking", text: c.thinking }); }
        if (c.text) { t.text += c.text; emit({ type: "delta", text: c.text }); }
      }
      if (!t.ended && !t.failed && !ac.signal.aborted) t.failed = incomplete(t.model);
    } catch (e: any) {
      if (!ac.signal.aborted) t.failed = e instanceof UserError ? e.message : String(e?.message ?? e);
    }
    return t;
  };
  // The answer limit a try had: Leanfare's own, or the one Claude is always sent.
  const limitOf = (m: Model): number | null => p.capOverride ?? (p.capped ? outCap(m) : provider(m.provider)!.kind === "anthropic" ? anthropicDefaultMax(effortFor(m, p.effortAsked)) : null);
  const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  // A try that failed before the provider answered was written down where it failed (sendWithFallback).
  const recordTry = (t: Try, status: "ok" | "stopped" | "error", error?: string) =>
    status !== "error" || t.answered || t.usage
      ? record(p, t.model, source, t.usage ?? estimatedUsage(p, t.text.length + t.thinking.length), { status, error, ms: performance.now() - t.t0, firstMs: t.firstMs, reportedCost: t.reported, estimated: !t.usage })
      : null;

  let t = await attempt(opts.maxOut ?? null);
  let retried = false;
  let written: ReturnType<typeof recordTry> | undefined; // the first try, when it was not asked again (already in the ledger)
  let firstSpent: number | null = 0; // a first try that was asked again: charged in the ledger too
  // An answer that came back empty, or was cut off on the way, is asked once more (noted on the answer).
  if (t.answered && !ac.signal.aborted) {
    let why: { note: string; ledger: string; cap: number | null } | null = null;
    const name = t.model.label;
    if (t.failed) why = { note: t.text ? `The first answer was cut off after about ${words(t.text).toLocaleString("en-US")} words, so Leanfare asked again.` : `The first try stopped before ${name} answered, so Leanfare asked again.`, ledger: `cut off: ${t.failed}`, cap: null };
    else if (!t.text.trim() && t.finish === "length") {
      const limit = limitOf(t.model);
      if (limit) why = { note: `${name} spent its whole ${limit.toLocaleString("en-US")}-token answer limit thinking and wrote nothing, so Leanfare asked again with ${Math.min(2 * limit, 64000).toLocaleString("en-US")}.`, ledger: "spent the answer limit thinking", cap: Math.min(2 * limit, 64000) };
    } else if (!t.text.trim() && t.finish !== "content_filter") why = { note: `The first try came back empty, so Leanfare asked ${name} once more.`, ledger: "came back empty", cap: null };
    if (why) {
      const first = recordTry(t, "error", why.ledger);
      if (reserveAgain(p, t.model, why.cap ?? p.maxOut)) {
        firstSpent = first ? first.cost : 0;
        p.notes.push(why.note);
        p.model = t.model; p.candidates = [t.model]; // the same model again: the first try did reach it
        emit({ type: "retry", message: why.note });
        emit({ type: "meta", plan: planView(p) });
        retried = true;
        t = await attempt(why.cap ?? opts.maxOut ?? null);
      } else {
        p.notes.push(`${why.note.replace(/, so Leanfare .*$/, ".")} The budget does not leave room to ask again.`);
        written = first;
      }
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
  const r = written !== undefined ? written : recordTry(t, status, failed ?? undefined);
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
