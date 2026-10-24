// The savings page. Every number comes from the ledger, and each has
// a written definition the screen links to.
//
// Saved by Auto: for each answer where Auto picked a model other than your
//    usual one, what the usual model would have cost for the same token counts
//    minus what the answer cost.
// Gap to your subscription: the price you entered minus what you spent.
// More for your money: what all your answers would have cost on your usual
//    model, divided by what they cost.
import { TASKS, getModel } from "./data";
import { db } from "./db";
import { budgetState } from "./budget";
import { settings } from "./settings";
import { localDay, localMonth } from "./util";

export const DEFINITIONS = {
  spent: "What this month's answers cost at the providers' list prices. Answers on free plans, free models and local models count as $0.",
  saved: "For each answer where Auto picked a model other than your usual one: what your usual model would have cost for the same tokens, minus what the answer cost. Adds up both ways, so a pricier pick in Best quality mode counts against it.",
  more: "What all of this month's answers would have cost on your usual model, divided by what they did cost. 3x means the same money got three times as many answers.",
  gap: "The subscription price you entered minus what you spent this month.",
  answers: "Finished answers this month, from the chat and from your other apps. Stopped answers are counted separately.",
  budget: "Your monthly budget minus what was spent and what requests still running have reserved.",
  top: "The model that wrote the most answers this month.",
};

const taskLabel = (t: string) => TASKS.find(([id]) => id === t)?.[1] ?? t;
const labelOf = (id: string) => getModel(id)?.label ?? id.split("/").slice(1).join("/");

export function savings(month = localMonth()) {
  const q = (sql: string, ...args: any[]) => db.query(sql).get(month, ...args) as any;
  const all = (sql: string, ...args: any[]) => db.query(sql).all(month, ...args) as any[];
  const spent = q("SELECT COALESCE(SUM(cost), 0) AS v FROM ledger WHERE month = ?").v as number;
  const today = (db.query("SELECT COALESCE(SUM(cost), 0) AS v FROM ledger WHERE day = ?").get(localDay()) as any).v as number;
  const counts = q(`SELECT
      SUM(status = 'ok') AS ok, SUM(status = 'stopped') AS stopped, SUM(status = 'error') AS errors,
      SUM(status = 'ok' AND auto = 1) AS auto, SUM(cost IS NULL AND status != 'error') AS unpriced,
      SUM(usage_status = 'estimated' AND status != 'error') AS estimated
    FROM ledger WHERE month = ?`);
  const saved = q(`SELECT COALESCE(SUM(usual_cost - cost), 0) AS v, COUNT(*) AS n FROM ledger
    WHERE month = ? AND auto = 1 AND status != 'error' AND usual IS NOT NULL AND usual != model AND usual_cost IS NOT NULL AND cost IS NOT NULL`);
  const pair = q(`SELECT COALESCE(SUM(usual_cost), 0) AS usual, COALESCE(SUM(cost), 0) AS paid, COUNT(*) AS n FROM ledger
    WHERE month = ? AND status != 'error' AND usual_cost IS NOT NULL AND cost IS NOT NULL`);
  const byModel = all(`SELECT model, provider, SUM(status = 'ok') AS answers, COALESCE(SUM(cost), 0) AS cost,
      COALESCE(SUM(in_tokens), 0) AS inTok, COALESCE(SUM(out_tokens), 0) AS outTok
    FROM ledger WHERE month = ? AND status != 'error' GROUP BY model ORDER BY answers DESC, cost DESC`)
    .map((r) => ({ ...r, label: labelOf(r.model) }));
  const byTask = all(`SELECT task, SUM(status = 'ok') AS answers, COALESCE(SUM(cost), 0) AS cost,
      COALESCE(SUM(CASE WHEN auto = 1 AND usual != model AND usual_cost IS NOT NULL AND cost IS NOT NULL THEN usual_cost - cost ELSE 0 END), 0) AS saved
    FROM ledger WHERE month = ? AND status != 'error' GROUP BY task ORDER BY answers DESC`)
    .map((r) => ({ ...r, label: taskLabel(r.task ?? "overall") }));
  const byDay = all(`SELECT day, COALESCE(SUM(cost), 0) AS cost, SUM(status = 'ok') AS answers FROM ledger
    WHERE month = ? AND status != 'error' GROUP BY day ORDER BY day`);
  const bySource = all(`SELECT source, SUM(status = 'ok') AS answers, COALESCE(SUM(cost), 0) AS cost FROM ledger
    WHERE month = ? AND status != 'error' GROUP BY source`);
  const s = settings();
  const b = budgetState();
  const answers = counts.ok ?? 0;
  const top = byModel[0] && byModel[0].answers > 0 ? { model: byModel[0].model, label: byModel[0].label, share: answers ? byModel[0].answers / answers : 0, answers: byModel[0].answers } : null;
  const usualIds = (db.query("SELECT DISTINCT usual FROM ledger WHERE month = ? AND usual IS NOT NULL").all(month) as any[]).map((r) => r.usual);
  return {
    month,
    spent,
    today,
    answers,
    stopped: counts.stopped ?? 0,
    errors: counts.errors ?? 0,
    autoAnswers: counts.auto ?? 0,
    unpriced: counts.unpriced ?? 0,
    estimated: counts.estimated ?? 0,
    saved: { amount: saved.v, answers: saved.n },
    more: pair.n === 0 ? null : pair.paid > 0 ? { ratio: pair.usual / pair.paid, usual: pair.usual, paid: pair.paid } : { ratio: null, usual: pair.usual, paid: 0 },
    usualLabels: usualIds.map(labelOf),
    subscription: s.subscription,
    gap: s.subscription === null ? null : s.subscription - spent,
    budget: { amount: b.budget, left: b.left, reserved: b.reserved, pct: b.pct, warn: b.warn, reached: b.reached },
    top,
    byModel,
    byTask,
    byDay,
    bySource,
    definitions: DEFINITIONS,
  };
}
