// Retirement warnings and successors.
//
// Successor: the newest model from the same provider, maker and family that
// is not retiring within 30 days and has a price. A family is the name without
// its version numbers and dates: claude-sonnet-4.6 and claude-sonnet-5.5 are
// both "claude-sonnet". Your own choice in Settings wins over the rule.
import { allModels, family, getModel, isRetired, retiresWithin, type Model } from "./data";
import { settings } from "./settings";
import { localDay } from "./util";

export { family };

const isPreview = (m: Model) => /preview|exp|beta/i.test(m.name);

export function successor(m: Model, day = localDay()): Model | null {
  const own = settings().successors[m.id];
  if (own) {
    const s = getModel(own);
    if (s && !isRetired(s, day)) return s;
  }
  const fam = family(m.name);
  const options = allModels().filter((o) =>
    o.id !== m.id && o.provider === m.provider && o.maker === m.maker && family(o.name) === fam &&
    o.input !== null && o.output !== null && !isRetired(o, day) && !retiresWithin(o, day, 30));
  options.sort((a, b) =>
    Number(isPreview(a)) - Number(isPreview(b)) ||
    (b.added ?? "").localeCompare(a.added ?? "") ||
    (b.ratings.overall ?? 0) - (a.ratings.overall ?? 0));
  return options[0] ?? null;
}

export interface Notice { model: string; label: string; retire: string; daysLeft: number; retired: boolean; successor: string | null; successorLabel: string | null }

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
      retired, successor: s?.id ?? null, successorLabel: s?.label ?? null,
    });
  }
  return out.sort((a, b) => a.retire.localeCompare(b.retire));
}
