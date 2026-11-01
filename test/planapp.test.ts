// The plan's page inside apps that show MCP Apps (planapp.ts), run in happy-dom with a stand in for
// the app it is shown in: the handshake, the table from the tool's result, and the run followed by
// itself with plan_status (peek) until Claude has graded every answer; no buttons, nothing sent to the chat.
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

  test("a plan that came with its run: the page follows it by itself, from running to done, with Claude and checked, and has no buttons", async () => {
    let looks = 0;
    const part1 = { n: 1, title: "Read the logs", model: "GPT-5 mini", error: null };
    const part2 = { n: 2, title: "Fix the cause", status: "yours", model: null, answer: null, error: null };
    const { doc, sent, push } = open((m) => {
      if (m.method === "ui/initialize") return { hostContext: {} };
      if (m.method === "tools/call" && m.params.name === "plan_status") {
        looks++;
        if (looks === 1) return { structuredContent: { id: "p1", running: true, asks: null, parts: [{ ...part1, status: "running", answer: null }, part2] } };
        if (looks === 2) return { structuredContent: { id: "p1", running: false, asks: null, parts: [{ ...part1, status: "done", answer: "Three timeouts at 10:02.", took: false }, part2] } };
        if (looks === 3) return { structuredContent: { id: "p1", running: false, asks: null, parts: [{ ...part1, status: "done", answer: "Three timeouts at 10:02.", took: true }, part2] } };
        return { structuredContent: { id: "p1", running: false, asks: null, parts: [{ ...part1, status: "done", answer: "Three timeouts at 10:02.", took: true, verdict: "good" }, part2] } };
      }
    });
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    push("ui/notifications/tool-result", { content: [{ type: "text", text: "| # | Part |" }], structuredContent: { ...PLAN, run: { running: true, cost_usd: 0, asks: null, parts: [{ ...part1, status: "running", answer: null }, part2] } } });
    await until(() => doc.body.textContent.includes("Leanfare is running 1 part by itself"));
    expect(doc.querySelector("#state .dot")).not.toBeNull(); // it shows it is working
    const t = doc.body.textContent;
    expect(t).toContain("Read the logs");
    expect(t).toContain("GPT-5 mini");
    expect(t).toContain("your model");
    expect(t).toContain("in your plan");
    expect(t).toContain("running…");
    await until(() => doc.body.textContent.includes("Claude picks up their answers next"), 6000);
    expect(doc.querySelector("details pre").textContent).toBe("Three timeouts at 10:02.");
    await until(() => doc.body.textContent.includes("Claude has every answer and is checking them"), 9000);
    expect(doc.body.textContent).toContain("with Claude");
    await until(() => doc.body.textContent.includes("Done: Claude checked every answer (1 good)."), 9000);
    expect(doc.body.textContent).toContain("checked: good");
    expect(doc.querySelector("#state .dot")).toBeNull();
    // It only looked: every call was plan_status with peek, nothing was run, and nothing was sent to the chat.
    const calls = sent.filter((m) => m.method === "tools/call");
    expect(calls.every((m) => m.params.name === "plan_status" && m.params.arguments.peek === true)).toBe(true);
    expect(sent.some((m) => m.method === "ui/message")).toBe(false);
    expect(doc.querySelectorAll("button").length).toBe(0);
    const n = looks;
    await Bun.sleep(4500);
    expect(looks).toBe(n); // every answer graded: it stops looking
    expect(sent.some((m) => m.method === "ui/notifications/size-changed")).toBe(true); // it tells the app its height
  }, 30000);

  test("a plan that came without a run (run false): the page looks for one Claude starts later, and follows it", async () => {
    let looks = 0;
    const { doc, sent, push } = open((m) => {
      if (m.method === "ui/initialize") return { hostContext: {} };
      if (m.method === "tools/call" && m.params.name === "plan_status") {
        looks++;
        if (looks === 1) return { isError: true, content: [{ type: "text", text: "No run of that plan." }] }; // Claude has not started it yet
        if (looks <= 3) return { structuredContent: { id: "p1", running: true, asks: null, parts: [{ n: 1, title: "Read the logs", status: "running", model: null, answer: null, error: null }, { n: 2, title: "Fix the cause", status: "yours", model: null, answer: null, error: null }] } };
        return { structuredContent: { id: "p1", running: false, asks: null, parts: [{ n: 1, title: "Read the logs", status: "done", model: "GPT-5 mini", answer: "Three timeouts at 10:02.", took: true, error: null }, { n: 2, title: "Fix the cause", status: "yours", model: null, answer: null, error: null }] } };
      }
    });
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    push("ui/notifications/tool-result", { structuredContent: PLAN });
    await until(() => doc.body.textContent.includes("Leanfare has not started its parts."));
    await until(() => doc.body.textContent.includes("Leanfare is running 1 part by itself"), 9000);
    await until(() => doc.body.textContent.includes("Three timeouts"), 9000);
    expect(doc.body.textContent).toContain("Claude has every answer and is checking them.");
    expect(sent.some((m) => m.params?.name === "plan_run")).toBe(false);
    expect(doc.querySelectorAll("button").length).toBe(0);
  }, 30000);

  test("a paid part waiting for a yes, and a part after one of yours: the page says who does what next, with no button", async () => {
    const { doc, sent, push } = open((m) => (m.method === "ui/initialize" ? { hostContext: {} } : m.method === "tools/call" ? { structuredContent: { id: "p2", running: false, asks: { parts: [3], estimate: 0.04, cap: 0 }, parts: [{ n: 1, title: "Decide", status: "yours" }, { n: 2, title: "Read after", status: "after_yours" }, { n: 3, title: "Search", status: "asks" }] } } : undefined));
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    const parts = [
      { ...PLAN.parts[1], n: 1, needs: [] }, // yours
      { ...PLAN.parts[0], n: 2, needs: [1], runs_on: "free", cost_usd: 0 }, // Leanfare's, after yours
      { ...PLAN.parts[0], n: 3, title: "Search", needs: [], runs_on: "paid", cost_usd: 0.04 }, // paid, over the cap
    ];
    push("ui/notifications/tool-result", { structuredContent: { id: "p2", parts, totals: { parts: 3, out: 2, later: 1, kept: 31000, used: 5000, seconds: null, after: 12, cost: 0.04 },
      run: { running: false, cost_usd: 0, asks: { parts: [3], estimate: 0.04, cap: 0 }, parts: [{ n: 1, title: "Decide", status: "yours" }, { n: 2, title: "Read after", status: "after_yours" }, { n: 3, title: "Search", status: "asks" }] } } });
    await until(() => doc.body.textContent.includes("waits for yours"));
    expect(doc.body.textContent).toContain("Part 2 waits for yours: once yours are done, Claude hands it to Leanfare.");
    expect(doc.body.textContent).toContain("Part 3 is paid (about $0.04) and waits for your yes: Claude asks you in the chat.");
    expect(doc.body.textContent).toContain("waits for a yes");
    expect(doc.querySelectorAll("button").length).toBe(0);
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
    expect(PLAN_APP_HTML).not.toContain("ui/message"); // it never writes in the chat for you
    expect(PLAN_APP_HTML).not.toContain("<button");
  });
});
