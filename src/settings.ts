// Your choices: which models appear, how Auto picks, the budget and the
// subscription price to compare against. Stored as one row in the database.
import type { ProviderId } from "./config";
import { getSetting, putSetting } from "./db";
import type { CustomProvider } from "./providers";
import { parseSpeed, type SpeedChoice } from "./speed";

export type Mode = "save" | "balanced" | "best";
export type Effort = "auto" | "low" | "medium" | "high"; // auto: each model's own default
export type AtLimit = "cheapest" | "stop";

export interface ProviderSettings { on: boolean; free?: boolean }

// A plan you pay for outside Leanfare (Claude Max, ChatGPT Plus, Perplexity Pro...): its limits, and its price next to
// what your sessions would cost at API prices (subscriptions.ts).
export type PlanProvider = "claude" | "chatgpt" | "perplexity" | "google" | "copilot" | "cursor" | "grok";
// price: US dollars a month. since and until: the months the plan covers ("2026-07"); none: from always, to now.
export interface Plan { name: string; price: number; since?: string; until?: string }
export type Plans = Partial<Record<PlanProvider, Plan>>;
export const PLAN_KEYS: PlanProvider[] = ["claude", "chatgpt", "perplexity", "google", "copilot", "cursor", "grok"];
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Whether a plan covers a month.
export const covers = (p: Plan, month: string) => (!p.since || p.since <= month) && (!p.until || p.until >= month);

export interface Settings {
  mode: Mode;
  usual: string | null; // the model you would use without Leanfare; null: the best rated ticked model
  budget: number | null; // US dollars a month
  atLimit: AtLimit;
  subscription: number | null; // US dollars a month, to compare against
  plans: Plans; // your Claude and ChatGPT plans, to compare with the usage in their log files (see plans.ts)
  history: boolean; // keep chats on this computer
  ticked: string[]; // model ids shown in the chat and used by Auto
  providers: Partial<Record<ProviderId, ProviderSettings>>;
  successors: Record<string, string>; // your own choice of replacement for a retiring model
  allowOrigins: string[]; // web pages allowed to call the engine addresses (empty: none)
  instructions: string; // given to every new chat as its instructions (a system prompt); empty: none
  effort: Effort; // how hard thinking models think on the chat screen
  accessKey: string | null; // when set, other apps must send it (see lock.ts); null: no key needed
  custom: CustomProvider[]; // providers you added: a name and an address that speaks OpenAI's format (providers.ts)
  speed: SpeedChoice; // at the same quality: the cheapest, the fastest, or the cheapest expected within N seconds (speed.ts)
  updateCheck: boolean; // ask GitHub once a day whether a newer Leanfare is out (update.ts)
  showValue: boolean; // Savings: also show what subscription use would cost per use (at API prices); off: tokens and limits only
  brief: boolean; // the chat screen's answers: short (the answer first, a table or a short list), more only when asked
  planAuto: number; // a plan's paid parts run without asking while their estimate is at most this many US dollars (0: always ask)
  codexPlan: boolean; // a plan's reading, drafting and working out parts may run on your ChatGPT plan through Codex (codex.ts); off until you turn it on
  setupDone: boolean; // the first run's Set up was done (setup.ts); until then the app opens on it
}

export const DEFAULTS: Settings = {
  mode: "balanced",
  usual: null,
  budget: null,
  atLimit: "cheapest",
  subscription: null,
  plans: {},
  history: true,
  ticked: [],
  providers: {},
  successors: {},
  allowOrigins: [],
  instructions: "",
  effort: "auto",
  accessKey: null,
  custom: [],
  speed: "cheapest",
  updateCheck: true,
  showValue: false,
  brief: true,
  planAuto: 0,
  codexPlan: false,
  setupDone: false,
};

// What a short answer is, given to the chat screen's models before the chat's own instructions
// (26 Oct: the chat "went on explaining too much").
export const BRIEF = "Answer briefly. Lead with the answer itself. When it has parts, steps or options, give a short table or a numbered list instead of paragraphs. Keep it under about 150 words unless the person asks for more, for detail, or for a long piece of writing. No preamble, no restating the question, no offer at the end.";

export const MAX_INSTRUCTIONS = 20_000; // characters

export const MODES: Record<Mode, { label: string; margin: number; blurb: string }> = {
  save: { label: "Save more", margin: 80, blurb: "the cheapest model rated within 80 points of the best you ticked" },
  balanced: { label: "Balanced", margin: 40, blurb: "the cheapest model rated within 40 points of the best you ticked" },
  best: { label: "Best quality", margin: 15, blurb: "the cheapest model rated within 15 points of the best you ticked" },
};

let cache: Settings | null = null;

export function settings(): Settings {
  if (!cache) cache = { ...DEFAULTS, ...getSetting<Partial<Settings>>("settings", {}) };
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...settings(), ...patch };
  putSetting("settings", next);
  cache = next;
  return next;
}

export const resetSettingsCache = () => { cache = null; };

// Checks a change coming from the screen. Returns the clean patch or a sentence
// saying what is wrong.
export function validatePatch(p: any): { patch: Partial<Settings> } | { error: string } {
  const out: Partial<Settings> = {};
  if (p === null || typeof p !== "object") return { error: "expected an object of settings" };
  if ("mode" in p) { if (!(p.mode in MODES)) return { error: "mode must be save, balanced or best" }; out.mode = p.mode; }
  if ("usual" in p) { if (p.usual !== null && typeof p.usual !== "string") return { error: "usual must be a model id or null" }; out.usual = p.usual; }
  for (const k of ["budget", "subscription"] as const) {
    if (k in p) {
      if (p[k] === null || p[k] === "") out[k] = null;
      else { const v = Number(p[k]); if (!Number.isFinite(v) || v < 0 || v > 1_000_000) return { error: `${k} must be a dollar amount from 0 to 1,000,000` }; out[k] = Math.round(v * 100) / 100; }
    }
  }
  if ("plans" in p) {
    if (p.plans === null || typeof p.plans !== "object" || Array.isArray(p.plans)) return { error: "plans must be an object like {\"claude\": {\"name\": \"Claude Max\", \"price\": 100}}" };
    const plans: Plans = { ...settings().plans }; // the plans not named stay as they are
    for (const [k, v] of Object.entries(p.plans)) {
      if (!PLAN_KEYS.includes(k as PlanProvider)) return { error: `plans can hold ${PLAN_KEYS.join(", ")}` };
      if (v === null) { delete plans[k as PlanProvider]; continue; } // null removes that plan
      const w = v as any;
      const name = typeof w?.name === "string" ? w.name.trim().slice(0, 60) : "";
      const price = Number(w?.price);
      if (!name) return { error: `the ${k} plan needs a name` };
      if (w.price === "" || w.price === null || !Number.isFinite(price) || price < 0 || price > 100_000) return { error: `the ${k} plan's price must be a dollar amount a month from 0 to 100,000` };
      const plan: Plan = { name, price: Math.round(price * 100) / 100 };
      for (const end of ["since", "until"] as const) {
        const m = w[end];
        if (m === undefined || m === null || m === "") continue; // none: from always, or to now
        if (typeof m !== "string" || !MONTH_RE.test(m)) return { error: `the ${k} plan's ${end} must be a month like 2026-07` };
        plan[end] = m;
      }
      if (plan.since && plan.until && plan.since > plan.until) return { error: `the ${k} plan ends (${plan.until}) before it starts (${plan.since})` };
      plans[k as PlanProvider] = plan;
    }
    out.plans = plans;
  }
  if ("speed" in p) { const v = parseSpeed(p.speed); if (v === null) return { error: "speed must be cheapest, fastest, or a number of seconds from 1 to 3600" }; out.speed = v; }
  if ("atLimit" in p) { if (p.atLimit !== "cheapest" && p.atLimit !== "stop") return { error: "atLimit must be cheapest or stop" }; out.atLimit = p.atLimit; }
  if ("history" in p) out.history = !!p.history;
  if ("updateCheck" in p) out.updateCheck = !!p.updateCheck;
  for (const k of ["showValue", "brief", "codexPlan", "setupDone"] as const) {
    if (!(k in p)) continue;
    if (typeof p[k] !== "boolean") return { error: `${k} must be true or false` };
    out[k] = p[k];
  }
  if ("planAuto" in p) {
    if (typeof p.planAuto === "boolean") return { error: "planAuto must be a dollar amount from 0 to 1,000" };
    const v = p.planAuto === null || p.planAuto === "" ? 0 : Number(p.planAuto);
    if (!Number.isFinite(v) || v < 0 || v > 1000) return { error: "planAuto must be a dollar amount from 0 to 1,000" };
    out.planAuto = Math.round(v * 100) / 100;
  }
  if ("successors" in p) {
    if (typeof p.successors !== "object" || p.successors === null) return { error: "successors must be an object" };
    out.successors = Object.fromEntries(Object.entries(p.successors).filter(([a, b]) => typeof a === "string" && typeof b === "string")) as Record<string, string>;
  }
  if ("allowOrigins" in p) {
    if (!Array.isArray(p.allowOrigins) || p.allowOrigins.some((o: unknown) => typeof o !== "string" || !/^https?:\/\/[^/]+$/.test(o as string))) return { error: "allowOrigins must be a list like http://localhost:3000" };
    out.allowOrigins = p.allowOrigins;
  }
  if ("effort" in p) { if (!["auto", "low", "medium", "high"].includes(p.effort)) return { error: "effort must be auto, low, medium or high" }; out.effort = p.effort; }
  if ("instructions" in p) {
    if (typeof p.instructions !== "string" || p.instructions.length > MAX_INSTRUCTIONS) return { error: `instructions must be text of at most ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters` };
    out.instructions = p.instructions.trim();
  }
  return { patch: out };
}
