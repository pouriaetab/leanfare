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
import { saveSettings, settings } from "./settings";
import { localDay, now } from "./util";

export const platformOf = (m: Pick<Model, "provider" | "local">): string => (m.local ? "local" : m.provider === "openai" ? "chatgpt" : m.provider);
export const platformOn = (p: string): boolean => !(settings().appsOff ?? []).includes(p);
export const modelOn = (m: Pick<Model, "provider" | "local">): boolean => platformOn(platformOf(m));

// What a model's own terms let its company do with what is sent to it. Google's free key: people may read it, and
// Google asks that nothing sensitive or personal goes there (Gemini API Additional Terms, Unpaid Services, March
// 2026). OpenRouter's free models: their providers may keep it or train on it, as your OpenRouter settings allow.
export function readRisk(m: Pick<Model, "provider" | "free">): string | null {
  if (m.provider === "google" && settings().providers.google?.free) return "people may read it";
  if (m.free) return "its provider may train on it";
  return null;
}
export const RISK_WHY: Record<string, string> = {
  "people may read it": "Google's terms for a free Gemini key: people may read what is sent, and it is used to improve Google's products; Google asks that nothing sensitive or personal goes there. A paid key is not read or used that way.",
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
async function planWindows(p: "claude" | "chatgpt"): Promise<LimitWindow[]> {
  try { return windowsOf((await meterView(p)).windows); } catch { return []; }
}
function budgetLine(): string {
  const b = budgetState();
  return b.budget === null ? "Pay per use; no monthly budget is set." : `Pay per use: ${usd(Math.max(0, b.left ?? 0))} of your ${usd(b.budget)} monthly budget left.`;
}
const requestsToday = (prov: string): number => (db.query("SELECT COUNT(*) AS n FROM ledger WHERE day = ? AND provider = ? AND status != 'error'").get(localDay(), prov) as any).n;

// A plan's windows in words, the nearest first: "5 hours: 62% left (about 1.2M tokens), resets 4:10 PM · week: 81% left".
export function windowsText(ws: LimitWindow[], at = now().getTime()): string {
  const when = (iso: string) => {
    const d = new Date(iso), t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date(at).toDateString() ? t : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${t}`;
  };
  return ws.map((w) => `${w.kind}: ${w.left}% left${w.tokensLeft ? ` (about ${tok(w.tokensLeft)} tokens)` : ""}${w.resets ? `, resets ${when(w.resets)}` : ""}`).join(" · ");
}

export async function platformsView(): Promise<{ rows: PlatformRow[]; lines: string[] }> {
  const s = settings();
  const rows: PlatformRow[] = [];
  const row = (r: Omit<PlatformRow, "on" | "risk" | "riskWhy"> & { risk?: string | null }) => rows.push({ ...r, on: platformOn(r.id), risk: r.risk ?? null, riskWhy: r.risk ? RISK_WHY[r.risk] ?? null : null });
  // Claude: work goes to Claude's models with an Anthropic key; the plan's limits come from Claude Code's status line.
  const claude = await planWindows("claude");
  const anthropic = providerReady("anthropic");
  row({ id: "anthropic", label: "Claude", ready: anthropic, windows: claude, source: claude.length ? "your plan, from Claude Code's status line" : null,
    needs: anthropic ? null : "No Anthropic key: Leanfare sends Claude's models no work, and only shows your plan's limits.",
    limit: anthropic ? budgetLine() : claude.length ? null : "Your plan's limits show once Leanfare is in Claude Code's status line (Savings, Your subscriptions)." });
  // ChatGPT: OpenAI's models with a key, and Codex on your ChatGPT plan when plans may use it.
  const gpt = await planWindows("chatgpt");
  const openai = providerReady("openai");
  let codex = false;
  try { const c = await codexState(); codex = c.signedIn && c.login === "chatgpt" && s.codexPlan; } catch {}
  row({ id: "chatgpt", label: "ChatGPT", ready: openai || codex, windows: gpt, source: gpt.length ? "your plan, from Codex" : null,
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
    row({ id: p.id, label: provider(p.id)?.name ?? p.id, ready: true, windows: [], source: null, needs: null, limit: budgetLine(), risk: freeOnes ? "its provider may train on it" : null });
  }
  return { rows, lines: platformLines(rows) };
}

// The lines the MCP door's spend tool shows.
export function platformLines(rows: PlatformRow[]): string[] {
  return rows.filter((r) => r.ready || r.windows.length).map((r) => `${r.label}${r.ready && !r.on ? " (off for plans and the delegate)" : ""}${!r.ready ? " (not used: " + (r.needs ?? "").replace(/\.$/, "").toLowerCase() + ")" : ""}: ${[r.windows.length ? `${windowsText(r.windows)}${r.source ? ` (${r.source})` : ""}.` : null, r.limit].filter(Boolean).join(" ") || "no limit known."}`);
}
