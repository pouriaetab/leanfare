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
export type PlanProvider = "claude" | "chatgpt" | "perplexity" | "google" | "copilot" | "cursor";
export interface Plan { name: string; price: number } // price: US dollars a month
export type Plans = Partial<Record<PlanProvider, Plan>>;
export const PLAN_KEYS: PlanProvider[] = ["claude", "chatgpt", "perplexity", "google", "copilot", "cursor"];

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
};

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
      plans[k as PlanProvider] = { name, price: Math.round(price * 100) / 100 };
    }
    out.plans = plans;
  }
  if ("speed" in p) { const v = parseSpeed(p.speed); if (v === null) return { error: "speed must be cheapest, fastest, or a number of seconds from 1 to 3600" }; out.speed = v; }
  if ("atLimit" in p) { if (p.atLimit !== "cheapest" && p.atLimit !== "stop") return { error: "atLimit must be cheapest or stop" }; out.atLimit = p.atLimit; }
  if ("history" in p) out.history = !!p.history;
  if ("updateCheck" in p) out.updateCheck = !!p.updateCheck;
  if ("showValue" in p) out.showValue = !!p.showValue;
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
