// The plan inside Claude Desktop, Cowork and other apps that show MCP Apps (an MCP extension, 26
// Jan 2026: a tool's result drawn as a small page inside the chat). The plan tool names this page
// (ui://leanfare/plan). Since 0.13 Leanfare starts its parts by itself and Claude collects and grades
// the answers, so the page has no buttons: it draws the table from the tool's result and follows the
// run with plan_status (peek: it only looks), each part from waiting to running, done, with Claude and
// checked, and says in one line where the whole plan is. Apps that do not show pages (Claude Code) get
// the same table as text.
//
// One file, no outside scripts or fonts: the page talks to the app it is shown in with postMessage
// (JSON-RPC: ui/initialize, ui/notifications/tool-result, tools/call), and only with it.
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
  .state { margin: 0 0 8px; display: flex; gap: 7px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
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
  const share = (t) => (t.kept > 0 ? " (" + (t.used ? Math.max(1, Math.min(99, Math.round((t.kept / (t.kept + t.used)) * 100))) + "%" : "all") + " of the parts' tokens)" : "");
  const secs = (s) => (s === null || s === undefined ? "" : s < 90 ? "~" + Math.max(1, Math.round(s)) + " s" : "~" + Math.round(s / 60) + " min");
  const RUNS = { you: "you", local: "Leanfare, this computer", free: "Leanfare, free", paid: "Leanfare, pay per use", codex: "Leanfare, through Codex" };
  const NOW = { waiting: "waiting", running: "running…", done: "done", failed: "failed", stopped: "stopped", yours: "yours", after_yours: "after yours", blocked: "waits", asks: "waits for a yes" };
  // A part in words: what the run says, then whether Claude has its answer and how Claude graded it.
  const nowOf = (r) => (!r ? "" : r.verdict ? "checked: " + r.verdict : r.took && r.status === "done" ? "with Claude" : NOW[r.status] || r.status || "");
  const nowClass = (r) => (!r ? "" : r.verdict === "good" || (!r.verdict && r.status === "done") ? "done" : r.verdict === "wrong" || ["failed", "blocked", "asks"].includes(r.status) ? "bad" : "");
  const count = (n) => (n === 1 ? "1 part" : n + " parts");
  let plan = null, run = null, timer = null, watch = null, until = 0;
  // When every part stays with you: what would send some out (as the planner says it).
  const nothingOut = (parts) => {
    const hints = [parts.some((p) => p.kind === "search" && p.runs_on === "you") ? "tick Perplexity Sonar in Leanfare and the searches go out" : "",
      parts.every((p) => !(p.files || []).length) ? "name the files or folder it is about and the reading goes out" : ""].filter(Boolean);
    return "Nothing goes to Leanfare: " + (hints.length ? hints.join("; ") : "every part changes the project or needs the hardest judgement") + ".";
  };
  // Where the whole plan is, in one line: nothing here waits for a press.
  function stateOf() {
    const mine = plan.parts.filter((p) => p.runs_on !== "you");
    if (!mine.length) return { text: nothingOut(plan.parts), cls: "muted" };
    if (!run) return { text: "Leanfare has not started its parts.", cls: "muted" };
    const of = (n) => run.parts.find((r) => r.n === n) || {};
    const ours = mine.map((p) => of(p.n));
    const going = ours.filter((r) => r.status === "running" || r.status === "waiting");
    const answered = ours.filter((r) => r.answer);
    if (going.length) return { text: "Leanfare is running " + count(going.length) + " by itself. Claude collects the answers.", cls: "", live: true };
    if (answered.length && answered.every((r) => r.verdict)) {
      const by = {};
      for (const r of answered) by[r.verdict] = (by[r.verdict] || 0) + 1;
      return { text: "Done: Claude checked every answer (" + ["good", "partly", "wrong"].filter((k) => by[k]).map((k) => by[k] + " " + k).join(", ") + ").", cls: "done" };
    }
    if (answered.length && answered.every((r) => r.took)) return { text: "Claude has every answer and is checking them.", cls: "" };
    if (answered.length) return { text: "Leanfare's parts are done. Claude picks up their answers next.", cls: "" };
    if (ours.some((r) => r.status === "failed")) return { text: "Leanfare's parts ended without an answer: Claude does them itself.", cls: "bad" };
    return { text: "Leanfare's parts have ended.", cls: "muted" };
  }

  function draw() {
    const app = $("#app");
    if (!plan) return;
    // Who a part that stays with you runs on: the app's own plan, when Settings names it.
    const youText = (pl) => (pl.you && pl.you.plan ? "you (on your " + pl.you.plan.replace(/ plan$/i, "") + " plan)" : RUNS.you || "you");
    const st = (n) => (run ? run.parts.find((p) => p.n === n) : null);
    const byN = (n) => plan.parts.find((q) => q.n === n) || {};
    const laterOf = (p, seen = 0) => seen < 50 && p.needs.some((n) => byN(n).runs_on === "you" || (byN(n).needs && laterOf(byN(n), seen + 1))); // it waits for one of yours, through its needs
    const rows = plan.parts.map((p) => el("tr", { class: p.runs_on === "you" ? "you" : "" },
      el("td", { class: "n", text: p.n }),
      el("td", {}, el("b", { text: p.title }), el("div", { class: "why", text: p.kind + ", " + p.effort + (p.needs.length ? " · after " + p.needs.join(", ") : "") })),
      el("td", { "data-l": "Runs on", text: (p.runs_on === "you" ? youText(plan) : RUNS[p.runs_on] || p.runs_on) + (p.risk ? " (" + p.risk + ")" : "") }),
      el("td", { "data-l": "Model", text: p.model_label || (p.runs_on === "you" ? (plan.you && plan.you.label) || (p.your_model && p.your_model.label) || "your model" : p.model || "") }),
      el("td", { class: "t", "data-l": "Time", text: secs(p.seconds) }),
      el("td", { "data-l": "Tokens", text: "~" + tok(p.tokens) + (p.runs_on === "you" ? " of your plan" : " kept") }),
      el("td", { class: "c", "data-l": "Cost", text: p.runs_on === "you" ? "in your plan" : p.runs_on === "codex" ? "in your ChatGPT plan" : usd(p.cost_usd) }),
      run ? el("td", { class: "s " + nowClass(st(p.n)), "data-l": "Now", text: nowOf(st(p.n)) }) : null));
    const t = plan.totals;
    const mine = plan.parts.filter((p) => p.runs_on !== "you").length;
    const later = plan.parts.filter((p) => p.runs_on !== "you" && laterOf(p)).map((p) => p.n);
    const state = stateOf();
    const kids = [
      el("h1", {}, "Leanfare's plan", el("small", { text: mine + " of " + plan.parts.length + " parts to Leanfare" })),
      el("p", { class: "state " + state.cls, id: "state" }, state.live ? el("span", { class: "dot" }) : null, state.text),
      el("table", {}, el("thead", {}, el("tr", {}, ...["#", "Part", "Runs on", "Model", "Time", "Tokens", "Cost", ...(run ? ["Now"] : [])].map((x) => el("th", { text: x })))), el("tbody", {}, ...rows)),
      mine ? el("p", { class: "sum", text: "About " + tok(t.kept) + " tokens stay out of your plan" + share(t) + (t.used ? " and about " + tok(t.used) + " stay in it" : "") + ": " + (t.guessed ? "a guess, as no files were named for the reading" : "an estimate until the parts end") + ". Pay per use: " + usd(t.cost) + "." }) : null,
      plan.local ? el("p", { class: "muted", text: "A local model fits this computer: " + plan.local.name + " (" + (plan.local.size / 1e9).toFixed(plan.local.size < 10e9 ? 1 : 0) + " GB), rated like " + plan.local.like + ", free to run. Ask for it to be downloaded (Leanfare's local_model asks you first)." }) : null,
    ].filter(Boolean); // replaceChildren would print a left out part as the word null
    if (run && run.asks) kids.push(el("p", { class: "bad", text: (run.asks.parts.length === 1 ? "Part " + run.asks.parts[0] + " is" : "Parts " + run.asks.parts.join(", ") + " are") + " paid (" + (run.asks.estimate === null || run.asks.estimate === undefined ? "cost not known" : "about " + usd(run.asks.estimate)) + ") and wait" + (run.asks.parts.length === 1 ? "s" : "") + " for your yes: Claude asks you in the chat." }));
    if (later.length) kids.push(el("p", { class: "muted", text: (later.length === 1 ? "Part " + later[0] + " waits" : "Parts " + later.join(", ") + " wait") + " for yours: once yours are done, Claude hands " + (later.length === 1 ? "it" : "them") + " to Leanfare." }));
    if (run) for (const p of run.parts.filter((x) => x.answer || x.error)) kids.push(el("details", {}, el("summary", { text: "Part " + p.n + " · " + p.title + " · " + nowOf(p) + (p.model ? " · " + p.model : "") }), p.answer ? el("pre", { text: p.answer }) : null, p.error ? el("p", { class: "bad", text: p.error }) : null));
    app.replaceChildren(...kids);
    size();
  }
  // Follows the run with plan_status, which only looks (peek): every 2 seconds while parts run, then every 4 for up to
  // 5 minutes while Claude takes and grades the answers, until every answer is graded.
  async function follow() {
    clearTimeout(timer);
    try {
      const r = await request("tools/call", { name: "plan_status", arguments: { id: plan.id, peek: true } });
      const sc = r && !r.isError && r.structuredContent;
      if (sc && Array.isArray(sc.parts)) { run = sc; draw(); }
    } catch (e) {} // the next look tries again
    if (!run) return;
    if (run.running) { timer = setTimeout(follow, 2000); return; }
    if (run.parts.some((p) => p.answer && !p.verdict) && Date.now() < until) timer = setTimeout(follow, 4000);
  }
  // A plan that came without a run (made with run false, or by an older Leanfare): it looks for one Claude starts
  // later, a few seconds after the plan arrives, then every 3 seconds for a minute.
  async function look(tries) {
    clearTimeout(watch);
    if (run || !plan) return;
    try {
      const r = await request("tools/call", { name: "plan_status", arguments: { id: plan.id, peek: true } });
      const sc = r && !r.isError && r.structuredContent;
      if (sc && Array.isArray(sc.parts)) { run = sc; until = Date.now() + 300000; draw(); follow(); return; }
    } catch (e) {} // no run of it yet
    if (tries > 0 && !run) watch = setTimeout(() => look(tries - 1), 3000);
  }
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
    plan = sc; run = sc.run && Array.isArray(sc.run.parts) ? { ...sc.run, cost: sc.run.cost_usd } : null; until = Date.now() + 300000;
    draw();
    clearTimeout(timer); clearTimeout(watch);
    if (run) timer = setTimeout(follow, 1500); else watch = setTimeout(() => look(20), 2500);
  }
  window.addEventListener("message", (e) => {
    if (e.source !== host) return; // only the app this page is shown in
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(m.error); else p.resolve(m.result); return; }
    if (m.method === "ui/notifications/tool-result") show(m.params);
    else if (m.method === "ui/notifications/host-context-changed") theme(m.params);
    else if (m.method === "ui/resource-teardown" && m.id !== undefined) { clearTimeout(timer); clearTimeout(watch); send({ jsonrpc: "2.0", id: m.id, result: {} }); }
  });
  request("ui/initialize", { protocolVersion: "${APP_PROTOCOL}", appInfo: { name: "Leanfare plan", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] } })
    .then((r) => { theme(r && r.hostContext); notify("ui/notifications/initialized", {}); })
    .catch(() => notify("ui/notifications/initialized", {}));
})();
</script></body></html>`;
