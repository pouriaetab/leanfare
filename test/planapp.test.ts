// The plan's page inside apps that show MCP Apps (planapp.ts), run in happy-dom with a stand in for
// the app it is shown in: the handshake, the table from the tool's result, Run (plan_run, then
// plan_status until the parts end), handing the answers back to the chat, and nothing else.
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { APP_PROTOCOL, PLAN_APP_HTML } from "../src/planapp";

let win: any = null;
afterEach(async () => { try { await win?.happyDOM?.abort(); win?.close(); } catch {} win = null; });

// The page, with a host that records what the page sends and answers like an MCP Apps host.
function open(answer: (msg: any) => any) {
  win = new Window({ url: "https://host.example/", width: 900, height: 700 });
  const sent: any[] = [];
  const host = {
    postMessage(msg: any) {
      sent.push(msg);
      if (msg.id === undefined) return; // a notification
      const result = answer(msg);
      if (result !== undefined) setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data: { jsonrpc: "2.0", id: msg.id, result }, source: host })), 0);
    },
  };
  Object.defineProperty(win, "parent", { value: host });
  const doc = win.document;
  doc.write(PLAN_APP_HTML.replace(/<script>[\s\S]*<\/script>/, ""));
  const script = /<script>([\s\S]*)<\/script>/.exec(PLAN_APP_HTML)![1];
  new Function("window", "document", "Node", "setTimeout", "clearTimeout", script.replace(/window\.parent/g, "window.parent"))(win, doc, win.Node, win.setTimeout.bind(win), win.clearTimeout.bind(win));
  const push = (method: string, params: unknown, source: unknown = host) => win.dispatchEvent(new win.MessageEvent("message", { data: { jsonrpc: "2.0", method, params }, source }));
  return { doc, sent, push, host };
}
const until = async (ok: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 20 && !ok(); i++) await Bun.sleep(20); };

const PLAN = {
  id: "p1",
  parts: [
    { n: 1, title: "Read the logs", kind: "read", effort: "low", needs: [], runs_on: "paid", model: "openai/gpt-5-mini", model_label: "GPT-5 mini", seconds: 12, tokens: 31000, cost_usd: 0.012, files: [], task: "Find the errors." },
    { n: 2, title: "Fix the cause", kind: "code", effort: "high", needs: [1], runs_on: "you", model: null, model_label: null, seconds: null, tokens: 5000, cost_usd: null, files: [], task: "Fix it." },
  ],
  totals: { parts: 2, out: 1, kept: 31000, used: 5000, seconds: 12, cost: 0.012 },
};

describe("the plan inside the chat (an MCP App)", () => {
  test("it opens with ui/initialize, takes the app's theme, and says it is ready", async () => {
    const { doc, sent } = open((m) => (m.method === "ui/initialize" ? { hostCapabilities: {}, hostContext: { theme: "dark", styles: { variables: { "--color-background-primary": "#101010", "bad name": "x" } } } } : undefined));
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    const init = sent.find((m) => m.method === "ui/initialize");
    expect(init.params).toMatchObject({ protocolVersion: APP_PROTOCOL, appInfo: { name: "Leanfare plan" } });
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(doc.documentElement.style.getPropertyValue("--color-background-primary")).toBe("#101010");
    expect(doc.body.textContent).toContain("Waiting for Leanfare's plan");
  });

  test("the tool's result becomes the table; Run is the yes for the paid parts it names, then it follows the parts to their answers", async () => {
    let calls = 0;
    const { doc, sent, push } = open((m) => {
      if (m.method === "ui/initialize") return { hostContext: {} };
      if (m.method === "tools/call" && m.params.name === "plan_run") return { structuredContent: { id: "p1", running: true, parts: [{ n: 1, status: "running" }, { n: 2, status: "yours" }], asks: null } };
      if (m.method === "tools/call" && m.params.name === "plan_status") {
        calls++;
        return { structuredContent: { id: "p1", running: false, asks: null, parts: [{ n: 1, title: "Read the logs", status: "done", model: "GPT-5 mini", answer: "Three timeouts at 10:02.", error: null }, { n: 2, title: "Fix the cause", status: "yours", model: null, answer: null, error: null }] } };
      }
      if (m.method === "ui/message") return {};
    });
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    push("ui/notifications/tool-result", { content: [{ type: "text", text: "| # | Part |" }], structuredContent: PLAN });
    await until(() => !!doc.querySelector("#run"));
    const t = doc.body.textContent;
    expect(t).toContain("Read the logs");
    expect(t).toContain("GPT-5 mini");
    expect(t).toContain("your model");
    expect(t).toContain("in your plan");
    expect(doc.querySelector("#run").textContent).toBe("Run Leanfare's parts (about $0.01 paid)");
    doc.querySelector("#run").click();
    await until(() => calls > 0 && doc.body.textContent.includes("Three timeouts"));
    expect(sent.find((m) => m.params?.name === "plan_run").params.arguments).toEqual({ id: "p1", paid: "yes" });
    expect(doc.body.textContent).toContain("done");
    expect(doc.querySelector("details pre").textContent).toBe("Three timeouts at 10:02.");
    doc.querySelector("#back").click();
    await until(() => sent.some((m) => m.method === "ui/message"));
    expect(sent.find((m) => m.method === "ui/message").params.content.text).toContain("plan_status");
    expect(sent.some((m) => m.method === "ui/notifications/size-changed")).toBe(true); // it tells the app its height
  });

  test("messages from anywhere but the app it is shown in are ignored, and a result with no plan shows its text", async () => {
    const { doc, push } = open((m) => (m.method === "ui/initialize" ? { hostContext: {} } : undefined));
    push("ui/notifications/tool-result", { structuredContent: PLAN }, { postMessage() {} }); // another frame
    await Bun.sleep(50);
    expect(doc.body.textContent).toContain("Waiting for Leanfare's plan");
    push("ui/notifications/tool-result", { content: [{ type: "text", text: "plan needs a task." }], isError: true });
    await until(() => doc.body.textContent.includes("plan needs a task."));
    expect(doc.body.textContent).toContain("plan needs a task.");
  });

  test("the page loads nothing from outside: no script, style or font addresses", () => {
    expect(PLAN_APP_HTML).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
    expect(PLAN_APP_HTML).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(PLAN_APP_HTML).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });
});
