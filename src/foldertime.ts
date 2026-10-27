// Leanfare's own writes in another app's folder leave the folder's times as they were. Savings tells when an
// app was last used by the times of its folders (found.ts), and a file Leanfare adds, swaps in or takes out
// there moves the folder's time to now, which is not use of the app. (On macOS, a folder's time set back sets
// its birth time back too, so a folder that holds only Leanfare's files is dated by the folder's own time.)
import { statSync, utimesSync } from "node:fs";
import { dirname } from "node:path";

export function keepingFolderTimes<T>(files: string[], write: () => T): T {
  const before: { dir: string; atime: Date; mtime: Date }[] = [];
  for (const dir of new Set(files.map((f) => dirname(f)))) {
    try { const s = statSync(dir); before.push({ dir, atime: s.atime, mtime: s.mtime }); } catch {} // a folder made now keeps its new time
  }
  try { return write(); }
  finally { for (const b of before) { try { utimesSync(b.dir, b.atime, b.mtime); } catch {} } }
}
