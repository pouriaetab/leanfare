// leanfare mcp, the real command over stdio, against the test server: both eras
// of the protocol, and every tool.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TICKED, boot, fake, keys, ledger, reset } from "./app";
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
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["plan", "plan_run", "plan_stop", "plan_status", "ask", "delegate", "spend", "models", "estimate", "trial", "local_model"]);
    expect(list.result.resultType).toBeUndefined();
  });

  test("a 2026 client: server/discover, and every result says it is complete", async () => {
    const d = await rpc("server/discover", modern());
    expect(d.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"], capabilities: { tools: {} } });
    expect(d.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("leanfare");
    const list = await rpc("tools/list", modern());
    expect(list.result.resultType).toBe("complete");
    expect(list.result.tools).toHaveLength(11);
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
    expect(list.result.resources).toEqual([expect.objectContaining({ uri: "ui://leanfare/plan", mimeType: "text/html;profile=mcp-app" })]);
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
      const [answer, receipt] = r.result.content[0].text.split("\n\n");
      expect(answer).toBe("Hello from deepseek-v4-flash.");
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
      expect(noTask.result).toMatchObject({ isError: true, content: [{ text: "delegate needs a task." }] });
    } finally { rmSync(folder, { recursive: true, force: true }); }
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
    expect(two[1].result.tools).toHaveLength(11);
  }, 20000);
});
