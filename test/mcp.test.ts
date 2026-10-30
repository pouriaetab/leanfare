// leanfare mcp, the real command over stdio, against the test server: both eras
// of the protocol, and every tool.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";
import { db } from "../src/db";
import { forgetSpeeds } from "../src/speed";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const waiting = new Map<number | string, (m: any) => void>();
let nextId = 1;
// Questions the door asks this client (elicitation/create): answered by the test that expects one.
let onRequest: ((msg: any) => void) | null = null;

beforeAll(async () => {
  url = (await boot()).url;
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" },
  });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffer += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        const msg = JSON.parse(line);
        if (msg.method) { onRequest?.(msg); continue; }
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  })();
});
afterAll(() => { try { child?.kill(); } catch {} });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const write = (msg: unknown) => { (child!.stdin as any).write(JSON.stringify(msg) + "\n"); (child!.stdin as any).flush?.(); };
function rpc(method: string, params?: unknown, id: number | string = nextId++): Promise<any> {
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`no answer to ${method}`)); } }, 8000);
  });
}
const modern = (extra: Record<string, unknown> = {}) => ({ ...extra, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } } });

describe("the protocol", () => {
  test("an older client opens with initialize and gets the version it asked for", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } });
    expect(r.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "leanfare" }, capabilities: { tools: { listChanged: false } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" }); // never answered
    const unknown = await rpc("initialize", { protocolVersion: "2019-01-01", capabilities: {} });
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
    const list = await rpc("tools/list", {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["plan", "plan_run", "plan_stop", "plan_status", "grade", "ask", "delegate", "spend", "report", "models", "estimate", "trial", "local_model"]);
    expect(list.result.resultType).toBeUndefined();
  });

  test("a 2026 client: server/discover, and every result says it is complete", async () => {
    const d = await rpc("server/discover", modern());
    expect(d.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"], capabilities: { tools: {} } });
    expect(d.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("leanfare");
    const list = await rpc("tools/list", modern());
    expect(list.result.resultType).toBe("complete");
    expect(list.result.tools).toHaveLength(13);
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
  });

  test("an unknown version, a missing capability field and an unknown method are errors with their codes", async () => {
    const v = await rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01", "io.modelcontextprotocol/clientCapabilities": {} } });
    expect(v.error).toMatchObject({ code: -32022, data: { requested: "2030-01-01" } });
    expect(v.error.data.supported).toContain("2026-07-28");
    const c = await rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    expect(c.error.code).toBe(-32602);
    const m = await rpc("prompts/list", {}); // Leanfare has tools and one page, no prompts
    expect(m.error.code).toBe(-32601);
    const t = await rpc("tools/call", { name: "nope", arguments: {} });
    expect(t.error.code).toBe(-32602);
  });
});

describe("the plan's page (an MCP App)", () => {
  test("the plan tool names its page, and the page is a resource of the MCP App kind", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
    expect(init.result.capabilities.resources).toEqual({});
    const tools = (await rpc("tools/list", {})).result.tools;
    expect(tools.find((t: any) => t.name === "plan")._meta).toEqual({ ui: { resourceUri: "ui://leanfare/plan" }, "ui/resourceUri": "ui://leanfare/plan" });
    const list = await rpc("resources/list", {});
    expect(list.result.resources).toEqual([expect.objectContaining({ uri: "ui://leanfare/plan", mimeType: "text/html;profile=mcp-app" }), expect.objectContaining({ uri: "ui://leanfare/report", mimeType: "text/html;profile=mcp-app" })]);
    expect(tools.find((t: any) => t.name === "report")._meta).toEqual({ ui: { resourceUri: "ui://leanfare/report" }, "ui/resourceUri": "ui://leanfare/report" });
    const read = await rpc("resources/read", { uri: "ui://leanfare/plan" });
    const c = read.result.contents[0];
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toContain("ui/initialize");
    expect(c._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] }); // it reaches nothing outside
    const none = await rpc("resources/read", { uri: "ui://leanfare/other" });
    expect(none.error.message).toContain("no resource");
  });
});

describe("the tools", () => {
  test("plan: a table of the parts, the app's own name in it, and the files only measured", async () => {
    await keys("openai", "google", "deepseek");
    // Its real path: on macOS the temp folder is a link (/var/folders is /private/var/folders), and the plan names files by their real paths.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plan-project-")));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "src", "router.ts"), "x".repeat(40_000));
    writeFileSync(join(dir, "src", "logo.png"), "png");
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-should-never-be-read");
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "y".repeat(90_000));
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } });
    const r = await rpc("tools/call", { name: "plan", arguments: { task: "Reverse engineer the router in this project and build a smaller one", files: [dir], split: "rules" } });
    expect(r.result.isError).toBeUndefined();
    const t = r.result.content[0].text;
    expect(t).toContain("| # | Part | Kind | Runs on | Model | Time | Tokens | Cost | When |");
    expect(t).toContain("you (Claude Code)");
    expect(t).toContain("Run part 1 now with delegate");
    const parts = r.result.structuredContent.parts;
    expect(parts.map((p: any) => p.kind)).toEqual(["read", "read", "reason", "code", "reason"]);
    expect(parts[0].files).toEqual([`${dir}/src/router.ts`.replace(process.env.HOME!, "~")]); // the logo, the dependencies and .env are not counted
    expect(parts[0].tokens).toBeGreaterThan(10_000); // 40 KB, about 10k tokens, and the task
    expect(parts[3]).toMatchObject({ runs_on: "you", model: null });
    const named = await rpc("tools/call", { name: "plan", arguments: { task: "Look at it", files: [join(dir, ".env")] } });
    expect(named.result.isError).toBe(true);
    expect(named.result.content[0].text).toContain("was not counted");
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan_run and plan_status: Leanfare's parts in the background, the answers saved in the project; paid parts ask the user here first", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "plan-shared-"));
    fake.hooks.answer = (prompt) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Read the logs", kind: "read", effort: "low", needs: [], size: "small", task: "Find the errors in the logs." },
      { title: "Fix the cause", kind: "code", effort: "high", needs: [1], size: "small", task: "Fix it." },
    ] }) : prompt.includes("Find the errors") ? "Three timeouts at 10:02." : null);
    try {
      // A client that can show questions (elicitation), saying yes to the paid part.
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "2.1" } });
      const questions: any[] = [];
      onRequest = (msg) => { questions.push(msg); write({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: { run: true } } }); };
      const plan = await rpc("tools/call", { name: "plan", arguments: { task: "The nightly job fails: find out why and fix it", folder: dir } });
      const id = plan.result.structuredContent.id;
      expect(plan.result.content[0].text).toContain(`plan_run with id ${id}`);
      expect(readFileSync(join(dir, ".leanfare", "plans", id, "plan.md"), "utf8")).toContain("| # | Part |");
      expect(readFileSync(join(dir, ".leanfare", ".gitignore"), "utf8")).toContain("*"); // git leaves the folder out
      const run = await rpc("tools/call", { name: "plan_run", arguments: { id } });
      expect(questions.length).toBe(1);
      expect(questions[0].method).toBe("elicitation/create");
      expect(questions[0].params.message).toContain("paid parts (part 1)");
      expect(run.result.structuredContent.asks).toBeNull(); // the yes came: nothing waits for one
      const st = await rpc("tools/call", { name: "plan_status", arguments: { id, wait: 10, folder: dir } });
      const t = st.result.content[0].text;
      expect(t).toContain("| 1 | Read the logs | done |");
      expect(t).toContain("| 2 | Fix the cause | yours to do |");
      expect(t).toContain("Three timeouts at 10:02.");
      expect(st.result.structuredContent.saved_in).toBe(`.leanfare/plans/${id}`);
      expect(readFileSync(join(dir, ".leanfare", "plans", id, "part-1.md"), "utf8")).toContain("Three timeouts at 10:02.");
      // Once it used the answer, the app grades it: the grade goes with the model and the kind, never the words.
      expect(t).toContain("grade it with grade (good, partly or wrong, with the plan's id and the part)");
      const g = await rpc("tools/call", { name: "grade", arguments: { id, part: 1, verdict: "partly" } });
      expect(g.result.isError).toBeUndefined();
      expect(g.result.content[0].text).toMatch(/^Graded partly\. .+ for reading: 1 partly of its last 1 \(it moves down below half good, from 3 grades on\)\.$/);
      expect(g.result.structuredContent).toMatchObject({ kind: "read", n: 1, partly: 1, down: false });
      const mine = await rpc("tools/call", { name: "grade", arguments: { id, part: 2, verdict: "good" } });
      expect(mine.result.isError).toBe(true);
      expect(mine.result.content[0].text).toContain("Part 2 has no answer to grade (it is yours).");
      const none = await rpc("tools/call", { name: "grade", arguments: { verdict: "good" } });
      expect(none.result.isError).toBe(true);
      expect(none.result.content[0].text).toContain("grade needs the plan's id and the part's number");
      // No yes: the paid part waits, and the tool says to ask the user.
      onRequest = (msg) => write({ jsonrpc: "2.0", id: msg.id, result: { action: "decline" } });
      const again = await rpc("tools/call", { name: "plan", arguments: { task: "The nightly job fails again: find out why", folder: dir } });
      const r2 = await rpc("tools/call", { name: "plan_run", arguments: { id: again.result.structuredContent.id } });
      expect(r2.result.content[0].text).toContain("wait for the user's yes");
      expect(r2.result.structuredContent.asks.parts).toEqual([1]);
    } finally { onRequest = null; fake.hooks.answer = null; rmSync(dir, { recursive: true, force: true }); }
  });

  test("ask: the answer, the model, the cost, and it counts in the ledger", async () => {
    await keys("openai");
    const r = await rpc("tools/call", modern({ name: "ask", arguments: { prompt: "Hi [usage 2000 500]", model: "openai/gpt-5-mini" } }));
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toContain("Hello from gpt-5-mini.");
    expect(r.result.content[0].text).toContain("(Leanfare: openai/gpt-5-mini, $0.0015.");
    expect(r.result.structuredContent).toMatchObject({ answer: "Hello from gpt-5-mini.", model: "openai/gpt-5-mini", cost_usd: 0.0015 });
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0].source).toBe("openai");
  });

  test("ask without a ready model says why, as a tool error", async () => {
    const r = await rpc("tools/call", { name: "ask", arguments: { prompt: "Hi" } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("No model is ready");
  });

  test("spend, models and estimate", async () => {
    await keys("openai");
    await rpc("tools/call", { name: "ask", arguments: { prompt: "Hi [usage 2000 500]", model: "openai/gpt-5-mini" } });
    const s = await rpc("tools/call", { name: "spend", arguments: {} });
    expect(s.result.content[0].text).toContain("This month: $0.0015 over 1 answers.");
    expect(s.result.content[0].text).toContain("No work was handed to Leanfare by your apps this month (plan and delegate).");
    expect(s.result.structuredContent.work).toMatchObject({ tasks: 0 });
    expect(s.result.structuredContent.month_usd).toBeCloseTo(0.0015, 8);
    const m = await rpc("tools/call", { name: "models", arguments: { provider: "openai" } });
    expect(m.result.content[0].text).toContain("openai/gpt-5-mini: GPT-5 mini, $0.25 in / $2 out per 1M tokens");
    const e = await rpc("tools/call", { name: "estimate", arguments: { prompt: "Write a Python function to sort a list" } });
    expect(e.result.content[0].text).toMatch(/^About \$[\d.]+ on GPT-5 mini, about (a second|\d+ s) \(an estimate; the time is a rough guess\)\./);
    expect(e.result.structuredContent.seconds).toBeGreaterThan(0);
    expect(e.result.structuredContent.speed).toBe("cheapest");
    expect(ledger()).toHaveLength(1); // estimating sends nothing
  });

  test("estimate: the time, and at the same quality the cheapest and the fastest; speed changes the pick", async () => {
    await keys("anthropic", "google", "xai");
    const row = db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, ms, first_ms, out_tokens)
      VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'chat', ?, ?, 'listed', 'reported', 'ok', ?, ?, 400)`);
    for (let i = 0; i < 3; i++) { row.run("google", "google/gemini-3.8-flash", 700, 300); row.run("xai", "xai/grok-4.20-beta", 29_000, 9_000); }
    forgetSpeeds();
    const e = await rpc("tools/call", { name: "estimate", arguments: { prompt: "What is the capital of Australia?" } });
    const t = e.result.content[0].text;
    expect(t).toMatch(/^About \$[\d.]+ on Grok 4\.20 Beta, about 29 s \(an estimate\)\./);
    expect(t).toMatch(/\nAt the same quality: the cheapest is Grok 4\.20 Beta \(about \$[\d.]+, about 29 s\), the fastest is Gemini 3\.8 Flash \(about \$[\d.]+, about a second\)\./);
    expect(e.result.structuredContent.choices.fastest.id).toBe("google/gemini-3.8-flash");
    const f = await rpc("tools/call", { name: "estimate", arguments: { prompt: "What is the capital of Australia?", speed: "fastest" } });
    expect(f.result.content[0].text).toMatch(/^About \$[\d.]+ on Gemini 3\.8 Flash, about a second \(an estimate\)\./);
    expect(f.result.structuredContent.speed).toBe("fastest");
  });

  test("trial: start returns at once, status follows it, and the report names the lowest effort that passed", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    const { QUESTIONS, timing, truths } = await import("../src/trial");
    const T = truths();
    fake.hooks.answer = (prompt) => { const i = QUESTIONS.findIndex((q) => prompt.includes(q.task)); return i < 0 ? null : Array.isArray(T[i]) ? (T[i] as string[]).join(", ") : String(T[i]); };
    timing.pause = 0;
    try {
      const none = await rpc("tools/call", { name: "trial", arguments: {} });
      expect(none.result.content[0].text).toBe("No trial has run yet. Call trial with action start to begin one.");
      const s = await rpc("tools/call", { name: "trial", arguments: { action: "start" } });
      expect(s.result.content[0].text).toMatch(/^The trial started: 30 answers, about \$[\d.]+, about \d+ min\. Ask for its status in a few minutes\.$/);
      let r: any = null;
      for (let i = 0; i < 200; i++) { r = await rpc("tools/call", { name: "trial", arguments: { action: "status" } }); if (!r.result.structuredContent.running) break; await Bun.sleep(50); }
      expect(r.result.structuredContent).toMatchObject({ running: false, status: "done", lowest_passing: "low" });
      expect(r.result.content[0].text).toContain("Low effort passes (at most one miss): Claude can hand reading work to Leanfare at effort low.");
      expect(r.result.content[0].text).toContain("To share these numbers on GitHub, open this address; you read them and press Submit yourself, nothing is sent on its own: https://github.com/pouriaetab/leanfare/issues/new?title=");
      expect((await rpc("tools/call", { name: "trial", arguments: { action: "fly" } })).result.isError).toBe(true);
    } finally { timing.pause = 2000; }
  }, 30_000);

  test("delegate: the door reads the files itself, and the answer comes back with its receipt", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    const folder = mkdtempSync(join(tmpdir(), "leanfare-door-"));
    try {
      mkdirSync(join(folder, "logs"));
      writeFileSync(join(folder, "logs", "app.log"), "10:00 start\n10:01 error: disk full\n");
      const r = await rpc("tools/call", modern({ name: "delegate", arguments: { task: "List the errors.", files: ["logs/app.log"], folder, kind: "read", effort: "low", check: "never" } }));
      expect(r.result.isError).toBeUndefined();
      const [answer, receipt, gradeIt] = r.result.content[0].text.split("\n\n");
      expect(answer).toBe("Hello from deepseek-v4-flash.");
      const row = r.result.structuredContent.handoff;
      expect(row).toBeGreaterThan(0);
      expect(gradeIt).toBe(`(Once you have used it: grade, with model deepseek/deepseek-v4-flash, kind read and handoff ${row}.)`);
      // Graded without its handoff (an older app): the grade still finds its hand off, the last one of that model and kind.
      const g = await rpc("tools/call", { name: "grade", arguments: { model: "deepseek/deepseek-v4-flash", kind: "read", verdict: "good" } });
      expect(g.result.content[0].text).toBe("Graded good. DeepSeek V4 Flash for reading: 1 good of its last 1 (it moves down below half good, from 3 grades on).");
      const work = (await ui(url, "/api/savings")).json.work;
      expect(work).toMatchObject({ tasks: 1, kept: 9, back: 8, grades: { good: 1, partly: 0, wrong: 0 } });
      expect(work.recent[0]).toMatchObject({ plan: false, kinds: ["reading"], files: 1, models: [{ label: "DeepSeek V4 Flash", where: "paid" }], grades: ["good"] });
      // Graded again with its handoff: that grade replaces the first.
      await rpc("tools/call", { name: "grade", arguments: { model: "deepseek/deepseek-v4-flash", kind: "read", verdict: "partly", handoff: row } });
      expect((await ui(url, "/api/savings")).json.work.grades).toEqual({ good: 0, partly: 1, wrong: 0 });
      // The whole prompt's result, graded at its end: kept with this app's last hand off, for the report's "together".
      const whole = await rpc("tools/call", { name: "grade", arguments: { verdict: "good", whole: true } });
      expect(whole.result.content[0].text).toBe('Graded the whole result good. The report shows it as the prompt\'s "together" grade.');
      expect(db.query("SELECT together, together_by FROM delegations WHERE id = ?").get(row)).toEqual({ together: "good", together_by: "app" });
      const spent = (await rpc("tools/call", { name: "spend", arguments: {} })).result;
      expect(spent.content[0].text).toMatch(/Work for your apps this month \(plan and delegate\): 1 task; Leanfare's models read 9 tokens your apps never had to, and 8 came back to them; \$[\d.e-]+\.\nQuality: 0 of 1 graded good, 1 partly, 0 wrong; checks: none yet\./);
      expect(spent.structuredContent.work).toMatchObject({ tasks: 1, tokens_kept_out: 9, tokens_came_back: 8, grades: { partly: 1 }, checks: { passed: 0, failed: 0 } });
      expect(receipt).toMatch(/^\(Leanfare delegate: DeepSeek V4 Flash, \$[\d.e-]+\. About 9 tokens of files stayed out of your context; this answer is about 8\. It took about (a second|\d+ s)\.\)$/);
      expect(r.result.structuredContent).toMatchObject({ answer: "Hello from deepseek-v4-flash.", model: "deepseek/deepseek-v4-flash", task: "longer_query", effort: "low", check: null, first: null, tokens: { files: 9, answer: 8 }, cut: false });
      expect(ledger().map((l) => l.source)).toEqual(["delegate"]);
      // A file that holds secrets never leaves the computer, and nothing is sent.
      writeFileSync(join(folder, ".env"), "OPENAI_API_KEY=sk-real");
      const refused = await rpc("tools/call", { name: "delegate", arguments: { task: "Check the settings.", files: [".env"], folder } });
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content[0].text).toBe(".env was not read: files like it hold secrets (keys, passwords or tokens). Leanfare never hands those to a model.");
      expect(ledger()).toHaveLength(1);
      const noTask = await rpc("tools/call", { name: "delegate", arguments: { files: ["logs/app.log"], folder } });
      expect(noTask.result).toMatchObject({ isError: true, content: [{ text: "delegate needs a task, or the id of one still working." }] });
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test("delegate with Show who wrote what on: the answer's paragraphs carry the model's mark, and the app is asked to keep them", async () => {
    await keys("deepseek");
    await ui(url, "/api/settings", { whoWrote: true });
    const r = await rpc("tools/call", modern({ name: "delegate", arguments: { task: "Say it. [reply The disk is full.\n\nRetry failed.]", kind: "write", effort: "low", check: "never" } }));
    const t = r.result.content[0].text;
    expect(t).toStartWith("`DeepSeek V4 Flash` The disk is full.\n\n`DeepSeek V4 Flash` Retry failed.\n\n(Leanfare delegate: DeepSeek V4 Flash");
    expect(t).toEndWith("(Test, Show who wrote what is on in Leanfare: keep the `DeepSeek V4 Flash` marks on what you take from this answer, and start each paragraph you write yourself with your own model's name the same way, so the user sees who wrote what.)");
    expect(r.result.structuredContent.answer).toBe("The disk is full.\n\nRetry failed."); // the answer itself is unchanged
    await ui(url, "/api/settings", { whoWrote: false });
    const off = await rpc("tools/call", modern({ name: "delegate", arguments: { task: "Say it. [reply The disk is full.]", kind: "write", effort: "low", check: "never" } }));
    expect(off.result.content[0].text).toStartWith("The disk is full.\n\n(Leanfare delegate:");
    expect(off.result.content[0].text).not.toContain("Show who wrote what");
  });

  test("report: the text for apps without pages, the card's data, and the card itself", async () => {
    db.query("INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, files, file_tokens, answer_tokens, status, chance, app, app_model, grade) VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'longer_query', 'read', 'low', 'google/gemini-3.8-flash', 0, 1, 20000, 300, 'ok', 0, 'Claude', 'claude-opus-5-5', 'good')").run();
    const r = await rpc("tools/call", modern({ name: "report", arguments: { range: "today" } }));
    const t = r.result.content[0].text;
    expect(t).toStartWith("Leanfare's report, today: 20k tokens kept out of your plans.");
    expect(t).toContain("Your apps' own use: Claude: not known.");
    expect(t).toContain("Quality: 100% good (0 partly, 0 wrong; 0 judged blind).");
    expect(t).toContain("Last prompts:\n- PRM-1, 2026-10-21 11:00 UTC, Claude (Claude Opus 5.5): Gemini 3.8 Flash, 20k kept out, good");
    expect(t).toMatch(/The full report: Leanfare, Savings \(http:\/\/127\.0\.0\.1:\d+\/#report\)\.$/);
    expect(r.result.structuredContent).toMatchObject({ range: "today", prompts: [{ id: "PRM-1", app: "Claude", model: "Claude Opus 5.5", parts: ["Gemini 3.8 Flash"], kept: 20000, grade: "good" }] });
    expect(r.result.structuredContent.open_url).toMatch(/\/#report$/);
    const list = await rpc("resources/list", {});
    expect(list.result.resources.map((x: any) => x.uri)).toEqual(["ui://leanfare/plan", "ui://leanfare/report"]);
    const page = await rpc("resources/read", { uri: "ui://leanfare/report" });
    expect(page.result.contents[0]).toMatchObject({ uri: "ui://leanfare/report", mimeType: "text/html;profile=mcp-app" });
    expect(page.result.contents[0].text).toContain("<title>Leanfare report</title>");
    const none = await rpc("tools/call", { name: "report", arguments: { range: "1h", app: "Codex" } });
    expect(none.result.content[0].text).toBe("Leanfare's report, the last hour: nothing handed to Leanfare yet in this span.");
    expect(none.result.structuredContent).toMatchObject({ range: "1h", app: "Codex", prompts: [] }); // the card asks again for the same app
    const one = await rpc("tools/call", { name: "report", arguments: { prompt: "prm-1" } }); // one prompt by its id, with its parts
    expect(one.result.content[0].text).toMatch(/^Prompt PRM-1: 2026-10-21 11:00 UTC, Claude \(Claude Opus 5\.5\)\.\nIts own work: not known \(this app does not share it\)\.\nKept out: 20k tokens; cost \$0; lowest grade good\. Claude alone: about 20k \(an estimate\); saved about 20k\.\nParts:\n- PRM-1\.1 reading: Gemini 3\.8 Flash, 20k read, 300 back, free, good \(by your app\), Claude alone about 20k \(an estimate\), saved about 20k \(hand off \d+\)\n/);
    expect(one.result.structuredContent).toMatchObject({ range: "prompt", prompts: [{ id: "PRM-1" }] });
    const unknown = await rpc("tools/call", { name: "report", arguments: { prompt: "PRM-9" } });
    expect([unknown.result.isError, unknown.result.content[0].text]).toEqual([true, "No prompt PRM-9 yet: an id the report gave, like PRM-41."]);
  });

  test("works while Leanfare is locked (the door uses the control token)", async () => {
    await keys("openai");
    await fetch(`${url}/api/lock`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    const r = await rpc("tools/call", { name: "ask", arguments: { prompt: "Hi", model: "openai/gpt-5-mini" } });
    expect(r.result.isError).toBeUndefined();
    const s = await rpc("tools/call", { name: "spend", arguments: {} });
    expect(s.result.isError).toBeUndefined();
  });
});

describe("the end of the input", () => {
  test("the door answers a last message that has no newline before its input closes", async () => {
    const run = async (input: string) => {
      const p = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: "http://127.0.0.1:9", LEANFARE_TOKEN: "x" } });
      (p.stdin as any).write(input);
      await (p.stdin as any).end();
      const out = await new Response(p.stdout as ReadableStream).text();
      await p.exited;
      return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    };
    expect((await run('{"jsonrpc":"2.0","id":1,"method":"ping"}')).map((m) => m.id)).toEqual([1]);
    const two = await run('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');
    expect(two.map((m) => m.id)).toEqual([1, 2]);
    expect(two[1].result.tools).toHaveLength(13);
  }, 20000);
});
