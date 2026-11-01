// Live tokens inside Claude Desktop, Cowork and other apps that show MCP Apps (planapp.ts says how they work). The
// live tool names this page (ui://leanfare/live); it draws the tool's result and asks the tool again every 2 seconds
// while anything runs (every 10 when nothing does), so its bars move: one row per call, its tokens by kind (new input,
// cached, thinking, written), and tokens a second. Numbers only. Apps that do not show pages get the same as text.
//
// One file, no outside scripts or fonts: the page talks only to the app it is shown in, with postMessage.
import { APP_PROTOCOL } from "./planapp";

export const LIVE_APP_URI = "ui://leanfare/live";

export const LIVE_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Leanfare live</title>
<style>
  :root { --bg: var(--color-background-primary, #ffffff); --fg: var(--color-text-primary, #1d2021); --muted: var(--color-text-secondary, #6b6f72);
    --line: var(--color-border-primary, #e3e5e6); --soft: var(--color-background-secondary, #f4f5f5); --accent: #0f766e;
    --k1: #2a78d6; --k2: #eb6834; --k3: #1baf7a; --k4: #eda100; }
  :root[data-theme="dark"] { --bg: var(--color-background-primary, #1b1d1e); --fg: var(--color-text-primary, #eceeef); --muted: var(--color-text-secondary, #a3a8ab);
    --line: var(--color-border-primary, #33373a); --soft: var(--color-background-secondary, #24272a); --accent: #2dd4bf;
    --k1: #3987e5; --k2: #d95926; --k3: #199e70; --k4: #c98500; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #app { padding: 10px 12px; display: grid; gap: 8px; }
  .head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; }
  h1 { font-size: 15px; margin: 0; display: flex; align-items: center; gap: 7px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .dot.on { animation: none; } .bar span { transition: none !important; } }
  .muted { color: var(--muted); }
  .num { font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 12px; }
  .legend span::before { content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; background: var(--c); }
  .row { display: grid; grid-template-columns: minmax(0, 13em) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .row.ended { opacity: 0.55; }
  .who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who b { font-weight: 600; }
  .bar { display: flex; gap: 2px; height: 12px; min-width: 0; }
  .bar span { height: 100%; border-radius: 3px; background: var(--c); transition: width 0.45s ease; min-width: 0; }
  .tot { font-size: 12px; text-align: right; min-width: 4.5em; }
  @media (max-width: 480px) { .row { grid-template-columns: 1fr auto; } .row .bar { grid-column: 1 / -1; grid-row: 2; } }
</style></head>
<body><div id="app"><p class="muted">Waiting for Leanfare's live numbers…</p></div>
<script>
(() => {
  "use strict";
  const host = window.parent;
  let nextId = 1, data = null, timer = null;
  const pending = new Map();
  const send = (msg) => host.postMessage(msg, "*");
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const $ = (sel) => document.querySelector(sel);
  const KINDS = [["input", "New input", "--k1"], ["cached", "Cached", "--k2"], ["thinking", "Thinking", "--k3"], ["written", "Written", "--k4"]];
  const SOURCE = { chat: "Chat", delegate: "Hand off", check: "Check", trial: "Trial", plan: "Plan part", sidebyside: "Side by side", ask: "Ask about prompts", openai: "App", anthropic: "App" };
  const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [key, v] of Object.entries(props || {})) { if (v === null || v === undefined) continue; if (key === "class") e.className = v; else if (key === "text") e.textContent = v; else if (key === "style") e.setAttribute("style", v); else e.setAttribute(key, String(v)); }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const total = (c) => c.input + c.cached + c.thinking + c.written;
  function draw() {
    const v = data;
    if (!v) return;
    const calls = [...v.running, ...v.ended.filter((c) => v.at - c.ended < 60000)];
    const most = Math.max(1, ...calls.map(total));
    const head = el("div", { class: "head" }, el("h1", {}, el("span", { class: v.running.length ? "dot on" : "dot" }), "Leanfare live"),
      el("span", { class: "muted num", text: v.running.length ? v.running.length + " running · " + k(v.rate) + " tokens a second" : "nothing running now" }));
    const legend = el("div", { class: "legend" }, ...KINDS.map(([key, name, c]) => el("span", { style: "--c: var(" + c + ")", text: name + " " + k(v.minute[key]) })));
    const rows = calls.length ? calls.map((c) => {
      const secs = Math.round(((c.ended || v.at) - c.started) / 1000);
      return el("div", { class: c.ended ? "row ended" : "row", title: KINDS.map(([key, name]) => name + " " + k(c[key])).join(", ") + (c.exact ? "" : " (estimates until the provider's counts come)") },
        el("div", { class: "who" }, el("b", { text: (c.model && c.model.label) || "a model" }), " ", el("span", { class: "muted", text: (SOURCE[c.source] || c.source) + " · " + secs + " s" })),
        el("div", { class: "bar" }, ...KINDS.map(([key, , col]) => el("span", { style: "--c: var(" + col + "); width: " + ((c[key] / most) * 100).toFixed(2) + "%" }))),
        el("div", { class: "tot num", text: k(total(c)) }));
    }) : [el("p", { class: "muted", text: "No model calls in the last minute. Hand offs, checks and plan parts show here as they run." })];
    $("#app").replaceChildren(head, legend, ...rows, el("div", { class: "legend", text: "The last minute's tokens by kind. Numbers only; Leanfare keeps no words for this." }));
    size();
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(again, data && data.running.length ? 2000 : 10000); }
  async function again() {
    try { const r = await request("tools/call", { name: "live", arguments: {} }); if (r && r.structuredContent && r.structuredContent.running) { data = r.structuredContent; draw(); } } catch (e) {}
    schedule();
  }
  function size() { notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }); }
  function theme(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") for (const [key, v] of Object.entries(vars)) if (/^--[\\w-]+$/.test(key) && typeof v === "string") document.documentElement.style.setProperty(key, v);
  }
  function show(result) {
    const sc = result && result.structuredContent;
    if (!sc || !sc.running) { $("#app").replaceChildren(el("p", { class: "muted", text: (result && result.content && result.content[0] && result.content[0].text) || "No live numbers to show." })); size(); return; }
    data = sc; draw(); schedule();
  }
  window.addEventListener("message", (e) => {
    if (e.source !== host) return; // only the app this page is shown in
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(m.error); else p.resolve(m.result); return; }
    if (m.method === "ui/notifications/tool-result") show(m.params);
    else if (m.method === "ui/notifications/host-context-changed") theme(m.params);
    else if (m.method === "ui/resource-teardown" && m.id !== undefined) { clearTimeout(timer); send({ jsonrpc: "2.0", id: m.id, result: {} }); }
  });
  request("ui/initialize", { protocolVersion: "${APP_PROTOCOL}", appInfo: { name: "Leanfare live", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] } })
    .then((r) => { theme(r && r.hostContext); notify("ui/notifications/initialized", {}); })
    .catch(() => notify("ui/notifications/initialized", {}));
})();
</script></body></html>`;
