// Where Leanfare may send work for your apps (plans and the delegate): each platform on or off, and what is left
// before its nearest limit, read only through the doors the apps themselves give: Claude Code's status line for
// a Claude plan, Codex's own log files for a ChatGPT plan, and Leanfare's own count of what it sent. A
// platform is a company's models (ChatGPT: OpenAI's models and Codex), or the models on this computer. Off,
// plans and the delegate leave it out; the chat uses the models you ticked, as before.
import { budgetState } from "./budget";
import { codexState } from "./codex";
import { PROVIDERS, provider } from "./config";
import type { Model } from "./data";
import { db } from "./db";
import { providerReady } from "./engine";
import { meterView, type WindowView } from "./meter";
import { FREE_PLANS, onFreePlan } from "./freeplans";
import { saveSettings, settings } from "./settings";
import { localDay, now } from "./util";

export const platformOf = (m: Pick<Model, "provider" | "local">): string => (m.local ? "local" : m.provider === "openai" ? "chatgpt" : m.provider);
export const platformOn = (p: string): boolean => !(settings().appsOff ?? []).includes(p);
export const modelOn = (m: Pick<Model, "provider" | "local">): boolean => platformOn(platformOf(m));

// What a model's own terms let its company do with what is sent to it. Google's free key: people may read it, and
// Google asks that nothing sensitive or personal goes there (Gemini API Additional Terms, Unpaid Services, March
// 2026). Mistral's free Experiment plan: what is sent may be used to train its models. OpenRouter's free models:
// their providers may keep it or train on it, as your OpenRouter settings allow (freeplans.ts has the free plans).
export function readRisk(m: Pick<Model, "provider" | "free">): string | null {
  if (onFreePlan(m.provider)) { const r = FREE_PLANS[m.provider as keyof typeof FREE_PLANS]?.risk ?? null; if (r) return r; }
  if (m.free) return "its provider may train on it";
  return null;
}
export const RISK_WHY: Record<string, string> = {
  "people may read it": "Google's terms for a free Gemini key: people may read what is sent, and it is used to improve Google's products; Google asks that nothing sensitive or personal goes there. A paid key is not read or used that way.",
  "its company may train on it": "Mistral's free Experiment plan: what is sent through it may be used to train Mistral's models. A paid plan is not used that way.",
  "its provider may train on it": "A free model on OpenRouter: its provider may keep what is sent or train on it, as your OpenRouter privacy settings allow.",
};
// Whether a model may take a piece of work: a private one stays on this computer; one with files from your
// projects goes where Settings says (any platform that is on, not to a free tier that may be read, or this computer).
export function mayTake(m: Pick<Model, "provider" | "free" | "local">, work: { private?: boolean; files?: boolean }): boolean {
  if (work.private) return !!m.local;
  if (!work.files) return true;
  const to = settings().filesTo ?? "any";
  return to === "local" ? !!m.local : to === "notFree" ? !readRisk(m) : true;
}

export function setPlatform(id: string, on: boolean) {
  const off = new Set(settings().appsOff ?? []);
  if (on) off.delete(id); else off.add(id);
  saveSettings({ appsOff: [...off].sort() });
}

export interface LimitWindow { kind: string; left: number; tokensLeft: number | null; resets: string | null }
export interface PlatformRow {
  id: string; label: string; on: boolean; ready: boolean;
  needs: string | null; // what it needs before Leanfare can send it work
  windows: LimitWindow[]; // a plan's windows, the nearest first (the 5 hours before the week)
  limit: string | null; // the rest, in words: a free key's count today, a budget, no limit
  source: string | null; // where the numbers come from
  asOf: string | null; // when a plan's numbers were read (the app writes them only while it runs)
  stale: string | null; // when that was long ago: why the number may be behind, and what updates it
  risk: string | null; // a free tier whose terms let its company read or train on what is sent, and why (riskWhy)
  riskWhy: string | null;
}

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const usd = (v: number) => `$${v.toFixed(2)}`;
const ORDER = ["5 hours", "week"];
function windowsOf(ws: WindowView[]): LimitWindow[] {
  return ws.filter((w) => typeof w.used === "number").sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .map((w) => ({ kind: w.kind, left: Math.max(0, Math.round(100 - w.used)), tokensLeft: w.tokensLeft === null ? null : Math.round(w.tokensLeft), resets: w.resets }));
}
async function planView(p: "claude" | "chatgpt"): Promise<{ windows: LimitWindow[]; at: string | null }> {
  try { const v = await meterView(p); return { windows: windowsOf(v.windows), at: v.at }; } catch { return { windows: [], at: null }; }
}
// A plan's numbers are read from its own app, and only while that app runs: Claude Code's status line, Codex's
// log files. Claude's chats, Cowork and ChatGPT's app use the same limits but tell Leanfare nothing, so an old
// reading can be well behind (28 Oct: the week read 91% left when Claude's own page said 64% used).
export const STALE_AFTER = 60 * 60_000;
const STALE: Record<"claude" | "chatgpt", string> = {
  claude: "It may be behind: Claude's chats and Cowork use the same limits and tell Leanfare nothing. Any prompt in Claude Code updates it.",
  chatgpt: "It may be behind: ChatGPT's own app uses the same limits and tells Leanfare nothing. Any message in Codex updates it.",
};
const staleOf = (p: "claude" | "chatgpt", at: string | null) => (at && now().getTime() - Date.parse(at) > STALE_AFTER ? STALE[p] : null);
function budgetLine(): string {
  const b = budgetState();
  return b.budget === null ? "Pay per use; no monthly budget is set." : `Pay per use: ${usd(Math.max(0, b.left ?? 0))} of your ${usd(b.budget)} monthly budget left.`;
}
const requestsToday = (prov: string): number => (db.query("SELECT COUNT(*) AS n FROM ledger WHERE day = ? AND provider = ? AND status != 'error'").get(localDay(), prov) as any).n;

// A time in words: "4:10 PM" today, "Tue 4:10 PM" another day.
export function whenText(iso: string, at = now().getTime()): string {
  const d = new Date(iso), t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(at).toDateString() ? t : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${t}`;
}
// A plan's windows in words, the nearest first: "5 hours: 62% left (about 1.2M tokens), resets 4:10 PM · week: 81% left".
export function windowsText(ws: LimitWindow[], at = now().getTime()): string {
  return ws.map((w) => `${w.kind}: ${w.left}% left${w.tokensLeft ? ` (about ${tok(w.tokensLeft)} tokens)` : ""}${w.resets ? `, resets ${whenText(w.resets, at)}` : ""}`).join(" · ");
}

export async function platformsView(): Promise<{ rows: PlatformRow[]; lines: string[] }> {
  const s = settings();
  const rows: PlatformRow[] = [];
  const row = (r: Omit<PlatformRow, "on" | "risk" | "riskWhy" | "asOf" | "stale"> & { risk?: string | null; asOf?: string | null; stale?: string | null }) =>
    rows.push({ ...r, on: platformOn(r.id), risk: r.risk ?? null, riskWhy: r.risk ? RISK_WHY[r.risk] ?? null : null, asOf: r.asOf ?? null, stale: r.stale ?? null });
  // Claude: work goes to Claude's models with an Anthropic key; the plan's limits come from Claude Code's status line.
  const cv = await planView("claude"), claude = cv.windows;
  const anthropic = providerReady("anthropic");
  row({ id: "anthropic", label: "Claude", ready: anthropic, windows: claude, source: claude.length ? "your plan, from Claude Code's status line" : null,
    asOf: claude.length ? cv.at : null, stale: claude.length ? staleOf("claude", cv.at) : null,
    needs: anthropic ? null : "No Anthropic key: Leanfare sends Claude's models no work, and only shows your plan's limits.",
    limit: anthropic ? budgetLine() : claude.length ? null : "Your plan's limits show once Leanfare is in Claude Code's status line (Savings, Your subscriptions)." });
  // ChatGPT: OpenAI's models with a key, and Codex on your ChatGPT plan when plans may use it.
  const gv = await planView("chatgpt"), gpt = gv.windows;
  const openai = providerReady("openai");
  let codex = false;
  try { const c = await codexState(); codex = c.signedIn && c.login === "chatgpt" && s.codexPlan; } catch {}
  row({ id: "chatgpt", label: "ChatGPT", ready: openai || codex, windows: gpt, source: gpt.length ? "your plan, from Codex" : null,
    asOf: gpt.length ? gv.at : null, stale: gpt.length ? staleOf("chatgpt", gv.at) : null,
    needs: openai || codex ? null : "Add an OpenAI key, or let plans use Codex on your ChatGPT plan (Your ChatGPT plan, through Codex).",
    limit: [codex ? "Plans' parts run on Codex, on your plan." : null, openai ? budgetLine() : null].filter(Boolean).join(" ") || null });
  // Gemini: a free key's requests through Leanfare today (Google does not say its free limits ahead).
  const google = providerReady("google");
  const free = !!s.providers.google?.free;
  const n = requestsToday("google");
  row({ id: "google", label: "Gemini", ready: google, windows: [], source: null, risk: google && free ? "people may read it" : null,
    needs: google ? null : "Add a Gemini key to use it (Google gives a free one).",
    limit: !google ? null : free ? `Free key: ${n.toLocaleString("en-US")} request${n === 1 ? "" : "s"} through Leanfare today (Google sets its free limits and does not say them ahead).` : budgetLine() });
  // Grok.
  const xai = providerReady("xai");
  row({ id: "xai", label: "Grok", ready: xai, windows: [], source: null, needs: xai ? null : "Add an xAI key to use it.", limit: xai ? budgetLine() : null });
  // The models on this computer: free, with no limit but the computer's own.
  const local = PROVIDERS.some((p) => p.local && providerReady(p.id)) || providerReady("ollama");
  row({ id: "local", label: "On this computer", ready: local, windows: [], source: null, needs: local ? null : "Start Ollama (Settings, Local models).", limit: local ? "No limit: free." : null });
  // The other companies you have a key for.
  for (const p of PROVIDERS) {
    if (["openai", "anthropic", "google", "xai", "ollama"].includes(p.id) || p.local || !providerReady(p.id)) continue;
    const freeOnes = p.id === "openrouter" && settings().ticked.some((id) => id.startsWith("openrouter/") && id.endsWith(":free"));
    // A free plan you said you are on (Groq's, Mistral's): its requests through Leanfare today, and its own limits.
    const plan = onFreePlan(p.id) ? FREE_PLANS[p.id as keyof typeof FREE_PLANS]! : null, n = plan ? requestsToday(p.id) : 0;
    const limit = plan ? `Free plan: ${n.toLocaleString("en-US")} request${n === 1 ? "" : "s"} through Leanfare today${plan.tokensPerMinute ? `; at most ${tok(plan.tokensPerMinute)} tokens a minute, so bigger work goes to another model` : ""}.` : budgetLine();
    row({ id: p.id, label: provider(p.id)?.name ?? p.id, ready: true, windows: [], source: null, needs: null, limit, risk: plan?.risk ?? (freeOnes ? "its provider may train on it" : null) });
  }
  return { rows, lines: platformLines(rows) };
}

// The lines the MCP door's spend tool shows.
export function platformLines(rows: PlatformRow[]): string[] {
  return rows.filter((r) => r.ready || r.windows.length).map((r) => `${r.label}${r.ready && !r.on ? " (off for plans and the delegate)" : ""}${!r.ready ? " (not used: " + (r.needs ?? "").replace(/\.$/, "").toLowerCase() + ")" : ""}: ${[r.windows.length ? `${windowsText(r.windows)}${r.source ? ` (${r.source}${r.asOf ? `, as of ${whenText(r.asOf)}` : ""})` : ""}.` : null, r.stale, r.limit].filter(Boolean).join(" ") || "no limit known."}`);
}
