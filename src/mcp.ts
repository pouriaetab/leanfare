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
import { VERSION } from "./config";
import { call } from "./client";
import { secondsText } from "./util";
import { reportText } from "./trialtext";
import { APP_MIME, PLAN_APP_HTML, PLAN_APP_URI } from "./planapp";
import { readForDelegate, resolvePath, sizesForPlan } from "./readfiles";
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "leanfare", title: "Leanfare", version: VERSION };
const META = { "io.modelcontextprotocol/serverInfo": SERVER };
const INSTRUCTIONS = "Leanfare runs every top AI model on this computer with the user's own keys, shows what each answer costs, and keeps a monthly budget. At the start of a task with several parts, call plan: it splits the task and says, in a short table, which parts to hand to Leanfare and on which model, and which to do yourself. Use delegate to hand work that reads a lot (big files, logs, many documents) to a cheaper model: Leanfare reads the files itself, so their text stays out of your context, and returns a short answer with a receipt. Use ask to hand a question to another model (Auto picks the cheapest one that rates well for the task); spend to see what was spent and saved; models to see which models and prices are available; estimate to price a prompt before sending it; trial to measure how well delegate answers on the user's models before relying on it.";

const TOOLS = [
  {
    name: "plan",
    title: "Split a task across models",
    description: "Before a task with several parts (a feature, a fix across files, a refactor, research across many files, reverse engineering a project), ask Leanfare how to split it. It answers with a short table: each part, its kind, where it runs (you, or Leanfare on a local, free or pay per use model), the model, about how long, the tokens it keeps out of the user's plan, and the cost; then what to do next. Run the parts it gives to Leanfare with delegate, several in the same turn when they do not wait for each other, and do the parts it leaves to you yourself. Name the files or folders the task is about in files: here Leanfare only measures them, it reads them when delegate runs a part. A model the user ticked does the split (a few cents or less, $0 on free models); split rules makes it by rules, with no model.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The whole task, as the user gave it, with what you already know about it." },
        files: { type: "array", items: { type: "string" }, maxItems: 200, description: "The files or folders the task is about: full paths, ~/ paths, or paths relative to folder. Only their names and sizes are used here." },
        folder: { type: "string", description: "The folder relative paths start from. By default, the folder the MCP client started Leanfare in (in Claude Code, the project)." },
        split: { type: "string", enum: ["auto", "rules"], description: "auto (the default): a model the user ticked splits it. rules: Leanfare splits it by rules, with no model call." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    annotations: { title: "Split a task across models", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // Apps that show MCP Apps (Claude Desktop, Cowork) draw the plan as a table with a Run button (planapp.ts).
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
    description: "Where each part of a plan stands (waiting, running, done, failed, yours, after yours, waiting for a yes) and the answers of the parts Leanfare finished. Each answer is also saved in the project, in .leanfare/plans/<id>/ (a folder git ignores), where you and the user can read it. wait: up to that many seconds for something to change before answering (default 0, at most 50).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The plan's id, from plan." },
        wait: { type: "integer", minimum: 0, maximum: 50, description: "Seconds to wait for a part to change before answering." },
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
    description: "After you used the answer of a part Leanfare ran (plan_status) or of delegate, say how good it was: good, partly or wrong. Leanfare keeps only the grade, with the model that answered and the kind of part, never the words. A model graded below good too often for a kind is moved down, so plans and delegate stop picking it for that kind. Grade a plan's part with id and part; a delegate answer with model (from its receipt) and kind.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["good", "partly", "wrong"], description: "good: you used it as it was. partly: you had to fix or redo some of it. wrong: you could not use it." },
        id: { type: "string", description: "The plan's id, from plan." },
        part: { type: "integer", minimum: 1, description: "The part's number in the plan." },
        model: { type: "string", description: "For a delegate answer: the model id its receipt named, such as deepseek/deepseek-v4-flash." },
        kind: { type: "string", enum: ["read", "write", "reason", "search"], description: "For a delegate answer: the kind you gave it." },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
    annotations: { title: "Grade an answer", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    description: "Hand a piece of work to a cheaper model through Leanfare, to save your own context and usage. Best for work that reads a lot and answers briefly: search or summarize big files, logs or many documents, review a file, draft a section. Name the files in files: Leanfare reads them itself, so their text never enters your context. Leanfare picks the cheapest model the user ticked that rates well enough for the kind and effort, and returns a short answer with a receipt (the model, the cost, the tokens kept out of your context). Every high effort answer, and a sample of the others, is checked by a stronger model; a failed check is asked again one tier up. Costs count toward the user's Leanfare budget.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to do, written for a model that has not seen this conversation: the goal, what to look for, and the form of answer you want (for example: a list of file:line, one line each)." },
        files: { type: "array", items: { type: "string" }, maxItems: 50, description: "Text files for Leanfare to read and hand over with the task: full paths, ~/ paths, or paths relative to folder. At most 50 files, 2 MB each, 4 MB in all. Files that hold secrets (.env files, private keys, credentials) are refused." },
        folder: { type: "string", description: "The folder relative paths start from. By default, the folder the MCP client started Leanfare in (in Claude Code, the project)." },
        kind: { type: "string", enum: ["read", "write", "reason"], description: "read: find, pull out or summarize from the files. write: draft text or code. reason: work something out (a bug's cause, a plan, a proof). Leave it out to let Leanfare guess." },
        effort: { type: "string", enum: ["low", "medium", "high"], description: "How good the model must be: low takes the cheapest rated within 80 points of the best model the user ticked, medium within 40, high within 15. Also the thinking effort for models that think. Default medium." },
        check: { type: "string", enum: ["auto", "always", "never"], description: "auto (the default) has a stronger model check every high effort answer, 1 in 4 medium ones and 1 in 10 low ones." },
        speed: { type: "string", description: "At the same quality: \"cheapest\" (however long it takes), \"fastest\" (whatever it costs), or a number of seconds to answer within, like \"30\". Default: the user's choice in Leanfare." },
        max_tokens: { type: "integer", minimum: 1, maximum: 64000, description: "The longest answer to allow, in tokens (default 8,192)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    annotations: { title: "Hand a task to a cheaper model", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "spend",
    title: "What was spent",
    description: "What the user spent on AI through Leanfare today and this month, the budget left, what Auto saved against their usual model, and the top models.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "What was spent", readOnlyHint: true, openWorldHint: false },
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
    title: "A local model for this computer",
    description: "The open model Leanfare suggests for this computer: the best rated one that runs comfortably in its memory, fits on its disk and beats what is installed (free to run, and Leanfare's Auto and plans then use it for reading and drafting). suggest (the default) says which and why; download asks the user, then has Ollama download it; status says how the download goes. Nothing is downloaded without the user's yes.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["suggest", "download", "status"], description: "suggest (the default), download or status." },
        yes: { type: "string", enum: ["yes", "no"], description: "For download, only where your app cannot show Leanfare's question: yes once the user agreed to the download in the chat. An app that can show it gets the question from Leanfare itself." },
      },
      additionalProperties: false,
    },
    annotations: { title: "A local model for this computer", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

// ---- the tools -------------------------------------------------------------------------

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const text = (t: string, structured?: unknown) => ({ content: [{ type: "text", text: t }], ...(structured !== undefined ? { structuredContent: structured } : {}) });
const failure = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

// The app on the other side, by the name it gives (initialize's clientInfo), for the plan's table.
let client: string | null = null;
const CLIENTS: [RegExp, string][] = [[/claude[- _]?code/i, "Claude Code"], [/^claude/i, "Claude"], [/codex/i, "Codex"], [/cursor/i, "Cursor"], [/gemini/i, "Gemini CLI"],
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
export function sharedFolder(given?: unknown): string | null {
  let dir = process.cwd();
  if (typeof given === "string" && given.trim()) { try { dir = resolvePath(given, process.cwd()); } catch { return null; } }
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
const STATUS: Record<string, string> = { waiting: "waiting", running: "running", done: "done", failed: "failed", stopped: "stopped", yours: "yours to do", after_yours: "after yours: hand it to delegate once yours is done", blocked: "waits for a part that is not done", asks: "paid: waits for a yes" };
const SHOWN = 3000; // characters of an answer in the tool's result (the whole answer is in its file)
export function statusText(v: any, saved: string | null): string {
  const rows = v.parts.map((r: any) => `| ${r.n} | ${String(r.title).replace(/\|/g, "/")} | ${STATUS[r.status] ?? r.status} | ${r.model ?? ""} | ${r.cost === null || r.cost === undefined ? "" : usd(r.cost)} |`);
  const done = v.parts.filter((r: any) => r.answer);
  const lines = ["| # | Part | Now | Model | Cost |", "|---|---|---|---|---|", ...rows, ""];
  lines.push(v.running ? "Still running: ask plan_status again (wait up to 50 seconds)." : "Leanfare's parts have ended.");
  if (v.asks) lines.push(`Parts ${v.asks.parts.join(", ")} are paid (about ${usd(v.asks.estimate)}, over the cap of ${usd(v.asks.cap)} set in Leanfare) and wait for the user's yes: ask them, then call plan_run with paid yes.`);
  for (const r of done) lines.push("", `## Part ${r.n}: ${r.title}`, "", r.answer.length > SHOWN ? `${r.answer.slice(0, SHOWN)}\n\n(cut here: the whole answer is in ${saved ?? "Leanfare"}${saved ? `/part-${r.n}.md` : ""})` : r.answer, "", `(${r.receipt})`);
  for (const r of v.parts.filter((x: any) => x.error)) lines.push("", `Part ${r.n} failed: ${r.error}`);
  if (done.length) lines.push("", `Once you have used ${done.length === 1 ? "this answer" : "these answers"}, grade ${done.length === 1 ? "it" : "each"} with grade (good, partly or wrong, with the plan's id and the part): models graded below good too often are moved down.`);
  if (saved) lines.push("", `Saved in ${saved}/ in the project.`);
  return lines.join("\n");
}
function sharedFiles(v: any): Record<string, string> {
  const files: Record<string, string> = { "status.md": statusText(v, null) + "\n" };
  for (const r of v.parts.filter((x: any) => x.answer)) files[`part-${r.n}.md`] = `# Part ${r.n}: ${r.title}\n\n${r.answer}\n\n---\n${r.receipt}\n`;
  return files;
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
function pullLine(p: any): string {
  if (!p) return "No download is running.";
  const at = p.percent !== null && p.percent !== undefined ? `, ${p.percent}%` : "";
  return p.active ? `${p.name}: ${String(p.step).toLowerCase()}${at}.` : p.message ?? `${p.name}: ${p.status}.`;
}

async function runTool(name: string, args: any, signal: AbortSignal): Promise<any> {
  if (name === "grade") {
    if (!["good", "partly", "wrong"].includes(args?.verdict)) return failure("grade needs a verdict: good, partly or wrong.");
    const body = typeof args.id === "string" && Number.isInteger(args.part) ? { id: args.id, part: args.part, verdict: args.verdict }
      : typeof args.model === "string" && typeof args.kind === "string" ? { model: args.model, kind: args.kind, verdict: args.verdict } : null;
    if (!body) return failure("grade needs the plan's id and the part's number, or, for a delegate answer, the model and the kind.");
    const { j } = await call("/api/grades", { method: "POST", json: body }, signal);
    return text(`Graded ${args.verdict}. ${j.text}`, j.standing);
  }
  if (name === "local_model") {
    const action = args?.action ?? "suggest";
    if (action === "status") { const { j } = await call("/api/local/pull", {}, signal); return text(pullLine(j.pull), { pull: j.pull }); }
    if (action !== "suggest" && action !== "download") return failure("local_model takes action suggest, download or status.");
    const { j: s } = await call("/api/local/suggest", {}, signal);
    if (action === "suggest") return text(s.suggestion ? `${s.why}\n\nTo download it: local_model with action download (the user is asked first).` : s.why, s);
    if (!s.suggestion) return failure(s.why);
    const sg = s.suggestion;
    // An app that can show Leanfare's question always gets it (a yes from the model is not the user's);
    // one that cannot says yes only once the user agreed in the chat.
    let yes = !canAsk && args?.yes === "yes";
    if (canAsk) {
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
    if (v.asks && !yes && canAsk) {
      const yesTo = (a: any) => a?.action === "accept" && a.content?.run === true;
      const a = await askUser({
        message: `Leanfare's plan has paid parts (${v.asks.parts.map((n: number) => `part ${n}`).join(", ")}), about ${usd(v.asks.estimate)} on pay per use, over your cap of ${usd(v.asks.cap)}. The free and local parts are running. Run the paid ones too?`,
        requestedSchema: { type: "object", properties: { run: { type: "boolean", title: "Run the paid parts", description: `About ${usd(v.asks.estimate)}, within your monthly budget in Leanfare.`, default: false } }, required: ["run"] },
      }, {
        // A yes after the tool stopped waiting: the person said yes to these parts, so they run (once: a run that has them going is left as it is).
        late: (r) => { if (yesTo(r)) call("/api/plan/run", { method: "POST", json: { id: args.id, paid: true } }, new AbortController().signal).catch(() => {}); },
      });
      if (yesTo(a)) ({ j: v } = await call("/api/plan/run", { method: "POST", json: { id: args.id, paid: true } }, signal));
    }
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
    const look = async () => (await call(`/api/plan/run?id=${encodeURIComponent(args.id)}`, {}, signal)).j;
    let v = await look();
    const key = (x: any) => x.parts.map((r: any) => r.status).join(",");
    const first = key(v);
    for (let t = 0; t < wait && v.running && key(v) === first && !signal.aborted; t++) { await Bun.sleep(1000); v = await look(); }
    const folder = sharedFolder(args.folder);
    const saved = folder ? writeShared(folder, args.id, sharedFiles(v)) : null;
    return text(statusText(v, saved), { id: v.id, running: v.running, cost_usd: v.cost, asks: v.asks, saved_in: saved, parts: v.parts.map((r: any) => ({ n: r.n, title: r.title, status: r.status, model: r.model, cost_usd: r.cost, seconds: r.seconds, answer: r.answer, error: r.error })) });
  }
  if (name === "plan") {
    if (typeof args?.task !== "string" || !args.task.trim()) return failure("plan needs a task.");
    const files = sizesForPlan(args.files, args.folder);
    if (typeof files === "string") return failure(files);
    const { j } = await call("/api/plan", { method: "POST", json: { task: args.task, files, manager: client, split: args.split === "rules" ? "rules" : "auto" } }, signal);
    const note = j.split?.note ? `\n\n(${j.split.note})` : j.split?.model ? `\n\n(Split by ${j.split.model.label}${typeof j.split.cost === "number" ? `, ${usd(j.split.cost)}` : ""}.)` : "";
    const folder = sharedFolder(args.folder);
    const saved = folder ? writeShared(folder, j.id, { "plan.md": `# Plan ${j.id}\n\n${args.task.trim()}\n\n${j.table}\n\n${j.next}\n` }) : null;
    const runNote = j.totals.out - (j.totals.later ?? 0) > 0 ? `\n\nOr call plan_run with id ${j.id} to run Leanfare's parts in the background, then plan_status for their answers.${saved ? ` The plan is saved in ${saved}/plan.md.` : ""}` : "";
    return text(`${j.table}\n\n${j.next}${runNote}${note}`, {
      id: j.id, saved_in: saved,
      parts: j.parts.map((p: any) => ({ n: p.n, title: p.title, kind: p.kind, effort: p.effort, needs: p.needs, runs_on: p.where, model: p.model?.id ?? null, model_label: p.model?.label ?? null,
        your_model: p.use ?? null, // a part that stays with you: the model to pick for it in your app (alias: Claude Code's name for it)
        seconds: p.seconds, tokens: p.tokens, cost_usd: p.cost,
        files: p.files.slice(0, 50), more_files: Math.max(0, p.files.length - 50), task: p.task })),
      totals: j.totals, split: j.split, limits: j.limits, local: j.local ?? null,
    });
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
    if (typeof args?.task !== "string" || !args.task.trim()) return failure("delegate needs a task.");
    const files = readForDelegate(args.files, args.folder);
    if (typeof files === "string") return failure(files);
    const body = { task: args.task, files, kind: args.kind ?? null, effort: args.effort ?? "medium", check: args.check ?? "auto", ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}), ...(args.speed !== undefined ? { speed: args.speed } : {}) };
    const { j } = await call("/api/delegate", { method: "POST", json: body }, signal);
    const gradeIt = ["read", "write", "reason"].includes(args.kind) ? `\n\n(Once you have used it: grade, with model ${j.model.id} and kind ${args.kind}.)` : "";
    return text(`${j.answer}\n\n(${j.receipt})${gradeIt}`, {
      answer: j.answer, model: j.model.id, cost_usd: j.cost, total_usd: j.total, task: j.task, effort: j.effort,
      check: j.check.picked ? { verdict: j.check.verdict, by: j.check.checker?.id ?? null, why: j.check.why || null, cost_usd: j.check.cost } : null,
      first: j.first ? { model: j.first.model.id, cost_usd: j.first.cost } : null,
      tokens: j.tokens, cut: j.cut, seconds: j.seconds,
    });
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
  if (name === "spend") {
    const { j: s } = await call("/api/summary", {}, signal);
    const { j: v } = await call("/api/savings", {}, signal);
    const lines = [
      `Today: ${usd(s.today)}. This month: ${usd(s.month)} over ${s.answers} answers.`,
      s.budget ? `Budget: ${usd(s.budget.amount)} a month, ${usd(s.budget.left)} left (${Math.floor(s.budget.pct ?? 0)}% used).` : "No monthly budget is set.",
      v.saved?.amount ? `Auto saved ${usd(v.saved.amount)} against the usual model this month${v.more?.ratio ? `: ${v.more.ratio.toFixed(1)} times as many answers for the money` : ""}.` : "Auto has not saved anything against the usual model yet this month.",
      v.byModel?.length ? `By model: ${v.byModel.slice(0, 5).map((r: any) => `${r.label} ${usd(r.cost)} (${r.answers})`).join(", ")}.` : "",
      s.paused ? "Leanfare is paused: new requests wait." : "",
    ].filter(Boolean);
    return text(lines.join("\n"), { today_usd: s.today, month_usd: s.month, answers: s.answers, budget: s.budget, saved_usd: v.saved?.amount ?? 0, top: s.top });
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
    return send.reply(id, { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: { listChanged: false }, resources: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS });
  }
  if (method === "server/discover") return send.reply(id, { resultType: "complete", supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: {}, resources: {} }, _meta: META, instructions: INSTRUCTIONS });
  // The plan's page (an MCP App): listed and read like any resource.
  if (method === "resources/list") return done({ resources: [{ uri: PLAN_APP_URI, name: "Leanfare plan", title: "Leanfare plan", description: "The plan as a table with a Run button, for apps that show MCP Apps.", mimeType: APP_MIME }] });
  if (method === "resources/read") {
    if (params?.uri !== PLAN_APP_URI) return send.error(id, -32002, `Leanfare has no resource ${String(params?.uri)}.`);
    return done({ contents: [{ uri: PLAN_APP_URI, mimeType: APP_MIME, text: PLAN_APP_HTML, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] });
  }
  if (method === "ping") return done({});
  if (method === "tools/list") return done({ tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return send.error(id, -32602, `Leanfare has no tool named ${String(name)}.`);
    const ac = new AbortController();
    inflight.set(id, ac);
    try {
      const result = await runTool(name, params?.arguments ?? {}, ac.signal);
      if (!ac.signal.aborted) done(result);
    } catch (e: any) {
      if (!ac.signal.aborted) done(failure(String(e?.message ?? e)));
    } finally { inflight.delete(id); }
    return;
  }
  return send.error(id, -32601, `Leanfare's MCP door has no method ${method}.`);
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
