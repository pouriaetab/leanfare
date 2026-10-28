// The test of a model on this computer. Arena rates few small models, so Leanfare measures one here instead:
// the trial's reading questions (trial.ts: known answers about files Leanfare makes up, the same on every
// computer), each asked once at low effort with no check, on that model only. The questions too long for its
// context are left out and said. Nothing leaves the computer: the model runs in Ollama here, and the files
// are made up. At most one wrong (of at least five) passes, and plans and the delegate then send it reading
// work first (localpass.ts). One test runs at a time, never during the trial.
import { doerSystem, filesBlock, runDelegate } from "./delegate";
import { fitsText, getModel } from "./data";
import { keepTest, passed, testResults, type TestResult } from "./localpass";
import { saveSettings, settings } from "./settings";
import { CORPUS, MAX_OUT, QUESTIONS, inputOf, trialFiles, trialRunning, truths } from "./trial";
import { UserError } from "./upstream";
import { now } from "./util";

export const timing = { perQuestion: 180_000 }; // a question with no answer in 3 minutes counts as wrong

type Status = "running" | "done" | "stopped" | "failed";
interface Test {
  model: string; label: string; status: Status; done: number; total: number; right: number; skipped: number;
  started: number; ended: number | null; error: string | null; wasTicked: boolean; ac: AbortController;
}
let current: Test | null = null;
export const testRunning = () => current?.status === "running";

// The reading questions, as the delegate would get them.
const READING = QUESTIONS.filter((q) => q.kind === "read");
export const TEST_QUESTIONS = READING.length;

// Whether a question fits the model's context with room for its answer, counted as the delegate counts it.
function fits(modelId: string, q: (typeof READING)[number], f: Record<string, string>): boolean {
  const m = getModel(modelId);
  if (!m) return false;
  const input = inputOf(q, "low", "never", f);
  const block = filesBlock(input.files, true);
  const chars = (block ? `${input.task}\n\n${block}` : input.task).length + doerSystem(true, false, input.files.length > 0).length;
  return fitsText(m, chars, MAX_OUT);
}

export function testView() {
  const results = testResults();
  const t = current;
  return {
    running: testRunning(),
    current: t ? { model: t.model, label: t.label, status: t.status, done: t.done, total: t.total, right: t.right, skipped: t.skipped, seconds: Math.round(((t.ended ?? Date.now()) - t.started) / 1000), error: t.error } : null,
    results: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { ...r, passed: passed(r), older: r.corpus !== CORPUS }])),
    questions: TEST_QUESTIONS,
  };
}

export function startTest(modelId: unknown): ReturnType<typeof testView> {
  if (typeof modelId !== "string" || !modelId) throw new UserError(400, "Say which model to test, like ollama/qwen3:8b.");
  const id = modelId.startsWith("ollama/") ? modelId : `ollama/${modelId}`;
  const m = getModel(id);
  if (!m || !m.local) throw new UserError(404, `${modelId} is not a model on this computer. The test is for models in Ollama here.`);
  if (testRunning()) throw new UserError(409, `${current!.label} is being tested now. Stop it first, or wait until it is done.`);
  if (trialRunning()) throw new UserError(409, "The delegate trial is running. Wait until it is done, or stop it.");
  const f = trialFiles();
  const asked = READING.filter((q) => fits(id, q, f));
  if (asked.length < 5) throw new UserError(400, `${m.label} runs here with too little context for the test (${asked.length} of its ${READING.length} questions fit).`);
  const s = settings();
  const wasTicked = s.ticked.includes(id);
  if (!wasTicked) saveSettings({ ticked: [...s.ticked, id] }); // only a ticked model answers; it stays ticked if it passes
  current = { model: id, label: m.label, status: "running", done: 0, total: asked.length, right: 0, skipped: READING.length - asked.length, started: Date.now(), ended: null, error: null, wasTicked, ac: new AbortController() };
  void run(current, asked, f);
  return testView();
}

export function forgetTests() { stopTest(); current = null; } // for the tests

export function stopTest(): boolean {
  if (!testRunning()) return false;
  current!.status = "stopped";
  current!.ended = Date.now();
  current!.ac.abort();
  untickIfNew(current!);
  return true;
}

function untickIfNew(t: Test) {
  if (t.wasTicked) return;
  const s = settings();
  if (s.ticked.includes(t.model)) saveSettings({ ticked: s.ticked.filter((x) => x !== t.model) });
}

async function run(t: Test, asked: typeof READING, f: Record<string, string>) {
  const truth = truths(f);
  try {
    for (const q of asked) {
      if (t.status !== "running") return;
      const one = new AbortController();
      const timer = setTimeout(() => one.abort(), timing.perQuestion);
      const stop = () => one.abort();
      t.ac.signal.addEventListener("abort", stop, { once: true });
      try {
        const r = await runDelegate({ ...inputOf(q, "low", "never", f), model: t.model, only: (m) => m.id === t.model }, one.signal);
        if (r.model.id === t.model && q.grade(r.answer, truth[QUESTIONS.indexOf(q)])) t.right++;
      } catch (e: any) {
        if (t.status !== "running") return; // stopped
        // One that failed or took too long counts as wrong; Ollama itself gone ends the test.
        if (/not running|ECONNREFUSED|Unable to connect|fetch failed/i.test(String(e?.message ?? e))) throw new Error("Ollama stopped answering, so the test ended. Open Ollama and test again.");
      } finally { clearTimeout(timer); t.ac.signal.removeEventListener("abort", stop); }
      t.done++;
    }
    if (t.status !== "running") return;
    t.status = "done";
    t.ended = Date.now();
    const result: TestResult = { right: t.right, asked: t.total, skipped: t.skipped, seconds: Math.round((t.ended - t.started) / 1000), at: now().toISOString(), corpus: CORPUS };
    keepTest(t.model, result);
    if (!passed(result)) untickIfNew(t);
  } catch (e: any) {
    if (t.status !== "running") return;
    t.status = "failed";
    t.ended = Date.now();
    t.error = String(e?.message ?? e);
    untickIfNew(t);
  }
}
