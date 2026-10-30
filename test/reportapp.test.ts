// The report's card inside apps that show MCP Apps (reportapp.ts), run in happy-dom with a stand in for the app it
// is shown in: the handshake, the tiles, the chart, the bars and the last prompts from the tool's result, a span
// picked (the report tool asked again), and the full report opened in Leanfare.
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { APP_PROTOCOL } from "../src/planapp";
import { REPORT_APP_HTML } from "../src/reportapp";

let win: any = null;
afterEach(async () => { try { await win?.happyDOM?.abort(); win?.close(); } catch {} win = null; });
function open(answer: (msg: any) => any) {
  win = new Window({ url: "https://host.example/", width: 700, height: 900 });
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
  doc.write(REPORT_APP_HTML.replace(/<script>[\s\S]*<\/script>/, ""));
  const script = /<script>([\s\S]*)<\/script>/.exec(REPORT_APP_HTML)![1];
  new Function("window", "document", "Node", "setTimeout", "clearTimeout", script)(win, doc, win.Node, win.setTimeout.bind(win), win.clearTimeout.bind(win));
  const push = (method: string, params: unknown) => win.dispatchEvent(new win.MessageEvent("message", { data: { jsonrpc: "2.0", method, params }, source: host }));
  return { doc, sent, push };
}
const until = async (ok: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 20 && !ok(); i++) await Bun.sleep(20); };
const REPORT = (range = "7d", kept = 1_420_000) => ({
  range, from: "2026-10-14T12:00:00Z", to: "2026-10-21T12:00:00Z", step: 86_400_000,
  tiles: { kept: { tokens: kept, share: 0.31, measuredIn: "Claude Code", value: 7.1, valueModel: "Claude Opus 5.5" }, own: { fresh: 3_160_000, cached: 9e6, measured: 21, notKnown: 4, byApp: [] },
    cost: { usd: 0.42, freeShare: 0.96, parts: 48, prompts: 21 }, quality: { good: 44, partly: 5, wrong: 1, graded: 50, goodShare: 0.88, score: { score: 93, lo: 87, hi: 96, n: 50 }, blind: 12, judge: "Gemini 3.8 Flash" } },
  series: Array.from({ length: 8 }, (_, i) => ({ at: new Date(Date.parse("2026-10-14T00:00:00Z") + i * 86_400_000).toISOString(), kept: 100_000 * i, used: 300_000 + 50_000 * i })),
  byModel: [{ label: "Gemini 3.5 Flash-Lite", where: "free", read: 820_000, parts: 23, cost: 0, goodShare: 0.91, score: { score: 93, lo: 80, hi: 98, n: 23 } }, { label: "DeepSeek V4 Flash", where: "paid", read: 72_000, parts: 4, cost: 0.38, goodShare: 0.75, score: { score: 75, lo: 40, hi: 93, n: 4 } }],
  byKind: [],
  prompts: [{ id: "PRM-12", ts: "2026-10-21T11:41:00Z", app: "Claude", model: "Claude Opus 5.5", plan: "Max", parts: ["Gemini 3.5 Flash-Lite", "qwen3.5:9b"], kept: 158_000, saved: null, grade: "good" }],
  open_url: "http://127.0.0.1:4747/#report",
});

describe("the report inside the chat (an MCP App)", () => {
  test("from the tool's result: three tiles, tokens over time, the work by model and the last prompts", async () => {
    const { doc, sent, push } = open((m) => (m.method === "ui/initialize" ? { hostContext: { theme: "dark" } } : undefined));
    await until(() => sent.some((m) => m.method === "ui/notifications/initialized"));
    expect(sent.find((m) => m.method === "ui/initialize").params).toMatchObject({ protocolVersion: APP_PROTOCOL, appInfo: { name: "Leanfare report" } });
    push("ui/notifications/tool-result", { structuredContent: REPORT() });
    await until(() => !!doc.querySelector(".tiles"));
    expect([...doc.querySelectorAll(".tile")].map((t: any) => t.textContent)).toEqual([
      "Kept out1.4M31% of Claude Code's use", "Cost$0.4296% free or on this computer", "Quality93 / 10012 judged blind"]);
    expect(doc.querySelectorAll(".chart path.l1, .chart path.l2")).toHaveLength(2);
    expect([...doc.querySelectorAll(".bar .n")].map((e: any) => e.textContent)).toEqual(["Gemini 3.5 Flash-Litefree", "DeepSeek V4 Flash$0.38"]);
    expect(doc.querySelector(".p").textContent).toContain("Claude · Claude Opus 5.5 · Max → Gemini 3.5 Flash-Lite, qwen3.5:9b158k kept✓ good");
    expect(doc.querySelector(".p .w").textContent).toMatch(/^PRM-12 Oct 21/); // its id, and in 7 days its day too, not only its time
    expect(doc.querySelector(".chips button.on").textContent).toBe("7 days");
    expect(sent.some((m) => m.method === "ui/notifications/size-changed")).toBe(true);
  });

  test("a span picked asks the report tool again; the button opens the full report in Leanfare", async () => {
    const { doc, sent, push } = open((m) => {
      if (m.method === "ui/initialize") return { hostContext: {} };
      if (m.method === "tools/call" && m.params.name === "report") return { structuredContent: REPORT(m.params.arguments.range, 5000) };
      if (m.method === "ui/open-link") return {};
      return undefined;
    });
    push("ui/notifications/tool-result", { structuredContent: REPORT() });
    await until(() => !!doc.querySelector(".chips"));
    ([...doc.querySelectorAll(".chips button")] as any[]).find((b) => b.textContent === "Today").click();
    await until(() => doc.querySelector(".chips button.on")?.textContent === "Today");
    expect(sent.find((m) => m.method === "tools/call").params).toEqual({ name: "report", arguments: { range: "today" } });
    expect(doc.querySelector(".tile .v").textContent).toBe("5k");
    ([...doc.querySelectorAll("button")] as any[]).find((b) => b.textContent === "Open the full report in Leanfare").click();
    await until(() => sent.some((m) => m.method === "ui/open-link"));
    expect(sent.find((m) => m.method === "ui/open-link").params).toEqual({ url: "http://127.0.0.1:4747/#report" });
  });

  test("a report asked for one app keeps that app when another span is picked", async () => {
    const { doc, sent, push } = open((m) => (m.method === "tools/call" ? { structuredContent: { ...REPORT(m.params.arguments.range), app: m.params.arguments.app } } : m.method === "ui/initialize" ? { hostContext: {} } : undefined));
    push("ui/notifications/tool-result", { structuredContent: { ...REPORT(), app: "Claude Code" } });
    await until(() => !!doc.querySelector(".chips"));
    expect(doc.querySelector(".chips button.on").getAttribute("aria-pressed")).toBe("true");
    ([...doc.querySelectorAll(".chips button")] as any[]).find((b) => b.textContent === "30 days").click();
    await until(() => sent.some((m) => m.method === "tools/call"));
    expect(sent.find((m) => m.method === "tools/call").params).toEqual({ name: "report", arguments: { range: "30d", app: "Claude Code" } });
  });

  test("a share of 0 says nothing was handed off there", async () => {
    const { doc, push } = open(() => undefined);
    const r = REPORT();
    push("ui/notifications/tool-result", { structuredContent: { ...r, tiles: { ...r.tiles, kept: { ...r.tiles.kept, share: 0 } } } });
    await until(() => !!doc.querySelector(".tile .s"));
    expect(doc.querySelector(".tile .s").textContent).toBe("0% of Claude Code's use: nothing handed off there");
  });

  test("with nothing in the span, it says so; a result without a report shows its text", async () => {
    const { doc, push } = open(() => undefined);
    push("ui/notifications/tool-result", { structuredContent: { ...REPORT(), prompts: [] } });
    await until(() => doc.body.textContent.includes("Nothing in this span yet"));
    push("ui/notifications/tool-result", { content: [{ type: "text", text: "Leanfare is switched off." }] });
    await until(() => doc.body.textContent.includes("Leanfare is switched off."));
    expect(doc.querySelector(".tiles")).toBeNull();
  });
});
