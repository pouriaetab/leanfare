// The subscriptions people pay for: their usual prices and the kinds of limits each has, so
// Leanfare can show a plan's limits and not only dollars. Prices and limits as each company's own
// pages said on 26 Oct 2026; your price may differ (yearly billing, taxes, a business seat), so
// every one can be edited.
//
// Where Leanfare can read your use of a plan on this computer without signing in anywhere:
//   - Claude: Claude Code's status line hands it the 5 hour and weekly percentages (statusline.ts).
//   - ChatGPT: Codex writes them in its own log files, with the plan's name (plans.ts).
// The others (Perplexity, Google AI, GitHub Copilot, Cursor) keep no usage numbers on the computer
// and have no public way to read them, so Leanfare shows their limits and a link to their own page.
import type { PlanProvider } from "./settings";

export interface Preset { name: string; price: number | null; limits: string }
export interface SubInfo { label: string; logs: string | null; usageUrl: string | null; presets: Preset[]; limits: string; note: string }

export const SUBSCRIPTIONS: Record<PlanProvider, SubInfo> = {
  claude: {
    label: "Claude", logs: "Claude Code", usageUrl: "https://claude.ai/settings/usage", limits: "a 5 hour session limit and a weekly limit",
    presets: [
      { name: "Claude Pro", price: 20, limits: "a 5 hour session limit and a weekly limit" },
      { name: "Claude Max 5x", price: 100, limits: "5 times Pro's session limit, and a weekly limit" },
      { name: "Claude Max 20x", price: 200, limits: "20 times Pro's session limit, and a weekly limit" },
    ],
    note: "Claude's two percentages come from Claude Code's status line once Leanfare is in it.",
  },
  chatgpt: {
    label: "ChatGPT", logs: "Codex", usageUrl: "https://chatgpt.com/codex/settings/usage", limits: "Codex: a 5 hour limit and a weekly limit, by plan",
    presets: [
      { name: "ChatGPT Go", price: 8, limits: "higher limits than Free; numbers not published" },
      { name: "ChatGPT Plus", price: 20, limits: "Codex: a 5 hour limit and a weekly limit" },
      { name: "ChatGPT Pro", price: 200, limits: "Codex: a weekly allowance, no 5 hour limit" },
      { name: "ChatGPT Business", price: 25, limits: "per seat, the same Codex limits as Plus" },
    ],
    note: "Codex writes how much of its limits each message used, and which plan you are on.",
  },
  perplexity: {
    label: "Perplexity", logs: null, usageUrl: "https://www.perplexity.ai/account/usage", limits: "weekly and monthly limits, by plan",
    presets: [
      { name: "Perplexity Pro", price: 20, limits: "weekly limits on Pro Searches and uploads, monthly limits on Research; numbers not published" },
      { name: "Perplexity Max", price: 200, limits: "10,000 credits a month, unlimited Ask searches" },
    ],
    note: "Perplexity keeps no usage numbers on this computer: its own usage page shows the weekly bar.",
  },
  google: {
    label: "Google AI", logs: null, usageUrl: null, limits: "limits that refresh every 5 hours up to a weekly cap, by plan",
    presets: [
      { name: "Google AI Plus", price: 4.99, limits: "limits that refresh every 5 hours up to a weekly cap: 2 times Free" },
      { name: "Google AI Pro", price: 19.99, limits: "limits that refresh every 5 hours up to a weekly cap: 4 times Free" },
      { name: "Google AI Ultra", price: 99.99, limits: "limits that refresh every 5 hours up to a weekly cap: 5 times Pro" },
    ],
    note: "Google keeps no usage numbers for the Gemini app on this computer.",
  },
  copilot: {
    label: "GitHub Copilot", logs: null, usageUrl: "https://github.com/settings/copilot", limits: "monthly AI credits, by plan",
    presets: [
      { name: "Copilot Pro", price: 10, limits: "1,500 AI credits a month, resetting on the 1st" },
      { name: "Copilot Pro+", price: 39, limits: "7,000 AI credits a month, resetting on the 1st" },
    ],
    note: "GitHub shows your monthly credits on its own page.",
  },
  cursor: {
    label: "Cursor", logs: null, usageUrl: "https://cursor.com/dashboard", limits: "monthly pools of usage, reset with your billing",
    presets: [
      { name: "Cursor Pro", price: 20, limits: "two monthly pools of usage, reset with your billing" },
      { name: "Cursor Ultra", price: 200, limits: "larger monthly pools, reset with your billing" },
    ],
    note: "Cursor shows your usage on its own dashboard.",
  },
};

// The plan Codex says you are on (its logs' plan_type), as a plan Leanfare can show. Prices only
// where OpenAI's pages make the match plain; the others ask you for the price.
const CHATGPT: Record<string, { name: string; price: number | null }> = {
  free: { name: "ChatGPT Free", price: 0 }, go: { name: "ChatGPT Go", price: 8 }, plus: { name: "ChatGPT Plus", price: 20 },
  pro: { name: "ChatGPT Pro", price: 200 }, prolite: { name: "ChatGPT Pro (a lighter tier)", price: null }, promax: { name: "ChatGPT Pro (the top tier)", price: null },
  team: { name: "ChatGPT Business", price: 25 }, business: { name: "ChatGPT Business", price: 25 }, enterprise: { name: "ChatGPT Enterprise", price: null },
  edu: { name: "ChatGPT Edu", price: null },
};
export function chatgptPlan(planType: string | null): { name: string; price: number | null; from: string } | null {
  if (!planType) return null;
  const k = planType.toLowerCase();
  const hit = CHATGPT[k] ?? (k.startsWith("enterprise") ? CHATGPT.enterprise : k.startsWith("edu") ? CHATGPT.edu : k.includes("business") ? CHATGPT.business : null);
  return hit ? { ...hit, from: planType } : null;
}

// The limits of the plan you entered: its preset by name; else the preset whose own words are all in
// it ("Max 20x" for "claude max 20x plan"); else the kind of limits every plan of it has.
const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
export function presetLimits(provider: PlanProvider, name: string): string | null {
  const info = SUBSCRIPTIONS[provider];
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const exact = info.presets.find((p) => p.name.toLowerCase() === n);
  if (exact) return exact.limits;
  const label = new Set(words(info.label)), have = new Set(words(n));
  const fits = info.presets.map((p) => ({ p, need: words(p.name).filter((w) => !label.has(w)) }))
    .filter((x) => x.need.length && x.need.every((w) => have.has(w))).sort((a, b) => b.need.length - a.need.length);
  return fits[0]?.p.limits ?? info.limits;
}
