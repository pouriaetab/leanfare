// The report inside Claude Desktop, Cowork and other apps that show MCP Apps (planapp.ts says how they work). The
// report tool names this page (ui://leanfare/report); it draws the tool's result: three tiles, tokens over time, the
// work by model and the last prompts, with spans to pick (each asks the report tool again) and a button that opens
// the full report in Leanfare. Apps that do not show pages (Claude Code) get the same report as text.
//
// One file, no outside scripts or fonts: the page talks only to the app it is shown in, with postMessage.
import { APP_PROTOCOL } from "./planapp";

export const REPORT_APP_URI = "ui://leanfare/report";

export const REPORT_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Leanfare report</title>
<style>
  :root { --bg: var(--color-background-primary, #ffffff); --fg: var(--color-text-primary, #1d2021); --muted: var(--color-text-secondary, #6b6f72);
    --line: var(--color-border-primary, #e3e5e6); --soft: var(--color-background-secondary, #f4f5f5); --accent: #0f766e;
    --s1: #2a78d6; --s2: #eb6834; --good: #22a35a; --warn: #eba129; --bad: #df4a3f; }
  :root[data-theme="dark"] { --bg: var(--color-background-primary, #1b1d1e); --fg: var(--color-text-primary, #eceeef); --muted: var(--color-text-secondary, #a3a8ab);
    --line: var(--color-border-primary, #33373a); --soft: var(--color-background-secondary, #24272a); --accent: #2dd4bf;
    --s1: #3987e5; --s2: #d95926; --good: #36b56c; --warn: #e3a032; --bad: #e8584e; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #app { padding: 10px 12px; display: grid; gap: 10px; }
  .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
  h1 { font-size: 15px; margin: 0; }
  .chips { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .chips button { font: inherit; font-size: 12.5px; border: 0; border-right: 1px solid var(--line); background: none; color: var(--fg); padding: 4px 10px; cursor: pointer; }
  .chips button:last-child { border-right: 0; }
  .chips button.on { background: var(--soft); font-weight: 600; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 8px; }
  .tile { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; min-width: 0; }
  .tile .l { color: var(--muted); font-size: 12px; }
  .tile .v { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .tile .s { color: var(--muted); font-size: 12px; }
  .box { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; min-width: 0; }
  .box h2 { font-size: 13px; margin: 0 0 6px; }
  .legend { display: flex; gap: 14px; color: var(--muted); font-size: 12px; }
  .legend span::before { content: ""; display: inline-block; width: 12px; height: 2px; margin-right: 5px; vertical-align: middle; }
  .legend .k1::before { background: var(--s1); } .legend .k2::before { background: var(--s2); }
  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: auto; }
  .chart .grid { stroke: var(--line); } .chart .tick { fill: var(--muted); font-size: 10.5px; }
  .chart .l1, .chart .l2 { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .chart .l1 { stroke: var(--s1); } .chart .l2 { stroke: var(--s2); } .chart .a1 { fill: var(--s1); opacity: .1; }
  .chart .cross { stroke: var(--muted); stroke-opacity: .5; }
  .tip { position: absolute; top: 2px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font-size: 12px; pointer-events: none; }
  .bar { display: grid; grid-template-columns: minmax(100px, 1.2fr) minmax(40px, 2fr) auto auto; gap: 8px; align-items: center; margin: 4px 0; }
  .bar .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .bar .n small { display: block; color: var(--muted); font-size: 11px; }
  .bar .t i { display: block; height: 11px; background: var(--s1); border-radius: 0 4px 4px 0; }
  .bar .v, .bar .q { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .dot.good { background: var(--good); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); } .dot.none { background: var(--line); }
  .p { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid var(--line); }
  .p:first-of-type { border-top: 0; }
  .p .w { color: var(--muted); white-space: nowrap; font-size: 12px; } .p .m { min-width: 0; } .p .k { color: var(--muted); white-space: nowrap; font-size: 12px; }
  .g { border-radius: 999px; padding: 1px 8px; font-size: 11.5px; white-space: nowrap; border: 1px solid var(--line); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button.go { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px; padding: 5px 11px; cursor: pointer; }
  .muted { color: var(--muted); } .bad { color: var(--bad); }
  @media (max-width: 480px) { .p { grid-template-columns: 1fr auto; } .p .w { grid-column: 1 / -1; } }
</style></head>
<body><div id="app"><p class="muted">Waiting for Leanfare's report…</p></div>
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
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const NS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) e.setAttribute(k, String(v)); for (const k of kids.flat(Infinity)) if (k) e.append(k instanceof Node ? k : document.createTextNode(String(k))); return e; };
  const usd = (v) => (v === null || v === undefined ? "—" : v === 0 ? "$0" : v < 0.01 ? "under $0.01" : "$" + v.toFixed(2));
  const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));
  const pct = (x) => (x === null || x === undefined ? "—" : Math.round(x * 100) + "%");
  const RANGES = [["1h", "1 h"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
  const WHERE = { local: "this computer", free: "free", plan: "ChatGPT plan", paid: "paid" };
  const GRADE = { good: "✓ good", partly: "~ partly", wrong: "× wrong" };
  let data = null, busy = false, err = null;

  function label(iso, step) {
    const d = new Date(iso);
    if (step < 86400000) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + d.getDate();
  }
  function when(iso, d) {
    const t = new Date(iso), long = Date.parse(d.to) - Date.parse(d.from) > 86400000;
    return long ? t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function chart(d) {
    const box = el("div", { class: "chart" });
    const W = 560, H = 150, L = 38, R = 8, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
    const s = d.series, n = s.length, known = d.tiles.own.measured > 0;
    let max = Math.max(1, ...s.map((p) => Math.max(p.kept, known ? p.used : 0)));
    const p10 = Math.pow(10, Math.floor(Math.log10(max))); max = [1, 2, 2.5, 5, 10].map((m) => m * p10).find((x) => x >= max);
    const x = (i) => L + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw), y = (v) => T + ph - (v / max) * ph;
    const line = (k) => s.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(p[k]).toFixed(1)).join("");
    const every = Math.max(1, Math.ceil(n / 4));
    const kids = [
      [0, 0.5, 1].map((f) => [svg("line", { x1: L, x2: L + pw, y1: y(max * f), y2: y(max * f), class: "grid" }), svg("text", { x: L - 5, y: y(max * f) + 3.5, "text-anchor": "end", class: "tick" }, tok(max * f))]),
      svg("path", { d: line("kept") + "L" + x(n - 1).toFixed(1) + "," + y(0) + "L" + x(0).toFixed(1) + "," + y(0) + "Z", class: "a1" }),
      known ? svg("path", { d: line("used"), class: "l2" }) : null,
      svg("path", { d: line("kept"), class: "l1" }),
      s.map((p, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2) ? svg("text", { x: x(i), y: H - 5, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", class: "tick" }, label(p.at, d.step)) : null),
    ];
    const cross = svg("line", { y1: T, y2: T + ph, class: "cross", visibility: "hidden" });
    const hit = svg("rect", { x: L, y: T, width: pw, height: ph, fill: "transparent" });
    const root = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Tokens over time" }, kids, cross, hit);
    const tip = el("div", { class: "tip", hidden: true });
    const point = (e) => {
      const r = root.getBoundingClientRect(), cx = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
      const i = Math.max(0, Math.min(n - 1, Math.round((((cx - r.left) * W) / (r.width || W) - L) / pw * (n - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      tip.textContent = label(s[i].at, d.step) + ": " + tok(s[i].kept) + " kept out" + (known ? ", " + tok(s[i].used) + " used" : "");
      tip.hidden = false; tip.style.left = Math.min(r.width - 200, Math.max(0, ((x(i) / W) * r.width) + 8)) + "px";
    };
    hit.addEventListener("mousemove", point);
    hit.addEventListener("touchstart", point, { passive: true });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
    box.append(root, tip);
    return box;
  }

  function draw() {
    const app = $("#app");
    if (!data) return;
    const d = data, t = d.tiles;
    const range = el("div", { class: "chips", role: "group", "aria-label": "Span" }, RANGES.map(([v, txt]) => el("button", { class: d.range === v ? "on" : "", text: txt, "aria-pressed": String(d.range === v), onclick: () => pick(v) })));
    const kids = [el("div", { class: "head" }, el("h1", { text: "Leanfare report" }), range)];
    if (err) kids.push(el("p", { class: "bad", text: err }));
    if (!d.prompts.length) kids.push(el("p", { class: "muted", text: "Nothing in this span yet. The work your apps hand to Leanfare shows here." }));
    else {
      const dot = (g) => (g === null || g === undefined ? "none" : g >= 0.8 ? "good" : g >= 0.5 ? "warn" : "bad");
      const max = Math.max(1, ...d.byModel.map((m) => m.read));
      kids.push(
        el("div", { class: "tiles" },
          el("div", { class: "tile" }, el("div", { class: "l", text: "Kept out" }), el("div", { class: "v", text: tok(t.kept.tokens) }), el("div", { class: "s", text: t.kept.share !== null ? pct(t.kept.share) + " of your apps' use where it is known" : "read by Leanfare's models, not your apps" })),
          el("div", { class: "tile" }, el("div", { class: "l", text: "Cost" }), el("div", { class: "v", text: usd(t.cost.usd) }), el("div", { class: "s", text: pct(t.cost.freeShare) + " free or on this computer" })),
          el("div", { class: "tile" }, el("div", { class: "l", text: "Quality" }), el("div", { class: "v", text: t.quality.graded ? pct(t.quality.goodShare) + " good" : "not graded" }), el("div", { class: "s", text: t.quality.blind ? t.quality.blind + " judged blind" : "graded by your app" }))),
        el("div", { class: "box" }, el("div", { class: "legend" }, el("span", { class: "k1", text: "Kept out" }), t.own.measured ? el("span", { class: "k2", text: "Used by your apps (measured)" }) : null), chart(d)),
        el("div", { class: "box" }, el("h2", { text: "Work by model" }), d.byModel.map((m) => el("div", { class: "bar" },
          el("span", { class: "n" }, m.label, el("small", { text: m.where === "paid" ? usd(m.cost) : WHERE[m.where] })),
          el("span", { class: "t" }, el("i", { style: "width:" + Math.max(2, (m.read / max) * 100) + "%" })),
          el("span", { class: "v", text: tok(m.read) + " · " + m.parts + (m.parts === 1 ? " part" : " parts") }),
          el("span", { class: "q" }, el("i", { class: "dot " + dot(m.goodShare) }), m.goodShare === null ? "not graded" : pct(m.goodShare) + " good")))),
        el("div", { class: "box" }, el("h2", { text: "Last prompts" }), d.prompts.map((p) => el("div", { class: "p" },
          el("span", { class: "w" }, p.id ? el("b", { text: p.id + " " }) : null, when(p.ts, d)),
          el("span", { class: "m", text: p.app + (p.model ? " · " + p.model : "") + (p.plan ? " · " + p.plan : "") + (p.parts.length ? " → " + p.parts.join(", ") : "") }),
          el("span", { class: "k", text: tok(p.kept) + " kept" + (p.saved !== null ? " · " + pct(p.saved) : "") }),
          p.grade ? el("span", { class: "g", text: GRADE[p.grade] }) : el("span", { class: "muted", text: "—" })))));
    }
    kids.push(el("div", { class: "row" }, d.open_url ? el("button", { class: "go", onclick: openFull, text: "Open the full report in Leanfare" }) : null,
      el("span", { class: "muted", text: busy ? "Reading…" : "Numbers only: never your words." })));
    app.replaceChildren(...kids);
    size();
  }
  async function pick(range) {
    if (busy) return;
    busy = true; err = null; draw();
    try { const r = await request("tools/call", { name: "report", arguments: data && data.app ? { range, app: data.app } : { range } }); if (r && r.structuredContent && r.structuredContent.tiles) data = r.structuredContent; else err = (r && r.content && r.content[0] && r.content[0].text) || "No report."; }
    catch (e) { err = "Leanfare: " + (e && e.message ? e.message : String(e)); }
    busy = false; draw();
  }
  async function openFull() { try { await request("ui/open-link", { url: data.open_url }); } catch (e) { err = "Open " + data.open_url + " in your browser."; draw(); } }
  function size() { notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }); }
  function theme(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") for (const [k, v] of Object.entries(vars)) if (/^--[\\w-]+$/.test(k) && typeof v === "string") document.documentElement.style.setProperty(k, v);
  }
  function show(result) {
    const sc = result && result.structuredContent;
    if (!sc || !sc.tiles) { $("#app").replaceChildren(el("p", { class: "muted", text: (result && result.content && result.content[0] && result.content[0].text) || "No report to show." })); size(); return; }
    data = sc; draw();
  }
  window.addEventListener("message", (e) => {
    if (e.source !== host) return; // only the app this page is shown in
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(m.error); else p.resolve(m.result); return; }
    if (m.method === "ui/notifications/tool-result") show(m.params);
    else if (m.method === "ui/notifications/host-context-changed") theme(m.params);
    else if (m.method === "ui/resource-teardown" && m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  request("ui/initialize", { protocolVersion: "${APP_PROTOCOL}", appInfo: { name: "Leanfare report", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] } })
    .then((r) => { theme(r && r.hostContext); notify("ui/notifications/initialized", {}); })
    .catch(() => notify("ui/notifications/initialized", {}));
})();
</script></body></html>`;
