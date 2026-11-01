// leanfare mcp: Leanfare as an MCP server (stdio), so Claude Desktop and other
// MCP clients can ask a model through Leanfare, check what you spent, list your
// models and estimate a prompt's cost. It is a small door into the running app:
// every call goes to Leanfare at 127.0.0.1 (started if it is not running), so
// the costs, the budget and the ledger are the same as everywhere else.
//
// It speaks both eras of the protocol: the 2026-07-28 revision (each request
// carries its version in _meta; server/discover) and the earlier ones that
// open with initialize (2025-11-25 and before). No SDK: JSON-RPC over stdin and
// stdout, one message per line; anything for a person goes to stderr.
import { appKey, isLevel, LEVEL_NAME, LEVELS, levelAdvice, levelText, type Level } from "./level";
import { VERSION } from "./config";
import { OFF_TEXT, switchedOn } from "./switch";
import { app, call, healthy, seenVersion, where } from "./client";
import { secondsText } from "./util";
import { FAIL_KINDS, FAIL_WORD } from "./fails";
import { scoreText } from "./score";
import { reportText } from "./trialtext";
import { APP_MIME, PLAN_APP_HTML, PLAN_APP_URI } from "./planapp";
import { REPORT_APP_HTML, REPORT_APP_URI } from "./reportapp";
import { LIVE_APP_HTML, LIVE_APP_URI } from "./liveapp";
import { LIVE_SOURCE } from "./live";
import { readForDelegate, resolvePath, sizesForPlan } from "./readfiles";
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// The door's own version (LEANFARE_DOOR_VERSION: a test's older door). An app keeps the door it started running until
// it restarts, so after an update the door can be older than the running Leanfare: it then hands each call, and the
// list of tools, to the app, which runs them with its newer code (0.11; before, Cowork kept 0.9's tools after 0.10).
export const DOOR = { version: process.env.LEANFARE_DOOR_VERSION || VERSION };
const SERVER = { name: "leanfare", title: "Leanfare", version: DOOR.version };
const newer = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
// The app's version when it is newer than this door, else null. start: start the app when it is not running.
async function appNewer(start: boolean): Promise<string | null> {
  try { if (start) await app(); else await healthy(where().base); } catch { return null; }
  const v = seenVersion();
  return v && newer(v, DOOR.version) ? v : null;
}
let told = false; // the app was said to be newer, and the tool list to have changed, once
const META = { "io.modelcontextprotocol/serverInfo": SERVER };
const INSTRUCTIONS = "Leanfare runs every top AI model on this computer with the user's own keys, shows what each answer costs, and keeps a monthly budget. At the start of a task with several parts, call plan: it splits the task, starts Leanfare's parts at once by itself, and says in a short table which parts are yours; collect the rest of Leanfare's answers with plan_status, then review and grade each. Use delegate to hand work that reads a lot (big files, logs, many documents) to a cheaper model: Leanfare reads the files itself, so their text stays out of your context, and returns a short answer with a receipt. Use ask to hand a question to another model (Auto picks the cheapest one that rates well for the task); spend to see what was spent and saved; models to see which models and prices are available; estimate to price a prompt before sending it; trial to measure how well delegate answers on the user's models before relying on it.";

export const TOOLS = [
  {
    name: "plan",
    title: "Split a task across models",
    description: "Before a task with several parts (a feature, a fix across files, a refactor, research across many files, reverse engineering a project), ask Leanfare how to split it. It answers with a short table: each part, its kind, where it runs (you, or Leanfare on a local, free or pay per use model), the model, about how long, the tokens it keeps out of the user's plan, and the cost; then what to do next. Leanfare starts its own parts at once by itself (local and free ones, paid ones within the user's cap) and this answers with those that finish within about 25 seconds: do not run them again with delegate. Do the parts it leaves to you, then call plan_status with the plan's id (wait 50) for the rest of Leanfare's answers, and review and grade each. Name the files or folders the task is about in files: here Leanfare only measures them, it reads them when delegate runs a part. A model the user ticked does the split (a few cents or less, $0 on free models; one that takes more than 40 seconds is let go, and the rules split it); split rules makes it by rules, with no model.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The whole task, as the user gave it, with what you already know about it." },
        files: { type: "array", items: { type: "string" }, maxItems: 200, description: "The files or folders the task is about: full paths, ~/ paths, or paths relative to folder. Only their names and sizes are used here." },
        folder: { type: "string", description: "The folder relative paths start from. By default, the folder the MCP client started Leanfare in (in Claude Code, the project)." },
        split: { type: "string", enum: ["auto", "rules"], description: "auto (the default): a model the user ticked splits it. rules: Leanfare splits it by rules, with no model call." },
        private: { type: "boolean", description: "true keeps the whole plan on the user's computer: the split and every Leanfare part go only to models there (Ollama), and a part none of them can take stays with you. Use it for anything sensitive or personal, or when the user asks." },
        your_model: { type: "string", description: "The model you run on, as your own instructions name it (for example claude-opus-5-5). Leanfare names it for the work that stays with you, and the report shows it as the prompt's main model." },
        level: { type: "integer", minimum: 1, maximum: 5, description: "The Leanfare level for this chat or session, as the level tool or Leanfare's prompt line gave it. Leave it out when none was given." },
        run: { type: "boolean", description: "false: only split the task; Leanfare runs nothing. By default Leanfare starts its parts at once." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    annotations: { title: "Split a task across models", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // Apps that show MCP Apps (Claude Desktop, Cowork) draw the plan as a table that follows each part as it runs (planapp.ts).
    _meta: { ui: { resourceUri: PLAN_APP_URI }, "ui/resourceUri": PLAN_APP_URI },
  },
  {
    name: "plan_run",
    title: "Run Leanfare's parts of a plan",
    description: "Start the parts of a plan that Leanfare runs (local, free and pay per use models), in the background: at once where they can, each as soon as the parts it needs are done, with their answers handed on. Returns at once; read the progress and the answers with plan_status. Parts on local or free models run without asking. Paid parts run only within the cap the user set in Leanfare, or when the user said yes: Leanfare asks them itself where this app can show a question; otherwise ask the user, and call again with paid yes only after they agree. The user's monthly budget in Leanfare always holds.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The plan's id, from plan." },
        paid: { type: "string", enum: ["yes", "no"], description: "yes: the user agreed to the paid parts. Default no." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "Run Leanfare's parts of a plan", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "plan_stop",
    title: "Stop a plan's parts",
    description: "Stop the parts of a plan that Leanfare is running (plan_run). What was done stays; a part stopped half way may have been charged.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The plan's id, from plan." } }, required: ["id"], additionalProperties: false },
    annotations: { title: "Stop a plan's parts", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "plan_status",
    title: "Progress of a plan",
    description: "Where each part of a plan stands (waiting, running, done, failed, yours, after yours, waiting for a yes) and the answers of the parts Leanfare finished. Each answer is also saved in the project, in .leanfare/plans/<id>/ (a folder git ignores), where you and the user can read it. wait: up to that many seconds for the running parts to end (it answers as soon as none is running; default 0, at most 50).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The plan's id, from plan." },
        wait: { type: "integer", minimum: 0, maximum: 50, description: "Seconds to wait for the running parts to end before answering." },
        peek: { type: "boolean", description: "true: only look, without taking the answers (Leanfare's plan card uses it)." },
        folder: { type: "string", description: "The project folder to save the answers in. By default, the folder the MCP client started Leanfare in." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "Progress of a plan", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "grade",
    title: "Grade an answer",
    description: "Review every answer Leanfare brings back (delegate, or a plan's part from plan_status) before you use it, then say how good it was: good, partly or wrong. Grade a delegate answer with handoff (the number in its receipt); a plan's part with id and part. If it is partly or wrong, fix it before you answer the user: yourself (fix myself), or with fix leanfare and why, and Leanfare asks again one tier up and returns the new answer, a new hand off to review and grade too. Leanfare keeps only the grade, with the model that answered and the kind of part, never the words; why goes only to the model asked again. A model graded below good too often for a kind is moved down, so plans and delegate stop picking it for that kind. At the end of a prompt that handed work off, grade its whole result too, your work and the hand offs together: whole true and the verdict.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["good", "partly", "wrong"], description: "good: you used it as it was. partly: you had to fix or redo some of it. wrong: you could not use it." },
        id: { type: "string", description: "The plan's id, from plan." },
        part: { type: "integer", minimum: 1, description: "The part's number in the plan." },
        model: { type: "string", description: "For a delegate answer: the model id its receipt named, such as deepseek/deepseek-v4-flash." },
        kind: { type: "string", enum: ["read", "write", "reason", "search"], description: "For a delegate answer: the kind you gave it." },
        handoff: { type: "integer", minimum: 1, description: "For a delegate answer: the hand off's number, from its receipt. Enough on its own." },
        fix: { type: "string", enum: ["myself", "leanfare"], description: "With partly or wrong. myself: you fixed it yourself before answering. leanfare: Leanfare asks again one tier up, with why, by another model, and returns the new answer." },
        why: { type: "string", maxLength: 2000, description: "With fix leanfare: what was wrong or missing, in a line or two. It goes to the model asked again, and is not kept." },
        whole: { type: "boolean", description: "true: grade the final result of the prompt you are on, your own work and Leanfare's parts together (once, at the end of a prompt that handed work off). Only the verdict is needed with it." },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
    annotations: { title: "Grade an answer", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, // fix leanfare asks a model
  },
  {
    name: "ask",
    title: "Ask a model",
    description: "Ask a question through Leanfare and get the answer with its cost. By default Leanfare's Auto picks the cheapest model the user ticked that rates well for the task; name a model to use that one. The cost counts toward the user's budget.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question or task, with everything the model needs to answer it." },
        model: { type: "string", description: "auto (the default), auto-save, auto-balanced, auto-best, or a model id from the models tool, such as google/gemini-3.8-flash." },
        system: { type: "string", description: "Instructions for the model (a system prompt)." },
        max_tokens: { type: "integer", minimum: 1, maximum: 64000, description: "The longest answer to allow, in tokens." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: { title: "Ask a model", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "delegate",
    title: "Hand a task to a cheaper model",
    description: "Hand a piece of work to a cheaper model through Leanfare, to save your own context and usage. Best for work that reads a lot and answers briefly: search or summarize big files, logs or many documents, review a file, draft a section. Name the files in files: Leanfare reads them itself, so their text never enters your context. Leanfare picks the cheapest model the user ticked that rates well enough for the kind and effort, and returns a short answer with a receipt (the model, the cost, the tokens kept out of your context). Every high effort answer, and a sample of the others, is checked by a stronger model, blind and from another company when one can take it; a failed check is asked again one tier up. One that takes more than about 40 seconds answers with an id instead and keeps working: call delegate again with only that id to get the answer. Costs count toward the user's Leanfare budget.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to do, written for a model that has not seen this conversation: the goal, what to look for, and the form of answer you want (for example: a list of file:line, one line each)." },
        id: { type: "string", description: "The id an earlier delegate answered with while it was still working: give only this to get that answer." },
        files: { type: "array", items: { type: "string" }, maxItems: 50, description: "Text files for Leanfare to read and hand over with the task: full paths, ~/ paths, or paths relative to folder. At most 50 files, 2 MB each, 4 MB in all. Files that hold secrets (.env files, private keys, credentials) are refused." },
        folder: { type: "string", description: "The folder relative paths start from. By default, the folder the MCP client started Leanfare in (in Claude Code, the project)." },
        kind: { type: "string", enum: ["read", "write", "reason"], description: "read: find, pull out or summarize from the files. write: draft text or code. reason: work something out (a bug's cause, a plan, a proof). Leave it out to let Leanfare guess." },
        effort: { type: "string", enum: ["low", "medium", "high"], description: "How good the model must be: low takes the cheapest rated within 80 points of the best model the user ticked, medium within 40, high within 15. Also the thinking effort for models that think. Default medium." },
        check: { type: "string", enum: ["auto", "always", "never"], description: "auto (the default) has a stronger model check every high effort answer, 1 in 4 medium ones and 1 in 10 low ones." },
        speed: { type: "string", description: "At the same quality: \"cheapest\" (however long it takes), \"balanced\" (time and cost weighed alike), \"fastest\" (whatever it costs), or a number of seconds to answer within, like \"30\". Default: the user's choice in Leanfare." },
        private: { type: "boolean", description: "true keeps this task on the user's computer: only models there (Ollama) take it, and its check too. Use it for anything sensitive or personal, or when the user asks." },
        max_tokens: { type: "integer", minimum: 1, maximum: 64000, description: "The longest answer to allow, in tokens (default 8,192)." },
        your_model: { type: "string", description: "The model you run on, as your own instructions name it (for example claude-opus-5-5). Leanfare names it for the work that stays with you, and the report shows it as the prompt's main model." },
        level: { type: "integer", minimum: 1, maximum: 5, description: "The Leanfare level for this chat or session, as the level tool or Leanfare's prompt line gave it. Leave it out when none was given." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Hand a task to a cheaper model", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "spend",
    title: "What was spent",
    description: "What the user spent on AI through Leanfare today and this month, the budget left, what Auto saved against their usual model, the top models, the work Leanfare did for apps this month (plan and delegate): the share kept out of their plans, its cost and the grades; and each platform Leanfare may send work to, with what is left before its nearest limit (the 5 hours before the week).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "What was spent", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "report",
    title: "Leanfare's report",
    description: "What Leanfare did for the user's apps over a span of time: the tokens its models read so the apps did not (kept out of their plans), the apps' own use where it is known (Claude Code's, from its own files), the cost, the quality (the apps' grades and the blind checks), tokens over time, the work by model, and the last prompts with what each handed off. Each prompt has an id (PRM-41), kept for good; give prompt for one prompt and its parts. Use it when the user asks what Leanfare saved, how the models did, or for a report. Apps that show MCP Apps draw it as a card with spans to pick.",
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "string", enum: ["1h", "6h", "today", "7d", "30d", "year"], description: "The span: the last hour, 6 hours, today, the last 7 or 30 days, or the last year. Default 7d." },
        app: { type: "string", description: "Only the prompts of this app, as Leanfare names it (Claude Code, Claude, Codex)." },
        prompt: { type: "string", description: "One prompt's id from a report, like PRM-41: that prompt and each of its parts (PRM-41.1, PRM-41.2). range and app are then left out." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Leanfare's report", readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: REPORT_APP_URI }, "ui/resourceUri": REPORT_APP_URI },
  },
  {
    name: "models",
    title: "Models and prices",
    description: "The models the user ticked in Leanfare and can use now, with their prices in US dollars per 1M tokens and their quality rating (Arena).",
    inputSchema: { type: "object", properties: { provider: { type: "string", description: "Only this provider, for example openai, anthropic, google, openrouter." } }, additionalProperties: false },
    annotations: { title: "Models and prices", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "estimate",
    title: "Estimate a cost and a time",
    description: "Estimate what a prompt would cost and how long it would take before sending it: the model Auto would pick, why, and at the same quality the cheapest and the fastest choice. Nothing is sent to a model.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to price." },
        model: { type: "string", description: "auto (the default) or a model id." },
        speed: { type: "string", description: "For auto: \"cheapest\", \"fastest\", or a number of seconds to answer within, like \"30\". Default: the user's choice in Leanfare." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: { title: "Estimate a cost and a time", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "trial",
    title: "Try the delegate first",
    description: "Measure how well delegate answers on the user's models before relying on it: 10 questions with known answers about files Leanfare makes up, each asked at low, medium and high effort (30 answers, a few minutes; it costs what those answers cost, $0 on free plans). start begins it and returns at once; status gives the progress or the report, with the lowest effort that passed and the line for CLAUDE.md; stop ends it. Nothing of the user's is sent.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["status", "start", "stop"], description: "status (the default), start or stop." } }, additionalProperties: false },
    annotations: { title: "Try the delegate first", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "local_model",
    title: "Local models on this computer",
    description: "The models on this computer (Ollama): where Ollama keeps them (the drive and its free space; downloads go there too), one suggested for each kind of work (reading, drafting, working things out) with its size in GB, and a test of a model the user has. Arena rates few small models, so the test asks one of them 8 questions with known answers about made up files, on this computer (free, a few minutes, nothing leaves it); one that passes then takes reading work first in plans and the delegate. suggest (the default) says all this; test, with model, starts the test; status says how a test or a download goes; download asks the user, then has Ollama download a suggested model (model names which; the default is the best rated one). Nothing is downloaded without the user's yes.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["suggest", "test", "status", "download"], description: "suggest (the default), test, status or download." },
        model: { type: "string", description: "For test: a model the user has, like qwen3:8b. For download: one of the suggested models." },
        yes: { type: "string", enum: ["yes", "no"], description: "For download, only where your app cannot show Leanfare's question: yes once the user agreed to the download in the chat. An app that can show it gets the question from Leanfare itself." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Local models on this computer", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "level",
    title: "Leanfare's level",
    description: "How much to hand to Leanfare first, from 1 to 5: 1 Off (only when the user asks), 2 Light (big reads and tasks with several parts), 3 More (also reads over about 10 KB you will not change, project wide searches, summaries, reviews and first drafts), 4 Most (plan every prompt that is more than a quick question with Leanfare first), 5 All it can (every part a model can do; you review, decide and answer). Call it with nothing at the start of a chat to learn the level, and follow it. When the user sets one (\"Leanfare 4\", \"use Leanfare less\"), call it with set, and scope: chat (this chat only, the default), app (this app from now on) or default (every app). Pass the level to delegate and plan.",
    inputSchema: {
      type: "object",
      properties: {
        set: { type: "integer", minimum: 1, maximum: 5, description: "The level to set: 1 Off, 2 Light, 3 More, 4 Most, 5 All it can." },
        scope: { type: "string", enum: ["chat", "app", "default"], description: "With set: chat (this chat only, the default), app (this app from now on) or default (every app and new chat)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Leanfare's level", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "live",
    title: "Live tokens",
    description: "The model calls Leanfare is running right now, and those that ended in the last minute, as numbers only: the model, what it is for (a hand off, its check, a plan's part, an app through Leanfare's address), how long it has run, and its tokens so far by kind (new input, cached, thinking, written), with tokens a second. Use it when the user asks what Leanfare is doing now, or to watch a plan's parts run. Apps that show MCP Apps draw it as a live card that keeps moving.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Live tokens", readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: LIVE_APP_URI }, "ui/resourceUri": LIVE_APP_URI },
  },
];

// ---- the tools -------------------------------------------------------------------------

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const count = (n: number) => n.toLocaleString("en-US");
// The spend tool's lines for the work Leanfare did for apps this month (savings.ts: work).
function workLines(w: any): string {
  if (!w?.tasks) return "No work was handed to Leanfare by your apps this month (plan and delegate).";
  const graded = w.grades.good + w.grades.partly + w.grades.wrong;
  const checked = w.checks.passed + w.checks.failed;
  return [
    `Work for your apps this month (plan and delegate): ${count(w.tasks)} task${w.tasks === 1 ? "" : "s"}; Leanfare's models read ${count(w.kept)} tokens your apps never had to, and ${count(w.back)} came back to them; ${usd(w.cost)}.`,
    `Quality: ${graded ? `${count(w.grades.good)} of ${count(graded)} graded good, ${count(w.grades.partly)} partly, ${count(w.grades.wrong)} wrong` : "no answer graded yet"}; checks: ${checked ? `${count(w.checks.passed)} of ${count(checked)} passed` : "none yet"}${w.side?.compared ? `; side by side: as good as the top model in ${count(w.side.asGood)} of ${count(w.side.compared)}, judged blind` : ""}.`,
  ].join("\n");
}
// The report tool's text (apps without pages read this) and its card's data (reportapp.ts draws it).
const SPAN: Record<string, string> = { "1h": "the last hour", "6h": "the last 6 hours", today: "today", "7d": "the last 7 days", "30d": "the last 30 days", year: "the last year" };
const tokShort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pctOf = (x: number | null | undefined) => (x === null || x === undefined ? "not known" : `${Math.round(x * 100)}%`);
const planShort = (name: string | null) => (name ? name.replace(/^(Claude|ChatGPT)\s+/i, "") : null);
// What the outside models used for a part or a prompt, measured: read, thinking (where known) and written.
export function usedText(u: any): string | null {
  if (!u) return null;
  return u.thought === null ? `${tokShort(u.read)} read, ${tokShort(u.wrote)} written (thinking not split)`
    : `${tokShort(u.read)} read, ${tokShort(u.thought)} thinking${u.estimated ? " (partly from its text)" : ""}, ${tokShort(u.wrote)} written`;
}
// Speed and failures of the models used most in the span: the middle answer's time, and what failed.
const sec = (v: number) => (v < 10 ? `${v} s` : `${Math.round(v)} s`);
export function speedLine(rows: any[] | undefined): string {
  if (!rows?.length) return "";
  return `Speed by model: ${rows.slice(0, 5).map((m: any) => {
    const failed = m.failed ? `${m.failed} of ${m.calls} calls failed (${FAIL_KINDS.filter((k) => m.fails?.[k]).map((k) => `${m.fails[k]} ${FAIL_WORD[k]}`).join(", ")})` : `${m.calls} call${m.calls === 1 ? "" : "s"}, none failed`;
    const rest = m.rest ? `, resting until ${new Date(m.rest.until).toISOString().slice(11, 16)} UTC (${m.rest.why})` : m.noQuota ? `, left out: ${m.noQuota.why}` : "";
    return `${m.label} ${m.whole ? `${sec(m.whole.mid)} an answer${m.first ? ` (first word ${sec(m.first.mid)})` : ""}` : "no answer yet"}, ${failed}${rest}`;
  }).join("; ")}.`;
}
export function reportLines(r: any, range: string): string {
  const t = r.tiles;
  if (!r.prompts.length) return `Leanfare's report, ${SPAN[range] ?? range}: nothing handed to Leanfare yet in this span.`;
  const own = t.own.byApp.map((a: any) => (a.measured ? `${a.app} ${tokShort(a.fresh)} new tokens (measured)` : `${a.app}: not known`)).join("; ");
  const lines = [
    `Leanfare's report, ${SPAN[range] ?? range}: ${tokShort(t.kept.tokens)} tokens kept out of your plans${t.kept.share !== null ? ` (${pctOf(t.kept.share)} of ${t.kept.measuredIn ?? "your apps"}'s use${t.kept.share === 0 ? ": nothing handed off there" : ""})` : ""}${t.kept.value !== null ? `; about ${usd(t.kept.value)} at ${t.kept.valueModel}'s prices` : ""}.`,
    `Your apps' own use: ${own}${t.own.cached ? `; ${tokShort(t.own.cached)} more read again from the cache` : ""}.`,
    `Cost of the hand offs: ${usd(t.cost.usd)}; ${pctOf(t.cost.freeShare)} of parts free or on this computer; ${t.cost.parts} parts in ${t.cost.prompts} prompts.`,
    t.both ? `Saved for ${t.both.app ?? "your apps"} (an estimate): about ${tokShort(Math.max(0, t.both.saved.mid))} tokens (${t.both.app ?? "your apps"} alone about ${tokShort(t.both.alone.mid)}, less the hand offs' own cost of about ${tokShort(t.both.spent)}; between ${tokShort(Math.max(0, t.both.saved.low))} and ${tokShort(Math.max(0, t.both.saved.high))}).` : "",
    t.three ? `Quality three ways, as scores out of 100 (good 1, partly half, wrong 0) with their 90% range: the outside answers ${scoreText(t.three.outside.score)}; the whole results together ${scoreText(t.three.together.score)}; the app alone ${scoreText(t.three.alone.score, "not known")}.` : "",
    t.outside?.measured ? `What the outside models used (measured): ${usedText(t.outside)}, in ${t.outside.calls} call${t.outside.calls === 1 ? "" : "s"}${t.outside.failed ? ` (${t.outside.failed} failed)` : ""}${t.outside.notMeasured ? `; ${t.outside.notMeasured} older part${t.outside.notMeasured === 1 ? "" : "s"} not measured` : ""}.` : "",
    `Quality: ${t.quality.graded ? `${scoreText(t.quality.score)}: ${t.quality.good} good, ${t.quality.partly} partly, ${t.quality.wrong} wrong; ${t.quality.blind} judged blind` : "not graded yet"}.`,
    levelLine(r.byLevel),
    speedLine(r.speed),
    r.byModel.length ? `Work by model: ${r.byModel.slice(0, 6).map((m: any) => `${m.label} ${tokShort(m.read)} tokens, ${m.parts} part${m.parts === 1 ? "" : "s"}${m.score ? `, score ${scoreText(m.score)}` : ""}`).join("; ")}.` : "",
    `Last prompts:\n${r.prompts.slice(0, 6).map((p: any) => `- ${p.id ? `${p.id}, ` : ""}${new Date(p.ts).toISOString().slice(0, 16).replace("T", " ")} UTC, ${p.app}${p.model ? ` (${p.model.label}${p.plan ? `, ${planShort(p.plan)}` : ""})` : ""}: ${p.parts.length ? `${[...new Set(p.parts.map((x: any) => x.label))].join(", ")}, ${tokShort(p.kept)} kept out${p.saved !== null ? `, ${pctOf(p.saved)} saved` : ""}` : "nothing handed off"}${p.grade ? `, ${p.grade}` : ""}`).join("\n")}`,
    `The full report: Leanfare, Savings (${where().base}/#report).`,
  ];
  return lines.filter(Boolean).join("\n");
}
// Quality by level (0.12): each level's share graded good and how many were fixed before the app answered, then all.
export function levelLine(b: any): string {
  if (!b || !b.all?.parts) return "";
  const one = (r: any) => (r.graded ? `${Math.round(r.goodShare * 100)}% good of ${r.graded} graded${r.bad ? `, ${r.fixed} of ${r.bad} fixed first` : ""}` : `${r.parts} not graded yet`);
  const rows = [...b.levels.map((r: any) => `${levelText(r.level as Level)} ${one(r)}`), ...(b.before ? [`before levels ${one(b.before)}`] : [])];
  return `Quality by level: ${rows.join("; ")}; all levels ${one(b.all)}.`;
}
// One prompt and its parts, by its id (report with prompt).
const KIND_WORD: Record<string, string> = { read: "reading", write: "drafting", reason: "working out", search: "search" };
const WHERE_WORD: Record<string, string> = { local: "on this computer", free: "free", plan: "on your ChatGPT plan", paid: "paid" };
export function promptLines(r: any): string {
  const p = r.prompts[0];
  if (!p) return "Leanfare's report: no such prompt in the report.";
  const when = new Date(p.ts).toISOString().slice(0, 16).replace("T", " ");
  const head = `Prompt ${p.id}: ${when} UTC, ${p.app}${p.model ? ` (${p.model.label}${p.plan ? `, ${planShort(p.plan)}` : ""})` : ""}.`;
  const own = p.own ? `Its own work: ${tokShort(p.own.fresh)} new tokens (measured)${p.own.cached ? `, ${tokShort(p.own.cached)} more read again from the cache` : ""}.` : "Its own work: not known (this app does not share it).";
  const sum = p.parts.length ? `Kept out: ${tokShort(p.kept)} tokens${p.saved !== null ? ` (${pctOf(p.saved)} of its use)` : ""}; cost ${usd(p.cost)}${p.grade ? `; lowest grade ${p.grade}` : ""}.${p.used ? ` The outside models used ${usedText(p.used)} (measured).` : ""}${p.both ? ` ${p.app} alone: about ${tokShort(p.both.alone.mid)} (an estimate); saved about ${tokShort(Math.max(0, p.both.saved.mid))}.` : ""}${p.together ? ` The whole result: ${p.together} (graded by ${p.togetherBy === "you" ? "you" : p.app}).` : ""}` : "Nothing handed off.";
  const parts = p.parts.map((x: any) => `- ${x.ref ?? `#${x.id}`} ${KIND_WORD[x.kind] ?? x.kind ?? "part"}: ${x.label}, ${tokShort(x.read)} read, ${tokShort(x.back)} back${x.used ? ` (the outside models used ${usedText(x.used)})` : ""}, ${x.where === "paid" ? usd(x.cost) : WHERE_WORD[x.where]}${x.ms ? `, ${Math.max(1, Math.round(x.ms / 1000))} s` : ""}${x.grade ? `, ${x.grade}${x.gradedBy === "check" ? ` (checked blind${x.checker ? ` by ${x.checker}` : ""})` : " (by your app)"}` : ""}${x.side ? `, side by side: ${x.side === "same" ? "as good as the top model's" : x.side === "better" ? "better than the top model's" : "the top model's was better"}` : ""}${x.both ? `, ${p.app} alone about ${tokShort(x.both.alone.mid)} (an estimate), saved about ${tokShort(Math.max(0, x.both.saved.mid))}` : ""} (hand off ${x.id})`);
  // Kept words (words.ts, 0.12): each part's task and answer, cut to keep the reply short.
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}… (${t.length.toLocaleString("en-US")} characters in all)` : t);
  const words = p.parts.filter((x: any) => x.text).map((x: any) => `${x.ref ?? `#${x.id}`}, the task:\n${cut(x.text.task, 1500)}${x.text.answer ? `\n${x.ref ?? `#${x.id}`}, the answer:\n${cut(x.text.answer, 1500)}` : ""}${x.text.files?.length ? `\nFiles: ${x.text.files.map((f: any) => f.name).join(", ")}` : ""}`);
  return [head, own, sum, parts.length ? `Parts:\n${parts.join("\n")}` : "", words.length ? `Kept words:\n${words.join("\n\n")}` : "", `The full report: Leanfare, Savings (${where().base}/#report).`].filter(Boolean).join("\n");
}
function compactReport(r: any, range: string, app: string | null = null) {
  return {
    range, app, from: r.from, to: r.to, step: r.step, tiles: r.tiles, series: r.series,
    byModel: r.byModel.slice(0, 6).map((m: any) => ({ label: m.label, where: m.where, read: m.read, parts: m.parts, cost: m.cost, goodShare: m.goodShare, score: m.score ?? null })),
    byKind: r.byKind,
    byLevel: r.byLevel ?? null,
    speed: (r.speed ?? []).slice(0, 6).map((m: any) => ({ label: m.label, where: m.where, calls: m.calls, failed: m.failed, fails: m.fails, first: m.first, whole: m.whole, goodShare: m.goodShare, score: m.score ?? null, rest: m.rest, noQuota: m.noQuota ?? null })),
    prompts: r.prompts.slice(0, 6).map((p: any) => ({ id: p.id, ts: p.ts, app: p.app, model: p.model?.label ?? null, plan: planShort(p.plan), parts: [...new Set(p.parts.map((x: any) => x.label))], kept: p.kept, saved: p.saved, grade: p.grade, used: p.used ? { read: p.used.read, thought: p.used.thought, wrote: p.used.wrote } : null,
      both: p.both ? { alone: p.both.alone.mid, saved: p.both.saved.mid } : null, together: p.together ?? null })),
    open_url: `${where().base}/#report`,
  };
}
// The live tool's lines (live.ts): each call running, then those ended in the last minute, then the minute's sums.
const tk = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
function liveLines(v: any): string {
  const one = (c: any) => `${c.model?.label ?? "a model"}, ${LIVE_SOURCE[c.source] ?? c.source}, ${Math.round(((c.ended ?? v.at) - c.started) / 1000)} s: new input ${tk(c.input)}, cached ${tk(c.cached)}, thinking ${tk(c.thinking)}, written ${tk(c.written)}${c.exact ? "" : " (estimates until the provider's counts come)"}`;
  const ended = (v.ended ?? []).filter((c: any) => v.at - c.ended < 60_000);
  return [
    v.running.length ? `Running now: ${v.running.length} ${v.running.length === 1 ? "call" : "calls"}, ${tk(v.rate)} tokens a second.` : "Nothing is running now.",
    ...v.running.map((c: any, i: number) => `${i + 1}. ${one(c)}`),
    ended.length ? "Ended in the last minute:" : "",
    ...ended.map((c: any) => `- ${one(c)}`),
    `The last minute: new input ${tk(v.minute.input)}, cached ${tk(v.minute.cached)}, thinking ${tk(v.minute.thinking)}, written ${tk(v.minute.written)}. Numbers only; no words are kept for this.`,
  ].filter(Boolean).join("\n");
}
const text = (t: string, structured?: unknown) => ({ content: [{ type: "text", text: t }], ...(structured !== undefined ? { structuredContent: structured } : {}) });
const failure = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

const agoText = (ms: number) => (ms < 90_000 ? "just now" : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} minutes ago` : ms < 36 * 3600_000 ? `${Math.round(ms / 3600_000)} hours ago` : `${Math.round(ms / 86_400_000)} days ago`);
// What the app is asked to do with an answer Leanfare brought back (0.12): review it, grade it, and fix it before it
// answers (Settings, Review every answer); off, or with no number to grade by, the line of before.
export function reviewLine(j: { row?: number | null; kind?: string | null; model: { id: string }; review?: boolean }): string {
  if (j.row && j.review !== false)
    return `(Review it before you use it: check it against the task. Then grade hand off ${j.row}: good, partly or wrong. If it is partly or wrong, fix it before you answer: yourself (grade with fix "myself"), or grade with fix "leanfare" and why, and Leanfare asks again one tier up and sends back a new answer to review.)`;
  if (!["read", "write", "reason"].includes(String(j.kind))) return "";
  return `(Once you have used it: grade, with model ${j.model.id}, kind ${j.kind}${j.row ? ` and handoff ${j.row}` : ""}.)`;
}
// A hand off's answer as the app reads it: the answer, the receipt, the review line; a fix's starts with its grade.
function handOffReply(j: any, before = "") {
  const review = reviewLine(j);
  const who = j.whoWrote ? `\n\n${whoNote([j.model.label])}` : "";
  return text(`${before}${j.whoWrote ? markedBy(j.answer, j.model.label) : j.answer}\n\n(${j.receipt})${review ? `\n\n${review}` : ""}${who}`, {
    answer: j.answer, model: j.model.id, cost_usd: j.cost, total_usd: j.total, task: j.task, effort: j.effort,
    check: j.check.picked ? { verdict: j.check.verdict, by: j.check.checker?.id ?? null, why: j.check.why || null, cost_usd: j.check.cost } : null,
    first: j.first ? { model: j.first.model.id, cost_usd: j.first.cost } : null,
    tokens: j.tokens, cut: j.cut, seconds: j.seconds, handoff: j.row ?? null, ...(j.fixOf ? { fix_of: j.fixOf } : {}),
    // 0.12: some apps read only this part of a tool's result (Cowork does), so the receipt and what to do with the answer
    // are here too, not only in the text.
    receipt: j.receipt, review: review || null,
  });
}

// The app on the other side, by the name it gives (initialize's clientInfo), for the plan's table.
let client: string | null = null;
// Cowork gives its door the name "local-agent-mode-<server>" (local-agent-mode-leanfare).
const CLIENTS: [RegExp, string][] = [[/^local[- _]agent[- _]mode|cowork/i, "Cowork"], [/claude[- _]?code/i, "Claude Code"], [/^claude/i, "Claude"], [/codex/i, "Codex"], [/cursor/i, "Cursor"], [/gemini/i, "Gemini CLI"],
  [/windsurf|codeium/i, "Windsurf"], [/grok/i, "Grok"], [/perplexity/i, "Perplexity"], [/visual studio code|vs ?code|copilot/i, "VS Code"], [/lm ?studio/i, "LM Studio"]];
export function clientLabel(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const hit = CLIENTS.find(([re]) => re.test(name));
  return hit ? hit[1] : name.replace(/[^\w .-]/g, "").trim().slice(0, 40) || null;
}
export const setClient = (name: unknown) => { client = clientLabel(name); };

// ---- the shared folder: a plan and its answers, in the project ----------------------------------
// .leanfare/plans/<id>/: plan.md (the task and the table), part-<n>.md (an answer and its receipt),
// status.md. The folder holds a .gitignore of its own, so git leaves it out without your .gitignore
// changing. Only in a project: never in the computer's top folder or straight in your home folder.
export function sharedFolder(given?: unknown, base = process.cwd()): string | null {
  let dir = base;
  if (typeof given === "string" && given.trim()) { try { dir = resolvePath(given, base); } catch { return null; } }
  dir = resolve(dir);
  if (dir === resolve("/") || dir === resolve(homedir())) return null;
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  return dir;
}
const PLAN_ID = /^[A-Za-z0-9_-]{6,64}$/; // the ids Leanfare makes (randomId): never a path
// Each folder on the way and each file is checked not to be a link (a cloned repo could carry one
// that points anywhere), and a file is written only as a plain file.
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
function writeShared(folder: string, id: string, files: Record<string, string>): string | null {
  if (!PLAN_ID.test(id)) return null;
  try {
    const root = join(folder, ".leanfare"), dir = join(root, "plans", id);
    for (const d of [root, join(root, "plans"), dir]) { if (isLink(d)) return null; if (!existsSync(d)) mkdirSync(d); }
    const ignore = join(root, ".gitignore");
    if (!isLink(ignore) && !existsSync(ignore)) writeFileSync(ignore, "# Leanfare's plans and their answers: kept out of git.\n*\n", { flag: "wx" });
    for (const [name, text] of Object.entries(files)) {
      const f = join(dir, name);
      if (isLink(f)) continue;
      writeFileSync(f, text);
    }
    return `.leanfare/plans/${id}`;
  } catch { return null; } // a folder Leanfare may not write in: the answers are in the tool's result anyway
}
// The test switch (Settings, Show who wrote what): each paragraph of a model's answer starts with the model's name
// in a small mark (inline code, which apps show highlighted), and the app is asked to keep the marks on what it takes
// and to mark its own paragraphs the same way, so its reply shows who wrote what. A list, a table, a heading or code
// keeps its form: the mark goes on its own line above it, and nothing inside code is marked.
export function markedBy(text: string, label: string): string {
  const mark = "`" + label.replace(/`/g, "") + "`";
  let fence = false;
  return text.split(/\n{2,}/).map((block) => {
    const inside = fence;
    if ((block.match(/^\s*```/gm) ?? []).length % 2 === 1) fence = !fence;
    if (inside || !block.trim()) return block;
    return /^\s*([-*+]\s|\d+[.)]\s|\||#|```|>)/.test(block) ? `${mark}\n${block}` : `${mark} ${block}`;
  }).join("\n\n");
}
export const whoNote = (labels: string[]) => `(Test, Show who wrote what is on in Leanfare: keep the ${labels.map((l) => "`" + l + "`").join(", ")} marks on what you take from ${labels.length === 1 ? "this answer" : "these answers"}, and start each paragraph you write yourself with your own model's name the same way, so the user sees who wrote what.)`;
const STATUS: Record<string, string> = { waiting: "waiting", running: "running", done: "done", failed: "failed", stopped: "stopped", yours: "yours to do", after_yours: "after yours: hand it to delegate once yours is done", blocked: "waits for a part that is not done", asks: "paid: waits for a yes" };
const SHOWN = 3000; // characters of an answer in the tool's result (the whole answer is in its file)
// What the app is asked to do with a plan's answers: review, grade and fix them (0.12), or only grade them.
export function planReview(v: any): string {
  const done = v.parts.filter((r: any) => r.answer);
  if (!done.length) return "";
  if (v.review !== false) return `Review ${done.length === 1 ? "this answer" : "each answer"} before you use it, then grade ${done.length === 1 ? "it" : "each"} with grade (good, partly or wrong, with the plan's id and the part). If one is partly or wrong, fix it before you answer: yourself (fix "myself"), or with fix "leanfare" and why, and Leanfare asks again one tier up and sends back a new answer to review.`;
  return `Once you have used ${done.length === 1 ? "this answer" : "these answers"}, grade ${done.length === 1 ? "it" : "each"} with grade (good, partly or wrong, with the plan's id and the part): models graded below good too often are moved down.`;
}
// A run's parts as the tools give them; took: the app has had the answer, verdict: its grade.
const runParts = (v: any) => v.parts.map((r: any) => ({ n: r.n, title: r.title, status: r.status, model: r.model, cost_usd: r.cost, seconds: r.seconds, answer: r.answer, receipt: r.receipt, error: r.error, took: !!r.took, verdict: r.verdict ?? null }));
// Nothing of Leanfare's left running in a run: every part is done, failed, stopped, waiting for a yes or for yours.
const ENDED = new Set(["done", "failed", "stopped", "asks", "blocked", "yours", "after_yours"]);
export const settled = (v: any) => !v.running || v.parts.every((r: any) => ENDED.has(r.status));
export const PLAN_WAIT = 25; // seconds the plan tool waits for Leanfare's quick parts before answering (0.13)
export function statusText(v: any, saved: string | null): string {
  const rows = v.parts.map((r: any) => `| ${r.n} | ${String(r.title).replace(/\|/g, "/")} | ${STATUS[r.status] ?? r.status} | ${r.model ?? ""} | ${r.cost === null || r.cost === undefined ? "" : usd(r.cost)} |`);
  const done = v.parts.filter((r: any) => r.answer);
  const lines = ["| # | Part | Now | Model | Cost |", "|---|---|---|---|---|", ...rows, ""];
  lines.push(v.running ? "Still running: ask plan_status again (wait up to 50 seconds)." : "Leanfare's parts have ended.");
  if (v.asks) lines.push(`Parts ${v.asks.parts.join(", ")} are paid (about ${usd(v.asks.estimate)}, over the cap of ${usd(v.asks.cap)} set in Leanfare) and wait for the user's yes: ask them, then call plan_run with paid yes.`);
  const shown = (r: any) => (v.whoWrote ? markedBy(r.answer, r.model ?? "Leanfare") : r.answer);
  for (const r of done) lines.push("", `## Part ${r.n}: ${r.title}`, "", r.answer.length > SHOWN ? `${shown({ ...r, answer: r.answer.slice(0, SHOWN) })}\n\n(cut here: the whole answer is in ${saved ?? "Leanfare"}${saved ? `/part-${r.n}.md` : ""})` : shown(r), "", `(${r.receipt})`);
  for (const r of v.parts.filter((x: any) => x.error)) lines.push("", `Part ${r.n} failed: ${r.error}`);
  const review = planReview(v);
  if (review) lines.push("", review);
  if (saved) lines.push("", `Saved in ${saved}/ in the project.`);
  if (v.whoWrote && done.length) lines.push("", whoNote([...new Set<string>(done.map((r: any) => String(r.model ?? "Leanfare")))]));
  return lines.join("\n");
}
function sharedFiles(v: any): Record<string, string> {
  const files: Record<string, string> = { "status.md": statusText(v, null) + "\n" };
  for (const r of v.parts.filter((x: any) => x.answer)) files[`part-${r.n}.md`] = `# Part ${r.n}: ${r.title}\n\n${r.answer}\n\n---\n${r.receipt}\n`;
  return files;
}

// A plan's paid parts over the user's cap wait for a yes: asked here where the app shows questions (MCP elicitation).
// off: Leanfare was switched off while the question was open, so nothing more runs.
async function askPaid(ctx: ToolCtx, id: string, v: any, signal: AbortSignal): Promise<any> {
  if (!v.asks || !ctx.canAsk) return v;
  const yesTo = (a: any) => a?.action === "accept" && a.content?.run === true;
  const a = await askUser({
    message: `Leanfare's plan has paid parts (${v.asks.parts.map((n: number) => `part ${n}`).join(", ")}), about ${usd(v.asks.estimate)} on pay per use, over your cap of ${usd(v.asks.cap)}. The free and local parts are running. Run the paid ones too?`,
    requestedSchema: { type: "object", properties: { run: { type: "boolean", title: "Run the paid parts", description: `About ${usd(v.asks.estimate)}, within your monthly budget in Leanfare.`, default: false } }, required: ["run"] },
  }, {
    // A yes after the tool stopped waiting: the person said yes to these parts, so they run (once: a run that has them going is left as it is).
    // Not once Leanfare is switched off: the yes was for a Leanfare that was on.
    late: (r) => { if (yesTo(r) && switchedOn()) call("/api/plan/run", { method: "POST", json: { id, paid: true } }, new AbortController().signal).catch(() => {}); },
  });
  if (!yesTo(a)) return v;
  if (!switchedOn()) return { ...v, off: true };
  return (await call("/api/plan/run", { method: "POST", json: { id, paid: true } }, signal)).j;
}

// Asking the user, where the app can show a question (MCP elicitation): yes or no to the paid parts.
let canAsk = false;
const asked = new Map<string, (msg: any) => void>();
let askId = 0;
// After ms the tool stops waiting and says the parts wait; an answer that still comes (within half
// an hour: the app may keep showing the question) goes to late.
const LATE_MS = 30 * 60_000;
const ASK_MS = Number(process.env.LEANFARE_ASK_WAIT_MS) > 0 ? Number(process.env.LEANFARE_ASK_WAIT_MS) : 120_000; // the tests' wait is shorter
function askUser(params: unknown, opts: { ms?: number; late?: (result: any) => void } = {}): Promise<any> {
  const id = `leanfare-${++askId}`;
  return new Promise((done) => {
    const t = setTimeout(() => {
      asked.delete(id);
      out({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "No answer in time: the paid parts wait. A yes here later still runs them, or plan_run can be called again." } });
      done(null);
      if (opts.late) {
        const gone = setTimeout(() => asked.delete(id), LATE_MS);
        (gone as any).unref?.();
        asked.set(id, (msg) => { clearTimeout(gone); opts.late!(msg?.result ?? null); });
      }
    }, opts.ms ?? ASK_MS);
    asked.set(id, (msg) => { clearTimeout(t); done(msg?.result ?? null); });
    out({ jsonrpc: "2.0", id, method: "elicitation/create", params });
  });
}

const gbText = (b: number) => `${(b / 1e9).toFixed(b < 10e9 ? 1 : 0)} GB`;
// Where Ollama keeps its models, as Settings says it (local.ts: whereModels).
export function whereLine(o: any): string {
  const w = o?.where;
  if (!o?.running) return "Ollama is not running on this computer.";
  if (!w) return "Ollama runs on another computer, so Leanfare cannot see its disk.";
  const n = o.installed?.length ?? 0;
  if (w.missing) return `Ollama's models folder is a link to ${w.real ?? "a folder"}${w.drive ? `, on the drive ${w.drive}` : ""}, which is not there now: attach that drive and Ollama finds its models again.`;
  const place = w.drive ? `on the drive ${w.drive}` : `in ${w.real ?? w.dir}, on this ${o.machine ?? "computer"}'s own disk`;
  const room = w.free !== null ? `, with ${gbText(w.free)} free` : "";
  if (!n) return `Ollama has no models yet. Its folder is ${place}${room}, and downloads go there.`;
  return `Ollama keeps your ${n} model${n === 1 ? "" : "s"} (${gbText(o.total)}) ${place}${room}. New downloads go there too.`;
}
function kindLine(k: any): string {
  const p = k.pick;
  if (!p) return `${k.title}: none. ${k.why}`;
  const state = p.act === "use" ? (p.test?.passed ? `you have it, passed the test (${p.test.right} of ${p.test.asked})` : "you have it") : p.act === "test" ? "you have it, not tested yet" : "a download";
  const next = p.act === "test" ? ` To test it: local_model with action test and model ${p.name}.` : p.act === "download" || p.act === "download-test" ? ` To download it: local_model with action download and model ${p.name} (the user is asked first).` : "";
  return `${k.title}: ${p.name} (${gbText(p.size)}), ${state}. ${k.why}${next}`;
}
function testLine(t: any): string {
  const c = t?.current;
  if (!c) return "No model was tested here yet.";
  if (c.status === "running") return `Testing ${c.label} on this computer: ${c.done} of ${c.total} questions so far, ${c.right} right.`;
  if (c.status === "done") { const r = t.results?.[c.model]; return `${c.label}: ${c.right} of ${c.total} right${c.skipped ? ` (${c.skipped} too long for it, left out)` : ""}, in ${c.seconds} seconds. ${r?.passed ? "It passed: plans and the delegate send reading to it first." : "It did not pass (at most one wrong), so it gets no reading work."}`; }
  return c.status === "stopped" ? `The test of ${c.label} was stopped.` : `The test of ${c.label} failed: ${c.error}`;
}
function pullLine(p: any): string {
  if (!p) return "No download is running.";
  const at = p.percent !== null && p.percent !== undefined ? `, ${p.percent}%` : "";
  return p.active ? `${p.name}: ${String(p.step).toLowerCase()}${at}.` : p.message ?? `${p.name}: ${p.status}.`;
}

// The tools that hand work over. While Leanfare is switched off (switch.ts) each says so, and the app does it itself.
const HANDS_OVER = new Set(["plan", "plan_run", "ask", "delegate"]);

// Who a tool call is for: the app on the other side, the folder relative paths start from, and whether Leanfare can ask
// that app's person a question (elicitation). The door's own, or one the app was handed (a door older than the app).
export interface ToolCtx { client: string | null; cwd: string; canAsk: boolean }
const here = (): ToolCtx => ({ client, cwd: process.cwd(), canAsk });
export const runToolFor = (ctx: ToolCtx, name: string, args: any, signal: AbortSignal) => runTool(name, args, signal, ctx);
async function runTool(name: string, args: any, signal: AbortSignal, ctx: ToolCtx = here()): Promise<any> {
  if ((HANDS_OVER.has(name) || (name === "trial" && args?.action === "start")) && !switchedOn()) return text(OFF_TEXT, { off: true });
  if (name === "live") {
    const { j: v } = await call("/api/live", {}, signal);
    return text(liveLines(v), v);
  }
  if (name === "level") {
    const set = args?.set, scope = args?.scope ?? "chat";
    if (set !== undefined && !isLevel(set)) return failure("set is a level from 1 to 5: 1 Off, 2 Light, 3 More, 4 Most, 5 All it can.");
    if (!["chat", "app", "default"].includes(scope)) return failure("scope is chat (this chat only), app (this app from now on) or default (every app and new chat).");
    if (set !== undefined && scope === "app" && !appKey(ctx.client)) return failure(`A level can be kept for Claude Code, Claude Desktop and Cowork, Codex, Gemini CLI and Cursor, and this app is ${ctx.client ?? "not named"}. Set it for this chat, or as the default.`);
    if (set !== undefined && scope !== "chat") await call("/api/level", { method: "POST", json: { set, scope, app: ctx.client } }, signal);
    const q = [ctx.client ? `app=${encodeURIComponent(ctx.client)}` : "", set !== undefined && scope === "chat" ? `chat=${set}` : ""].filter(Boolean).join("&");
    const { j } = await call(`/api/level${q ? `?${q}` : ""}`, {}, signal);
    const lines = [levelAdvice(j.view, "chat")];
    if (set !== undefined) lines.push(scope === "chat" ? `Set for this chat only: follow it until the user changes it. Leanfare's default stays ${levelText(j.default)}.` : scope === "app" ? `Kept for ${ctx.client} from now on, in every chat that sets none of its own.` : "Kept as the default for every app and new chat that sets none of its own.");
    else if (j.ask) lines.push("Ask the user which level they want for this chat (1 Off, 2 Light, 3 More, 4 Most, 5 All it can), then call level with set.");
    const p = j.plan;
    if (p?.at) lines.push(`The Claude plan, read ${agoText(Date.now() - p.at)}: ${[p.five !== null ? `the 5 hours ${p.five}% used` : "", p.week !== null ? `the week ${p.week}% used` : ""].filter(Boolean).join(", ") || "no window known"}.`);
    lines.push(`The levels: ${LEVELS.map((n) => `${n} ${LEVEL_NAME[n]}`).join(", ")}.`);
    return text(lines.join("\n"), { level: j.view.level, name: LEVEL_NAME[j.view.level as Level], from: set !== undefined ? scope : j.view.from, default: j.default, raised: j.view.raised, advice: lines[0], note: lines.slice(1).join(" ") });
  }
  if (name === "grade") {
    if (!["good", "partly", "wrong"].includes(args?.verdict)) return failure("grade needs a verdict: good, partly or wrong.");
    if (args.whole === true) { // the prompt's whole result: kept with this app's last hand off, so the report shows it on that prompt
      const { j } = await call("/api/grades/together", { method: "POST", json: { verdict: args.verdict, app: ctx.client } }, signal);
      return text(j.ok ? `Graded the whole result ${args.verdict}. The report shows it as the prompt's "together" grade.` : "No hand off from this app in the last 6 hours to keep that grade with.", j);
    }
    const fix = args.fix === "myself" || args.fix === "leanfare" ? args.fix : null;
    if (args.fix !== undefined && !fix) return failure('fix is "myself" (you fixed it yourself) or "leanfare" (Leanfare asks again one tier up).');
    if (fix && args.verdict === "good") return failure("fix goes with partly or wrong: a good answer needs no fix.");
    const handoff = Number.isInteger(args.handoff) ? { handoff: args.handoff } : {};
    const body = typeof args.id === "string" && Number.isInteger(args.part) ? { id: args.id, part: args.part, verdict: args.verdict }
      : typeof args.model === "string" && typeof args.kind === "string" ? { model: args.model, kind: args.kind, verdict: args.verdict, ...handoff }
      : Number.isInteger(args.handoff) ? { verdict: args.verdict, ...handoff } : null;
    if (!body) return failure("grade needs the hand off's number (from its receipt), or the plan's id and the part's number.");
    const wait = Number(process.env.LEANFARE_DELEGATE_WAIT) > 0 ? Number(process.env.LEANFARE_DELEGATE_WAIT) : 40;
    const { j } = await call("/api/grades", { method: "POST", json: { ...body, ...(fix ? { fix, wait } : {}), ...(fix === "leanfare" && typeof args.why === "string" ? { why: args.why } : {}) } }, signal);
    const graded = `Graded ${args.verdict}. ${j.text}`;
    const f = j.fix;
    if (!f) { const said = fix === "myself" ? `${graded} Kept as fixed by you before you answered.` : graded; return text(said, { ...j.standing, said }); }
    if (f.error) return text(`${graded}\n\n${f.error}`, { ...j.standing, said: graded, fix: { error: f.error } });
    if (f.running) { const next = `Call delegate with id "${f.id}" and nothing else to get the new answer.`; return text(`${graded}\n\nAsked again one tier up. Still working in Leanfare (${f.seconds} seconds so far): ${next[0].toLowerCase()}${next.slice(1)}`, { ...j.standing, said: graded, fix: { running: true, id: f.id, next } }); }
    return handOffReply(f, `${graded}\n\nAsked again one tier up: the new answer is hand off ${f.row ?? "?"}, a fix of ${f.fixOf}.\n\n`);
  }
  if (name === "local_model") {
    const action = args?.action ?? "suggest";
    if (action === "status") {
      const { j } = await call("/api/local/pull", {}, signal);
      const { j: t } = await call("/api/local/test", {}, signal);
      return text(`${testLine(t)}\n${pullLine(j.pull)}`, { pull: j.pull, test: t.current });
    }
    if (action === "test") {
      if (typeof args?.model !== "string" || !args.model.trim()) return failure("test needs model: a model on this computer, like qwen3:8b.");
      const { j: t } = await call("/api/local/test", { method: "POST", json: { model: args.model.trim() } }, signal);
      if (t.error) return failure(t.error);
      return text(`Testing ${t.current.label} on this computer: ${t.current.total} questions with known answers about made up files, free, a few minutes. Nothing leaves this computer. Follow it with local_model action status.`, { test: t.current });
    }
    if (action !== "suggest" && action !== "download") return failure("local_model takes action suggest, test, status or download.");
    const { j: o } = await call("/api/local", {}, signal);
    const { j: s } = await call("/api/local/suggest", {}, signal);
    if (action === "suggest") {
      const lines = [whereLine(o), ...(o.kinds ?? []).map(kindLine)];
      for (const f of o.found ?? []) lines.push(`Found ${f.models} Ollama model${f.models === 1 ? "" : "s"} (${gbText(f.size)}) in ${f.path}, on the drive ${f.drive}, that Ollama does not use: Settings, Local models, Use them.`);
      return text(lines.join("\n"), { where: o.where, kinds: o.kinds, found: o.found, suggestion: s.suggestion });
    }
    // download: a model named among the suggestions, or the best rated one.
    const named = typeof args?.model === "string" && args.model.trim() ? args.model.trim() : null;
    const pick = named ? (o.kinds ?? []).map((k: any) => k.pick).find((p: any) => p && !p.have && p.name === named) : null;
    if (named && !pick && s.suggestion?.name !== named) return failure(`${named} is not one of the models Leanfare suggests here. local_model with action suggest lists them.`);
    const sg = pick ? { name: pick.name, size: pick.size, license: "Apache 2.0" } : s.suggestion;
    if (!sg) return failure(s.why);
    // An app that can show Leanfare's question always gets it (a yes from the model is not the user's);
    // one that cannot says yes only once the user agreed in the chat.
    let yes = !ctx.canAsk && args?.yes === "yes";
    if (ctx.canAsk) {
      const a = await askUser({
        message: `Download ${sg.name} (${gbText(sg.size)}) with Ollama? It runs free, on this computer, and Leanfare's Auto and plans can then use it for reading and drafting. ${sg.license}: free to use for work.`,
        requestedSchema: { type: "object", properties: { download: { type: "boolean", title: `Download ${sg.name}`, description: `${gbText(sg.size)} of disk.`, default: false } }, required: ["download"] },
      });
      if (!(a?.action === "accept" && a.content?.download === true)) return text(`Nothing was downloaded: the user did not say yes to ${sg.name}.`, { downloading: false, suggestion: sg });
      yes = true;
    }
    if (!yes) return text(`Ask the user first: download ${sg.name} (${gbText(sg.size)}) with Ollama, to run free on this computer? If they agree, call local_model with action download and yes yes.`, { downloading: false, asks: true, suggestion: sg });
    const { j } = await call("/api/local/pull", { method: "POST", json: { name: sg.name, sizeBytes: sg.size } }, signal);
    return text(`Downloading ${sg.name} with Ollama (${gbText(sg.size)}). Follow it with local_model action status.`, { downloading: true, pull: j.pull, suggestion: sg });
  }
  if (name === "plan_run") {
    if (typeof args?.id !== "string" || !PLAN_ID.test(args.id)) return failure("plan_run needs the plan's id, from plan.");
    const yes = args.paid === "yes";
    let { j: v } = await call("/api/plan/run", { method: "POST", json: { id: args.id, paid: yes } }, signal);
    if (!yes) { v = await askPaid(ctx, args.id, v, signal); if (v.off) return text(OFF_TEXT, { off: true }); }
    return text(statusText(v, null), { id: v.id, running: v.running, parts: v.parts.map((r: any) => ({ n: r.n, status: r.status })), asks: v.asks });
  }
  if (name === "plan_stop") {
    if (typeof args?.id !== "string" || !PLAN_ID.test(args.id)) return failure("plan_stop needs the plan's id, from plan.");
    const { j: v } = await call("/api/plan/stop", { method: "POST", json: { id: args.id } }, signal);
    return text(statusText(v, null), { id: v.id, running: v.running, parts: v.parts.map((r: any) => ({ n: r.n, status: r.status })) });
  }
  if (name === "plan_status") {
    if (typeof args?.id !== "string" || !PLAN_ID.test(args.id)) return failure("plan_status needs the plan's id, from plan.");
    const wait = Number.isInteger(args.wait) ? Math.min(50, Math.max(0, args.wait)) : 0;
    const look = async (took = false) => (await call(`/api/plan/run?id=${encodeURIComponent(args.id)}${took ? "&took=1" : ""}`, {}, signal)).j;
    let v = await look();
    for (let t = 0; t < wait && !settled(v) && !signal.aborted; t++) { await Bun.sleep(1000); v = await look(); }
    if (args.peek !== true) v = await look(true); // the app has the answers now: the plan card says so
    const folder = sharedFolder(args.folder, ctx.cwd);
    const saved = folder ? writeShared(folder, args.id, sharedFiles(v)) : null;
    return text(statusText(v, saved), { id: v.id, running: v.running, cost_usd: v.cost, asks: v.asks, saved_in: saved, review: planReview(v) || null, parts: runParts(v) });
  }
  if (name === "plan") {
    if (typeof args?.task !== "string" || !args.task.trim()) return failure("plan needs a task.");
    const files = sizesForPlan(args.files, args.folder, ctx.cwd);
    if (typeof files === "string") return failure(files);
    const t0 = Date.now();
    const { j } = await call("/api/plan", { method: "POST", json: { task: args.task, files, manager: ctx.client, split: args.split === "rules" ? "rules" : "auto", ...(args.run !== false ? { run: true } : {}), ...(args.private === true ? { private: true } : {}), ...(isLevel(args.level) ? { level: args.level } : {}), ...(typeof args.your_model === "string" ? { your_model: args.your_model } : {}) } }, signal);
    const note = j.split?.note ? `\n\n(${j.split.note})` : j.split?.model ? `\n\n(Split by ${j.split.model.label}${typeof j.split.cost === "number" ? `, ${usd(j.split.cost)}` : ""}.)` : "";
    const folder = sharedFolder(args.folder, ctx.cwd);
    const saved = folder ? writeShared(folder, j.id, { "plan.md": `# Plan ${j.id}\n\n${args.task.trim()}\n\n${j.table}\n\n${j.next}\n` }) : null;
    const shape = {
      id: j.id, saved_in: saved,
      parts: j.parts.map((p: any) => ({ n: p.n, title: p.title, kind: p.kind, effort: p.effort, needs: p.needs, runs_on: p.where, risk: p.risk ?? null, model: p.model?.id ?? null, model_label: p.model?.label ?? null,
        your_model: p.use ?? null, // a part that stays with you: the model to pick for it in your app (alias: Claude Code's name for it)
        seconds: p.seconds, tokens: p.tokens, cost_usd: p.cost,
        files: p.files.slice(0, 50), more_files: Math.max(0, p.files.length - 50), task: p.task })),
      totals: j.totals, split: j.split, limits: j.limits, local: j.local ?? null, you: j.you ?? null,
    };
    if (!j.run) {
      const runNote = j.totals.out - (j.totals.later ?? 0) > 0 ? `\n\nOr call plan_run with id ${j.id} to run Leanfare's parts in the background, then plan_status for their answers.${saved ? ` The plan is saved in ${saved}/plan.md.` : ""}` : "";
      return text(`${j.table}\n\n${j.next}${runNote}${note}`, shape);
    }
    // Leanfare started its parts by itself (0.13): paid ones over the cap ask first, then the quick ones are waited for,
    // so most plans come back with their answers in this one call and nobody presses anything.
    let v = await askPaid(ctx, j.id, j.run, signal);
    if (v.off) return text(OFF_TEXT, { off: true });
    let next = j.next;
    if (v !== j.run) next = (await call(`/api/plan/next?id=${encodeURIComponent(j.id)}`, {}, signal)).j?.next ?? next; // the yes started the paid parts too
    const look = async (took = false) => (await call(`/api/plan/run?id=${encodeURIComponent(j.id)}${took ? "&took=1" : ""}`, {}, signal)).j;
    const wait = Math.max(0, Math.min(PLAN_WAIT, 40 - (Date.now() - t0) / 1000));
    for (let s = 0; s < wait && !settled(v) && !signal.aborted; s++) { await Bun.sleep(1000); v = await look(); }
    v = await look(true);
    const savedRun = folder ? writeShared(folder, j.id, sharedFiles(v)) : null;
    return text(`${j.table}\n\n${next}${note}\n\n${statusText(v, savedRun)}`, { ...shape, saved_in: savedRun ?? saved, review: planReview(v) || null, run: { running: v.running, cost_usd: v.cost, asks: v.asks, parts: runParts(v) } });
  }
  if (name === "ask") {
    if (typeof args?.prompt !== "string" || !args.prompt.trim()) return failure("ask needs a prompt.");
    const messages = [...(typeof args.system === "string" && args.system.trim() ? [{ role: "system", content: args.system }] : []), { role: "user", content: args.prompt }];
    const body: any = { model: typeof args.model === "string" && args.model ? args.model : "auto", messages };
    if (Number.isInteger(args.max_tokens) && args.max_tokens > 0) body.max_tokens = args.max_tokens;
    const { j, headers } = await call("/v1/chat/completions", { method: "POST", json: body }, signal);
    const answer = String(j?.choices?.[0]?.message?.content ?? "");
    const model = headers.get("x-leanfare-model") ?? "?";
    const costHeader = headers.get("x-leanfare-cost-usd");
    const cost = costHeader && costHeader !== "unknown" ? Number(costHeader) : null;
    const reason = decodeURIComponent(headers.get("x-leanfare-reason") ?? "");
    return text(`${answer}\n\n(Leanfare: ${model}, ${usd(cost)}. ${reason})`, { answer, model, cost_usd: cost, task: headers.get("x-leanfare-task"), reason });
  }
  if (name === "delegate") {
    // Under the minute an app waits for a tool (Cowork's link to the computer: 60 seconds); LEANFARE_DELEGATE_WAIT for tests.
    const wait = Number(process.env.LEANFARE_DELEGATE_WAIT) > 0 ? Number(process.env.LEANFARE_DELEGATE_WAIT) : 40;
    let j: any;
    if (typeof args?.id === "string" && args.id) {
      if (!PLAN_ID.test(args.id)) return failure("That is not the id of a hand off.");
      ({ j } = await call(`/api/delegate?id=${encodeURIComponent(args.id)}&wait=${wait}`, {}, signal));
    } else {
      if (typeof args?.task !== "string" || !args.task.trim()) return failure("delegate needs a task, or the id of one still working.");
      const files = readForDelegate(args.files, args.folder, ctx.cwd);
      if (typeof files === "string") return failure(files);
      const body = { task: args.task, files, kind: args.kind ?? null, effort: args.effort ?? "medium", check: args.check ?? "auto", wait, ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}), ...(args.speed !== undefined ? { speed: args.speed } : {}), ...(args.private === true ? { private: true } : {}),
        ...(ctx.client ? { app: ctx.client } : {}), ...(typeof args.your_model === "string" ? { your_model: args.your_model } : {}), ...(isLevel(args.level) ? { level: args.level } : {}) };
      ({ j } = await call("/api/delegate", { method: "POST", json: body }, signal));
    }
    if (j.running) { const next = `Call delegate again with id "${j.id}" and nothing else to get the answer.`; return text(`Still working in Leanfare (${j.seconds} seconds so far). ${next}`, { running: true, id: j.id, seconds: j.seconds, next }); }
    return handOffReply(j);
  }
  if (name === "trial") {
    const action = args?.action ?? "status";
    if (!["status", "start", "stop"].includes(action)) return failure("action must be status, start or stop.");
    let { j } = await call("/api/trial", {}, signal);
    if (action === "start" && !j.running) {
      if (!j.estimate?.models?.low) return failure(j.estimate?.error ?? "No model is ready yet. Open Leanfare, add a key and tick a model, then start the trial.");
      const e = j.estimate;
      ({ j } = await call("/api/trial/start", { method: "POST", json: {} }, signal));
      const cost = e.estimate === 0 ? "$0 on the models ticked now (free)" : e.estimate === null ? "an unknown cost" : `about ${usd(e.estimate)}`;
      return text(`The trial started: ${e.answers} answers, ${cost}${typeof e.seconds === "number" ? `, about ${Math.max(1, Math.round(e.seconds / 60))} min` : ""}. Ask for its status in a few minutes.`, { running: true, answers: e.answers, estimate_usd: e.estimate, seconds: e.seconds });
    }
    if (action === "stop" && j.running) ({ j } = await call("/api/trial/stop", { method: "POST", json: {} }, signal));
    const r = j.report;
    if (!r) return text("No trial has run yet. Call trial with action start to begin one.", { running: false, report: null });
    if (j.running) {
      const sofar = r.arms.filter((a: any) => a.asked).map((a: any) => `${a.effort}: ${a.right} of ${a.answered} right`).join(", ");
      return text(`The trial is running: ${r.done} of ${r.total} answers so far.${sofar ? ` ${sofar}.` : ""}`, { running: true, done: r.done, total: r.total });
    }
    return text(reportText(r, "mcp"), { running: false, status: r.status, lowest_passing: r.lowest, claude_line: r.claudeLine, arms: r.arms.map((a: any) => ({ effort: a.effort, right: a.right, answered: a.answered, verdict: a.verdict, cost_usd: a.cost })), share_url: r.share.url });
  }
  if (name === "report") {
    if (typeof args?.prompt === "string" && args.prompt.trim()) {
      const { j: r } = await call(`/api/report?prompt=${encodeURIComponent(args.prompt.trim().slice(0, 20))}`, {}, signal);
      return text(promptLines(r), compactReport(r, "prompt"));
    }
    const range = ["1h", "6h", "today", "7d", "30d", "year"].includes(args?.range) ? args.range : "7d";
    const app = typeof args?.app === "string" && args.app.trim() ? args.app.trim().slice(0, 60) : null;
    const { j: r } = await call(`/api/report?range=${range}${app ? `&app=${encodeURIComponent(app)}` : ""}`, {}, signal);
    return text(reportLines(r, range), compactReport(r, range, app));
  }
  if (name === "spend") {
    const { j: s } = await call("/api/summary", {}, signal);
    const { j: v } = await call("/api/savings", {}, signal);
    const { j: pv } = await call("/api/platforms", {}, signal);
    const lines = [
      `Today: ${usd(s.today)}. This month: ${usd(s.month)} over ${s.answers} answers.`,
      s.budget ? `Budget: ${usd(s.budget.amount)} a month, ${usd(s.budget.left)} left (${Math.floor(s.budget.pct ?? 0)}% used).` : "No monthly budget is set.",
      v.saved?.amount ? `Auto saved ${usd(v.saved.amount)} against the usual model this month${v.more?.ratio ? `: ${v.more.ratio.toFixed(1)} times as many answers for the money` : ""}.` : "Auto has not saved anything against the usual model yet this month.",
      v.byModel?.length ? `By model: ${v.byModel.slice(0, 5).map((r: any) => `${r.label} ${usd(r.cost)} (${r.answers})`).join(", ")}.` : "",
      workLines(v.work),
      pv.lines?.length ? `Where Leanfare may send work, and what is left before each one's nearest limit:\n${pv.lines.map((l: string) => `- ${l}`).join("\n")}` : "",
      pv.mode ? `Leanfare's mode for your Claude plan: ${pv.mode.mode} (${pv.mode.why}).${pv.mode.mode === "plenty" ? "" : " Hand off all reading, searching and drafting you will not change yourself."}` : "",
      s.paused ? "Leanfare is paused: new requests wait." : "",
    ].filter(Boolean);
    const w = v.work;
    return text(lines.join("\n"), { today_usd: s.today, month_usd: s.month, answers: s.answers, budget: s.budget, saved_usd: v.saved?.amount ?? 0, top: s.top,
      platforms: (pv.rows ?? []).map((r: any) => ({ id: r.id, label: r.label, on: r.on, ready: r.ready, windows: r.windows, limit: r.limit })), plan_mode: pv.mode ? { mode: pv.mode.mode, why: pv.mode.why } : null,
      work: w ? { tasks: w.tasks, kept_share: w.keptPct, tokens_kept_out: w.kept, tokens_came_back: w.back, cost_usd: w.cost, grades: w.grades, checks: { passed: w.checks.passed, failed: w.checks.failed } } : null });
  }
  if (name === "models") {
    const { j: st } = await call("/api/state", {}, signal);
    const ticked = new Set<string>(st.settings.ticked);
    const ready = new Set<string>(st.providers.filter((p: any) => p.ready).map((p: any) => p.id));
    const want = typeof args?.provider === "string" ? args.provider.toLowerCase() : null;
    const rows = (Object.values(st.models).flat() as any[]).filter((m) => ticked.has(m.id) && ready.has(m.provider) && !m.retired && (!want || m.provider === want));
    if (!rows.length) return text(want ? `No ticked, ready models from ${want}.` : "No models are ready. Add a key in Leanfare's Settings and tick some models.", { models: [] });
    const per = (v: number | null) => (v === null ? "?" : `$${v}`);
    return text(rows.map((m) => `${m.id}: ${m.label}, ${m.local || m.free ? "free" : `${per(m.input)} in / ${per(m.output)} out per 1M tokens`}${m.rating ? `, rated ${Math.round(m.rating)}` : ""}`).join("\n"),
      { models: rows.map((m) => ({ id: m.id, label: m.label, provider: m.provider, input_per_m: m.input, output_per_m: m.output, rating: m.rating })) });
  }
  if (name === "estimate") {
    if (typeof args?.prompt !== "string" || !args.prompt.trim()) return failure("estimate needs a prompt.");
    const { j } = await call("/api/estimate", { method: "POST", json: { messages: [{ role: "user", content: args.prompt }], model: typeof args.model === "string" && args.model ? args.model : "auto", ...(args.speed !== undefined ? { speed: args.speed } : {}) } }, signal);
    if (!j.plan) return failure(j.error ?? "Leanfare could not estimate this.");
    const p = j.plan;
    const alts = (p.alternatives ?? []).map((a: any) => `${a.label} about ${usd(a.estimate)}`).join(", ");
    const secs = typeof p.seconds === "number" ? `, ${secondsText(p.seconds)}` : "";
    const est = typeof p.seconds === "number" && !p.secondsMeasured ? "an estimate; the time is a rough guess" : "an estimate";
    // At the same quality: the cheapest and the fastest, when either is not the pick.
    const c = p.choices;
    const one = (x: any) => `${x.label} (about ${usd(x.estimate)}${typeof x.seconds === "number" ? `, ${secondsText(x.seconds)}` : ""})`;
    const same = c && (c.cheapest.id !== p.model.id || (c.fastest && c.fastest.id !== p.model.id))
      ? `\nAt the same quality: the cheapest is ${one(c.cheapest)}${c.fastest ? `, the fastest is ${one(c.fastest)}` : ""}.` : "";
    return text(`About ${usd(j.estimate)} on ${p.model.label}${secs} (${est}). ${p.reason}${same}${alts ? `\nOther choices: ${alts}.` : ""}`,
      { estimate_usd: j.estimate, seconds: p.seconds ?? null, model: p.model.id, task: p.task, reason: p.reason, speed: p.speed ?? null, choices: c ?? null, alternatives: p.alternatives });
  }
  return null;
}

// ---- JSON-RPC over stdio ----------------------------------------------------------------

type Id = string | number;
const out = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + "\n"); };
const reply = (id: Id, result: unknown): void => out({ jsonrpc: "2.0", id, result });
const error = (id: Id | null, code: number, message: string, data?: unknown): void => out({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const inflight = new Map<Id, AbortController>();

export async function handleMessage(msg: any, send = { reply, error }): Promise<void> {
  // An answer to a question Leanfare asked the client (elicitation/create), on time or late (see
  // askUser); one Leanfare no longer waits for is dropped. An answer is never answered.
  if (msg && msg.jsonrpc === "2.0" && msg.method === undefined && msg.id !== undefined && ("result" in msg || "error" in msg)) {
    const done = asked.get(msg.id);
    if (done) { asked.delete(msg.id); done(msg); }
    return;
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && msg.id !== undefined && msg.id !== null) send.error(msg.id, -32600, "Not a JSON-RPC 2.0 request.");
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) { // a notification: never answered
    if (method === "notifications/cancelled") inflight.get(params?.requestId)?.abort();
    return;
  }
  const meta = params?._meta ?? {};
  const version = meta["io.modelcontextprotocol/protocolVersion"];
  const modern = typeof version === "string";
  if (modern) {
    if (!MODERN.includes(version)) return send.error(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested: version });
    if (!meta["io.modelcontextprotocol/clientCapabilities"] || typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object") return send.error(id, -32602, "Every request needs io.modelcontextprotocol/clientCapabilities in its _meta.");
  }
  const done = (result: any) => send.reply(id, modern ? { resultType: "complete", ...result, _meta: META } : result);

  if (modern && meta["io.modelcontextprotocol/clientInfo"]) setClient(meta["io.modelcontextprotocol/clientInfo"]?.name);
  if (modern) canAsk = !!meta["io.modelcontextprotocol/clientCapabilities"]?.elicitation;
  if (method === "initialize") {
    setClient(params?.clientInfo?.name);
    canAsk = !!params?.capabilities?.elicitation;
    const asked = params?.protocolVersion;
    return send.reply(id, { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS });
  }
  if (method === "server/discover") return send.reply(id, { resultType: "complete", supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: { listChanged: true }, resources: {} }, _meta: META, instructions: INSTRUCTIONS });
  // The plan's page (an MCP App): listed and read like any resource.
  if (method === "resources/list") return done({ resources: [
    { uri: PLAN_APP_URI, name: "Leanfare plan", title: "Leanfare plan", description: "The plan as a table that follows each part as it runs, for apps that show MCP Apps.", mimeType: APP_MIME },
    { uri: REPORT_APP_URI, name: "Leanfare report", title: "Leanfare report", description: "The report as a card with spans to pick, for apps that show MCP Apps.", mimeType: APP_MIME },
    { uri: LIVE_APP_URI, name: "Leanfare live", title: "Leanfare live", description: "Live tokens as a card that keeps moving, for apps that show MCP Apps.", mimeType: APP_MIME },
  ] });
  if (method === "resources/read" && (await appNewer(false))) {
    const { j } = await call("/api/mcp/resource", { method: "POST", json: { uri: params?.uri } });
    if (!j?.contents) return send.error(id, -32002, `Leanfare has no resource ${String(params?.uri)}.`);
    return done({ contents: j.contents });
  }
  if (method === "resources/read") {
    const page = params?.uri === PLAN_APP_URI ? PLAN_APP_HTML : params?.uri === REPORT_APP_URI ? REPORT_APP_HTML : params?.uri === LIVE_APP_URI ? LIVE_APP_HTML : null;
    if (!page) return send.error(id, -32002, `Leanfare has no resource ${String(params?.uri)}.`);
    return done({ contents: [{ uri: params.uri, mimeType: APP_MIME, text: page, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] });
  }
  if (method === "ping") return done({});
  if (method === "tools/list") {
    if (await appNewer(false)) { const { j } = await call("/api/mcp/tools"); if (Array.isArray(j?.tools)) return done({ tools: j.tools }); }
    return done({ tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const ac = new AbortController();
    inflight.set(id, ac);
    const later = await appNewer(true);
    if (!later && !TOOLS.some((t) => t.name === name)) { inflight.delete(id); return send.error(id, -32602, `Leanfare has no tool named ${String(name)}.`); }
    try {
      // A door older than the app: the app runs the call with its newer code, for this app and this folder. It cannot
      // ask this app's person a question (elicitation): a tool that would asks in its answer instead.
      const result = later ? await forward(name, params?.arguments ?? {}, ac.signal, later) : await runTool(name, params?.arguments ?? {}, ac.signal);
      if (!ac.signal.aborted) done(result);
    } catch (e: any) {
      if (!ac.signal.aborted) done(failure(String(e?.message ?? e)));
    } finally { inflight.delete(id); }
    return;
  }
  return send.error(id, -32601, `Leanfare's MCP door has no method ${method}.`);
}

// The app's side of a door older than it (server.ts /api/mcp/resource): the page for an MCP App's resource.
export function resourceContents(uri: unknown): any[] | null {
  const page = uri === PLAN_APP_URI ? PLAN_APP_HTML : uri === REPORT_APP_URI ? REPORT_APP_HTML : uri === LIVE_APP_URI ? LIVE_APP_HTML : null;
  return page ? [{ uri, mimeType: APP_MIME, text: page, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] : null;
}

async function forward(name: string, args: unknown, signal: AbortSignal, version: string): Promise<any> {
  const { j } = await call("/api/mcp/call", { method: "POST", json: { name, arguments: args, client, folder: process.cwd() } }, signal);
  if (!told) {
    told = true;
    out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); // apps that follow it ask for the new tools
    const note = `(Leanfare was updated to ${version} while ${client ?? "this app"} kept its ${DOOR.version} door running: this call went through the updated app. Quit and reopen ${client ?? "the app"} to see the new tools.)`;
    return { ...j, content: [...(Array.isArray(j?.content) ? j.content : []), { type: "text", text: note }] };
  }
  return j;
}

export async function runMcp() {
  process.stderr.write(`Leanfare ${VERSION} MCP door: waiting on stdin.\n`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { error(null, -32700, "Not JSON."); continue; }
      const job = handleMessage(msg).catch((e) => process.stderr.write(`leanfare mcp: ${String(e?.message ?? e)}\n`));
      pending.add(job);
      job.finally(() => pending.delete(job));
    }
  }
  // A last message with no newline after it still counts.
  const rest = buf.trim();
  if (rest) {
    let msg: any = null;
    try { msg = JSON.parse(rest); } catch { error(null, -32700, "Not JSON."); }
    if (msg) { const job = handleMessage(msg).catch(() => {}); pending.add(job); }
  }
  // stdin closed: the client is done sending. Answer what is still running (at most 60 s), then exit.
  await Promise.race([Promise.all([...pending]), Bun.sleep(60_000)]);
  for (const ac of inflight.values()) ac.abort();
  process.exit(0);
}
const pending = new Set<Promise<unknown>>();
