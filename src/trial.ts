// The delegate trial: before Claude hands work to Leanfare on its own, see how well the models
// you ticked answer. Ten questions with known answers about files Leanfare writes itself (a server
// log, a settings file, orders, code, release notes, a team list and a long access log), each
// asked the way Claude asks (the delegate) at low, medium and high effort, and graded by code.
//
// The files come from a fixed seed, so they are the same on every computer and results compare
// across people. Nothing of yours is sent: not your files, not your chats. Its answers go to the
// ledger as "trial" (what they cost on paid models, $0 on free plans) and never count in the
// delegate's own pass rates. Sharing is a button: a GitHub issue you read and send yourself, or
// the same text copied. Nothing is sent anywhere on its own.
import { VERSION } from "./config";
import { db } from "./db";
import { estimateDelegate, runDelegate, type DelegateInput, type DelegateResult, type Effort, type Kind } from "./delegate";
import { getModel } from "./data";
import { median, now } from "./util";

export const CORPUS = "1"; // the questions' version: results compare only within one
export const REPO_ISSUES = "https://github.com/pouriaetab/leanfare/issues/new";

// ---- the files, from a fixed seed ---------------------------------------------------------

// mulberry32: small, fast, and the same numbers everywhere.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const day = (ms: number) => clock(ms).slice(0, 10);

function serverLog(): string {
  const r = rng(4701);
  const lines: string[] = [];
  let t = Date.UTC(2026, 9, 3, 9, 0, 0);
  for (let i = 0; i < 220; i++) {
    t += int(r, 1, 45) * 1000;
    const x = r();
    const level = i === 157 ? "ERROR" : x < 0.08 ? "ERROR" : x < 0.2 ? "WARN" : "INFO";
    const user = level === "ERROR" && i % 5 === 2 ? "u-23" : `u-${int(r, 10, 40)}`; // one user errs more than the rest
    const status = i === 157 ? 503 : level === "ERROR" ? pick(r, [500, 502, 504]) : level === "WARN" ? pick(r, [404, 409, 429]) : pick(r, [200, 200, 200, 201, 204, 304]);
    const id = `r-${String(10000 + i * 7 + int(r, 0, 6))}`;
    const extra = level === "ERROR" ? ` error="${pick(r, ["upstream timeout", "connection reset", "bad gateway", "disk full"])}"` : "";
    lines.push(`${clock(t)} ${level.padEnd(5)} [${pick(r, ["api", "auth", "billing", "search", "worker"])}] request id=${id} user=${user} status=${status} ms=${int(r, 3, 900)}${extra}`);
  }
  return lines.join("\n") + "\n";
}

function settingsYaml(): string {
  return `# Service settings. Each section is read by its own service at start.
server:
  port: 8080
  retry_limit: 3
  timeout_ms: 2000
  enabled: true

payments:
  provider: "stripe-sandbox"
  # retry_limit was 4 until the August outage review
  retry_limit: 7
  timeout_ms: 9000
  currency: "EUR"
  enabled: true

emails:
  sender: "noreply@example.com"
  retry_limit: 5
  timeout_ms: 4000
  enabled: false

search:
  index: "products-v2"
  retry_limit: 2
  timeout_ms: 1500
  enabled: true
`;
}

const CUSTOMERS = ["Ana Costa", "Ben Okafor", "Chen Wei", "Dara Novak", "Eli Brandt", "Farah Haddad", "Gus Moreno", "Hana Sato", "Ivo Petrov", "Jade Kim", "Kofi Mensah", "Lena Vogel"] as const;
function ordersCsv(): string {
  const r = rng(4702);
  const rows = ["id,date,customer,status,amount"];
  let t = Date.UTC(2026, 6, 1);
  for (let i = 0; i < 110; i++) {
    t += int(r, 0, 2) * 86_400_000;
    const x = r();
    const status = x < 0.13 ? "refunded" : x < 0.3 ? "pending" : "paid";
    rows.push(`${1001 + i},${day(t)},${pick(r, CUSTOMERS)},${status},${(int(r, 500, 25_000) / 100).toFixed(2)}`);
  }
  return rows.join("\n") + "\n";
}

function billingTs(): string {
  const r = rng(4703);
  const names = ["createInvoice", "refundOrder", "applyDiscount", "renewPlan", "closeAccount", "retryPayment", "sendReceipt", "upgradeSeat",
    "downgradeSeat", "chargeOverage", "settleBalance", "previewTotal", "addCredit", "voidInvoice", "scheduleRenewal", "billUsage"];
  const callers = new Set(["renewPlan", "retryPayment", "upgradeSeat", "chargeOverage", "billUsage"]);
  const later = new Set(["scheduleRenewal", "settleBalance"]); // they call chargeCardLater, a different function
  const out = [
    "// Billing helpers. chargeCard takes money now; chargeCardLater queues a charge for the nightly run.",
    "import { db } from \"./db\";",
    "",
    "export async function chargeCard(customer: string, cents: number): Promise<string> {",
    "  return db.charges.create({ customer, cents, at: Date.now() });",
    "}",
    "",
    "export async function chargeCardLater(customer: string, cents: number): Promise<void> {",
    "  await db.queue.push({ kind: \"charge\", customer, cents });",
    "}",
    "",
  ];
  for (const n of names) {
    const cents = int(r, 100, 9_900);
    out.push(`export async function ${n}(customer: string): Promise<void> {`);
    out.push(`  const account = await db.accounts.get(customer);`);
    if (callers.has(n)) out.push(`  if (account.balance < ${cents}) await chargeCard(customer, ${cents} - account.balance);`);
    else if (later.has(n)) out.push(`  await chargeCardLater(customer, ${cents});`);
    else out.push(`  account.notes.push("${n} for ${cents} cents");`);
    out.push(`  await db.accounts.put(account);`);
    out.push(`}`);
    out.push("");
  }
  return out.join("\n");
}

function notesMd(): string {
  return `# Release notes

## 2.6.0 (released 2026-06-02)
- Search results load in pages of 50.
- The export button keeps your filters.

## 2.5.0 (released 2026-04-28)
- Invoices can be paid in two parts.
- Faster start on older laptops.

## 2.4.1 (released 2026-03-25)
- Fixes the receipt total when a discount and a credit meet, eight days after 2.4.0.

## 2.4.0 (released 2026-03-17)
- Seats can be moved between teams.
- The monthly report shows refunds on their own line.

## 2.3.0 (released 2026-02-09)
- Dark mode for the reports page.
`;
}

const OFFICES = ["Lisbon", "Berlin", "Toronto", "Nairobi"] as const;
const PEOPLE = ["Aiko", "Bruno", "Carla", "Diego", "Esra", "Femi", "Greta", "Hugo", "Ines", "Jonas", "Kaveh", "Lucia", "Marta", "Nils", "Olga", "Pablo", "Qiu", "Rosa", "Sven", "Tomas"] as const;
function teamCsv(): string {
  const r = rng(4704);
  const rows = ["name,office,role,start_date"];
  PEOPLE.forEach((name, i) => {
    const start = Date.UTC(2019, 0, 1) + int(r, 0, 2400) * 86_400_000;
    rows.push(`${name},${OFFICES[i % 4]},${pick(r, ["engineer", "designer", "support", "sales", "finance"])},${day(start)}`);
  });
  return rows.join("\n") + "\n";
}

function accessLog(): string {
  const r = rng(4705);
  const paths = ["/", "/products", "/products/42", "/cart", "/checkout", "/api/search?q=lamp", "/login", "/account", "/static/app.js", "/static/app.css", "/admin/users", "/admin/reports"];
  const lines: string[] = [];
  let t = Date.UTC(2026, 9, 12, 0, 0, 0);
  for (let i = 0; i < 520; i++) {
    t += int(r, 1, 30) * 1000;
    const ip = i === 389 ? "203.0.113.77" : `198.51.100.${int(r, 2, 250)}`;
    const path = i === 389 ? "/admin/export" : pick(r, paths);
    const d = new Date(t);
    const when = `${two(d.getUTCDate())}/Oct/2026:${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
    lines.push(`${ip} - - [${when}] "GET ${path} HTTP/1.1" ${pick(r, [200, 200, 200, 304, 404])} ${int(r, 200, 48_000)} "-" "Mozilla/5.0"`);
  }
  return lines.join("\n") + "\n";
}

export function trialFiles(): Record<string, string> {
  return { "server.log": serverLog(), "settings.yaml": settingsYaml(), "orders.csv": ordersCsv(), "billing.ts": billingTs(), "notes.md": notesMd(), "team.csv": teamCsv(), "access.log": accessLog() };
}

// ---- grading: right answers in several shapes pass, wrong ones fail ---------------------

const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
// The numbers in an answer, in order: not digits inside a word (u23, 20x), thousands commas dropped.
export const nums = (s: string) => (s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").match(/(?<![A-Za-z_\d.\-])-?\d+(?:\.\d+)?(?![A-Za-z_\d])/g) ?? []).map(Number);
export function firstNumber(s: string): number | null {
  const n = nums(s);
  if (n.length) return n[0];
  const w = s.toLowerCase().match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
  return w ? WORDS[w[1]] : null;
}
const sameSet = (a: string[], b: string[]) => { const x = new Set(a), y = new Set(b); return x.size === y.size && [...x].every((v) => y.has(v)); };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(" "));

// ---- the questions and their known answers, worked out from the files --------------------

export interface Question { id: string; what: string; kind: Kind; files: string[]; task: string; truth: (f: Record<string, string>) => string | number | string[]; grade: (answer: string, truth: any) => boolean }

const logRows = (f: Record<string, string>) => f["server.log"].trim().split("\n").map((l) => ({ level: l.slice(20, 25).trim(), user: /user=(\S+)/.exec(l)![1], status: Number(/status=(\d+)/.exec(l)![1]), id: /id=(\S+)/.exec(l)![1] }));
const csv = (text: string) => { const [head, ...rows] = text.trim().split("\n"); const keys = head.split(","); return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [keys[i], v]))); };
const most = (xs: string[]) => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]); };

export const QUESTIONS: Question[] = [
  {
    id: "log-errors", what: "how many ERROR lines (server.log)", kind: "read", files: ["server.log"],
    task: "How many lines in server.log have the level ERROR? Answer with only the number.",
    truth: (f) => logRows(f).filter((r) => r.level === "ERROR").length,
    grade: (a, t) => firstNumber(a) === t,
  },
  {
    id: "log-503", what: "the request id of the only 503 (server.log)", kind: "read", files: ["server.log"],
    task: "What is the request id of the only line in server.log with status 503? Answer with only the id.",
    truth: (f) => logRows(f).find((r) => r.status === 503)!.id,
    grade: (a, t) => sameSet(a.match(/\br-\d+\b/g) ?? [], [t]),
  },
  {
    id: "log-user", what: "the user with the most ERROR lines (server.log)", kind: "read", files: ["server.log"],
    task: "Which user appears in the most ERROR lines of server.log? Answer with only the user id.",
    truth: (f) => most(logRows(f).filter((r) => r.level === "ERROR").map((r) => r.user))[0][0],
    grade: (a, t) => sameSet(a.match(/u-\d+/g) ?? [], [t]),
  },
  {
    id: "yaml-retry", what: "retry_limit under payments (settings.yaml)", kind: "read", files: ["settings.yaml"],
    task: "In settings.yaml, what is retry_limit in the payments section? Answer with only the number.",
    truth: (f) => Number(/payments:[\s\S]*?\n {2}retry_limit: (\d+)/.exec(f["settings.yaml"])![1]),
    grade: (a, t) => firstNumber(a) === t,
  },
  {
    id: "csv-refunds", what: "the total of refunded orders (orders.csv)", kind: "read", files: ["orders.csv"],
    task: "In orders.csv, what is the total amount of the orders with status refunded? Answer with only the number, with two decimals.",
    truth: (f) => Math.round(csv(f["orders.csv"]).filter((r) => r.status === "refunded").reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0)) / 100,
    grade: (a, t) => { const n = firstNumber(a); return n !== null && Math.abs(n - t) < 0.006; },
  },
  {
    id: "csv-customer", what: "who spent the most on paid orders (orders.csv)", kind: "reason", files: ["orders.csv"],
    task: "In orders.csv, which customer spent the most in total on orders with status paid? Answer with only the customer's name.",
    truth: (f) => { const t = new Map<string, number>(); for (const r of csv(f["orders.csv"])) if (r.status === "paid") t.set(r.customer, (t.get(r.customer) ?? 0) + Math.round(Number(r.amount) * 100)); return [...t].sort((a, b) => b[1] - a[1])[0][0]; },
    grade: (a, t) => { const named = CUSTOMERS.filter((c) => norm(a).includes(norm(c))); return named.length === 1 && named[0] === t; },
  },
  {
    id: "code-callers", what: "the functions that call chargeCard (billing.ts)", kind: "read", files: ["billing.ts"],
    task: "Which functions in billing.ts call chargeCard (not chargeCardLater)? Answer with only the function names, separated by commas.",
    truth: (f) => [...f["billing.ts"].matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)].filter((m) => /\bchargeCard\(/.test(m[2])).map((m) => m[1]),
    grade: (a, t) => sameSet((a.match(/\b[a-z][A-Za-z]+\b/g) ?? []).filter((w) => /[A-Z]/.test(w) && w !== "chargeCard" && w !== "chargeCardLater"), t),
  },
  {
    id: "notes-date", what: "when 2.4.0 came out (notes.md)", kind: "read", files: ["notes.md"],
    task: "According to notes.md, on what date was version 2.4.0 released? Answer with only the date as YYYY-MM-DD.",
    truth: (f) => /## 2\.4\.0 \(released (\d{4}-\d{2}-\d{2})\)/.exec(f["notes.md"])![1],
    grade: (a, t) => sameSet(a.match(/\d{4}-\d{2}-\d{2}/g) ?? [], [t]),
  },
  {
    id: "team-first", what: "who started first in Lisbon (team.csv)", kind: "read", files: ["team.csv"],
    task: "In team.csv, who in the Lisbon office has the earliest start_date? Answer with only the name.",
    truth: (f) => csv(f["team.csv"]).filter((r) => r.office === "Lisbon").sort((a, b) => a.start_date.localeCompare(b.start_date))[0].name,
    grade: (a, t) => { const w = words(a); const named = PEOPLE.filter((p) => w.has(p.toLowerCase())); return named.length === 1 && named[0] === t; },
  },
  {
    id: "big-needle", what: "who asked for /admin/export (a long access.log)", kind: "read", files: ["access.log"],
    task: "In access.log, which IP address made the only request to /admin/export? Answer with only the IP address.",
    truth: (f) => f["access.log"].split("\n").find((l) => l.includes("GET /admin/export "))!.split(" ")[0],
    grade: (a, t) => sameSet(a.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [], [t]),
  },
];

// Each question is asked three ways, as the delegate is used: low and medium with no
// check (most hand offs go unchecked), and high, where a stronger model checks every answer.
export const ARMS: { effort: Effort; check: "never" | "auto"; label: string }[] = [
  { effort: "low", check: "never", label: "low, no check" },
  { effort: "medium", check: "never", label: "medium, no check" },
  { effort: "high", check: "auto", label: "high, checked" },
];
export const MAX_OUT = 1024; // short answers are asked for; this is room for models that think aloud
const PASS = QUESTIONS.length - 1; // an effort passes with at most one miss
const RATE = /\b429\b|rate.?limit|quota|too many requests|resource.?exhausted/i;
export const timing = { pause: 2000, rateWait: 65_000 }; // between answers (free plans count tokens a minute); after a rate limit

export function truths(f = trialFiles()) { return QUESTIONS.map((q) => q.truth(f)); }
const inputOf = (q: Question, effort: Effort, check: "never" | "auto", f: Record<string, string>): DelegateInput =>
  ({ task: q.task, files: q.files.map((name) => ({ name, text: f[name] })), kind: q.kind, effort, check, maxOut: MAX_OUT, trial: true });
const tokensOf = (chars: number) => Math.ceil(chars / 4);

// ---- the estimate before it starts ------------------------------------------------------

// The first answers at today's picks, and the high effort checks at about the same again.
export async function trialEstimate(signal: AbortSignal): Promise<{ questions: number; answers: number; estimate: number | null; seconds: number | null; models: Record<Effort, string | null>; fileTokens: number; error: string | null }> {
  const f = trialFiles();
  let estimate: number | null = 0, seconds: number | null = 0, error: string | null = null;
  const models = { low: null, medium: null, high: null } as Record<Effort, string | null>;
  for (const arm of ARMS) for (const q of QUESTIONS) {
    const e = await estimateDelegate(inputOf(q, arm.effort, arm.check, f), signal);
    error ??= e.error; // why there is no model (none ready, or the budget), said once
    const times = arm.check === "auto" ? 2 : 1;
    estimate = estimate === null || e.estimate === null ? null : estimate + e.estimate * times;
    seconds = seconds === null || e.seconds === null ? null : seconds + e.seconds * times;
    models[arm.effort] ??= e.model;
  }
  const fileTokens = QUESTIONS.reduce((a, q) => a + tokensOf(q.files.reduce((n, name) => n + f[name].length, 0)), 0) * ARMS.length;
  if (seconds !== null) seconds += (QUESTIONS.length * ARMS.length * timing.pause) / 1000;
  return { questions: QUESTIONS.length, answers: QUESTIONS.length * ARMS.length, estimate, seconds, models, fileTokens, error: models.low ? null : error };
}

// ---- running it ---------------------------------------------------------------------------

export interface TrialRow {
  q: string; effort: Effort; ok: boolean; right: boolean | null; answer: string; model: string | null; cost: number | null;
  check: string | null; checker: string | null; first: string | null; fileTokens: number; seconds: number; error: string | null;
}
export interface TrialRun { id: number | null; started: string; finished: string | null; status: "running" | "done" | "stopped" | "failed"; corpus: string; version: string; total: number; rows: TrialRow[]; note: string | null }

let current: { run: TrialRun; ac: AbortController; done: Promise<void> } | null = null;
export const trialRunning = () => current !== null;

function save(run: TrialRun) {
  const rows = JSON.stringify(run.rows);
  try {
    if (run.id === null) {
      db.query("INSERT INTO trials(started, finished, status, corpus, version, total, rows, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(run.started, run.finished, run.status, run.corpus, run.version, run.total, rows, run.note);
      run.id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      db.query("DELETE FROM trials WHERE id NOT IN (SELECT id FROM trials ORDER BY id DESC LIMIT 20)").run(); // the last 20 runs
    } else db.query("UPDATE trials SET finished = ?, status = ?, rows = ?, note = ? WHERE id = ?").run(run.finished, run.status, rows, run.note, run.id);
  } catch (e) { console.error("leanfare: could not save the trial:", String(e)); }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  if (signal.aborted || ms <= 0) return res();
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

async function askOne(q: Question, arm: (typeof ARMS)[number], f: Record<string, string>, truth: any, ac: AbortController): Promise<TrialRow> {
  const input = inputOf(q, arm.effort, arm.check, f);
  let t0 = performance.now();
  let r: DelegateResult | null = null;
  let error: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { r = await runDelegate(input, ac.signal); error = null; break; }
    catch (e: any) {
      error = String(e?.message ?? e);
      if (e?.type === "stopped") ac.abort(); // stopped in Leanfare (Stop, or Pause's stop all): the trial stops too
      if (ac.signal.aborted || attempt || !RATE.test(error)) break;
      await sleep(timing.rateWait, ac.signal); // a free plan's limit a minute: wait, then once more
      if (ac.signal.aborted) break; // stopped while waiting: nothing more is sent
      t0 = performance.now(); // the answer's own time, not the wait
    }
  }
  const fileTokens = tokensOf(input.files.reduce((n, x) => n + x.text.length, 0));
  const seconds = r ? r.seconds : (performance.now() - t0) / 1000;
  if (!r) return { q: q.id, effort: arm.effort, ok: false, right: null, answer: "", model: null, cost: null, check: null, checker: null, first: null, fileTokens, seconds, error };
  return {
    q: q.id, effort: arm.effort, ok: true, right: q.grade(r.answer, truth), answer: r.answer.slice(0, 2000), model: r.model.id, cost: r.total,
    check: r.check.picked ? r.check.verdict : r.check.verdict === "skipped" ? "skipped" : null, checker: r.check.checker?.id ?? null, first: r.first?.model.id ?? null, fileTokens, seconds, error: null,
  };
}

export function startTrial(): TrialRun {
  if (current) return current.run;
  const f = trialFiles();
  const t = truths(f);
  const run: TrialRun = { id: null, started: now().toISOString(), finished: null, status: "running", corpus: CORPUS, version: VERSION, total: QUESTIONS.length * ARMS.length, rows: [], note: null };
  const ac = new AbortController();
  save(run);
  const done = (async () => {
    try {
      outer: for (let qi = 0; qi < QUESTIONS.length; qi++) for (const arm of ARMS) {
        if (ac.signal.aborted) break outer;
        run.rows.push(await askOne(QUESTIONS[qi], arm, f, t[qi], ac));
        save(run);
        if (run.rows.length < run.total) await sleep(timing.pause, ac.signal);
      }
      run.status = ac.signal.aborted ? "stopped" : "done";
    } catch (e: any) { run.status = "failed"; run.note = String(e?.message ?? e); }
    run.finished = now().toISOString();
    save(run);
    current = null;
  })();
  current = { run, ac, done };
  return run;
}

export async function stopTrial(): Promise<void> {
  const c = current;
  if (!c) return;
  c.ac.abort();
  await c.done;
}

// The run going now, or the last one kept. A run left "running" by a Leanfare that quit is stopped.
export function lastTrial(): TrialRun | null {
  if (current) return current.run;
  const row = db.query("SELECT * FROM trials ORDER BY id DESC LIMIT 1").get() as any;
  if (!row) return null;
  const run: TrialRun = { id: row.id, started: row.started, finished: row.finished, status: row.status, corpus: row.corpus, version: row.version, total: row.total, rows: JSON.parse(row.rows), note: row.note };
  if (run.status === "running") { run.status = "stopped"; save(run); }
  return run;
}

// ---- the report ---------------------------------------------------------------------------

export interface ArmReport {
  effort: Effort; label: string; right: number; answered: number; asked: number; total: number;
  verdict: "passes" | "does not pass" | "not decided"; medianSeconds: number | null; slowestSeconds: number | null; cost: number | null;
  models: { id: string; label: string; count: number }[];
}
export interface TrialReport {
  id: number | null; started: string; finished: string | null; status: TrialRun["status"]; version: string; corpus: string; note: string | null;
  done: number; total: number; arms: ArmReport[];
  rows: { q: string; what: string; effort: Effort; ok: boolean; right: boolean | null; model: string | null; label: string | null; seconds: number; check: string | null }[]; // in the order asked, words left out
  checks: { passed: number; failed: number; fixed: number; missed: number; other: number };
  misses: { q: string; what: string; effort: Effort; said: string; known: string }[];
  errors: { q: string; effort: Effort; error: string }[];
  kept: number; cost: number | null; lowest: Effort | null; claudeLine: string | null;
  share: { title: string; body: string; url: string };
}

const label = (id: string | null) => (id ? getModel(id)?.label ?? id : "?");
const short = (s: string, n = 60) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const show = (v: any) => (Array.isArray(v) ? v.join(", ") : String(v));
const sum = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0));
const usd = (v: number | null) => (v === null ? "cost unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const secs = (s: number | null) => (s === null ? "—" : s < 1.5 ? "about a second" : s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
const osName = () => `${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform} ${process.arch}`;
export const claudeLineFor = (effort: Effort) => `To read large files or logs, use the leanfare delegate tool with effort ${effort}, and work from its answer.`;

export function reportOf(run: TrialRun): TrialReport {
  const t = truths();
  const arms: ArmReport[] = ARMS.map((arm) => {
    const mine = run.rows.filter((r) => r.effort === arm.effort);
    const got = mine.filter((r) => r.ok);
    const right = got.filter((r) => r.right).length;
    const unanswered = QUESTIONS.length - got.length; // not asked yet, or no answer
    const times = got.map((r) => r.seconds).sort((a, b) => a - b);
    const counts = new Map<string, number>();
    for (const r of got) counts.set(r.model ?? "?", (counts.get(r.model ?? "?") ?? 0) + 1);
    return {
      effort: arm.effort, label: arm.label, right, answered: got.length, asked: mine.length, total: QUESTIONS.length,
      verdict: right >= PASS ? "passes" : right + unanswered >= PASS ? "not decided" : "does not pass",
      medianSeconds: median(times), slowestSeconds: times.at(-1) ?? null, cost: sum(mine.map((r) => r.cost ?? (r.ok ? null : 0))),
      models: [...counts].map(([id, count]) => ({ id, label: label(id), count })).sort((a, b) => b.count - a.count),
    };
  });
  const high = run.rows.filter((r) => r.effort === "high" && r.ok);
  const checks = {
    passed: high.filter((r) => r.check === "pass").length,
    failed: high.filter((r) => r.check === "fail" || r.first !== null).length,
    fixed: high.filter((r) => r.first !== null && r.right).length, // asked again after a failed check, then right
    missed: high.filter((r) => r.check === "pass" && !r.right).length, // the check passed a wrong answer
    other: high.filter((r) => r.check !== "pass" && r.check !== "fail" && r.first === null).length, // skipped (no stronger model) or unclear
  };
  const qOf = (id: string) => QUESTIONS.findIndex((q) => q.id === id);
  const misses = run.rows.filter((r) => r.ok && !r.right).map((r) => ({ q: r.q, what: QUESTIONS[qOf(r.q)]?.what ?? r.q, effort: r.effort, said: short(r.answer), known: short(show(t[qOf(r.q)])) }));
  const errors = run.rows.filter((r) => !r.ok).map((r) => ({ q: r.q, effort: r.effort, error: short(r.error ?? "no answer", 120) }));
  const kept = run.rows.filter((r) => r.effort === "medium" && r.ok).reduce((a, r) => a + r.fileTokens, 0);
  const lowest = run.status === "done" || arms.some((a) => a.verdict === "passes") ? arms.find((a) => a.verdict === "passes")?.effort ?? null : null;
  const report: Omit<TrialReport, "share"> = {
    id: run.id, started: run.started, finished: run.finished, status: run.status, version: run.version, corpus: run.corpus, note: run.note,
    done: run.rows.length, total: run.total, arms, checks, misses, errors, kept,
    rows: run.rows.map((r) => ({ q: r.q, what: QUESTIONS[qOf(r.q)]?.what ?? r.q, effort: r.effort, ok: r.ok, right: r.right, model: r.model, label: r.model ? label(r.model) : null, seconds: r.seconds, check: r.check })), cost: sum(run.rows.map((r) => r.cost ?? (r.ok ? null : 0))),
    lowest, claudeLine: lowest ? claudeLineFor(lowest) : null,
  };
  return { ...report, share: shareOf(report) };
}

// What a person can share: numbers, the made-up files' questions and short wrong answers.
// Nothing from their own files or chats is in it, and nothing is sent until they press Submit on GitHub.
export function shareOf(r: Omit<TrialReport, "share">): { title: string; body: string; url: string } {
  const title = `Trial results: Leanfare ${r.version}, ${r.arms.map((a) => `${a.effort} ${a.right}/${a.total}`).join(", ")}`;
  const lines = [
    `Leanfare ${r.version} · trial questions v${r.corpus} · ${osName()}${r.status === "done" ? "" : ` · ${r.status} after ${r.done} of ${r.total} answers`}`,
    "",
    "| Effort | Right | Half took under | Cost | Models |",
    "|---|---|---|---|---|",
    ...r.arms.map((a) => `| ${a.label} | ${a.right} of ${a.answered}${a.answered < a.total ? ` (${a.total - a.answered} not answered)` : ""} | ${secs(a.medianSeconds)} | ${usd(a.cost)} | ${a.models.map((m) => `${m.id} ×${m.count}`).join(", ") || "—"} |`),
    "",
    `Checks at high effort: ${r.checks.passed} passed, ${r.checks.failed} failed (right after asking again: ${r.checks.fixed}), wrong answers the check passed: ${r.checks.missed}${r.checks.other ? `, not checked or unclear: ${r.checks.other}` : ""}.`,
  ];
  if (r.misses.length) lines.push("", "Wrong answers:", ...r.misses.slice(0, 8).map((m) => `- ${m.effort} · ${m.what}: said "${m.said.replace(/[|`]/g, " ")}", known ${m.known}`), ...(r.misses.length > 8 ? [`- and ${r.misses.length - 8} more`] : []));
  if (r.errors.length) lines.push("", `No answer: ${r.errors.length} (${[...new Set(r.errors.map((e) => short(e.error, 50)))].slice(0, 3).join("; ")})`);
  lines.push("", "Numbers and Leanfare's own made-up files only: nothing from my files or chats.");
  const body = lines.join("\n");
  return { title, body, url: `${REPO_ISSUES}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` };
}

export async function trialView(signal: AbortSignal, withEstimate = true) {
  const run = lastTrial();
  return { running: trialRunning(), report: run ? reportOf(run) : null, estimate: withEstimate && !trialRunning() ? await trialEstimate(signal) : null };
}
