// What Leanfare keeps of each hand off's words (0.12, the keep dial in Settings, his ask: "i want to be able to analyze
// every prompt"). 1 numbers only (as before, the default); 2 also the task the app wrote; 3 also the answer that came
// back; 4 also the files' names and sizes; 5 also the files' text. Kept in Leanfare's database on this computer, never
// sent anywhere, for 7 to 90 days, and Delete all clears them. It never changes which models get the work.
import { db } from "./db";
import { now } from "./util";

export const KEEP_NAMES: Record<number, string> = { 1: "Numbers only", 2: "+ The task", 3: "+ The answer", 4: "+ File names", 5: "Everything" };
export const KEEP_SAYS: Record<number, string> = {
  1: "Sizes, models, times, costs and grades. No words.",
  2: "What your app wrote when it handed work off.",
  3: "What came back to your app.",
  4: "Which files were read, by name and size, not their text.",
  5: "The files' text too.",
};
export const KEEP_DAYS = [7, 14, 30, 60, 90];

// Kept with the hand off's number, as the setting says now.
export function keepWords(row: number, keep: number, w: { task: string; answer: string; files: { name: string; text: string }[] }) {
  if (!(keep >= 2)) return;
  try {
    db.query("INSERT OR REPLACE INTO words(handoff, ts, task, answer, files, texts) VALUES (?, ?, ?, ?, ?, ?)").run(
      row, now().toISOString(), w.task, keep >= 3 ? w.answer : null,
      keep >= 4 ? JSON.stringify(w.files.map((f) => ({ name: f.name, size: Buffer.byteLength(f.text) }))) : null,
      keep >= 5 ? JSON.stringify(w.files.map((f) => ({ name: f.name, text: f.text }))) : null);
  } catch (e) { console.error("leanfare: could not keep the hand off's words:", String(e)); }
}

// Older than the days kept: gone.
export function pruneWords(days: number): number {
  try { return db.query("DELETE FROM words WHERE ts < ?").run(new Date(now().getTime() - days * 86_400_000).toISOString()).changes; } catch { return 0; }
}
export function deleteWords(): number {
  try { const n = db.query("DELETE FROM words").run().changes; try { db.exec("VACUUM"); } catch {} return n; } catch { return 0; }
}
export function wordsKept(): { count: number; bytes: number } {
  try {
    const r = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(task) + COALESCE(LENGTH(answer), 0) + COALESCE(LENGTH(files), 0) + COALESCE(LENGTH(texts), 0)), 0) AS b FROM words").get() as { n: number; b: number };
    return { count: r.n, bytes: r.b };
  } catch { return { count: 0, bytes: 0 }; }
}
export function wordsOf(row: number): { task: string; answer: string | null; files: { name: string; size: number }[] | null; texts: { name: string; text: string }[] | null } | null {
  try {
    const r = db.query("SELECT task, answer, files, texts FROM words WHERE handoff = ?").get(row) as any;
    return r ? { task: r.task, answer: r.answer, files: r.files ? JSON.parse(r.files) : null, texts: r.texts ? JSON.parse(r.texts) : null } : null;
  } catch { return null; }
}
