// The plan inside Claude Desktop, Cowork and other apps that show MCP Apps (an MCP extension, 26
// Jan 2026: a tool's result drawn as a small page inside the chat). The plan tool names this page
// (ui://leanfare/plan); the app draws the table from the tool's result, runs Leanfare's parts with
// plan_run when you press Run, follows them with plan_status, and can hand the answers back to the
// chat. Apps that do not show pages (Claude Code) get the same table as text.
//
// One file, no outside scripts or fonts: the page talks to the app it is shown in with postMessage
// (JSON-RPC: ui/initialize, ui/notifications/tool-result, tools/call, ui/message), and only with it.
export const PLAN_APP_URI = "ui://leanfare/plan";
export const APP_MIME = "text/html;profile=mcp-app";
export const APP_PROTOCOL = "2026-01-26";

export const PLAN_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Leanfare plan</title>
<style>
  :root { --bg: var(--color-background-primary, #ffffff); --fg: var(--color-text-primary, #1d2021); --muted: var(--color-text-secondary, #6b6f72);
    --line: var(--color-border-primary, #e3e5e6); --soft: var(--color-background-secondary, #f4f5f5); --accent: #0f766e; --good: #15803d; --warn: #b45309; }
  :root[data-theme="dark"] { --bg: var(--color-background-primary, #1b1d1e); --fg: var(--color-text-primary, #eceeef); --muted: var(--color-text-secondary, #a3a8ab);
    --line: var(--color-border-primary, #33373a); --soft: var(--color-background-secondary, #24272a); --accent: #2dd4bf; --good: #4ade80; --warn: #fbbf24; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #app { padding: 10px 12px; }
  h1 { font-size: 14px; margin: 0 0 6px; display: flex; gap: 8px; align-items: baseline; }
  h1 small { color: var(--muted); font-weight: 400; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11.5px; white-space: nowrap; }
  td.n, td.t, td.c, td.s { white-space: nowrap; }
  tr.you td { background: var(--soft); }
  .why { color: var(--muted); font-size: 11.5px; }
  .sum { margin: 8px 0; }
  .muted { color: var(--muted); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
  button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px; padding: 5px 11px; cursor: pointer; }
  button.go { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button[disabled] { opacity: .55; cursor: default; }
  .done { color: var(--good); } .bad { color: var(--warn); }
  details { border-top: 1px solid var(--line); padding: 5px 0; }
  summary { cursor: pointer; font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0; font: 12px/1.45 ui-monospace, Menlo, monospace; background: var(--soft); padding: 8px; border-radius: 6px; }
  @media (max-width: 560px) { thead { display: none; } table, tbody, tr, td { display: block; width: 100%; } tr { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; padding: 4px 6px; } td { border: none; padding: 1px 0; white-space: normal !important; } td[data-l]::before { content: attr(data-l) ": "; color: var(--muted); } }
</style></head>
<body><div id="app"><p class="muted">Waiting for Leanfare's plan…</p></div>
<script>
(() => {
  "use strict";
  const host = window.parent;
  let nextId = 1;
  const pending = new Map();
  const send = (msg) => host.postMessage(msg, "*");
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) { if (v === null || v === undefined || v === false) continue; if (k === "text") e.textContent = v; else if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, String(v)); }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const usd = (v) => (v === null || v === undefined ? "not known" : v === 0 ? "$0" : v < 0.01 ? "under $0.01" : "$" + v.toFixed(2));
  const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));
  const secs = (s) => (s === null || s === undefined ? "" : s < 90 ? "~" + Math.max(1, Math.round(s)) + " s" : "~" + Math.round(s / 60) + " min");
  const RUNS = { you: "you", local: "Leanfare, this computer", free: "Leanfare, free", paid: "Leanfare, pay per use" };
  const NOW = { waiting: "waiting", running: "running…", done: "done", failed: "failed", stopped: "stopped", yours: "yours", after_yours: "after yours", blocked: "waits", asks: "waits for a yes" };
  let plan = null, run = null, timer = null;
  // When every part stays with you: what would send some out (as the planner says it).
  const nothingOut = (parts) => {
    const hints = [parts.some((p) => p.kind === "search" && p.runs_on === "you") ? "tick Perplexity Sonar in Leanfare and the searches go out" : "",
      parts.every((p) => !(p.files || []).length) ? "name the files or folder it is about and the reading goes out" : ""].filter(Boolean);
    return "Nothing goes to Leanfare: " + (hints.length ? hints.join("; ") : "every part changes the project or needs the hardest judgement") + ".";
  };

  function draw() {
    const app = $("#app");
    if (!plan) return;
    const st = (n) => (run ? run.parts.find((p) => p.n === n) : null);
    const byN = (n) => plan.parts.find((q) => q.n === n) || {};
    const laterOf = (p, seen = 0) => seen < 50 && p.needs.some((n) => byN(n).runs_on === "you" || (byN(n).needs && laterOf(byN(n), seen + 1))); // it waits for one of yours, through its needs
    const rows = plan.parts.map((p) => el("tr", { class: p.runs_on === "you" ? "you" : "" },
      el("td", { class: "n", text: p.n }),
      el("td", {}, el("b", { text: p.title }), el("div", { class: "why", text: p.kind + ", " + p.effort + (p.needs.length ? " · after " + p.needs.join(", ") : "") })),
      el("td", { "data-l": "Runs on", text: RUNS[p.runs_on] || p.runs_on }),
      el("td", { "data-l": "Model", text: p.model_label || (p.runs_on === "you" ? (p.your_model && p.your_model.label) || "your model" : p.model || "") }),
      el("td", { class: "t", "data-l": "Time", text: secs(p.seconds) }),
      el("td", { "data-l": "Tokens", text: "~" + tok(p.tokens) + (p.runs_on === "you" ? " of your plan" : " kept") }),
      el("td", { class: "c", "data-l": "Cost", text: p.runs_on === "you" ? "in your plan" : usd(p.cost_usd) }),
      run ? el("td", { class: "s " + ((st(p.n) || {}).status === "done" ? "done" : ["failed", "blocked", "asks"].includes((st(p.n) || {}).status) ? "bad" : ""), "data-l": "Now", text: NOW[(st(p.n) || {}).status] || "" }) : null));
    const t = plan.totals;
    const paidParts = plan.parts.filter((p) => p.runs_on === "paid");
    const paid = paidParts.reduce((n, p) => n + (p.cost_usd || 0), 0);
    const unknown = paidParts.some((p) => p.cost_usd === null || p.cost_usd === undefined);
    const mine = plan.parts.filter((p) => p.runs_on !== "you").length;
    const now = mine - (t.later || 0); // the parts of Leanfare's that do not wait for yours
    const later = plan.parts.filter((p) => p.runs_on !== "you" && laterOf(p)).map((p) => p.n);
    const going = run && run.running;
    // Something of Leanfare's left to run: never run, or ended without an answer.
    const left = !run || plan.parts.some((p) => p.runs_on !== "you" && ["waiting", "asks", "failed", "stopped", "blocked"].includes((st(p.n) || {}).status));
    const kids = [
      el("h1", {}, "Leanfare's plan", el("small", { text: mine + " of " + plan.parts.length + " parts to Leanfare" })),
      el("table", {}, el("thead", {}, el("tr", {}, ...["#", "Part", "Runs on", "Model", "Time", "Tokens", "Cost", ...(run ? ["Now"] : [])].map((x) => el("th", { text: x })))), el("tbody", {}, ...rows)),
      el("p", { class: "sum", text: "About " + tok(t.kept) + " tokens kept out of your plan" + (t.used ? ", about " + tok(t.used) + " stay in it" : "") + ". Pay per use: " + usd(t.cost) + "." + (mine ? "" : " " + nothingOut(plan.parts)) }),
      plan.local ? el("p", { class: "muted", text: "A local model fits this computer: " + plan.local.name + " (" + (plan.local.size / 1e9).toFixed(plan.local.size < 10e9 ? 1 : 0) + " GB), rated like " + plan.local.like + ", free to run. Ask for it to be downloaded (Leanfare's local_model asks you first)." }) : null,
      el("div", { class: "row" },
        now && (left || going) ? el("button", { class: "go", id: "run", disabled: going ? "" : null, onclick: start, text: going ? "Running…" : (run ? "Run the rest" : "Run Leanfare's parts") + (paidParts.length ? (unknown ? " (paid parts, cost not known)" : " (about " + usd(paid) + " paid)") : "") }) : null,
        going ? el("button", { id: "stop", onclick: stop, text: "Stop" }) : null,
        run && !going && run.parts.some((p) => p.answer) ? el("button", { id: "back", onclick: handBack, text: "Hand the answers to Claude" }) : null,
        el("span", { class: "muted", text: going ? "Leanfare runs its parts on your computer; this updates as they finish." : "" })),
    ];
    if (run) for (const p of run.parts.filter((x) => x.answer || x.error)) kids.push(el("details", {}, el("summary", { text: "Part " + p.n + " · " + p.title + " · " + (NOW[p.status] || p.status) + (p.model ? " · " + p.model : "") }), p.answer ? el("pre", { text: p.answer }) : null, p.error ? el("p", { class: "bad", text: p.error }) : null));
    if (later.length) kids.push(el("p", { class: "muted", text: (later.length === 1 ? "Part " + later[0] + " waits" : "Parts " + later.join(", ") + " wait") + " for yours: once yours are done, Claude hands " + (later.length === 1 ? "it" : "them") + " to Leanfare." }));
    if (run && run.asks) kids.push(el("p", { class: "bad", text: "Parts " + run.asks.parts.join(", ") + " are paid and wait for a yes: press Run to say yes." }));
    app.replaceChildren(...kids);
    size();
  }
  async function start() {
    try {
      const r = await request("tools/call", { name: "plan_run", arguments: { id: plan.id, paid: "yes" } }); // pressing Run is the yes for the paid parts shown on it
      run = r && r.structuredContent ? { ...r.structuredContent, parts: r.structuredContent.parts } : run;
      draw(); follow();
    } catch (e) { shout(e); }
  }
  async function follow() {
    clearTimeout(timer);
    try {
      const r = await request("tools/call", { name: "plan_status", arguments: { id: plan.id } });
      if (r && r.structuredContent) { run = r.structuredContent; draw(); }
    } catch (e) { shout(e); return; }
    if (run && run.running) timer = setTimeout(follow, 2000);
  }
  async function stop() {
    try { const r = await request("tools/call", { name: "plan_stop", arguments: { id: plan.id } }); if (r && r.structuredContent) run = { ...run, ...r.structuredContent, parts: run.parts.map((p) => ({ ...p, ...((r.structuredContent.parts || []).find((x) => x.n === p.n) || {}) })) }; draw(); follow(); }
    catch (e) { shout(e); }
  }
  async function handBack() {
    try { await request("ui/message", { role: "user", content: { type: "text", text: "Leanfare finished its parts of plan " + plan.id + ". Read their answers with plan_status, then do the parts left to you." } }); $("#back").disabled = true; }
    catch (e) { shout(e); }
  }
  function shout(e) { const p = el("p", { class: "bad", text: "Leanfare: " + (e && e.message ? e.message : String(e)) }); $("#app").append(p); size(); }
  function size() { notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }); }
  function theme(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") for (const [k, v] of Object.entries(vars)) if (/^--[\\w-]+$/.test(k) && typeof v === "string") document.documentElement.style.setProperty(k, v);
  }
  function show(result) {
    const sc = result && result.structuredContent;
    if (!sc || !Array.isArray(sc.parts)) { $("#app").replaceChildren(el("p", { class: "muted", text: (result && result.content && result.content[0] && result.content[0].text) || "No plan to show." })); size(); return; }
    plan = sc; run = null; draw();
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
  request("ui/initialize", { protocolVersion: "${APP_PROTOCOL}", appInfo: { name: "Leanfare plan", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] } })
    .then((r) => { theme(r && r.hostContext); notify("ui/notifications/initialized", {}); })
    .catch(() => notify("ui/notifications/initialized", {}));
})();
</script></body></html>`;
