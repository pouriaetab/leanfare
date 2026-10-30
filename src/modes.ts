// Plan modes (0.11, his pick): how much of your Claude plan is left, and how fast you are using it, set how hard
// Leanfare pushes work out of it. Nothing is ever stopped: a mode changes what Claude is told and where the next part
// of a plan goes.
//  - Plenty: as usual.
//  - Low: the week or the 5 hours are 70% used or more, or at this week's pace the week runs out before it resets.
//    Claude is told to hand off all reading, searching and drafting it will not change; reminders before big reads
//    come sooner; a plan's high effort parts go out too.
//  - Very low: 90% used or more. Everything that can go out goes out, and Claude is told to say so before a big job.
// From Claude Code's status line (statusline.ts): the plan's two percentages and when each resets. Numbers only.
import { clock, lastSnap, readSnaps, type Snap } from "./statusline";

export type PlanMode = "plenty" | "low" | "very low";
export const MODE_AT = { low: 70, veryLow: 90, pace: 6 * 3600_000 }; // percent used; the pace needs readings 6 hours apart
export interface ModeView {
  mode: PlanMode;
  why: string; // in words, for Claude and for you
  five: number | null; week: number | null; // percent used now, when known
  runsOut: number | null; // at this week's pace, when the week runs out (epoch ms), if before it resets
  resets: number | null; // when the week resets
  at: number | null; // when the numbers were read
}

const live = (w: { used: number; resets: number | null } | null | undefined, at: number) => (w && (w.resets === null || w.resets > at) ? w.used : null);
const dayWord = (t: number) => new Date(t).toLocaleDateString("en-US", { weekday: "long" });

// When the week runs out at the pace of this week's readings, or null (not enough readings, or it lasts to the reset).
export function runsOutAt(s: Snap | null, at: number, history: Snap[]): number | null {
  const week = s?.week;
  if (!week || week.resets === null || week.resets <= at) return null;
  const same = history.filter((h) => h.week && h.week.resets === week.resets && Number.isFinite(h.week.used)); // this week's readings
  if (!same.length) return null;
  const first = same[0];
  const span = s!.at - first.at;
  const rate = span >= MODE_AT.pace ? (week.used - first.week!.used) / span : 0; // percent a millisecond
  if (rate <= 0) return null;
  const out = s!.at + (100 - week.used) / rate;
  return out < week.resets ? Math.round(out) : null;
}

export function planMode(at = clock()): ModeView {
  const s = lastSnap();
  const five = live(s?.five, at), week = live(s?.week, at);
  const resets = s?.week?.resets ?? null;
  const top = Math.max(five ?? 0, week ?? 0);
  const runsOut = s ? runsOutAt(s, at, readSnaps(at - 8 * 86_400_000)) : null;
  const used = [five !== null ? `the 5 hours ${Math.round(five)}% used` : "", week !== null ? `the week ${Math.round(week)}% used` : ""].filter(Boolean).join(", ");
  const base = { five, week, runsOut, resets, at: s?.at ?? null };
  if (top >= MODE_AT.veryLow) return { ...base, mode: "very low", why: `your Claude plan is very low: ${used}` };
  if (top >= MODE_AT.low) return { ...base, mode: "low", why: `your Claude plan is running low: ${used}` };
  if (runsOut !== null) return { ...base, mode: "low", why: `at this week's pace your Claude plan runs out on ${dayWord(runsOut)}, before it resets on ${dayWord(resets!)} (${used})` };
  return { ...base, mode: "plenty", why: used ? `your Claude plan has plenty left: ${used}` : "your Claude plan's use is not known yet" };
}

// What Claude is told as each prompt goes (statusline.ts hookLine), by mode.
export function modeAdvice(v: ModeView): string {
  if (v.mode === "very low") return `Leanfare: ${v.why}. Hand everything you can to Leanfare (delegate, or plan and plan_run): reading, searching, drafting and working things out. Keep only changes to files and your final answer, and tell the user before any big job.`;
  if (v.mode === "low") return `Leanfare: ${v.why}. Hand all reading, searching and drafting you will not change yourself to Leanfare's delegate, and plan tasks with several parts with Leanfare's plan; keep changes to files and your final answers.`;
  return "";
}

// The read hook's sizes (readhook.ts): reminders come sooner as the plan runs low.
export const READ_SIZES: Record<PlanMode, { data: number; other: number }> = {
  plenty: { data: 40 * 1024, other: 200 * 1024 }, low: { data: 20 * 1024, other: 100 * 1024 }, "very low": { data: 10 * 1024, other: 50 * 1024 },
};
