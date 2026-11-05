// Claude's helpers on the plan's model (0.15): when a Claude app starts a helper (a subagent), the leanfare-level mod
// (Cowork, Claude Desktop) or Claude Code's hook asks here which Claude model it runs on, and Leanfare answers with
// its pick, so the plan's choice is an order, not a request. The pick: the plan part the helper is for, when its title
// is in the helper's words; else a guess from the helper's kind and words. Then what it used is said back, numbers
// only: the model that ran and its token counts, and the main model's own turns where no log file shows them.
import { db } from "./db";
import { claudeRungs, helperRules, pickClaude, restFamily, familyOf, TASK_OF, type ClaudePick } from "./claudeladder";
import { ALIASES } from "./helperhook";
import { partForHelper } from "./planner";
import { guessTask } from "./router";
import { localDay, now } from "./util";

export interface HelperAsk { app: string | null; session?: string | null; task?: string | null; description?: string | null; agent?: string | null; asked?: string | null }
export interface HelperAnswer { id: number | null; model: string | null; label: string | null; family: string | null; why: string; from: "plan" | "guess" | "off"; top: boolean }

// A helper's kind of work and effort from its agent type and its words, when no plan part names it.
export function guessHelper(agent: string | null | undefined, words: string): { kind: string; effort: "low" | "medium" | "high"; top: boolean } {
  const w = words.toLowerCase();
  if (/^explore$/i.test(agent ?? "")) return { kind: "read", effort: "low", top: false };
  if (/^plan$/i.test(agent ?? "")) return { kind: "reason", effort: "high", top: false };
  if (/\b(verify|double[- ]check|final check|check the (result|work|changes)|review the (result|work|changes|final))\b/.test(w)) return { kind: "reason", effort: "high", top: true };
  if (/\b(implement|refactor|fix|edit|patch|write the code|code change|failing test|bug)\b/.test(w)) return { kind: "code", effort: "medium", top: false };
  if (/\b(find|search|look for|list|summari[sz]e|read|scan|grep|where is|which files)\b/.test(w)) return { kind: "read", effort: "low", top: false };
  const g = guessTask([{ role: "user", content: words.slice(0, 4000) }]).task;
  return { kind: g === "coding" ? "code" : "reason", effort: "medium", top: false };
}

// Claude's names for its models in the Agent tool: an alias where Claude has one, else the model's own id. The mod
// takes either; Claude Code checks a hook's call against its Agent tool, which takes the aliases only, so a family with
// no alias yet is left out of its picks (the next strongest takes its parts there).
const nameFor = (p: ClaudePick) => (ALIASES.has(p.rung.family) ? p.rung.family : p.rung.model.apiId);

export function helperPick(a: HelperAsk): HelperAnswer {
  const rules = helperRules();
  if (!rules.on) return { id: null, model: null, label: null, family: null, why: "Settings, Claude's own models, is off: the helper runs on the model the app picks", from: "off", top: false };
  const words = [a.description, a.task].filter(Boolean).join("\n");
  const found = partForHelper(words, a.app);
  const rungs = a.app === "Claude Code" ? claudeRungs().filter((r) => ALIASES.has(r.family)) : claudeRungs();
  let pick: ClaudePick | null = null, from: HelperAnswer["from"] = "guess", kind: string, effort: "low" | "medium" | "high", top: boolean;
  if (found) {
    ({ kind, effort } = found.part);
    top = !!found.part.top;
    pick = pickClaude(kind, effort, top, rungs);
    from = "plan";
  } else {
    ({ kind, effort, top } = guessHelper(a.agent, words));
    pick = pickClaude(kind, effort, top, rungs);
  }
  if (!pick) return { id: null, model: null, label: null, family: null, why: "llmledger's catalogue has no rated Claude model yet", from, top };
  const why = from === "plan" ? `part ${found!.part.n} of plan ${found!.plan.id}: ${pick.why}` : `a ${kind} helper at ${effort} effort${top ? ", the final check" : ""}: ${pick.why}`;
  const day = localDay(), ts = now().toISOString();
  const r = db.query("INSERT INTO helpers(ts, day, app, session, plan, part, kind, effort, top, family, model, label, asked, why) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
    .get(ts, day, a.app ?? "Claude", a.session ?? null, found?.plan.id ?? null, found?.part.n ?? null, kind, effort, top ? 1 : 0, pick.rung.family, pick.rung.id, pick.rung.label, a.asked ?? null, why) as { id: number };
  return { id: r.id, model: nameFor(pick), label: pick.rung.label, family: pick.rung.family, why, from, top: pick.top };
}

export interface HelperDone { id: number; model?: string | null; input?: number; cached?: number; output?: number; seconds?: number | null; reason?: string | null }
const count = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
// What a helper used, as the mod saw it at its end. One that ended with an error and wrote nothing rests its family an
// hour (a limit Claude did not name, or no access to that model).
export function helperDone(d: HelperDone): { ok: boolean; rested: string | null } {
  const row = db.query("SELECT family FROM helpers WHERE id = ?").get(Number(d.id)) as { family: string | null } | null;
  if (!row) return { ok: false, rested: null };
  const ran = typeof d.model === "string" && d.model.trim() ? d.model.trim().slice(0, 80) : null;
  db.query("UPDATE helpers SET input = input + ?, cached = cached + ?, output = output + ?, seconds = COALESCE(?, seconds), ended = ?, model = COALESCE(?, model) WHERE id = ?")
    .run(count(d.input), count(d.cached), count(d.output), d.seconds ?? null, d.reason ?? "answer", ran ? (ran.includes("/") ? ran : `anthropic/${ran}`) : null, Number(d.id));
  const family = (ran ? familyOf(ran)?.family : null) ?? row.family;
  if (d.reason === "error" && count(d.output) === 0 && family) { restFamily(family); return { ok: true, rested: family }; }
  return { ok: true, rested: null };
}

export interface AppTurn { app: string | null; session?: string | null; model: string; effort?: string | null; input?: number; cached?: number; output?: number }
// The main model's own turn in Cowork or Claude Desktop, whose log files are not on this computer: numbers only.
export function appTurn(t: AppTurn): { ok: boolean } {
  if (typeof t.model !== "string" || !t.model.trim()) return { ok: false };
  const effort = typeof t.effort === "string" && /^(low|medium|high|xhigh|max)$/.test(t.effort) ? t.effort : null;
  db.query("INSERT INTO app_turns(ts, day, app, session, model, effort, input, cached, output) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(now().toISOString(), localDay(), t.app ?? "Claude", t.session ?? null, t.model.trim().slice(0, 80), effort, count(t.input), count(t.cached), count(t.output));
  return { ok: true };
}

// Settings, Claude's own models: the order, each one's pick for a part of each kind, and today's helpers.
export function claudeModelsView() {
  const rungs = claudeRungs();
  const picks: Record<string, Record<string, string | null>> = {};
  for (const kind of Object.keys(TASK_OF)) {
    picks[kind] = {};
    for (const effort of ["low", "medium", "high"] as const) picks[kind][effort] = pickClaude(kind, effort, false, rungs)?.rung.label ?? null;
    picks[kind].top = pickClaude(kind, "high", true, rungs)?.rung.label ?? null;
  }
  const today = db.query("SELECT family, COUNT(*) AS n, SUM(input + cached + output) AS tokens FROM helpers WHERE day = ? GROUP BY family").all(localDay()) as { family: string; n: number; tokens: number }[];
  return {
    rungs: rungs.map((r) => ({ id: r.id, family: r.family, label: r.label, rated: r.rated, overall: r.rated ? r.model.ratings.overall ?? null : null, input: r.input, output: r.output, added: r.added })),
    picks, rules: helperRules(), today,
  };
}
