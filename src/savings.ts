// The savings page. Every number comes from the ledger, and each has
// a written definition the screen links to.
//
// Saved by Auto: for each answer where Auto picked a model other than your
//    usual one, what the usual model would have cost for the same token counts
//    minus what the answer cost.
// Gap to your subscription: the price you entered minus what you spent.
// More for your money: what all your answers would have cost on your usual
//    model, divided by what they cost.
import { CODEX_ID } from "./codex";
import { TASKS, getModel } from "./data";
import { db } from "./db";
import { weightedPass, wilson } from "./delegate";
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
  kept: "Work Leanfare did for your apps this month (hand offs and plan parts): what its models read that the app never did (the files, and a plan part's own text), against the answers the app read back. What stays out of an app's context does not count toward its plan. The thinking and writing the app did not have to do is not counted, so this is the least it kept out.",
  workCost: "What that work cost: the hand offs, the plan parts and their checks, and the models that split the plans. Free and local models count as $0; a part Codex did counts in your ChatGPT plan, not here.",
  quality: "How the app that asked graded the answers it used (good, partly or wrong), from Leanfare's grade tool or the Plan tab. Answers nobody graded are not counted.",
  checked: "Answers a stronger model of yours checked. With checks on auto: every high effort answer, a quarter of the medium ones and a tenth of the low ones; a free part's checker is free too. A failed answer is asked again one tier up.",
  delegate: "Tasks another app (Claude Code, Claude Desktop) handed to Leanfare through its delegate tool. Leanfare read the files itself, so their text stayed out of that app's context. The pass rate counts checked answers only, with a 90% range (Wilson). The weighted rate counts each checked answer once for every answer it stands for (one over its chance of being checked), so it speaks for all handed over answers.",
};

const taskLabel = (t: string) => TASKS.find(([id]) => id === t)?.[1] ?? t;
const KIND_WORD: Record<string, string> = { read: "reading", write: "drafting", reason: "working out", search: "searching the web" };
// Where a part of the work ran: on this computer, on a free model, on the user's ChatGPT plan (Codex), or paid per use.
const whereOf = (id: string, cost: number | null) => (id === CODEX_ID ? "plan" : getModel(id)?.local ? "local" : cost === 0 ? "free" : "paid");
const nameOf = (id: string) => (id === CODEX_ID ? "Codex" : getModel(id)?.label ?? (id.split("/").slice(1).join("/") || id));

// What Leanfare did for the user's apps this month: the hand offs and the plan parts (the delegations table,
// which keeps no words). Stayed out: what Leanfare's models read that the app never did (the files, and a plan
// part's own text); came back: the answers the app read. The thinking and writing the app did not have to do
// is not counted, so the share is the least it kept out. Then the cost, how the app graded the answers, what
// the checks found, and the last few, a plan's parts together.
export function work(month = localMonth()) {
  const rows = db.query(`SELECT id, ts, kind, model, rerun, cost, check_cost, rerun_cost, files, file_tokens, task_tokens, answer_tokens, verdict, plan, grade
    FROM delegations WHERE month = ? AND status = 'ok' ORDER BY id`).all(month) as any[];
  // The ledger's plan answers: the models that split plans, and the web searches (which have their own rows here too).
  const planLedger = (db.query("SELECT COALESCE(SUM(cost), 0) AS v FROM ledger WHERE month = ? AND source = 'plan' AND status != 'error'").get(month) as any).v;
  const costOf = (r: any) => (r.cost ?? 0) + (r.check_cost ?? 0) + (r.rerun_cost ?? 0);
  const stayed = (rs: any[]) => rs.reduce((n, r) => n + r.file_tokens + r.task_tokens, 0);
  const back = (rs: any[]) => rs.reduce((n, r) => n + r.answer_tokens, 0);
  const share = (k: number, b: number) => (k + b > 0 ? k / (k + b) : null);
  const ranOn = (r: any) => r.rerun ?? r.model;
  const grades = { good: 0, partly: 0, wrong: 0 };
  for (const r of rows) if (r.grade in grades) grades[r.grade as keyof typeof grades]++;
  const where = { local: 0, free: 0, plan: 0, paid: 0 };
  for (const r of rows) where[whereOf(ranOn(r), r.cost) as keyof typeof where]++;
  // The last 8: a plan's parts as one line, a hand off as its own.
  const groups = new Map<string, any[]>();
  for (const r of rows) { const key = r.plan ? `plan:${String(r.plan).split(":")[0]}` : `row:${r.id}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  const recent = [...groups.entries()].map(([key, rs]) => {
    const models = [...new Map(rs.map((r) => [ranOn(r), { label: nameOf(ranOn(r)), where: whereOf(ranOn(r), r.cost) }])).values()];
    const k = stayed(rs), b = back(rs);
    return {
      ts: rs[rs.length - 1].ts, plan: key.startsWith("plan:"), parts: rs.length,
      kinds: [...new Set(rs.map((r) => KIND_WORD[r.kind] ?? "a task"))], files: rs.reduce((n, r) => n + r.files, 0), models,
      kept: k, back: b, keptPct: share(k, b), cost: rs.reduce((n, r) => n + costOf(r), 0),
      grades: rs.map((r) => r.grade).filter(Boolean), checks: rs.map((r) => r.verdict).filter((v) => v === "pass" || v === "fail"),
    };
  }).sort((x, y) => (x.ts < y.ts ? 1 : -1)).slice(0, 8);
  const k = stayed(rows), b = back(rows);
  return {
    tasks: groups.size, parts: rows.length, kept: k, back: b, keptPct: share(k, b),
    cost: rows.reduce((n, r) => n + costOf(r), 0) + Math.max(0, planLedger - rows.filter((r) => r.kind === "search").reduce((n, r) => n + (r.cost ?? 0), 0)), where, grades,
    checks: { passed: rows.filter((r) => r.verdict === "pass").length, failed: rows.filter((r) => r.verdict === "fail").length, again: rows.filter((r) => r.rerun).length },
    recent,
  };
}
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
  // Claude's delegate (delegate.ts): what was handed over, what the checks found.
  const dg = q(`SELECT COUNT(*) AS n, COALESCE(SUM(status = 'ok'), 0) AS ok,
      COALESCE(SUM(cost), 0) + COALESCE(SUM(check_cost), 0) + COALESCE(SUM(rerun_cost), 0) AS cost, COALESCE(SUM(check_cost), 0) AS checkCost,
      COALESCE(SUM(CASE WHEN status = 'ok' THEN file_tokens END), 0) AS kept, COALESCE(SUM(CASE WHEN status = 'ok' THEN answer_tokens END), 0) AS answerTokens,
      COALESCE(SUM(verdict = 'pass'), 0) AS passed, COALESCE(SUM(verdict = 'fail'), 0) AS failed, COALESCE(SUM(verdict = 'unclear'), 0) AS unclear,
      COALESCE(SUM(rerun IS NOT NULL), 0) AS reruns
    FROM delegations WHERE month = ?`);
  const checked = dg.passed + dg.failed;
  const interval = wilson(dg.passed, checked);
  const delegate = dg.n === 0 ? null : {
    tasks: dg.n, ok: dg.ok, cost: dg.cost, checkCost: dg.checkCost, kept: dg.kept, answerTokens: dg.answerTokens,
    passed: dg.passed, failed: dg.failed, unclear: dg.unclear, reruns: dg.reruns,
    passRate: checked ? dg.passed / checked : null, passLo: interval?.lo ?? null, passHi: interval?.hi ?? null,
    weighted: weightedPass(all("SELECT verdict, chance FROM delegations WHERE month = ? AND verdict IN ('pass', 'fail')")),
  };
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
    delegate,
    work: work(month),
    definitions: DEFINITIONS,
  };
}
