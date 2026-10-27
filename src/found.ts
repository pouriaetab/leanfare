// The AI apps on this computer, for Savings: which subscription each belongs to, and the months it
// was in use, so a plan you pay for shows up beside Claude and ChatGPT without being asked for, and
// only in its months.
//
// Only where an app is and the dates the computer keeps about it are read, never what is in its
// files (your words):
//  - an app in Applications (Mac): when it was added and last opened, from Spotlight's record of it
//    (mdls); without that, the app's own time and the newest time of its folders in ~/Library;
//  - a command line tool or an editor's add-on (a folder in your home folder): when the folder was
//    made, and the newest time of what is directly in it.
// Claude Code and Codex are not here: their log files say more (plans.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { PlanProvider } from "./settings";
import { localMonth, now } from "./util";

const home = () => (process.platform === "win32" ? homedir() : process.env.HOME || homedir());
const mac = () => process.platform === "darwin";
const localAppData = () => process.env.LOCALAPPDATA || join(home(), "AppData", "Local");

// Where Mac apps are: Applications, and your own Applications folder (the tests name their own).
export const appFolders = (): string[] => {
  const v = process.env.LEANFARE_APP_FOLDERS;
  if (v !== undefined) return v.split(delimiter).map((s) => s.trim()).filter(Boolean);
  return mac() ? ["/Applications", join(home(), "Applications")] : [];
};
const lib = (...p: string[]) => join(home(), "Library", ...p);

interface AppDef {
  id: string;
  name: string;
  provider: PlanProvider;
  bundles?: string[]; // the app's name in Applications (Mac)
  support?: () => string[]; // its own folders in ~/Library (Mac): their newest time says when it was last used
  dirs?: () => string[]; // folders that mean it is here (any computer)
  prefix?: () => { dir: string; starts: string[] }; // an editor's add-on: a folder whose name starts so
}

export const FOUND_APPS: AppDef[] = [
  { id: "claude-app", name: "Claude app", provider: "claude", bundles: ["Claude.app"], support: () => [lib("Application Support", "Claude")],
    dirs: () => (process.platform === "win32" ? [join(localAppData(), "AnthropicClaude")] : []) },
  { id: "chatgpt-app", name: "ChatGPT app", provider: "chatgpt", bundles: ["ChatGPT.app"], support: () => [lib("Application Support", "com.openai.chat")] },
  // Two Mac builds: the App Store's (ai.perplexity.mac, kept in a container) and the download (ai.perplexity.macv3).
  { id: "perplexity-app", name: "Perplexity app", provider: "perplexity", bundles: ["Perplexity.app"],
    support: () => [lib("Containers", "ai.perplexity.mac"), lib("Application Support", "ai.perplexity.macv3"), lib("Application Support", "Perplexity")] },
  { id: "cursor", name: "Cursor", provider: "cursor", bundles: ["Cursor.app"], support: () => [lib("Application Support", "Cursor")],
    dirs: () => [join(home(), ".cursor"), ...(process.platform === "win32" ? [join(localAppData(), "Programs", "cursor")] : [])] },
  { id: "gemini-cli", name: "Gemini CLI", provider: "google", dirs: () => [join(home(), ".gemini")] },
  { id: "copilot", name: "GitHub Copilot in VS Code", provider: "copilot", prefix: () => ({ dir: join(home(), ".vscode", "extensions"), starts: ["github.copilot-"] }) },
  { id: "grok-build", name: "Grok Build", provider: "grok", dirs: () => [join(home(), ".grok")] },
];

export interface FoundApp { id: string; name: string; provider: PlanProvider; first: string | null; last: string | null } // months, YYYY-MM

const monthOf = (ms: number | null) => (ms === null || !Number.isFinite(ms) || ms <= 0 ? null : localMonth(new Date(ms)));
const times = (p: string): { born: number | null; changed: number } | null => {
  try {
    const s = statSync(p);
    const born = s.birthtimeMs > 0 ? s.birthtimeMs : null; // 0 where the file system keeps no birth time
    return { born, changed: s.mtimeMs };
  } catch { return null; }
};
// A folder's newest time: its own, or of what is directly in it.
function newest(dir: string): number | null {
  const t = times(dir);
  if (!t) return null;
  let n = t.changed;
  try { for (const name of readdirSync(dir)) { const c = times(join(dir, name)); if (c && c.changed > n) n = c.changed; } } catch {}
  return n;
}
const earliest = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && x > 0); return v.length ? Math.min(...v) : null; };
const latest = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && x > 0); return v.length ? Math.max(...v) : null; };

// A date as mdls prints it: "2026-03-02 10:11:12 +0000"; "(null)" when Spotlight has none.
export function mdlsDate(v: string | undefined): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec((v ?? "").trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isFinite(t) ? t : null;
}

// Spotlight's record of a Mac app: when it was added and last opened. Null where there is none.
export function spotlight(path: string): { added: number | null; used: number | null } {
  if (!mac()) return { added: null, used: null };
  try {
    const r = spawnSync("mdls", ["-raw", "-name", "kMDItemDateAdded", "-name", "kMDItemLastUsedDate", path], { encoding: "utf8", timeout: 3000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return { added: null, used: null };
    const [a, u] = r.stdout.split("\0");
    return { added: mdlsDate(a), used: mdlsDate(u) };
  } catch { return { added: null, used: null }; }
}

// The tests put their own Spotlight here (an app's birth time cannot be set).
export const hooks = { spotlight };

function look(a: AppDef): FoundApp | null {
  const firsts: (number | null)[] = [], lasts: (number | null)[] = [];
  let here = false;
  for (const folder of a.bundles ? appFolders() : []) for (const b of a.bundles!) {
    const p = join(folder, b);
    const t = times(p);
    if (!t) continue;
    here = true;
    const sp = hooks.spotlight(p);
    // An app copied from a download keeps the time it was built, so its own time says nothing of its use.
    firsts.push(sp.added ?? t.born ?? t.changed);
    lasts.push(sp.used);
  }
  // Its own folders in ~/Library: made when it first ran, changed whenever it runs.
  if (here) for (const d of a.support?.() ?? []) { const t = times(d); if (t) { firsts.push(t.born); lasts.push(newest(d)); } }
  for (const d of a.dirs?.() ?? []) {
    const t = times(d);
    if (!t) continue;
    here = true;
    firsts.push(t.born ?? t.changed);
    lasts.push(newest(d));
  }
  const pre = a.prefix?.();
  if (pre && existsSync(pre.dir)) {
    let names: string[] = [];
    try { names = readdirSync(pre.dir); } catch {}
    for (const n of names) {
      if (!pre.starts.some((s) => n.startsWith(s))) continue;
      const t = times(join(pre.dir, n));
      if (!t) continue;
      here = true;
      firsts.push(t.born ?? t.changed);
      lasts.push(t.changed);
    }
  }
  if (!here) return null;
  const first = earliest(firsts);
  let last = latest(lasts); // none: nothing says when it was last used, so it counts as in use until now
  if (first !== null && last !== null && last < first) last = first;
  return { id: a.id, name: a.name, provider: a.provider, first: monthOf(first), last: monthOf(last) };
}

// Looked for at most every ten minutes: mdls takes a moment per app.
const FRESH_MS = 10 * 60_000;
let cache: { at: number; apps: FoundApp[] } | null = null;
export const forgetFound = () => { cache = null; };
export function foundApps(force = false): FoundApp[] {
  if (!force && cache && Date.now() - cache.at < FRESH_MS) return cache.apps;
  const apps = FOUND_APPS.map(look).filter((x): x is FoundApp => !!x);
  cache = { at: Date.now(), apps };
  return apps;
}

// Whether an app was in use in a month: from the month it came to the month it was last used.
export const usedIn = (a: FoundApp, month: string) => (a.first === null || a.first <= month) && (a.last === null || a.last >= month);
export const thisMonth = () => localMonth(now());
