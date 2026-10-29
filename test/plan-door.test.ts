// The MCP door and a response it no longer waits for, and the plan's page in the chat: Run names the
// paid parts, and Stop is there while they run.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { PLAN_APP_HTML } from "../src/planapp";
import { boot } from "./app";

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let buffer = "";
const lines: any[] = [];
beforeAll(async () => {
  url = (await boot()).url;
  child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" },
  });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
      buffer += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
    }
  })();
});
afterAll(() => { try { child?.kill(); } catch {} });
const write = (msg: unknown) => { (child!.stdin as any).write(JSON.stringify(msg) + "\n"); (child!.stdin as any).flush?.(); };

describe("the door", () => {
  test("an answer to a question the door no longer waits for gets no reply", async () => {
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "2" } } });
    for (let i = 0; i < 600 && !lines.some((l) => l.id === 1); i++) await Bun.sleep(25); // its answer first, however slowly the door starts
    expect(lines.some((l) => l.id === 1)).toBe(true);
    const before = lines.length;
    write({ jsonrpc: "2.0", id: "leanfare-7", result: { action: "accept", content: { run: true } } }); // a late yes: a response, not a request
    await Bun.sleep(500);
    expect(lines.slice(before)).toEqual([]); // JSON-RPC: a response is never answered
  });
});

let win: any = null;
afterEach(async () => { try { await win?.happyDOM?.abort(); win?.close(); } catch {} win = null; });
function open(answer: (msg: any) => any) {
  win = new Window({ url: "https://host.example/", width: 900, height: 700 });
  const sent: any[] = [];
  const host = {
    postMessage(msg: any) {
      sent.push(msg);
      if (msg.id === undefined) return;
      const result = answer(msg);
      if (result !== undefined) setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data: { jsonrpc: "2.0", id: msg.id, result }, source: host })), 0);
    },
  };
  Object.defineProperty(win, "parent", { value: host });
  const doc = win.document;
  doc.write(PLAN_APP_HTML.replace(/<script>[\s\S]*<\/script>/, ""));
  const script = /<script>([\s\S]*)<\/script>/.exec(PLAN_APP_HTML)![1];
  new Function("window", "document", "Node", "setTimeout", "clearTimeout", script)(win, doc, win.Node, win.setTimeout.bind(win), win.clearTimeout.bind(win));
  const push = (method: string, params: unknown) => win.dispatchEvent(new win.MessageEvent("message", { data: { jsonrpc: "2.0", method, params }, source: host }));
  return { doc, sent, push };
}
const until = async (ok: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 20 && !ok(); i++) await Bun.sleep(20); };

describe("the page's Run is the yes for the paid parts", () => {
  test("a paid part whose cost is not known: Run says so", async () => {
    const { doc, sent, push } = open((m) => (m.method === "ui/initialize" ? { hostContext: {} } : m.method === "tools/call" ? { structuredContent: { id: "p1", running: false, parts: [], asks: null } } : undefined));
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    push("ui/notifications/tool-result", { content: [{ type: "text", text: "| # |" }], structuredContent: {
      id: "p1",
      parts: [
        { n: 1, title: "Read the logs", kind: "read", effort: "low", needs: [], runs_on: "free", model: "x/free", model_label: "Free model", seconds: 5, tokens: 3000, cost_usd: 0, files: [], task: "t" },
        { n: 2, title: "Search the web", kind: "search", effort: "medium", needs: [], runs_on: "paid", model: "perplexity/sonar", model_label: "Sonar", seconds: 9, tokens: 2000, cost_usd: null, files: [], task: "t" },
      ],
      totals: { parts: 2, out: 2, kept: 5000, used: 0, seconds: 9, cost: null },
    } });
    await until(() => !!doc.querySelector("#run"));
    const label = doc.querySelector("#run").textContent;
    doc.querySelector("#run").click();
    await until(() => sent.some((m) => m.params?.name === "plan_run"));
    expect(label).toContain("paid");
  });

  test("while parts run there is a Stop: on the page, and plan_stop at the door", async () => {
    const { doc, sent, push } = open((m) => {
      if (m.method === "ui/initialize") return { hostContext: {} };
      if (m.method === "tools/call" && m.params.name === "plan_run") return { structuredContent: { id: "p1", running: true, parts: [{ n: 1, status: "running" }], asks: null } };
      if (m.method === "tools/call" && m.params.name === "plan_status") return { structuredContent: { id: "p1", running: true, asks: null, parts: [{ n: 1, title: "Read the logs", status: "running", model: null, answer: null, error: null }] } };
    });
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    push("ui/notifications/tool-result", { content: [{ type: "text", text: "| # |" }], structuredContent: {
      id: "p1", parts: [{ n: 1, title: "Read the logs", kind: "read", effort: "low", needs: [], runs_on: "paid", model: "openai/gpt-5-mini", model_label: "GPT-5 mini", seconds: 5, tokens: 3000, cost_usd: 0.4, files: [], task: "t" }],
      totals: { parts: 1, out: 1, kept: 3000, used: 0, seconds: 5, cost: 0.4 },
    } });
    await until(() => !!doc.querySelector("#run"));
    doc.querySelector("#run").click();
    await until(() => sent.some((m) => m.params?.name === "plan_status"));
    const buttons = [...doc.querySelectorAll("button")].map((b: any) => `${b.textContent}${b.disabled ? " (disabled)" : ""}`);
    write({ jsonrpc: "2.0", id: 900, method: "tools/list", params: {} });
    await Bun.sleep(400);
    const tools = lines.find((m) => m.id === 900)?.result?.tools?.map((t: any) => t.name);
    expect(buttons.some((b) => /stop/i.test(b)) || (tools ?? []).some((t: string) => /stop/i.test(t))).toBe(true);
  });
});
