// 0.12, live tokens (live.ts): every model call as it runs, numbers only (estimates first, the provider's counts when
// they come); /api/live once and as a stream; the live tool and its card for apps that show MCP Apps; Savings' Live
// card with bars, lanes and numbers.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { draw } from "../src/delegate";
import { forgetLive, liveAdd, liveEnd, liveStart, liveUsage, liveView } from "../src/live";
import { LIVE_APP_HTML } from "../src/liveapp";
import { runToolFor } from "../src/mcp";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp as open } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); forgetLive(); draw.next = () => 0.5; await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral"); });
afterEach(closeApp);
async function waitFor(ok: () => boolean | Promise<boolean>, ms = 8000) { for (let i = 0; i < ms / 50 && !(await ok()); i++) await Bun.sleep(50); }
const M = { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek" };
const slowHandOff = (ms: number) => ui(url, "/api/delegate", { task: `Find the errors. [slow ${ms}] [usage 2000 500] [cached 300]`, files: [{ name: "app.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "low", check: "never", app: "Claude" });

test("a call's tokens: estimates as text comes, the provider's counts when they come; ended calls go after 90 seconds", () => {
  const t = 1_000_000;
  liveStart("a", "delegate", "Delegate", M, 1200, t);
  liveAdd("a", 400, 800, t + 1000); // 400 characters written, 800 thought
  let v = liveView(t + 2000);
  expect(v.running[0]).toMatchObject({ id: "a", source: "delegate", model: M, input: 1200, cached: 0, thinking: 200, written: 100, exact: false });
  expect(v.rate).toBe(300); // 300 tokens in the second since its first token
  liveUsage("a", { uncached: 1500, cacheRead: 600, cacheWrite: 0, output: 500 });
  v = liveView(t + 2000);
  expect(v.running[0]).toMatchObject({ input: 1500, cached: 600, thinking: 200, written: 300, exact: true });
  liveEnd("a", t + 3000);
  v = liveView(t + 4000);
  expect([v.running.length, v.ended.length]).toEqual([0, 1]);
  expect(v.minute).toEqual({ input: 1500, cached: 600, thinking: 200, written: 300 });
  expect(liveView(t + 3000 + 91_000).ended).toEqual([]);
});

test("a hand off shows while it runs, then as ended with the provider's counts; the stream sends it too", async () => {
  const run = slowHandOff(1500);
  await waitFor(async () => (await ui(url, "/api/live")).json.running.length > 0);
  const now = (await ui(url, "/api/live")).json;
  expect(now.running[0]).toMatchObject({ source: "delegate", model: { id: "deepseek/deepseek-v4-flash" }, ended: null });
  expect(now.running[0].input).toBeGreaterThan(0); // Leanfare's estimate, before any token comes
  // The stream: a first view at once, numbers only.
  const ac = new AbortController();
  const res = await fetch(`${url}/api/live/stream`, { headers: { "x-leanfare": "1" }, signal: ac.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const first = new TextDecoder().decode((await res.body!.getReader().read()).value);
  expect(first.startsWith("data: ")).toBe(true);
  const sent = JSON.parse(first.slice(6).trim());
  expect(sent.running.length + sent.ended.length).toBeGreaterThan(0);
  expect(JSON.stringify(sent)).not.toContain("Find the errors"); // no words
  ac.abort();
  expect((await run).status).toBe(200);
  const after = (await ui(url, "/api/live")).json;
  expect(after.running).toEqual([]);
  expect(after.ended[0]).toMatchObject({ source: "delegate", input: 1700, cached: 300, written: 500, exact: true });
});

test("the live tool: lines and numbers, and a card for apps that show MCP Apps", async () => {
  const ctx = { client: "Claude", cwd: process.env.LEANFARE_DATA_DIR!, canAsk: false };
  const none = await runToolFor(ctx, "live", {}, new AbortController().signal);
  expect(none.content[0].text).toContain("Nothing is running now.");
  expect(none.structuredContent).toMatchObject({ running: [], minute: { input: 0, cached: 0, thinking: 0, written: 0 } });
  liveStart("b", "plan", "Plan part", M, 3000);
  liveAdd("b", 800, 0);
  const one = await runToolFor(ctx, "live", {}, new AbortController().signal);
  expect(one.content[0].text).toContain("Running now: 1 call");
  expect(one.content[0].text).toContain("1. DeepSeek V4 Flash, Plan part,");
  expect(one.content[0].text).toContain("new input 3.0k, cached 0, thinking 0, written 200 (estimates until the provider's counts come)");
  expect(LIVE_APP_HTML).toContain("ui/initialize");
  expect(LIVE_APP_HTML).toContain('request("tools/call", { name: "live", arguments: {} })');
  // Its script parses.
  const script = LIVE_APP_HTML.slice(LIVE_APP_HTML.indexOf("<script>") + 8, LIVE_APP_HTML.indexOf("</script>"));
  expect(() => new Function(script)).not.toThrow();
});

test("Savings: the Live card's bars while a hand off runs, a call opened into its kinds, the lanes, the numbers and the kinds", async () => {
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="savings"]').click();
  await waitFor(() => !!doc.querySelector("#liveCard"));
  await waitFor(() => doc.querySelector("#liveCard")?.textContent.includes("nothing running now"));
  const run = slowHandOff(2500);
  await waitFor(() => !!doc.querySelector("#liveCard .lv-bar-row"));
  const row = doc.querySelector("#liveCard .lv-bar-row");
  expect(row.textContent).toContain("DeepSeek V4 Flash");
  expect(row.textContent).toContain("Hand off");
  expect(doc.querySelector("#liveCard .lv-dot.on")).not.toBeNull();
  row.click();
  await waitFor(() => !!doc.querySelector("#liveCard .lv-open"));
  expect([...doc.querySelectorAll("#liveCard .lv-open .lv-kind")].map((k: any) => k.firstChild.textContent)).toEqual(["New input", "Cached", "Thinking", "Written"]);
  const pick = (name: string) => [...doc.querySelectorAll("#liveCard .seg button")].find((b: any) => b.textContent === name) as any;
  pick("Lanes").click();
  await waitFor(() => !!doc.querySelector("#liveCard svg.lv-lanes rect.lv-lane"));
  expect(doc.querySelector("#liveCard svg.lv-lanes").textContent).toContain("now");
  pick("Numbers").click();
  await waitFor(() => !!doc.querySelector("#liveCard .lv-table"));
  expect([...doc.querySelectorAll("#liveCard .lv-table tbody tr")].map((r: any) => r.firstChild.textContent)).toEqual(["New input", "Cached", "Thinking", "Written"]);
  const cached = [...doc.querySelectorAll("#liveCard .lv-kinds button")].find((b: any) => b.textContent === "Cached") as any;
  cached.click();
  await waitFor(() => doc.querySelector("#liveCard .lv-kinds button.lk-2")?.getAttribute("aria-pressed") === "false");
  expect(doc.querySelector("#liveCard .lv-table tbody tr.off").textContent).toContain("Cached");
  await run;
}, 30000);
