// Claude Code's read hook (0.11, Settings, In your apps, Plan by itself): before Claude Code reads a big file itself,
// it is reminded once that Leanfare can read it instead, so only the answer comes into its context. Big: a log, data
// or text file of 40 KB or more, or any other text file of 200 KB or more. Once per file in a session: when Claude
// reads it again (it needs the whole file, or will change it), it goes through. Never for a slice (a few hundred
// lines), an image or a PDF, a file over Leanfare's 2 MB, or while Leanfare is switched off. It must never get in the
// way: anything that goes wrong lets the read through. Kept: when each reminder was, and how big the file was (no
// names, no words), so Settings can say how often it reminded.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { paths } from "./config";
import { switchedOn } from "./switch";

export const BIG = { data: 40 * 1024, other: 200 * 1024, most: 2 * 1024 * 1024, slice: 400 };
const DATA = /\.(log|txt|text|out|err|trace|csv|tsv|jsonl|ndjson|json|xml|ya?ml|md|markdown|rst|html?|sql|har)$/i;
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|pdf|ipynb|zip|gz|tgz|bz2|xz|7z|tar|dmg|exe|bin|so|dylib|wasm|mp[34]|mov|wav|woff2?|ttf|otf)$/i;
const DAY = 86_400_000;
export const readsFile = () => join(dirname(paths.db), "reads.json");

interface Seen { at: Record<string, number>; days: Record<string, { n: number; kb: number }> }
function load(): Seen {
  try { const j = JSON.parse(readFileSync(readsFile(), "utf8")); return { at: j.at && typeof j.at === "object" ? j.at : {}, days: j.days && typeof j.days === "object" ? j.days : {} }; }
  catch { return { at: {}, days: {} }; }
}
function save(s: Seen, now: number) {
  // A day of reminders per session and file is enough to remember; 60 days of counts for Settings.
  const at = Object.entries(s.at).filter(([, t]) => now - t < DAY).sort((a, b) => b[1] - a[1]).slice(0, 500);
  const days = Object.entries(s.days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 60);
  try { writeFileSync(readsFile(), JSON.stringify({ at: Object.fromEntries(at), days: Object.fromEntries(days) }), { mode: 0o600 }); } catch {}
}
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const sizeText = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const tokText = (b: number) => { const t = b / 4; return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${Math.round(t / 1e3)}k` : String(Math.round(t)); };

// What Claude Code is told before a read, or null to let it through (the hook's whole decision; tested on its own).
export function readReminder(input: any, now = Date.now()): string | null {
  if (input?.tool_name !== "Read") return null;
  const given = input?.tool_input?.file_path;
  if (typeof given !== "string" || !given.trim()) return null;
  const path = isAbsolute(given) ? given : resolve(typeof input.cwd === "string" ? input.cwd : process.cwd(), given);
  const limit = Number(input.tool_input.limit), offset = Number(input.tool_input.offset);
  if ((Number.isFinite(limit) && limit > 0 && limit <= BIG.slice) || (Number.isFinite(offset) && offset > 1)) return null; // a slice
  if (NOT_TEXT.test(path)) return null; // Leanfare's delegate reads text
  let size = 0;
  try { const st = statSync(path); if (!st.isFile()) return null; size = st.size; } catch { return null; }
  if (size > BIG.most || size < (DATA.test(path) ? BIG.data : BIG.other)) return null;
  const s = load();
  const key = `${String(input.session_id ?? "")}|${path}`;
  if (now - (s.at[key] ?? 0) < DAY) return null; // reminded once already: this read goes through
  s.at[key] = now;
  const day = localDay(now);
  s.days[day] = { n: (s.days[day]?.n ?? 0) + 1, kb: (s.days[day]?.kb ?? 0) + Math.round(size / 1024) };
  save(s, now);
  return `Leanfare: ${basename(path)} is about ${tokText(size)} tokens (${sizeText(size)}). If you need facts from it rather than to change it, `
    + `hand it to Leanfare's delegate (files: ["${path}"], kind: read, and a task that says what to find): only the answer comes back, `
    + `and the file stays out of your context. To read it yourself anyway, read it again: it goes through.`;
}

// How often it reminded lately (Settings): reminders in the last 7 days, and their files' size.
export function remindersLately(now = Date.now()): { n: number; kb: number } {
  if (!existsSync(readsFile())) return { n: 0, kb: 0 };
  const s = load();
  const from = localDay(now - 6 * DAY);
  let n = 0, kb = 0;
  for (const [d, v] of Object.entries(s.days)) if (d >= from) { n += v.n ?? 0; kb += v.kb ?? 0; }
  return { n, kb };
}

// leanfare hook read: the JSON Claude Code sends on stdin; a denial with the reminder on stdout, or nothing.
export async function runReadHook() {
  try {
    if (!switchedOn()) return;
    const text = await Bun.stdin.text();
    const why = readReminder(JSON.parse(text));
    if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }) + "\n");
  } catch {} // never in the way
}
