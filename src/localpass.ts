// What the test of a local model found (localtest.ts runs it), kept on this computer, and the model that
// reading work goes to first. Arena rates few small models, so Auto would not pick most of the models people
// run in Ollama; one that answered the test's questions about made up files right, here, is good enough to
// read for the user. A local model is free, so plans and the delegate send it reading at low and medium
// effort before any other model, and a stronger model still checks a sample of its answers.
import { usableModels } from "./engine";
import { getSetting, putSetting } from "./db";
import type { Model } from "./data";

export interface TestResult {
  right: number; // answers right
  asked: number; // questions it was asked (the ones too long for its context are left out)
  skipped: number; // questions too long for it
  seconds: number; // the whole test
  at: string; // when it ended
  corpus: string; // the questions' version (trial.ts: CORPUS)
}
const KEY = "localTests";

export const testResults = (): Record<string, TestResult> => getSetting<Record<string, TestResult>>(KEY, {});
export const testOf = (id: string): TestResult | null => testResults()[id] ?? null;
export function keepTest(id: string, r: TestResult) { putSetting(KEY, { ...testResults(), [id]: r }); }
export function forgetTest(id: string) { const all = testResults(); delete all[id]; putSetting(KEY, all); }

// It passes as the trial's efforts do: at most one wrong, of at least five questions asked.
export const PASS_MIN = 5;
export const passed = (r: TestResult | null | undefined): boolean => !!r && r.asked >= PASS_MIN && r.right >= r.asked - 1;

// The local model reading work goes to first, among the ones `ok` lets through: one that passed, ticked and
// ready; the most right first, then the one that took the test fastest.
export function passedLocal(ok: (m: Model) => boolean = () => true): Model | null {
  const all = testResults();
  const share = (r: TestResult) => r.right / r.asked;
  return usableModels((m) => !!m.local && passed(all[m.id]) && ok(m))
    .sort((a, b) => share(all[b.id]) - share(all[a.id]) || all[a.id].seconds - all[b.id].seconds || a.id.localeCompare(b.id))[0] ?? null;
}
