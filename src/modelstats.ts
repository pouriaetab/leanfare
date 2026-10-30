// Speed, failures, cost and quality for each model (0.10), from the ledger's calls: every try Leanfare sent in a span,
// for hand offs, checks, side by side, plans, the trial and chats. Time is each call's own clock: the first word (time
// to first token) and the whole answer, the middle one and the slowest 1 in 10. A failed try counts as a failure of its
// model, also when Auto passed the work on to another. Numbers only: no words are kept.
import { CODEX_ID, CODEX_LABEL } from "./codex";
import { getModel } from "./data";
import { db } from "./db";
import { chargeOf } from "./engine";
import { FAIL_KINDS, FAIL_WORD, failOfText, type FailKind } from "./fails";
import { GRADED_KINDS, movedDown } from "./grades";
import { restOf, restsNow, restWhy } from "./rest";
import { noQuota, noQuotaNow, noQuotaWhy } from "./quota";
import { provider, type ProviderId } from "./config";

export { FAIL_KINDS, FAIL_WORD, type FailKind };

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mid = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

export interface ModelStat {
  id: string; label: string; provider: string; where: "local" | "free" | "plan" | "paid";
  calls: number; ok: number; failed: number; stopped: number; fails: Partial<Record<FailKind, number>>;
  first: { mid: number; slow: number } | null; // seconds to the first word: the middle and the slowest 1 in 10
  whole: { mid: number; slow: number } | null; // seconds for the whole answer
  perSecond: number | null; // how fast it wrote once it started, tokens a second (the middle answer)
  cost: number; costPerCall: number | null; // what its answers cost, and the middle answer's cost
  movedDown: string[]; // the kinds of work its grades moved it down for (grades.ts)
  rest: { until: string; why: string } | null; // resting now after failing too often (rest.ts): until when, and why
  noQuota: { since: string; why: string } | null; // left out: your key has no quota for it (quota.ts), since when and why
}
const quotaOf = (id: string) => { const q = noQuota(id); return q ? { since: q.since, why: noQuotaWhy(q, provider(q.provider as ProviderId)?.name) } : null; };

export interface StatsQuery { from: number; to: number; provider?: string | null; model?: string | null }
export function modelStats(q: StatsQuery, limit = 12): ModelStat[] {
  let rows: any[] = [];
  try {
    rows = db.query(`SELECT model, provider, status, fail, error, ms, first_ms AS f, out_tokens AS o, cost FROM ledger WHERE ts >= ? AND ts < ?`)
      .all(new Date(q.from).toISOString(), new Date(q.to).toISOString()) as any[];
  } catch { return []; } // the database busy: nothing this time
  const by = new Map<string, any[]>();
  for (const r of rows) {
    const local = r.provider === "ollama";
    if (q.provider && (local ? "local" : r.provider) !== q.provider) continue;
    if (q.model && r.model !== q.model) continue;
    by.set(r.model, [...(by.get(r.model) ?? []), r]);
  }
  const out: ModelStat[] = [];
  for (const [id, rs] of by) {
    const m = getModel(id);
    const ok = rs.filter((r) => r.status === "ok"), failed = rs.filter((r) => r.status === "error");
    const fails: Partial<Record<FailKind, number>> = {};
    for (const r of failed) { const k = (FAIL_KINDS as readonly string[]).includes(r.fail) ? (r.fail as FailKind) : failOfText(r.error); fails[k] = (fails[k] ?? 0) + 1; }
    const firsts = ok.filter((r) => r.f !== null && r.f >= 0).map((r) => r.f / 1000);
    const wholes = ok.filter((r) => r.ms !== null && r.ms >= 0).map((r) => r.ms / 1000);
    const rates = ok.filter((r) => r.f !== null && r.o >= 20 && r.ms - r.f >= 300).map((r) => r.o / ((r.ms - r.f) / 1000));
    const costs = ok.filter((r) => r.cost !== null).map((r) => r.cost as number);
    const cost = rs.reduce((n, r) => n + (r.cost ?? 0), 0);
    const local = !!m?.local || rs[0].provider === "ollama";
    out.push({
      id, label: id === CODEX_ID ? CODEX_LABEL : m?.label ?? (id.split("/").slice(1).join("/") || id), provider: local ? "local" : rs[0].provider,
      // Free: its answers here cost nothing, or with none yet, it is free to you (a free key or free model).
      where: id === CODEX_ID ? "plan" : local ? "local" : (costs.length ? costs.every((c) => c === 0) : !!m && chargeOf(m, 1).cost === 0) ? "free" : "paid",
      calls: rs.length, ok: ok.length, failed: failed.length, stopped: rs.filter((r) => r.status === "stopped").length, fails,
      first: firsts.length ? { mid: round(mid(firsts))!, slow: round(pct(firsts, 0.9))! } : null,
      whole: wholes.length ? { mid: round(mid(wholes))!, slow: round(pct(wholes, 0.9))! } : null,
      perSecond: rates.length ? Math.round(mid(rates)!) : null,
      cost, costPerCall: costs.length ? mid(costs) : null,
      movedDown: GRADED_KINDS.filter((k) => movedDown(id, k)),
      rest: (() => { const r = restOf(id); return r ? { until: r.until, why: restWhy(r) } : null; })(),
      noQuota: quotaOf(id),
    });
  }
  out.sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
  // Resting ones first: they are what changed. One resting now with no call in the span still shows.
  for (const r of restsNow()) if (!by.has(r.model) && (!q.model || q.model === r.model)) {
    const m = getModel(r.model);
    if (q.provider && (m?.local ? "local" : m?.provider) !== q.provider) continue;
    out.push({ id: r.model, label: m?.label ?? r.model, provider: m?.local ? "local" : m?.provider ?? r.model.split("/")[0], where: m?.local ? "local" : m && chargeOf(m, 1).cost === 0 ? "free" : "paid",
      calls: 0, ok: 0, failed: 0, stopped: 0, fails: {}, first: null, whole: null, perSecond: null, cost: 0, costPerCall: null, movedDown: GRADED_KINDS.filter((k) => movedDown(r.model, k)), rest: { until: r.until, why: restWhy(r) }, noQuota: quotaOf(r.model) });
  }
  // One left out because your key has no quota for it, with no call in the span, still shows (quota.ts).
  for (const nq of noQuotaNow()) if (!by.has(nq.model) && !out.some((x) => x.id === nq.model) && (!q.model || q.model === nq.model)) {
    const m = getModel(nq.model);
    if (q.provider && (m?.provider ?? nq.provider) !== q.provider) continue;
    out.push({ id: nq.model, label: m?.label ?? nq.model, provider: m?.provider ?? nq.provider, where: m && chargeOf(m, 1).cost === 0 ? "free" : "paid",
      calls: 0, ok: 0, failed: 0, stopped: 0, fails: {}, first: null, whole: null, perSecond: null, cost: 0, costPerCall: null, movedDown: GRADED_KINDS.filter((k) => movedDown(nq.model, k)), rest: null, noQuota: quotaOf(nq.model) });
  }
  // Resting and left out ones first: they are what changed.
  return [...out.filter((m) => m.rest || m.noQuota), ...out.filter((m) => !m.rest && !m.noQuota)].slice(0, limit);
}

// One line of what failed, for a person: "7 busy, 2 timed out".
export function failsText(s: Pick<ModelStat, "fails">): string {
  return FAIL_KINDS.filter((k) => s.fails[k]).map((k) => `${s.fails[k]} ${FAIL_WORD[k]}`).join(", ");
}
