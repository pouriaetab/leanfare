// Retirement warnings and successors.
//
// Successor: the newest model from the same provider, maker and family that
// is not retiring within 30 days and has a price. A family is the name without
// its version numbers and dates: claude-sonnet-4.6 and claude-sonnet-5.5 are
// both "claude-sonnet". Your own choice in Settings wins over the rule.
//
// Free stays free (0.13.6): a successor is of the same kind, so a free model never turns into a paid one without being
// asked (OpenRouter ends a model's ":free" copy while its paid copy goes on), and a paid one never into a free copy,
// whose terms can differ (some free copies may keep what is sent). With no free successor, a free model is just
// dropped on its day; your other free models carry on.
//
// The page says it once (0.13.6): a free model retiring needs nothing from you, so it gets no notice (its row in
// Settings says when it retires). The others share one short line, which × hides until another model retires.
import { allModels, family, getModel, isRetired, retiresWithin, type Model } from "./data";
import { getSetting, putSetting } from "./db";
import { settings } from "./settings";
import { localDay } from "./util";

export { family };

const isPreview = (m: Model) => /preview|exp|beta/i.test(m.name);
// Costs nothing: OpenRouter's ":free" models, and models whose price is 0.
export const costsNothing = (m: Model) => !!m.free || (m.input === 0 && m.output === 0);

export function successor(m: Model, day = localDay()): Model | null {
  const own = settings().successors[m.id];
  if (own) {
    const s = getModel(own);
    if (s && !isRetired(s, day)) return s;
  }
  const fam = family(m.name);
  const free = costsNothing(m);
  const options = allModels().filter((o) =>
    o.id !== m.id && o.provider === m.provider && o.maker === m.maker && family(o.name) === fam &&
    o.input !== null && o.output !== null && !isRetired(o, day) && !retiresWithin(o, day, 30) && costsNothing(o) === free);
  options.sort((a, b) =>
    Number(isPreview(a)) - Number(isPreview(b)) ||
    (b.added ?? "").localeCompare(a.added ?? "") ||
    (b.ratings.overall ?? 0) - (a.ratings.overall ?? 0));
  return options[0] ?? null;
}

export interface Notice { model: string; label: string; retire: string; daysLeft: number; retired: boolean; successor: string | null; successorLabel: string | null; free: boolean }

// A notice for each model you use that retires within 30 days or already has.
export function retirementNotices(inUse: string[], day = localDay()): Notice[] {
  const out: Notice[] = [];
  for (const id of new Set(inUse)) {
    const m = getModel(id);
    if (!m?.retire) continue;
    const retired = isRetired(m, day);
    if (!retired && !retiresWithin(m, day, 30)) continue;
    const s = successor(m, day);
    out.push({
      model: m.id, label: m.label, retire: m.retire,
      daysLeft: Math.round((Date.parse(m.retire) - Date.parse(day)) / 86_400_000),
      retired, successor: s?.id ?? null, successorLabel: s?.label ?? null, free: costsNothing(m),
    });
  }
  return out.sort((a, b) => a.retire.localeCompare(b.retire));
}

// The page's one line about retiring models (0.13.6), or null: free models left out (nothing to do), and those you
// hid with ×. How loud it is follows the worst of them: none to switch to, already retired, then retiring with a
// successor.
const HIDDEN = "retireHidden";
const dayText = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export interface RetireNotice { kind: "retire"; level: "error" | "warn" | "info"; model: string; models: string[]; text: string }
export function retireNotice(inUse: string[], day = localDay()): RetireNotice | null {
  const hidden = new Set(getSetting<string[]>(HIDDEN, []));
  const ns = retirementNotices(inUse, day).filter((n) => !n.free && !hidden.has(n.model));
  if (!ns.length) return null;
  const level = ns.some((n) => n.retired && !n.successor) ? "error" : ns.some((n) => !n.successor) ? "warn" : "info";
  const days = (n: Notice) => `in ${n.daysLeft} day${n.daysLeft === 1 ? "" : "s"}`;
  let text: string;
  if (ns.length === 1) {
    const n = ns[0];
    text = n.retired
      ? (n.successorLabel ? `${n.label} retired on ${dayText(n.retire)}; Leanfare now uses ${n.successorLabel}.` : `${n.label} retired on ${dayText(n.retire)} and has no replacement: untick it and pick another model in Settings.`)
      : (n.successorLabel ? `${n.label} retires on ${dayText(n.retire)}, ${days(n)}; Leanfare will then use ${n.successorLabel}.` : `${n.label} retires on ${dayText(n.retire)}, ${days(n)}, and has no replacement yet: pick another model in Settings.`);
  } else {
    const part = (n: Notice) => n.retired
      ? `${n.label} retired on ${dayText(n.retire)} (${n.successorLabel ? `now ${n.successorLabel}` : "no replacement: pick another"})`
      : `${n.label} on ${dayText(n.retire)} (${n.successorLabel ? `then ${n.successorLabel}` : "no replacement yet"})`;
    text = `Models you use are retiring: ${ns.map(part).join("; ")}.`;
  }
  return { kind: "retire", level, model: ns[0].model, models: ns.map((n) => n.model), text };
}
// × on that line: its models stay quiet; a model that retires later shows the line again.
export function hideRetireNotice(inUse: string[], day = localDay()): number {
  const n = retireNotice(inUse, day);
  if (!n) return 0;
  putSetting(HIDDEN, [...new Set([...getSetting<string[]>(HIDDEN, []), ...n.models])]);
  return n.models.length;
}
