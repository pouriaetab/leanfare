// The local database: settings, the cost ledger and (if kept) chat history.
//
// SQLite in WAL mode with synchronous=NORMAL: each write costs microseconds
// instead of a disk flush (a crash of Leanfare loses nothing; a power cut can
// lose the last few writes). The file heals itself: a damaged file is moved
// aside, never deleted, and the newest daily backup or an empty file takes its
// place, with a note on the Settings screen.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, statSync, copyFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { localDay, now } from "./util";

export let db: Database;
export interface Repair { at: string; moved: string; bytes: number; restored: "backup" | "empty"; reason: string }
export let lastRepair: Repair | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  month TEXT NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  asked TEXT,
  task TEXT,
  mode TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  usual TEXT,
  usual_cost REAL,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  list_cost REAL,
  price_status TEXT NOT NULL,
  usage_status TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  ms INTEGER,
  first_ms INTEGER,
  switched_from TEXT
);
CREATE INDEX IF NOT EXISTS ledger_month ON ledger(month);
CREATE INDEX IF NOT EXISTS ledger_model ON ledger(model);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, deleted TEXT);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  ts TEXT NOT NULL,
  deleted TEXT
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id INTEGER,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  pages INTEGER,
  data BLOB NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_chat ON files(chat_id, message_id);
-- Tasks handed over through the delegate tool (delegate.ts): models, verdicts, counts and costs, never words.
CREATE TABLE IF NOT EXISTS delegations(
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  month TEXT NOT NULL,
  day TEXT NOT NULL,
  task TEXT NOT NULL,
  kind TEXT,
  effort TEXT NOT NULL,
  model TEXT,
  cost REAL,
  files INTEGER NOT NULL DEFAULT 0,
  file_tokens INTEGER NOT NULL DEFAULT 0,
  answer_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  chance REAL NOT NULL DEFAULT 0,
  checker TEXT,
  verdict TEXT,
  check_cost REAL,
  rerun TEXT,
  rerun_cost REAL
);
CREATE INDEX IF NOT EXISTS delegations_month ON delegations(month);
-- The delegate trial's runs (trial.ts): grades, models, times and costs of questions about Leanfare's own made-up files.
CREATE TABLE IF NOT EXISTS trials(id INTEGER PRIMARY KEY, started TEXT NOT NULL, finished TEXT, status TEXT NOT NULL, corpus TEXT NOT NULL, version TEXT NOT NULL, total INTEGER NOT NULL, rows TEXT NOT NULL, note TEXT);
-- The manager's grades (grades.ts): which model, the kind of part, how good its answer was. No words.
CREATE TABLE IF NOT EXISTS grades(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, effort TEXT, verdict TEXT NOT NULL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS grades_model_kind ON grades(model, kind);
-- Side by side (sidebyside.ts): a hand off's answer and the top model's, compared blind by a judge of a third company.
-- Which models, the kind, which answer was shown first, the verdict (same, better or worse than the top model's) and
-- the costs. No words.
CREATE TABLE IF NOT EXISTS comparisons(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, month TEXT NOT NULL, day TEXT NOT NULL, handoff INTEGER, kind TEXT NOT NULL, effort TEXT, model TEXT NOT NULL, top_model TEXT NOT NULL, judge TEXT, shown_first TEXT, verdict TEXT NOT NULL, top_cost REAL, judge_cost REAL);
CREATE INDEX IF NOT EXISTS comparisons_month ON comparisons(month);
`;

// Columns added after 0.1: an older file gets them on its first start.
const ADDED: [table: string, column: string, type: string][] = [
  ["chats", "system", "TEXT"], // the chat's own instructions
  ["chats", "source", "TEXT"], // where an imported chat came from (so importing twice adds nothing)
  ["ledger", "effort", "TEXT"], // the thinking effort sent with the request, if any
  ["delegations", "plan", "TEXT"], // a plan's part: the plan's id and the part's number, as id:n
  ["delegations", "grade", "TEXT"], // how the app that asked graded the answer: good, partly or wrong
  ["delegations", "task_tokens", "INTEGER NOT NULL DEFAULT 0"], // a plan part's own text, which the app that asked never read
  ["delegations", "app", "TEXT"], // the app that asked, by the name it gives Leanfare's door ("Claude Code", "Claude")
  ["delegations", "app_model", "TEXT"], // the model that app runs on, as it says (claude-opus-5-5): the prompt's main model
  ["delegations", "ms", "INTEGER"], // how long it took, checks included (the report shows it)
];

function addColumns(d: Database) {
  for (const [table, column, type] of ADDED) {
    const cols = d.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function configure(d: Database) {
  d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON;");
  d.exec(SCHEMA);
  addColumns(d);
}

const backupsOf = (path: string) => {
  const dir = dirname(path), stem = basename(path, ".db");
  try {
    return readdirSync(dir).filter((f) => f.startsWith(`${stem}-backup-`) && f.endsWith(".db")).sort().reverse().map((f) => join(dir, f));
  } catch { return []; }
};

function healthy(path: string): { ok: boolean; reason: string } {
  try {
    const d = new Database(path, { readonly: true }); // check without writing anything
    try {
      const row = d.query("PRAGMA quick_check").get() as any;
      const v = row ? Object.values(row)[0] : "no answer";
      return v === "ok" ? { ok: true, reason: "" } : { ok: false, reason: String(v) };
    } finally { d.close(); }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

export function openDb(path: string): Database {
  if (existsSync(path)) {
    const h = healthy(path);
    if (!h.ok) {
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      const moved = `${path}.damaged-${stamp}`;
      const bytes = statSync(path).size;
      renameSync(path, moved);
      for (const side of ["-wal", "-shm"]) if (existsSync(path + side)) renameSync(path + side, moved + side);
      let restored: Repair["restored"] = "empty";
      for (const b of backupsOf(path)) {
        if (healthy(b).ok) { copyFileSync(b, path); restored = "backup"; break; }
      }
      lastRepair = { at: now().toISOString(), moved, bytes, restored, reason: h.reason.slice(0, 200) };
      console.error(`leanfare: the database was damaged (${lastRepair.reason}); moved it to ${moved} and started from ${restored === "backup" ? "the newest backup" : "an empty file"}.`);
    }
  }
  db = new Database(path, { create: true });
  configure(db);
  return db;
}

// One copy a day, the newest three kept, so damage costs at most a day.
export function dailyBackup(path: string) {
  const dir = dirname(path), stem = basename(path, ".db");
  const target = join(dir, `${stem}-backup-${localDay()}.db`);
  if (existsSync(target)) return;
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    for (const old of backupsOf(path).slice(3)) { try { unlinkSync(old); } catch {} }
  } catch (e) {
    console.error("leanfare: daily backup failed:", String(e));
  }
}

export function getSetting<T>(k: string, fallback: T): T {
  const row = db.query("SELECT v FROM settings WHERE k = ?").get(k) as { v: string } | null;
  if (!row) return fallback;
  try { return JSON.parse(row.v) as T; } catch { return fallback; }
}

export function putSetting(k: string, v: unknown) {
  db.query("INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
}
