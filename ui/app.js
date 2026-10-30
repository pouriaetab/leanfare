// Leanfare's screens. Plain JavaScript, no libraries, nothing loaded from the
// internet. Every value on screen comes from the local server (/api/...), so
// an action shows up everywhere at once and survives a reload.
"use strict";
(() => {
  // ---- small helpers ---------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("leanfare." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("leanfare." + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("leanfare." + k); } catch {} },
  };

  // append() and replaceChildren() print null as the word "null". Leave out
  // empty parts everywhere at once instead of at each call.
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const keep = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
    const { append, replaceChildren } = proto;
    proto.append = function (...xs) { return append.apply(this, keep(xs)); };
    proto.replaceChildren = function (...xs) { return replaceChildren.apply(this, keep(xs)); };
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "style") Object.assign(el.style, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function money(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (v === 0) return "$0";
    const a = Math.abs(v), sign = v < 0 ? "−" : "";
    if (a < 0.0001) return sign + "<$0.0001";
    if (a < 0.01) return sign + "$" + a.toPrecision(2);
    if (a < 1) return sign + "$" + a.toFixed(3);
    if (a < 1000) return sign + "$" + a.toFixed(2);
    return sign + "$" + Math.round(a).toLocaleString("en-US");
  }
  const money8 = (v) => (v === null || v === undefined ? "unknown" : "$" + v.toFixed(8));
  const perM = (v) => (v === null || v === undefined ? "—" : v === 0 ? "$0" : "$" + (v < 0.1 ? Number(v.toPrecision(2)) : Number(v.toFixed(2))));
  const tok = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n ?? 0));
  const secs = (ms) => (ms === null || ms === undefined ? "" : ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s");
  const num = (n) => Number(n ?? 0).toLocaleString("en-US");
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(s)) return "";
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  const dayLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const isPhone = () => matchMedia("(max-width: 760px)").matches;

  // ---- files attached to a message ------------------------------------------------------
  // The same rules as the server (src/files.ts); checked here first so a wrong
  // file is refused before it is read.
  const FILE_MAX = { image: 5 * 1048576, pdf: 20 * 1048576, text: 1048576, count: 10 };
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|cfg|conf|log|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|r|scala|lua|pl|dart|vue|svelte|tex|rst|env)$/i;
  function fileKind(type, name) {
    const t = (type || "").toLowerCase();
    if (/^image\/(png|jpeg|webp|gif|heic|heif)$/.test(t) || /\.(heic|heif)$/i.test(name)) return "image";
    if (t === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
    if (t.startsWith("text/") || /^application\/(json|ld\+json|xml|x-yaml|yaml|toml|javascript|typescript|x-sh|sql)/.test(t) || TEXT_EXT.test(name) || /^(Dockerfile|Makefile|README|LICENSE)$/i.test(name)) return "text";
    return null;
  }
  const mbs = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const KIND_WORD = { image: "an image", pdf: "a PDF", text: "a text file" };
  const readAsBase64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error ?? new Error("could not read the file")); r.readAsDataURL(blob); });
  // Big photos are made smaller before they leave: at most 2,048 pixels on the
  // long side, as JPEG. Providers shrink them anyway and charge by size.
  async function shrinkImage(file) {
    const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
    const keep = !heic && file.size <= 1.5 * 1048576 && /^image\/(png|jpeg|webp|gif)$/.test(file.type);
    let bmp = null;
    try { bmp = await createImageBitmap(file); } catch { if (keep) return { blob: file, type: file.type }; throw new Error(`${file.name}: this browser cannot open ${heic ? "HEIC photos; save it as JPEG first" : "this image"}.`); }
    const long = Math.max(bmp.width, bmp.height);
    if (keep && long <= 2048) { bmp.close?.(); return { blob: file, type: file.type }; }
    const scale = Math.min(1, 2048 / long);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // JPEG has no transparency
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) throw new Error(`${file.name}: could not make the image smaller.`);
    return { blob, type: "image/jpeg" };
  }
  function pdfPagesOf(b64) {
    try { return Math.max(1, (atob(b64).match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length); } catch { return 1; }
  }
  async function readAttachment(file) {
    const kind = fileKind(file.type, file.name);
    if (!kind) throw new Error(`${file.name}: Leanfare takes images (PNG, JPEG, WebP, GIF, HEIC), PDFs and text files.`);
    let blob = file, type = file.type || (kind === "text" ? "text/plain" : "");
    if (kind === "image") ({ blob, type } = await shrinkImage(file));
    if (blob.size > FILE_MAX[kind]) throw new Error(`${file.name} is ${mbs(blob.size)}; the most for ${KIND_WORD[kind]} is ${mbs(FILE_MAX[kind])}.`);
    const data = await readAsBase64(blob);
    const name = kind === "image" && type === "image/jpeg" && !/\.jpe?g$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, "") + ".jpg" : file.name;
    const a = { name, type: kind === "pdf" ? "application/pdf" : type, kind, size: blob.size, data };
    if (kind === "pdf") a.pages = pdfPagesOf(data);
    if (kind === "image") a.url = `data:${type};base64,${data}`;
    return a;
  }
  // A file as the server is sent it: by id once it is kept, otherwise with its contents.
  const fileForSend = (f) => (f.id ? { id: f.id, name: f.name } : { name: f.name, type: f.type, data: f.data });
  const fileForEstimate = (f) => ({ kind: f.kind, pages: f.pages ?? null, size: f.size });
  const fileLabel = (f) => `${f.name} · ${f.kind === "pdf" ? `${f.pages ?? "?"} page${f.pages === 1 ? "" : "s"} · ` : ""}${mbs(f.size)}`;
  // A kept image is read back once for its picture (the page asks with its header; an <img> cannot).
  const thumbCache = new Map();
  async function thumbOf(f) {
    if (f.url) return f.url;
    if (!f.id) return null;
    if (!thumbCache.has(f.id)) thumbCache.set(f.id, api(`/api/files/${f.id}`).then((r) => `data:${r.type};base64,${r.data}`).catch(() => null));
    return thumbCache.get(f.id);
  }
  function fileChips(files, onRemove = null) {
    return h("div", { class: "files" }, ...files.map((f, i) => {
      const chip = h("span", { class: "file " + f.kind, title: fileLabel(f) });
      if (f.kind === "image") {
        const img = h("img", { alt: f.name });
        thumbOf(f).then((u) => { if (u) img.src = u; });
        img.addEventListener("click", () => { thumbOf(f).then((u) => u && showImage(u, f.name)); });
        chip.append(img);
      } else chip.append(h("span", { class: "ico", text: f.kind === "pdf" ? "PDF" : "TXT" }));
      chip.append(h("span", { class: "fn", text: f.name }), h("span", { class: "fs", text: f.kind === "pdf" ? `${f.pages ?? "?"} p` : mbs(f.size) }));
      if (onRemove) chip.append(h("button", { type: "button", class: "x", "aria-label": `Remove ${f.name}`, text: "✕", onclick: () => onRemove(i) }));
      return chip;
    }));
  }
  function showImage(src, name) {
    const box = h("div", { class: "lightbox", role: "dialog", "aria-label": name, onclick: () => box.remove() }, h("img", { src, alt: name }));
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { box.remove(); document.removeEventListener("keydown", esc); } });
    document.body.append(box);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: { "x-leanfare": "1", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const err = new Error((j && (j.error?.message ?? j.error)) || text || `HTTP ${res.status}`);
      if (res.status === 401 && j?.locked && path !== "/api/unlock") { err.locked = true; renderLocked(); }
      throw err;
    }
    return j;
  }

  // A locked Leanfare (Settings: Other apps need a key) asks a browser without its
  // sign in for the key. In the Mac app, the app opens itself again, unlocked.
  function renderLocked() {
    if (document.getElementById("lockScreen")) return;
    const mac = window.webkit?.messageHandlers?.leanfareLocked;
    if (mac) { try { mac.postMessage({}); } catch {} }
    const input = h("input", { type: "password", placeholder: "lf-…", autocomplete: "off", "aria-label": "Access key" });
    const go = async () => {
      try { await api("/api/unlock", { body: { key: input.value } }); location.reload(); }
      catch (e) { failed(e); input.select(); }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    document.body.append(h("div", { id: "lockScreen", class: "lock" }, h("div", { class: "lock-card" },
      h("h2", { text: "Leanfare is locked" }),
      h("p", { text: mac ? "The lock is on (Settings: Other apps need a key), so Leanfare is opening again with its own sign in. If this stays, paste the access key here." : "Leanfare is set to ask for its access key (Settings: Other apps need a key). Paste the key to open Leanfare in this browser. The Mac app and the leanfare command in Terminal open it without the key." }),
      h("div", { class: "row" }, input, h("button", { class: "btn primary", type: "button", text: "Unlock", onclick: go })))));
    input.focus();
  }

  // ---- toasts: in progress, done (clears itself), failed (stays) ----------
  function toast(text, kind = "progress", opts = {}) {
    const box = $("#toasts");
    const el = h("div", { class: "toast " + kind, role: kind === "error" ? "alert" : "status" });
    let timer = null;
    const t = {
      set(nextText, nextKind = kind, nextOpts = {}) {
        kind = nextKind;
        el.className = "toast " + kind;
        el.replaceChildren(
          kind === "progress" ? h("span", { class: "spin" }) : null,
          h("span", { class: "grow", text: nextText }),
          nextOpts.action ? h("button", { text: nextOpts.action.label, onclick: () => { nextOpts.action.run(); if (!nextOpts.action.keep) t.close(); } }) : null,
          kind !== "progress" ? h("button", { class: "x", "aria-label": "Close", text: "✕", onclick: () => t.close() }) : null,
        );
        clearTimeout(timer);
        if (kind === "done") timer = setTimeout(() => t.close(), nextOpts.action ? 8000 : 3500);
        return t;
      },
      close() { clearTimeout(timer); el.remove(); },
    };
    box.append(el);
    return t.set(text, kind, opts);
  }
  const failed = (e) => toast(String(e?.message ?? e), "error");
  const secondsText = (x) => (x < 1.5 ? "about a second" : x < 90 ? `about ${Math.round(x)} s` : `about ${Math.round(x / 60)} min`);
  // Speed at the same quality (Settings and the composer): the value, its Settings label, its composer label.
  const SPEEDS = [["cheapest", "The cheapest, however long it takes", "Speed: cheapest"], ["balanced", "A balance of time and cost", "Speed: balanced"], [60, "The cheapest within about a minute", "Speed: within 1 min"],
    [20, "The cheapest within about 20 seconds", "Speed: within 20 s"], [5, "The cheapest within about 5 seconds", "Speed: within 5 s"], ["fastest", "The fastest, whatever it costs", "Speed: fastest"]];
  const speedValue = (v) => (/^\d+$/.test(v) ? Number(v) : v);
  const speedOptions = (cur, col) => [...SPEEDS.map((x) => h("option", { value: String(x[0]), selected: x[0] === cur, text: x[col] })),
    SPEEDS.some((x) => x[0] === cur) ? null : h("option", { value: String(cur), selected: true, text: col === 1 ? `The cheapest within ${cur} seconds` : `Speed: within ${cur} s` })];

  // The button that starts work becomes its Stop while it runs, and goes back to
  // its own label after. `work` receives an AbortSignal. While any
  // runs, background redraws wait, so the Stop stays where it is.
  let running = 0;
  function runButton(label, work, cls = "btn") {
    const btn = h("button", { class: cls, type: "button", "data-run": "1", text: label });
    let ac = null, startedAt = 0;
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (ac) { if (ev.detail > 1 || Date.now() - startedAt < 500) return; ac.abort(); return; } // the second click of a double click is not a Stop
      ac = new AbortController();
      startedAt = Date.now();
      running++;
      btn.textContent = "Stop";
      btn.classList.add("stop");
      try { await work(ac.signal); }
      catch (e) { if (e?.name !== "AbortError") failed(e); else toast("Stopped.", "done"); }
      finally { ac = null; running--; btn.textContent = label; btn.classList.remove("stop"); }
    });
    return btn;
  }
  // A background redraw of a screen waits while you are typing in it or while
  // one of its buttons is running; it happens on the next quiet moment.
  const busyIn = (el) => running > 0 || (!!el && el.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName));

  // ---- markdown, escaped first, so nothing a model writes can run as code ------------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function inline(raw) {
    const codes = [];
    let s = raw.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)] ?? "")}</code>`);
  }
  function blocks(text) {
    const lines = text.split("\n");
    const out = [];
    let i = 0;
    const para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para.length = 0; } };
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { flush(); i++; continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); const n = Math.min(4, m[1].length); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
      if (/^\s*>/.test(line)) {
        flush(); const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${blocks(q.join("\n"))}</blockquote>`); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        const head = row(line); i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        flush();
        const ordered = /\d/.test(m[2]);
        const items = [];
        while (i < lines.length) {
          const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (mm && /\d/.test(mm[2]) === ordered) { items.push(mm[3]); i++; }
          else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += "\n" + lines[i].trim(); i++; }
          else break;
        }
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${t.split("\n").map(inline).join("<br>")}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      para.push(line); i++;
    }
    flush();
    return out.join("");
  }
  function markdown(src) {
    const parts = String(src).replace(/\u0000/g, "").split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
    return parts.map((p) => {
      const m = /^```([^\n]*)\n([\s\S]*?)(?:```)?$/.exec(p);
      if (m) return `<pre><button class="copy" type="button">Copy</button><code>${esc(m[2].replace(/\n$/, ""))}</code></pre>`;
      return blocks(p);
    }).join("");
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("pre .copy");
    if (!b) return;
    const code = b.parentElement.querySelector("code")?.textContent ?? "";
    navigator.clipboard?.writeText(code).then(() => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); }, () => failed("Could not copy."));
  });

  // ---- state --------------------------------------------------------------------------
  // The screens with a tab; Set up has none (the first run, or Settings, In your apps).
  const SCREEN = (t) => (["chat", "plan", "savings", "settings"].includes(t) ? t : null);
  const S = {
    st: null,
    // #report (the report tool's link): Savings, where the report is; else the screen used last (null: decided at the start).
    tab: location.hash === "#report" ? "savings" : isPhone() ? null : SCREEN(store.get("screen", null)),
    chatId: store.get("chat", null),
    messages: [],
    chats: [],
    history: true,
    live: null, // the answer being written
    savings: null,
    plans: null, // Your plans: the month's Claude Code and Codex use, from /api/plans
    month: null,
    open: store.get("open", {}),
    showAll: {},
    defOpen: {},
    model: store.get("model", "auto"),
    estimateSeq: 0,
    system: null, // the open chat's instructions (a new chat starts with the default from Settings)
    sysOpen: false,
    pending: [], // files attached to the message being written
    editing: null, // the index of the question being edited
    search: null, // { q, results } while searching chats
    local: null, // what Ollama has (Settings, Local models), from /api/local
    confirmRemove: null, // the local model whose Remove is waiting for a yes
    found: null, // Find my keys: { keys, picked } while its list is open
    apps: null, // Use Leanfare in your apps: each AI app on this computer and whether Leanfare's tools are in it
    showAllApps: false,
    registry: null, // Add a provider: models.dev's list of providers that speak OpenAI's format
    setup: null, // Set up: the apps and models on this computer, from /api/setup
    afterSetup: null, // what each app needs after Set up (a restart), shown at the top until Done
  };
  const ready = () => S.st && S.st.usableCount > 0;
  const modelsOf = (pid) => (S.st?.models?.[pid] ?? []);
  const findModel = (id) => { for (const list of Object.values(S.st?.models ?? {})) { const m = list.find((x) => x.id === id); if (m) return m; } return null; };

  async function refreshState() {
    try {
      const st = await api("/api/state");
      // Timestamps of background checks change every few seconds without changing anything you see.
      const calm = (x) => (x ? JSON.stringify({ ...x, running: x.running.length, month: null, pause: null, providers: x.providers.map((p) => ({ ...p, list: p.list ? { ...p.list, at: null } : null })), data: { ...x.data, status: { ...x.data.status, at: null } } }) : "");
      const changed = calm(st) !== calm(S.st) || S.redrawLater;
      const before = S.st?.settings.instructions ?? "";
      S.st = st;
      followDefault(before);
      renderShell();
      if (st.local?.pull?.active) ensurePoll(); // a download started before this page opened
      if (S.tab === "settings") loadLocal();
      if (!changed) return;
      const screen = $("#tab-" + S.tab);
      if (busyIn(screen) && S.tab !== "chat") { S.redrawLater = true; return; }
      S.redrawLater = false;
      if (S.tab === "settings") { renderSettings(); loadPlatforms(); } // a key or a provider changed: so may where work can go
      if (S.tab === "chat") { renderComposerBar(); if (!S.messages.length && !busyIn($("#messages"))) renderMessages(); }
    } catch (e) {
      if (!e?.locked) renderOffline(e);
    }
  }

  // Redraw a part of the screen without losing what is typed in its boxes.
  function keepInputs(container, draw) {
    const kept = {};
    let focused = null;
    const sel = "input[data-keep], textarea[data-keep], select[data-keep]";
    // A box changed from what it was drawn with (a select keeps that in data-start).
    const changed = (i) => (i.tagName === "SELECT" ? i.value !== (i.dataset.start ?? "") : i.value !== i.defaultValue);
    container?.querySelectorAll(sel).forEach((i) => { if (changed(i)) kept[i.dataset.keep] = i.value; if (document.activeElement === i) focused = i.dataset.keep; });
    draw();
    container?.querySelectorAll(sel).forEach((i) => { if (i.dataset.keep in kept) i.value = kept[i.dataset.keep]; if (focused === i.dataset.keep) i.focus(); });
  }

  function renderOffline(e) {
    const n = $("#notices");
    n.replaceChildren(h("div", { class: "notice error" }, h("span", { class: "grow", text: `Leanfare is not answering at ${location.origin}. If you stopped it, start it again in Terminal with: leanfare` }), h("button", { class: "btn small", text: "Try again", onclick: refreshState })));
  }

  // ---- header, notices --------------------------------------------------------------------
  function renderShell() {
    const st = S.st;
    if (!st) return;
    $("#app").classList.toggle("simple", !S.tab || S.tab === "setup"); // no tabs before the first screen is picked, nor on Set up
    // The switch at the top: Leanfare on or off in your apps (switch.ts).
    const on = st.switchOn !== false;
    const sw = $("#appsSwitch");
    sw.setAttribute("aria-checked", String(on));
    sw.title = on ? "Leanfare is on in your apps: they hand simple work to it. Press to turn it off." : "Leanfare is off in your apps: they do all the work themselves. Press to turn it on.";
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + S.tab));
    const sp = $("#spendPill");
    const b = st.budget;
    sp.className = "pill" + (b.reached ? " bad" : b.warn ? " warn" : "");
    sp.replaceChildren(h("strong", { text: money(st.month.spent) }), " this month",
      b.budget !== null ? h("span", { class: "bar", title: `${Math.floor(b.pct)}% of your $${b.budget.toFixed(2)} budget` }, h("i", { style: { width: Math.min(100, b.pct) + "%" } })) : null);
    const rp = $("#runningPill");
    rp.hidden = !st.running.length;
    if (st.running.length) {
      rp.replaceChildren(h("span", { class: "spin" }), h("span", { class: "lbl", text: `${st.running.length} running` }),
        h("button", { text: "Stop", title: "Stop every answer that is running now, from the chat and from your other apps", onclick: async () => { try { S.st = await api("/api/running/stop", { body: {} }); renderShell(); toast("Stopped what was running.", "done"); } catch (e) { failed(e); } } }));
      rp.title = st.running.map((r) => `${r.label} (${r.source}, ${r.seconds} s)`).join("\n");
    }
    const pb = $("#pauseBtn");
    pb.textContent = st.pause.paused ? "Start again" : "Pause";
    pb.className = "btn" + (st.pause.paused ? " amber" : "");
    const n = $("#notices");
    const list = [];
    if (!on) list.push(h("div", { class: "notice warn" }, h("span", { class: "grow", text: "Leanfare is off in your apps: they do all the work themselves until you turn it on." }), h("button", { class: "btn small", text: "Turn on", onclick: () => toggleAppsSwitch(true) })));
    // After Set up: the one step each app needs (each says its app's name), until Done.
    if (S.afterSetup?.length) list.push(h("div", { class: "notice next" },
      h("div", { class: "grow" }, h("b", { text: "One last step" }), ...S.afterSetup.flatMap((x) => [h("div", { text: x.after }), x.note ? h("div", { class: "warn-text", text: x.note }) : null])),
      h("button", { class: "btn small", text: "Done", onclick: () => { S.afterSetup = null; renderShell(); } })));
    if (st.pause.paused) list.push(h("div", { class: "notice warn" }, h("span", { class: "grow", text: `Paused. New requests wait until you press Start again${st.pause.waiting ? ` (${st.pause.waiting} waiting now)` : ""}. Answers already running finish.` }), h("button", { class: "btn small", text: "Start again", onclick: togglePause })));
    for (const x of st.notices) {
      list.push(h("div", { class: "notice " + x.level }, h("span", { class: "grow", text: x.text }),
        x.kind === "retire" ? h("button", { class: "btn small", text: "Settings", onclick: () => setTab("settings") }) : null,
        x.kind === "budget" ? h("button", { class: "btn small", text: "Budget", onclick: () => setTab("settings") }) : null,
        x.kind === "update" && x.url ? h("a", { class: "btn small", href: x.url, target: "_blank", rel: "noopener noreferrer", text: "What changed" }) : null));
    }
    // Drawn again only when what they say changes, so a button is never rebuilt under your finger.
    const key = list.map((x) => x.textContent).join("|");
    if (n.dataset.key !== key) { n.dataset.key = key; n.replaceChildren(...list); }
  }

  async function togglePause() {
    const next = !S.st.pause.paused;
    S.st.pause.paused = next; // shown at once, confirmed by the server below
    renderShell();
    try { S.st = await api("/api/pause", { body: { paused: next } }); renderShell(); toast(next ? "Paused. New requests wait." : "Started again.", "done"); }
    catch (e) { S.st.pause.paused = !next; renderShell(); failed(e); }
  }

  function setTab(t) {
    S.tab = t;
    if (!isPhone() && SCREEN(t)) store.set("screen", t); // the screen the page opens on next time
    renderShell();
    if (t === "setup") { S.setup = null; S.setupError = null; renderSetup(); }
    if (t === "chat") renderChat();
    if (t === "savings") loadSavings();
    if (t === "settings") { renderSettings(); loadLocal(); loadPlatforms(); } // a plan's limits change while you are away
    if (t === "plan") renderPlan();
  }

  // ---- plan (planner.ts) ------------------------------------------------------------------------
  // A task in, a table out: each part, where it runs and on which model, with the time, the tokens
  // kept out of your plan and the cost. Leanfare's parts can run here at once; the rest is for the
  // app you work in (Copy for Claude Code hands it the plan).
  const planBox = { ta: null, rules: null };
  const PLAN_APPS = [["Claude Code", "Claude Code"], ["Claude", "Claude Desktop or Cowork"], ["Codex", "Codex"], ["Gemini CLI", "Gemini CLI"], ["Cursor", "Cursor"], ["you", "No app (just you)"]];
  let planTimer = null;
  const RUNS_ON = { you: "you", local: "Leanfare, on this computer", free: "Leanfare, free model", paid: "Leanfare, pay per use", codex: "Leanfare, through Codex" };
  // Who a part that stays with you runs on: "you (Claude, on your Claude Max plan)" (planner.ts: youText).
  const youText = (P) => {
    const plan = P.you && P.you.plan ? `on your ${P.you.plan.replace(/ plan$/i, "")} plan` : null;
    const app = P.manager === "you" ? null : P.manager;
    return app || plan ? `you (${[app, plan].filter(Boolean).join(", ")})` : "you";
  };
  const STATUS = { waiting: "waiting", running: "running…", done: "done", failed: "failed", stopped: "stopped", yours: "yours to do", after_yours: "after yours", blocked: "waits for a part that is not done", asks: "paid: waits for a yes" };
  function renderPlan() {
    const el = $("#tab-plan");
    if (!planBox.ta) {
      planBox.ta = h("textarea", { rows: "3", "aria-label": "What do you want to do?", placeholder: "What do you want to do? For example: reverse engineer LiteLLM's router and build a smaller one", maxlength: "20000" });
      planBox.ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#planGo")?.click(); } });
      planBox.rules = h("input", { type: "checkbox", "aria-label": "Split by rules" });
      planBox.paths = h("textarea", { rows: "2", "aria-label": "Files or folders", placeholder: "Files or folders it is about (optional), one per line, like ~/code/litellm", maxlength: "20000" });
      // The app the parts that stay with you are done in: the table names the model to pick there.
      planBox.works = h("select", { "aria-label": "Works in", onchange: (e) => store.set("planWorks", e.target.value) },
        ...PLAN_APPS.map(([v, t]) => h("option", { value: v, text: t })));
      planBox.works.value = PLAN_APPS.some(([v]) => v === store.get("planWorks", "")) ? store.get("planWorks", "") : "Claude Code";
    }
    const go = runButton("Make the plan", async (signal) => {
      const task = planBox.ta.value.trim();
      if (!task) { toast("Write the task first.", "error"); return; }
      clearTimeout(planTimer);
      if (S.planRun?.running) { try { await api("/api/plan/stop", { body: { id: S.planRun.id } }); toast("Stopped the parts of the last plan.", "done"); } catch {} }
      S.planRun = null;
      const paths = planBox.paths.value.split("\n").map((x) => x.trim()).filter(Boolean);
      S.plan = await api("/api/plan", { body: { task, paths, manager: planBox.works.value, split: planBox.rules.checked ? "rules" : "auto" }, signal });
      renderPlan();
    }, "btn primary");
    go.id = "planGo";
    const form = h("div", { class: "card plan-form" },
      h("h3", {}, "Plan a task", h("span", { class: "grow" }), h("small", { text: "a table of the parts and their models, before anything starts" })),
      planBox.ta, planBox.paths,
      h("div", { class: "row" }, go, h("label", { class: "check" }, "Works in ", planBox.works), h("label", { class: "check" }, planBox.rules, "Split by rules (no model asked)"), h("span", { class: "grow" }),
        h("small", { class: "fine", text: "A model you ticked splits it: a few cents or less, $0 on free models." })));
    el.replaceChildren(h("div", { class: "plan-col" }, form, S.plan ? planResultEl(S.plan) : planHelpEl()));
  }
  function planHelpEl() {
    return h("div", { class: "card" }, h("h3", { text: "How it works" }), h("ol", { class: "plan-help" },
      h("li", { text: "Leanfare splits the task into parts: reading, drafting, working something out, changing code, searching." }),
      h("li", { text: "For each part it picks where it runs and the model: changes to your project and the hardest judgement stay with the app you work in, on the model to pick there (in Claude Code: Opus for the hardest, Sonnet for most code, Haiku for light work); reading and drafting go to the cheapest model that rates well enough, local and free ones first." }),
      h("li", { text: "Run Leanfare's parts here, at once, or copy the plan into Claude Code, which runs them with Leanfare's delegate tool." }),
      h("li", { text: "In Claude Code and the other apps, the plan tool gives the same table (Settings, Use Leanfare in your apps)." })));
  }
  const tokShort = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
  // When every part stays with you: what would send some out (as planner.ts says it).
  const nothingOut = (parts) => {
    const hints = [parts.some((p) => p.kind === "search" && p.where === "you") ? "tick Perplexity Sonar in Leanfare and the searches go out" : "",
      parts.every((p) => !p.files.length) ? "name the files or folder it is about and the reading goes out" : ""].filter(Boolean);
    return `Nothing goes to Leanfare: ${hints.length ? hints.join("; ") : "every part changes the project or needs the hardest judgement"}.`;
  };
  function planResultEl(P) {
    const run = S.planRun?.id === P.id ? S.planRun : null;
    const st = (n) => run?.parts.find((x) => x.n === n) ?? null;
    const rows = P.parts.map((p) => {
      const r = st(p.n);
      const td = (label, props, ...kids) => h("td", { "data-label": label, ...props }, ...kids);
      return h("tr", { class: p.where === "you" ? "yours" : "" },
        td("#", { text: String(p.n) }),
        h("td", { "data-label": "Part", class: "part" }, h("b", { text: p.title }), h("div", { class: "fine", text: p.why })),
        td("Kind", { text: `${p.kind}, ${p.effort}` }),
        td("Runs on", {}, p.where === "you" ? youText(P) : RUNS_ON[p.where], p.risk ? h("span", { class: "chip warn", title: "A free tier: what is sent there may be read or kept by its company. Make the plan private to keep it on this computer.", text: p.risk }) : null),
        td("Model", { text: p.model?.label ?? ((/claude code/i.test(P.manager) ? p.use?.label : null) ?? P.you?.label ?? p.use?.label ?? "your model") }),
        td("Time", { text: p.seconds === null ? "—" : secsShort(p.seconds) }),
        td("Tokens", { text: p.where === "you" ? `~${tokShort(p.tokens)} of your plan` : `~${tokShort(p.tokens)} kept` }),
        td("Cost", { text: p.where === "you" ? "in your plan" : p.where === "codex" ? "in your ChatGPT plan" : p.cost === null ? "not known" : money(p.cost) }),
        td("When", { text: p.needs.length ? `after ${p.needs.join(", ")}` : "now" }),
        run ? td("Now", { class: "st " + (r?.status ?? ""), text: STATUS[r?.status] ?? "" }) : null);
    });
    const t = P.totals;
    const head = ["#", "Part", "Kind", "Runs on", "Model", "Time", "Tokens", "Cost", "When", ...(run ? ["Now"] : [])];
    const table = h("div", { class: "plan-table-wrap" }, h("table", { class: "plan-table" }, h("thead", {}, h("tr", {}, ...head.map((x) => h("th", { text: x })))), h("tbody", {}, ...rows)));
    const time = [t.seconds !== null ? `Leanfare's parts take ${secsShort(t.seconds)} done at once` : "", t.after !== null && t.after !== undefined ? `${t.seconds !== null ? "the ones after yours take" : "Leanfare's parts wait for yours, then take"} ${secsShort(t.after)}${t.seconds !== null ? " once yours are done" : ""}` : ""].filter(Boolean).join("; ");
    const share = t.kept > 0 ? ` (${t.used ? `${Math.max(1, Math.min(99, Math.round((t.kept / (t.kept + t.used)) * 100)))}%` : "all"} of the parts' tokens)` : "";
    // Before the parts run these are estimates, and a guess where no files were named (planner.ts: totalsText).
    const what = t.out ? `${t.out} of ${t.parts} parts go to Leanfare. If they run, about ${tokShort(t.kept)} tokens stay out of your plan${share}${t.used ? ` and about ${tokShort(t.used)} stay in it` : ""}: ${t.guessed ? "a guess, as no files were named for the reading" : "an estimate until they run"}.` : "Nothing goes to Leanfare.";
    const small = !t.out && P.parts.every((p) => p.keep);
    const sum = h("p", { class: "plan-sum", text: `${what}${time ? ` ${time}.` : ""} Pay per use: ${t.cost === null ? "not known" : money(t.cost)}.${t.out ? "" : ` ${small ? "It is small enough to answer yourself: handing it off would cost more than it saves." : nothingOut(P.parts)}`}` });
    // A local model that would run the reading and drafting free: pressing Download it is the yes.
    const localNote = P.local ? h("p", { class: "fine plan-local" }, `A local model fits this computer: ${P.local.name} (${gbs(P.local.size)}), rated like ${P.local.like}, free to run. `,
      h("button", { class: "btn small", type: "button", text: "Download it", onclick: async () => {
        try { await api("/api/local/pull", { body: { name: P.local.name, sizeBytes: P.local.size } }); S.local = null; toast(`Downloading ${P.local.name}: Settings, Local models shows how it goes.`, "done"); } catch (e) { failed(e); }
      } })) : null;
    const lim = P.limits ? h("p", { class: "fine", text: `Your Claude plan now: ${[P.limits.five !== null ? `5 hours ${Math.round(P.limits.five)}% used` : "", P.limits.week !== null ? `week ${Math.round(P.limits.week)}% used` : ""].filter(Boolean).join(", ")}. Near a limit, more parts go to Leanfare.` }) : null;
    const how = h("p", { class: "fine", text: P.split.note ?? (P.split.model ? `Split by ${P.split.model.label}${typeof P.split.cost === "number" ? `, ${money(P.split.cost)}` : ""}.` : "Split by rules.") });
    // Something of Leanfare's left to run: never run, or ended without an answer.
    const left = !run || P.parts.some((p) => p.where !== "you" && ["waiting", "asks", "failed", "stopped", "blocked"].includes(st(p.n)?.status));
    const canRun = t.out - (t.later ?? 0) > 0 && !run?.running && left; // the parts after yours run in your app, once yours are done
    const laterNote = t.later ? h("p", { class: "fine", text: `${t.later === 1 ? "One of Leanfare's parts waits" : `${t.later} of Leanfare's parts wait`} for yours (see When). Your app hands ${t.later === 1 ? "it" : "them"} to Leanfare once yours are done: Copy for Claude Code gives it the plan.` }) : null;
    const buttons = h("div", { class: "row" },
      // Pressing Run is the yes for the paid parts too (their cost is in the table); the monthly budget still holds.
      canRun ? runButton(run ? "Run the rest" : "Run Leanfare's parts", async (signal) => { S.planRun = await api("/api/plan/run", { body: { id: P.id, paid: true }, signal }); redrawPlanResult(); pollPlan(); }, "btn primary small") : null,
      run?.running ? runButton("Stop", async () => { clearTimeout(planTimer); S.planRun = await api("/api/plan/stop", { body: { id: P.id } }); redrawPlanResult(); toast("Stopped.", "done"); if (S.planRun.running) pollPlan(); }, "btn small") : null,
      h("button", { class: "btn small", type: "button", text: "Copy for Claude Code", onclick: () => copyText(forClaudeCode(P)) }),
      h("button", { class: "btn small", type: "button", text: "Copy the table", onclick: () => copyText(P.table) }));
    // Your grade of a part's answer (grades.ts): it goes with the model that answered and the part's kind.
    const GRADED = ["read", "write", "reason", "search"];
    const gradeRow = (r) => (!r.answer || !r.modelId || !GRADED.includes(P.parts.find((p) => p.n === r.n)?.kind) ? null : h("div", { class: "row grade-row" },
      h("span", { class: "fine grow", text: !r.verdict ? "How good was it?" : `${r.gradedBy === "you" ? "You" : P.manager === "you" ? "Your app" : P.manager} graded it ${r.verdict}.` }),
      ...["good", "partly", "wrong"].map((v) => h("button", { class: "btn small" + (r.verdict === v ? " primary" : ""), type: "button", "aria-pressed": String(r.verdict === v), text: v[0].toUpperCase() + v.slice(1),
        onclick: async () => {
          try { const g = await api("/api/grades", { body: { id: P.id, part: r.n, verdict: v, source: "you" } }); r.verdict = v; r.gradedBy = "you"; S.grades = undefined; redrawPlanResult(); toast(g.text, "done"); }
          catch (e) { failed(e); }
        } }))));
    const answers = run ? run.parts.filter((r) => r.answer || r.error).map((r) => h("details", { class: "plan-answer", open: r.n === run.parts.filter((x) => x.answer).at(-1)?.n },
      h("summary", { text: `Part ${r.n} · ${r.title} · ${STATUS[r.status]}${r.model ? ` · ${r.model}` : ""}${r.cost !== null && r.cost !== undefined ? ` · ${money(r.cost)}` : ""}${r.seconds ? ` · ${secsShort(r.seconds)}` : ""}` }),
      r.answer ? (() => { const md = h("div", { class: "md" }); md.innerHTML = markdown(r.answer); return md; })() : null,
      r.error ? h("p", { class: "pl-note", text: r.error }) : null,
      r.receipt ? h("p", { class: "fine", text: r.receipt }) : null,
      gradeRow(r))) : [];
    return h("div", { class: "card plan-result", id: "planResult" }, h("h3", {}, "The plan", h("span", { class: "grow" }), h("small", { text: P.task.length > 80 ? P.task.slice(0, 80) + "…" : P.task })),
      table, sum, localNote, laterNote, lim, buttons, how, ...answers);
  }
  // Only the plan's card is drawn again while its parts run: the boxes above keep what is typed and their focus.
  function redrawPlanResult() {
    const old = $("#planResult");
    if (old && S.plan) old.replaceWith(planResultEl(S.plan)); else renderPlan();
  }
  function pollPlan() {
    clearTimeout(planTimer);
    if (!S.planRun?.running) return;
    const id = S.planRun.id;
    planTimer = setTimeout(async () => {
      let v;
      try { v = await api(`/api/plan/run?id=${encodeURIComponent(id)}`); } catch { return; }
      if (S.planRun?.id !== id) return; // another plan since, or stopped
      S.planRun = v;
      if (S.tab === "plan") redrawPlanResult();
      if (v.running) pollPlan();
      else if (!v.parts.some((p) => p.status === "stopped")) toast("Leanfare's parts are done.", "done");
    }, 1500);
  }
  // What Claude Code needs to run the plan with Leanfare's tools: the task, the table, and how.
  function forClaudeCode(P) {
    return [`Task: ${P.task}`, "", "Leanfare made this plan for it (its plan tool gives the same):", "", P.table, "",
      P.next,
      "For each part on Leanfare, call Leanfare's delegate tool with that part's task, kind and effort, and the files it needs; run the parts that do not wait for each other in the same turn. Do the parts marked you yourself, then put it all together."].join("\n");
  }

  // ---- chat ----------------------------------------------------------------------------------
  const chatEl = () => $("#tab-chat");
  let composer = null; // built once so typing is never lost to a redraw

  async function loadChats() {
    try { const r = await api("/api/chats"); S.chats = r.chats; S.history = r.history; } catch (e) { failed(e); }
    renderChatList();
  }

  function renderChat() {
    const el = chatEl();
    if (!el.firstChild) {
      el.append(
        h("aside", { class: "chats" },
          h("div", { class: "chats-head" }, h("button", { class: "btn primary", text: "New chat", onclick: newChat })),
          h("div", { class: "chat-search" }, searchBox()),
          h("div", { class: "chat-list", id: "chatList" }),
          h("div", { class: "chats-foot", id: "chatsFoot" })),
        h("div", { class: "convo" },
          h("div", { class: "convo-head", id: "convoHead" }, h("div", { class: "row1" }), h("div", { class: "sys-slot" })),
          h("div", { class: "messages", id: "messages" }),
          buildComposer()),
      );
      setupDrop(el.querySelector(".convo"));
    }
    if (S.system === null) S.system = S.chatId ? "" : (S.st?.settings.instructions ?? "");
    renderChatList();
    renderMessages();
    renderComposerBar();
  }

  // The bar above the conversation: its name and its instructions (a system prompt).
  function renderConvoHead() {
    const head = $("#convoHead");
    if (!head || !S.st) return;
    const title = S.chatId ? (S.chats.find((c) => c.id === S.chatId)?.title ?? "Chat") : "New chat";
    const on = !!S.system?.trim();
    head.querySelector(".row1").replaceChildren(
      h("span", { class: "ct", text: title, title }),
      h("span", { class: "grow" }),
      h("button", { class: "chip-btn" + (on ? " on" : ""), type: "button", "aria-expanded": String(S.sysOpen), title: "What the model is told before every message in this chat (a system prompt)", text: on ? "Instructions on" : "Instructions", onclick: () => { S.sysOpen = !S.sysOpen; renderSysPanel(); renderConvoHead(); } }),
      S.messages.some((m) => !m.live) ? h("button", { class: "chip-btn", type: "button", title: "Save this chat as a Markdown file", text: "Export", onclick: () => download(`${slug(title)}.md`, chatMarkdown(title), "text/markdown") }) : null);
  }

  const slug = (t) => (t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chat");
  function download(name, text, type) {
    // In the Mac app, the app saves it (a web view has no downloads of its own).
    const mac = window.webkit?.messageHandlers?.leanfareSave;
    if (mac) { mac.postMessage({ name, text }); toast(`Saved ${name} in your Downloads folder.`, "done"); return; }
    const href = URL.createObjectURL(new Blob([text], { type }));
    const a = h("a", { href, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
    toast(`Saved ${name} to your downloads.`, "done");
  }
  // One chat as Markdown: the questions, the answers, which model wrote each and what it cost.
  function chatMarkdown(title) {
    const lines = [`# ${title}`, "", `Exported from Leanfare on ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.`];
    if (S.system?.trim()) lines.push("", `**Instructions:** ${S.system.trim()}`);
    for (const m of S.messages) {
      if (m.live) continue;
      if (m.role === "user") {
        lines.push("", "## You", "");
        if (m.content) lines.push(m.content);
        if (m.files?.length) lines.push("", `_Attached: ${m.files.map((f) => f.name).join(", ")}_`);
      } else if (m.role === "assistant" && m.content) {
        const meta = m.meta ?? {};
        lines.push("", `## ${meta.model?.label ?? "Answer"}${typeof meta.cost === "number" ? ` · ${money(meta.cost)}` : ""}`, "", m.content);
      }
    }
    return lines.join("\n") + "\n";
  }

  async function exportEverything() {
    const j = await api("/api/export");
    download(`leanfare-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(j), "application/json");
  }
  async function importFile(file) {
    if (!file) return;
    const t = toast(`Reading ${file.name}…`);
    try {
      const res = await fetch("/api/import", { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/octet-stream" }, body: file });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      const from = { leanfare: "a Leanfare export", chatgpt: "ChatGPT", claude: "Claude" }[j.from] ?? j.from;
      t.set(`Imported ${num(j.imported)} chat${j.imported === 1 ? "" : "s"} (${num(j.messages)} messages) from ${from}.${j.skipped ? ` ${num(j.skipped)} ${j.skipped === 1 ? "was" : "were"} already here.` : ""}`, "done");
      S.chats = j.chats; renderChatList();
    } catch (e) { t.set(String(e?.message ?? e), "error"); }
  }

  function renderSysPanel() {
    const slot = $("#convoHead .sys-slot");
    if (!slot) return;
    if (!S.sysOpen) { slot.replaceChildren(); return; }
    const ta = h("textarea", { rows: 4, placeholder: "For example: Answer briefly. I write Python 3.12 and use pandas.", "aria-label": "Instructions for this chat", text: S.system ?? "" });
    const save = async (text) => {
      const next = text.trim();
      if (S.chatId && S.history) {
        try { await api(`/api/chats/${S.chatId}`, { method: "PATCH", body: { system: next } }); } catch (e) { failed(e); return; }
      }
      S.system = next;
      S.sysOpen = false;
      renderSysPanel(); renderConvoHead(); scheduleEstimate();
      toast(next ? "Instructions saved for this chat." : "This chat has no instructions now.", "done");
    };
    const def = S.st.settings.instructions;
    slot.replaceChildren(h("div", { class: "sys-panel" }, ta,
      h("div", { class: "row" },
        h("button", { class: "btn small primary", type: "button", text: "Save", onclick: () => save(ta.value) }),
        def && def !== ta.value.trim() ? h("button", { class: "btn small", type: "button", text: "Use my default", title: def, onclick: () => { ta.value = def; ta.focus(); } }) : null,
        ta.value ? h("button", { class: "btn small quiet", type: "button", text: "Clear", onclick: () => save("") }) : null,
        h("span", { class: "grow" }),
        h("button", { class: "btn small quiet", type: "button", text: "Close", onclick: () => { S.sysOpen = false; renderSysPanel(); renderConvoHead(); } })),
      h("p", { text: "Sent before every message in this chat and counted in each estimate. New chats start with your default instructions from Settings." })));
    ta.focus();
  }

  let searchTimer = null, searchSeq = 0;
  function searchBox() {
    const input = h("input", { type: "search", placeholder: "Search chats", "aria-label": "Search chats", autocomplete: "off" });
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { S.search = null; renderChatList(); return; }
        const seq = ++searchSeq;
        try { const r = await api("/api/search?q=" + encodeURIComponent(q)); if (seq === searchSeq) { S.search = { q, results: r.results }; renderChatList(); } }
        catch (e) { failed(e); }
      }, 250);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); input.value = ""; S.search = null; renderChatList(); } });
    return input;
  }
  // The matching words, marked (built from text, never as HTML).
  function marked(text, q) {
    const out = [];
    const low = text.toLowerCase(), ql = q.toLowerCase();
    let i = 0;
    for (let at = low.indexOf(ql); at >= 0 && out.length < 20; at = low.indexOf(ql, i)) {
      out.push(text.slice(i, at), h("mark", { text: text.slice(at, at + q.length) }));
      i = at + q.length;
    }
    out.push(text.slice(i));
    return out;
  }
  function renderSearch(list) {
    const { q, results } = S.search;
    list.replaceChildren(
      h("div", { class: "chat-group", text: results.length ? `${results.length}${results.length === 50 ? "+" : ""} chat${results.length === 1 ? "" : "s"} match` : "No chat matches" }),
      ...results.map((r) => h("div", { class: "chat-item hit" + (r.id === S.chatId ? " on" : ""), title: r.title, onclick: () => openChat(r.id) },
        h("span", { class: "t" }, ...marked(r.title, q)),
        r.snippet ? h("span", { class: "snip" }, ...marked(r.snippet, q)) : null)));
  }

  function renderChatList() {
    const list = $("#chatList");
    if (!list) return;
    if (S.search) { renderSearch(list); renderConvoHead(); return; }
    const items = [];
    if (!S.history) items.push(h("div", { class: "empty", text: "Chat history is off, so chats are not kept. Turn it on in Settings." }));
    else if (!S.chats.length) items.push(h("div", { class: "empty", text: "Your chats will be listed here." }));
    let group = "";
    for (const c of S.chats) {
      const d = new Date(c.updated);
      const today = new Date();
      const g = d.toDateString() === today.toDateString() ? "Today" : (today - d) < 7 * 86400e3 ? "This week" : "Earlier";
      if (g !== group) { group = g; items.push(h("div", { class: "chat-group", text: g })); }
      items.push(h("div", { class: "chat-item" + (c.id === S.chatId ? " on" : ""), title: c.title, "data-id": c.id, onclick: () => openChat(c.id) },
        h("span", { class: "t", text: c.title }),
        h("span", { class: "acts" },
          h("button", { text: "✎", title: "Rename this chat", "aria-label": `Rename ${c.title}`, onclick: (e) => { e.stopPropagation(); renameChat(c); } }),
          h("button", { text: "✕", title: "Remove this chat from the list (you can undo)", "aria-label": `Remove ${c.title}`, onclick: (e) => { e.stopPropagation(); removeChat(c); } }))));
    }
    list.replaceChildren(...items);
    renderConvoHead();
    const foot = $("#chatsFoot");
    foot.replaceChildren(
      h("span", { text: S.history ? "Chats are kept on this computer only." : "History is off." }),
      h("button", { text: "Removed chats", onclick: showRemoved }));
  }

  async function showRemoved() {
    try {
      const r = await api("/api/chats/removed");
      if (!r.chats.length) { toast("No removed chats.", "done"); return; }
      const c = r.chats[0];
      toast(`${r.chats.length} removed chat${r.chats.length === 1 ? "" : "s"}. Latest: "${c.title}".`, "done", { action: { label: "Put it back", run: () => restoreChat(c.id) } });
    } catch (e) { failed(e); }
  }
  async function restoreChat(id) {
    try { const r = await api(`/api/chats/${id}/restore`, { body: {} }); S.chats = r.chats; renderChatList(); toast("Chat put back.", "done"); } catch (e) { failed(e); }
  }
  async function removeChat(c) {
    const before = S.chats;
    S.chats = S.chats.filter((x) => x.id !== c.id); // gone at once
    if (S.chatId === c.id) newChat();
    renderChatList();
    try { const r = await api(`/api/chats/${c.id}`, { method: "DELETE" }); S.chats = r.chats; renderChatList(); toast(`Removed "${c.title}".`, "done", { action: { label: "Undo", run: () => restoreChat(c.id) } }); }
    catch (e) { S.chats = before; renderChatList(); failed(e); }
  }
  async function renameChat(c) {
    const item = [...document.querySelectorAll(".chat-item")].find((el) => el.dataset.id === c.id);
    if (!item) return;
    const input = h("input", { type: "text", value: c.title, "aria-label": "Chat name" });
    item.replaceChildren(input);
    input.focus(); input.select();
    // Enter or leaving the box saves; Esc puts the old name back. Only the first of them counts
    // (redrawing the list removes the box, and that fires a blur of its own).
    let closed = false;
    const done = async (save) => {
      if (closed) return;
      closed = true;
      const title = input.value.trim();
      if (save && title && title !== c.title) {
        try { const r = await api(`/api/chats/${c.id}`, { method: "PATCH", body: { title } }); S.chats = r.chats; toast("Renamed.", "done"); } catch (e) { failed(e); }
      }
      renderChatList();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    input.addEventListener("blur", () => done(true));
  }

  function newChat() {
    if (S.live) stopLive();
    S.chatId = null;
    S.messages = [];
    S.editing = null;
    S.system = S.st?.settings.instructions ?? "";
    S.sysOpen = false;
    store.set("chat", null);
    chatEl().classList.remove("list-open");
    renderChatList();
    renderSysPanel();
    renderMessages();
    restoreDraft();
    composer?.ta.focus();
  }

  async function openChat(id) {
    if (S.live) stopLive();
    try {
      const r = await api(`/api/chats/${id}`);
      S.chatId = id;
      store.set("chat", id);
      S.editing = null;
      S.messages = r.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta, files: m.files?.length ? m.files : undefined }));
      S.system = r.chat?.system ?? "";
      S.sysOpen = false;
      chatEl().classList.remove("list-open");
      renderChatList();
      renderSysPanel();
      renderMessages(true);
      restoreDraft();
    } catch (e) {
      S.chatId = null; store.set("chat", null); failed(e);
    }
  }

  // The welcome screen: three free ways to start, each asked for once.
  function welcome() {
    const st = S.st;
    const g = st.providers.find((p) => p.id === "google");
    const o = st.providers.find((p) => p.id === "ollama");
    const r = st.providers.find((p) => p.id === "openrouter");
    const keyBox = (p, placeholder) => {
      const input = h("input", { type: "password", placeholder, autocomplete: "off", "data-keep": "welcome-" + p.id, "aria-label": `${p.name} key` });
      return h("div", { class: "keyrow" }, input, runButton("Test and save", (signal) => saveKey(p, input, signal), "btn primary"));
    };
    return h("div", { class: "welcome" },
      h("h1", { text: "Every top AI model, one app, real costs." }),
      h("p", { text: "Add one key to start. Leanfare shows what each answer costs, picks the cheapest model that does the job well, and keeps your budget. These three cost nothing:" }),
      h("div", { class: "starts" },
        h("div", { class: "start" }, h("h3", { text: "Google Gemini, free key" }),
          h("p", {}, "Make a free key at ", h("a", { href: g.keyUrl, target: "_blank", rel: "noopener noreferrer", text: "Google AI Studio" }), ", then paste it here. ", h("span", { text: g.note })),
          g.key?.saved ? h("span", { class: "chip good", text: "Key saved" }) : keyBox(g, "Paste your Gemini key")),
        h("div", { class: "start" }, h("h3", { text: "Ollama, on this computer" }),
          h("p", { text: o.ready ? `Found ${modelsOf("ollama").length} local model${modelsOf("ollama").length === 1 ? "" : "s"}. Ready to use.` : `Not found: Leanfare tried ${(o.list?.tried ?? "http://127.0.0.1:11434/api/tags")} (${o.list?.error ?? "no answer"}). Open the Ollama app, then look again.` }),
          o.ready ? h("span", { class: "chip good", text: "Ready" }) : h("div", { class: "row" }, runButton("Look again", (signal) => refreshList("ollama", signal)), h("a", { class: "btn quiet", href: o.keyUrl, target: "_blank", rel: "noopener noreferrer", text: "Get Ollama" }))),
        h("div", { class: "start" }, h("h3", { text: "OpenRouter, free models" }),
          h("p", { text: "Sign in once on OpenRouter: no key to copy. One account for many makers; models ending in :free cost nothing." }),
          r.key?.saved ? h("span", { class: "chip good", text: "Connected" }) : h("div", { class: "keyrow" },
            runButton("Connect OpenRouter", connectOpenRouter, "btn primary"),
            h("p", { class: "fine" }, "or paste a key (", h("a", { href: r.keyUrl, target: "_blank", rel: "noopener noreferrer", text: "make one" }), "):"),
            keyBox(r, "Paste your OpenRouter key")))),
      h("p", { class: "more" }, "Have an OpenAI, Anthropic, DeepSeek, xAI or Mistral key? ", h("button", { class: "btn small", text: "Add it in Settings", onclick: () => setTab("settings") })));
  }

  function renderMessages(scrollToEnd = false) {
    const box = $("#messages");
    if (!box || !S.st) return;
    if (!S.messages.length) {
      keepInputs(box, () => box.replaceChildren(ready() ? h("div", { class: "col welcome" }, h("h1", { text: "What can I do for you?" }), h("p", { text: `Auto (${S.st.modes[S.st.settings.mode].label}) picks ${S.st.modes[S.st.settings.mode].blurb}. Each answer says which model wrote it, why, and what it cost.` })) : welcome()));
      return;
    }
    const col = h("div", { class: "col" });
    S.messages.forEach((m, i) => col.append(messageEl(m, i)));
    keepInputs(box, () => box.replaceChildren(col)); // an open edit box keeps what is typed in it
    if (scrollToEnd) box.scrollTop = box.scrollHeight;
  }

  function messageEl(m, index) {
    if (m.role === "user") {
      if (S.editing === index) return editEl(m, index);
      return h("div", { class: "msg user" }, h("div", { class: "ucol" },
        m.files?.length ? fileChips(m.files) : null,
        m.content ? h("div", { class: "bubble", text: m.content }) : null,
        S.live ? null : h("button", { class: "edit-btn", type: "button", title: "Change this message and send it again", "aria-label": "Edit this message", text: "✎ Edit", onclick: () => { S.editing = index; renderMessages(); } })));
    }
    const el = h("div", { class: "msg ai", "data-i": index });
    const body = h("div", { class: "body" });
    if (m.content) body.innerHTML = markdown(m.content);
    const th = m.live ? m.thinking ?? "" : m.meta?.thinking ?? "";
    if (th) el.append(thinkingEl(m, th));
    else if (m.meta?.thinkingChars && !m.content) el.append(h("div", { class: "thinking-note", text: `Thinking… (${num(m.meta.thinkingChars)} characters)` }));
    el.append(body, metaEl(m, index));
    return el;
  }

  // What the model thought before answering: open while it is still thinking, folded after.
  function thinkingEl(m, text) {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const still = m.live && !m.content;
    const d = h("details", { class: "thinking" + (still ? " live" : ""), ...(still || m.thinkOpen ? { open: true } : {}) },
      h("summary", { text: still ? `Thinking… ${num(words)} words` : `Thought ${num(words)} words${m.meta?.effort ? ` · effort ${m.meta.effort}` : ""}` }),
      h("div", { class: "tbody", text }));
    d.addEventListener("toggle", () => { if (!still) m.thinkOpen = d.open; });
    if (still) requestAnimationFrame(() => { const b = d.querySelector(".tbody"); if (b) b.scrollTop = b.scrollHeight; });
    return d;
  }

  function metaEl(m, index) {
    const meta = m.meta ?? {};
    const box = h("div", { class: "meta-wrap" });
    const chips = [];
    if (meta.model) chips.push(h("span", { class: "chip model", title: meta.model.id, text: meta.model.label }));
    if (meta.task) chips.push(h("span", { class: "chip task", title: `Task guessed from ${meta.why}`, text: (S.st.tasks.find((t) => t[0] === meta.task)?.[1] ?? meta.task) }));
    if (meta.auto) chips.push(h("span", { class: "chip", text: `Auto · ${meta.modeLabel}` }));
    if (meta.switchedFrom) chips.push(h("span", { class: "chip warn", text: "Switched from a retired model" }));
    if (meta.retried && !m.live) chips.push(h("span", { class: "chip warn", title: (meta.notes ?? []).find((n) => /asked (again|.* once more)/.test(n)) ?? "", text: "Second try" }));
    if (meta.priceStatus === "free plan") chips.push(h("span", { class: "chip good", text: "Free plan" }));
    if (meta.priceStatus === "local") chips.push(h("span", { class: "chip good", text: "On this computer" }));
    if (meta.priceStatus === "free") chips.push(h("span", { class: "chip good", text: "Free model" }));
    if (meta.compare && meta.status !== "running" && !m.live) {
      const a = meta.compare.cost, b = meta.cost;
      const tone = typeof a === "number" && typeof b === "number" ? (b < a * 0.95 ? " good" : b > a * 1.05 ? " warn" : "") : "";
      chips.push(h("span", { class: "chip compare" + tone, text: compareText(meta) }));
    }
    const line = h("div", { class: "meta" }, ...chips);
    if (meta.status === "running" || m.live) {
      const waitingText = meta.waiting ? meta.waiting : !m.content ? (meta.retryNote ? `Asking again: ${meta.retryNote.replace(/, so Leanfare .*$/, ".")}` : meta.slow ? "Taking longer than usual. You can stop it, or wait." : meta.model ? `Waiting for ${meta.model.label}…` : "Choosing a model…") : `Writing… ${num(Math.ceil(m.content.length / 4))} tokens`;
      line.prepend(h("span", { class: "spin" }));
      line.append(h("span", { text: waitingText }));
      if (meta.estimate !== undefined && meta.estimate !== null) line.append(h("span", { text: `≈ ${money(meta.estimate)}${typeof meta.seconds === "number" ? `, ${secondsText(meta.seconds)}` : ""} (estimate)` }));
      box.append(line);
      return box;
    }
    const last = index === S.messages.length - 1; // only the last answer can be written again
    if (meta.status === "error") {
      box.append(h("div", { class: "err-box" }, h("span", { class: "grow", text: meta.error ?? "The answer failed." }), last ? h("button", { class: "btn small", text: "Try again", onclick: () => startAgain(index) }) : null));
      if (chips.length) box.append(line);
      return box;
    }
    if (meta.status === "stopped") line.append(h("span", { class: "chip warn", text: "Stopped" }));
    if (meta.cost !== undefined) line.append(h("span", { class: "cost", title: `Exact: ${money8(meta.cost)}`, text: meta.cost === null ? "price unknown" : money(meta.cost) }));
    if (meta.usage) line.append(h("span", { text: `${tok(meta.usage.uncached + meta.usage.cacheRead + meta.usage.cacheWrite)} in · ${tok(meta.usage.output)} out` }));
    if (meta.ms) line.append(h("span", { text: secs(meta.ms) }));
    const whyBtn = h("button", { class: "link", type: "button", text: m.whyOpen ? "Hide details" : "Why this model", onclick: () => { m.whyOpen = !m.whyOpen; renderMessages(); } });
    line.append(whyBtn);
    if (meta.status === "stopped" && last) line.append(h("button", { class: "btn small", text: "Start again", onclick: () => startAgain(index) }));
    // Copy any answer; for the newest question, ask again or ask another model and compare the costs.
    const group = lastGroup(index) && !S.live;
    line.append(h("span", { class: "acts" },
      m.content ? h("button", { class: "link", type: "button", text: "Copy", title: "Copy this answer (as Markdown)", onclick: () => copyText(m.content) }) : null,
      group && meta.status !== "stopped" ? h("button", { class: "link", type: "button", text: "Again", title: "Ask the same question again (this answer is replaced)", onclick: () => startAgain(index) }) : null,
      group ? anotherPicker(index, meta) : null));
    box.append(line);
    if (m.whyOpen) box.append(whyEl(meta));
    return box;
  }

  function whyEl(meta) {
    const rows = [];
    rows.push(h("div", {}, h("b", { text: "Why: " }), meta.reason ?? ""));
    if (meta.task) rows.push(h("div", {}, h("b", { text: "Task guess: " }), `${S.st.tasks.find((t) => t[0] === meta.task)?.[1] ?? meta.task}, from ${meta.why}.`, meta.alt ? ` It could also have been ${S.st.tasks.find((t) => t[0] === meta.alt)?.[1]?.toLowerCase() ?? meta.alt}.` : ""));
    for (const n of meta.notes ?? []) rows.push(h("div", {}, h("b", { text: "Note: " }), n));
    if (meta.model && (typeof meta.seconds === "number" || sameQuality(meta))) rows.push(h("div", {}, h("b", { text: "Speed: " }), `${typeof meta.seconds === "number" ? `expected ${secondsText(meta.seconds)}${meta.secondsMeasured ? ", from this model's answers here." : " (a rough guess until this model has answered three times here)."} ` : ""}${sameQuality(meta)}`.trim()));
    if (meta.alternatives?.length) rows.push(h("div", {}, h("b", { text: "Other choices: " }), meta.alternatives.map((a) => `${a.label} (rated ${a.rating ?? "—"}, ≈ ${money(a.estimate)}${typeof a.seconds === "number" ? `, ${secondsText(a.seconds)}` : ""})`).join(" · ")));
    if (meta.usual && meta.usualCost !== null && meta.usualCost !== undefined && meta.usual.id !== meta.model?.id) rows.push(h("div", {}, h("b", { text: "On your usual model: " }), `${meta.usual.label} would have cost ${money(meta.usualCost)} for the same tokens.`));
    if (meta.price) {
      const p = meta.price;
      const src = meta.priceCommit ? h("a", { href: `https://github.com/BerriAI/litellm/blob/${meta.priceCommit}/model_prices_and_context_window.json`, target: "_blank", rel: "noopener noreferrer", text: meta.priceSource }) : meta.priceSource;
      const long = p.above200k ? ` · above 200k input tokens ${perM(p.above200k.input ?? p.input)} in · ${perM(p.above200k.output ?? p.output)} out` : "";
      rows.push(h("div", {}, h("b", { text: "Price: " }), `${perM(p.input)} in · ${perM(p.output)} out per 1M tokens${p.cacheRead !== null && p.cacheRead !== undefined ? ` · cached input ${perM(p.cacheRead)}` : ""}${long}. Source: `, src, "."));
    }
    if (meta.usage) rows.push(h("div", {}, h("b", { text: "Exact: " }), `${money8(meta.cost)} for ${num(meta.usage.uncached)} input tokens, ${num(meta.usage.cacheRead)} cached, ${num(meta.usage.cacheWrite)} written to cache${meta.usage.cacheWrite1h ? ` and ${num(meta.usage.cacheWrite1h)} written for an hour` : ""}, ${num(meta.usage.output)} output${meta.estimatedUsage ? " (token counts estimated: the provider did not report them)" : ""}.`));
    if (meta.firstMs) rows.push(h("div", {}, h("b", { text: "Time: " }), `first words after ${secs(meta.firstMs)}, done after ${secs(meta.ms)}.`));
    return h("div", { class: "why" }, ...rows);
  }

  // ---- composer ---------------------------------------------------------------------------------
  function buildComposer() {
    const ta = h("textarea", { rows: 1, placeholder: "Ask anything", "aria-label": "Message" });
    const pick = h("select", { "aria-label": "Model" });
    const effort = h("select", { class: "effort", "aria-label": "Thinking effort", title: "How hard thinking models think before they answer. Thinking is billed as output: higher costs more and takes longer. Models that do not take a level think as they always do." },
      ...[["auto", "Thinking: auto"], ["low", "Thinking: low"], ["medium", "Thinking: medium"], ["high", "Thinking: high"]].map(([v, t]) => h("option", { value: v, text: t })));
    effort.addEventListener("change", async () => {
      try { S.st = await api("/api/settings", { body: { effort: effort.value } }); toast(effort.value === "auto" ? "Thinking models think as they do by default." : `Thinking effort: ${effort.value}.`, "done"); scheduleEstimate(); }
      catch (e) { failed(e); }
    });
    const speed = h("select", { class: "speed", "aria-label": "Speed", title: "At the same quality, the cheapest, the cheapest within a time, or the fastest. Times come from how fast each model answered you before." },
      ...speedOptions(S.st?.settings?.speed ?? "cheapest", 2));
    speed.addEventListener("change", async () => {
      try { S.st = await api("/api/settings", { body: { speed: speedValue(speed.value) } }); toast(`${speed.selectedOptions[0].textContent}.`, "done"); scheduleEstimate(); }
      catch (e) { failed(e); }
    });
    const est = h("div", { class: "est" });
    const send = h("button", { class: "btn primary send", type: "submit", text: "Send" });
    const back = h("button", { class: "btn small back", type: "button", text: "Chats", onclick: () => chatEl().classList.add("list-open") });
    const picker = h("input", { type: "file", multiple: true, hidden: true, accept: "image/*,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.swift,.sql,.sh,.heic", onchange: (e) => { addFiles([...e.target.files]); e.target.value = ""; } });
    const attach = h("button", { class: "attach", type: "button", "aria-label": "Attach files", title: "Attach images, PDFs or text files (or drop them here, or paste an image)", text: "+", onclick: () => picker.click() });
    const pending = h("div", { class: "pending" });
    const form = h("form", { class: "composer" },
      h("div", { class: "box" }, pending, ta, h("div", { class: "bar" }, back, attach, picker, pick, effort, speed, est, send)),
      h("div", { class: "hint", text: "Enter sends · Shift+Enter adds a line · Esc stops an answer · drop or paste files to attach" }));
    composer = { form, ta, pick, est, send, pending, effort, speed };
    ta.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(220, ta.scrollHeight) + "px"; };
    ta.addEventListener("input", () => { grow(); saveDraft(); scheduleEstimate(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (S.live) toast("An answer is still being written. Press Esc or Stop to end it first.", "done");
        else form.requestSubmit();
      }
      if (e.key === "Escape" && S.live) { e.preventDefault(); stopLive(); }
    });
    pick.addEventListener("change", async () => {
      const v = pick.value;
      if (v.startsWith("auto-")) {
        const mode = v.slice(5);
        S.model = "auto";
        try { S.st = await api("/api/settings", { body: { mode } }); toast(`Auto now picks: ${S.st.modes[mode].label}.`, "done"); } catch (e) { failed(e); }
      } else S.model = v;
      store.set("model", S.model);
      renderComposerBar();
      scheduleEstimate();
    });
    // Send turns into Stop at once, so the second click of a double click is not a Stop.
    send.addEventListener("click", (e) => { if (S.live && (e.detail > 1 || Date.now() - S.live.started < 500)) e.preventDefault(); });
    form.addEventListener("submit", (e) => { e.preventDefault(); if (S.live) stopLive(); else sendMessage(); });
    setTimeout(restoreDraft, 0);
    return form;
  }

  async function addFiles(files) {
    if (!files.length) return;
    if (S.pending.length + files.length > FILE_MAX.count) { toast(`At most ${FILE_MAX.count} files go with one message.`, "error"); files = files.slice(0, Math.max(0, FILE_MAX.count - S.pending.length)); }
    const t = files.length > 1 || files[0].size > 2 * 1048576 ? toast(`Reading ${files.length === 1 ? files[0].name : files.length + " files"}…`) : null;
    let added = 0;
    for (const f of files) {
      try { S.pending.push(await readAttachment(f)); added++; }
      catch (e) { toast(String(e?.message ?? e), "error"); }
    }
    t?.close();
    renderPending();
    if (added) { scheduleEstimate(); composer?.ta.focus(); }
  }
  function renderPending() {
    if (!composer) return;
    composer.pending.replaceChildren(S.pending.length ? fileChips(S.pending, (i) => { S.pending.splice(i, 1); renderPending(); scheduleEstimate(); }) : null);
    renderComposerBar();
  }
  function setupDrop(area) {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    area.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; area.classList.add("drop"); });
    area.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    area.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) area.classList.remove("drop"); });
    area.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; area.classList.remove("drop"); addFiles([...e.dataTransfer.files]); });
  }

  const draftKey = () => "draft." + (S.chatId ?? "new");
  function saveDraft() { const v = composer.ta.value; if (v) store.set(draftKey(), v); else store.del(draftKey()); }
  function restoreDraft() {
    if (!composer) return;
    composer.ta.value = store.get(draftKey(), "");
    composer.ta.dispatchEvent(new Event("input"));
  }

  function renderComposerBar() {
    if (!composer || !S.st) return;
    const st = S.st;
    const { pick, send, est } = composer;
    const opts = [];
    const mode = st.settings.mode;
    for (const [k, v] of Object.entries(st.modes)) opts.push(h("option", { value: "auto-" + k, selected: S.model === "auto" && mode === k, text: `Auto · ${v.label}` }));
    const ticked = new Set(st.settings.ticked);
    for (const p of st.providers) {
      if (!p.ready) continue;
      const ms = modelsOf(p.id).filter((m) => ticked.has(m.id) && !m.retired);
      if (!ms.length) continue;
      opts.push(h("optgroup", { label: p.name }, ...ms.map((m) => h("option", { value: m.id, selected: S.model === m.id, text: `${m.label} · ${m.local || m.free ? "free" : perM(m.input) + " / " + perM(m.output)}` }))));
    }
    pick.replaceChildren(...opts);
    const shown = new Set([...pick.querySelectorAll("option")].map((o) => o.value));
    if (S.model !== "auto" && !shown.has(S.model)) { S.model = "auto"; store.set("model", "auto"); }
    pick.value = S.model === "auto" ? "auto-" + mode : S.model;
    pick.disabled = !ready();
    const thinkers = Object.values(st.models).flat().some((m) => ticked.has(m.id) && m.effort?.length);
    composer.effort.hidden = !thinkers;
    if (document.activeElement !== composer.effort) composer.effort.value = st.settings.effort ?? "auto";
    composer.speed.hidden = S.model !== "auto"; // speed is how Auto picks; a model you chose is that model
    if (document.activeElement !== composer.speed) { const cur = st.settings.speed ?? "cheapest"; composer.speed.replaceChildren(...speedOptions(cur, 2)); composer.speed.value = String(cur); }
    send.disabled = !ready() && !S.live;
    send.textContent = S.live ? "Stop" : "Send";
    send.classList.toggle("stop", !!S.live);
    if (!ready()) est.textContent = "To send, add a key in Settings or start Ollama, and tick at least one model.";
    else if (!composer.ta.value.trim() && !S.pending.length) est.textContent = S.model === "auto" ? `Auto picks ${st.modes[mode].blurb}.` : "";
  }

  // At the same quality: the cheapest and the fastest choice, said when either is not the pick.
  const choiceText = (c) => `${c.label} ≈ ${money(c.estimate)}${typeof c.seconds === "number" ? `, ${secondsText(c.seconds)}` : ""}`;
  function sameQuality(p) {
    const c = p.choices;
    if (!c || (c.cheapest.id === p.model?.id && (!c.fastest || c.fastest.id === p.model?.id))) return "";
    return `At the same quality: cheapest ${choiceText(c.cheapest)}${c.fastest ? ` · fastest ${choiceText(c.fastest)}` : ""}.`;
  }
  // The one worth a glance in the composer: a faster one when Auto took the cheapest, a cheaper one when it took the fastest.
  function otherChoice(p) {
    const c = p.choices;
    if (!c) return "";
    if (c.fastest && c.fastest.id !== p.model.id && typeof c.fastest.seconds === "number" && typeof p.seconds === "number" && c.fastest.seconds < p.seconds * 0.7) return ` · faster: ${choiceText(c.fastest)}`;
    if (c.cheapest.id !== p.model.id && c.cheapest.estimate !== null && p.estimate !== null && c.cheapest.estimate < p.estimate * 0.7) return ` · cheaper: ${choiceText(c.cheapest)}`;
    return "";
  }

  let estTimer = null;
  function scheduleEstimate() {
    clearTimeout(estTimer);
    estTimer = setTimeout(runEstimate, 350);
  }
  async function runEstimate() {
    if (!composer || !ready()) return;
    const draft = composer.ta.value.trim();
    if (!draft && !S.pending.length) { renderComposerBar(); return; }
    const seq = ++S.estimateSeq;
    try {
      const r = await api("/api/estimate", { body: { messages: [...contextMessages(fileForEstimate), { role: "user", content: draft, files: S.pending.map(fileForEstimate) }], model: S.model, system: S.system ?? "" } });
      if (seq !== S.estimateSeq) return;
      if (r.error) { composer.est.textContent = r.error; return; }
      const p = r.plan;
      const nf = S.pending.length;
      composer.est.textContent = `≈ ${money(r.estimate)}${typeof p.seconds === "number" ? ` · ${secondsText(p.seconds)}${p.secondsMeasured ? "" : " (a guess)"}` : ""} on ${p.model.label}${p.auto ? ` · ${S.st.tasks.find((t) => t[0] === p.task)?.[1] ?? p.task}` : ""}${p.effort ? ` · thinking ${p.effort}` : ""}${nf ? ` · ${nf} file${nf === 1 ? "" : "s"}` : ""} · estimate${otherChoice(p)}`;
      composer.est.title = [p.reason, sameQuality(p)].filter(Boolean).join("\n");
    } catch {}
  }

  // The conversation so far, as it is sent: files by id once kept (or with their
  // contents), or just what they are when it is only for an estimate.
  // When a question has two answers (another model was asked), the chat goes on from the newer one.
  function contextMessages(asFile = fileForSend) {
    const out = [];
    for (const m of S.messages) {
      if (!((m.role === "user" && (m.content || m.files?.length)) || (m.role === "assistant" && m.content && m.meta?.status !== "error"))) continue;
      const x = m.files?.length ? { role: m.role, content: m.content, files: m.files.map(asFile) } : { role: m.role, content: m.content };
      if (x.role === "assistant" && out.at(-1)?.role === "assistant") out[out.length - 1] = x;
      else out.push(x);
    }
    return out;
  }

  // action: send (the composer's message), again, another or edit (see the server's chat route).
  async function sendMessage(opts = {}) {
    if (!ready()) { toast("Add a key in Settings first.", "error"); return; }
    const action = opts.action ?? "send";
    let text;
    if (action === "send") {
      text = composer.ta.value.trim();
      if (!text && !S.pending.length) return;
      const files = S.pending;
      S.pending = [];
      renderPending();
      composer.ta.value = "";
      composer.ta.dispatchEvent(new Event("input"));
      store.del(draftKey());
      S.messages.push(files.length ? { role: "user", content: text, files } : { role: "user", content: text });
    }
    const messages = contextMessages();
    if (action === "again" || action === "another") while (messages.length && messages.at(-1).role === "assistant") messages.pop();
    const view = S.messages; // the conversation on screen (another chat, or a new one, is a new list)
    // An answer read back later must be newer than everything on screen now.
    const after = Math.max(0, ...S.messages.map((m) => (typeof m.id === "number" ? m.id : 0)));
    // A new chat gets its name here, so a Stop before the server says it back still knows it.
    const newId = S.chatId ? null : chatIdNew();
    const live = { role: "assistant", content: "", meta: { status: "running" }, live: true, after };
    S.messages.push(live);
    S.live = { ac: new AbortController(), msg: live, started: Date.now() };
    renderMessages(true);
    renderComposerBar();
    const slowTimer = setTimeout(() => { if (S.live?.msg === live && !live.content) { live.meta.slow = true; paintLive(); } }, 20000);
    let streamed = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "x-leanfare": "1", "content-type": "application/json" },
        body: JSON.stringify({ chatId: S.chatId ?? newId, messages, model: opts.model ?? S.model, action, target: opts.target ?? null, compare: opts.compare ?? null, system: S.system ?? "" }),
        signal: S.live.ac.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      streamed = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) onChatEvent(JSON.parse(line.slice(6)), live);
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        live.meta = { ...live.meta, status: "stopped" };
      } else {
        live.meta = { ...live.meta, status: "error", error: String(e?.message ?? e) };
      }
    } finally {
      clearTimeout(slowTimer);
      // The answer stream ended without saying how: the connection broke on the way.
      if (live.meta.status === "running") live.meta = { ...live.meta, status: "error", error: "The connection to Leanfare closed before the answer finished. Try again." };
      const stopped = live.meta.status === "stopped";
      live.live = false;
      S.live = null;
      const here = S.messages === view;
      // Ended before the server said the chat's name: it is the name this page gave it
      // (a chat the server did not make yet is made under that name by the next message).
      if (here && (stopped || streamed) && newId && !S.chatId && S.history) { S.chatId = newId; store.set("chat", newId); }
      // Asked again and nothing new came: the earlier answer stays (the server keeps it too).
      let kept = false;
      const old = opts.replaces;
      if (here && old?.msg.content && old.msg.meta?.status !== "error" && (live.meta.status === "error" || !live.content)) {
        const at = S.messages.indexOf(live);
        if (at >= 0) S.messages.splice(at, 1);
        S.messages.splice(Math.min(old.index, S.messages.length), 0, old.msg);
        kept = true;
        toast(live.meta.status === "error" ? `${live.meta.error ?? "The answer failed."} The earlier answer is kept.` : "Stopped. The earlier answer is kept.", live.meta.status === "error" ? "error" : "done");
      }
      renderMessages();
      renderComposerBar();
      loadChats();
      refreshState();
      setTimeout(refreshState, 600); // the running count settles a moment after the answer ends
      // A stopped answer's cost is recorded by the server; read it back.
      if (here && stopped && !kept && S.chatId && S.history) { const id = S.chatId; setTimeout(() => reloadMeta(live, id), 400); }
    }
  }

  // A chat name made by the page, in the server's own form.
  function chatIdNew() {
    const b = crypto.getRandomValues(new Uint8Array(9));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Reads a stopped answer back from the chat: only one saved after this question
  // was sent, never an older answer.
  async function reloadMeta(live, chatId) {
    try {
      const r = await api(`/api/chats/${chatId}`);
      const mine = [...r.messages].reverse().find((m) => m.role === "assistant" && typeof m.id === "number" && m.id > (live.after ?? 0));
      if (mine?.meta && S.chatId === chatId && S.messages.includes(live)) { live.id = mine.id; live.meta = mine.meta; live.content = mine.content; renderMessages(); }
    } catch {}
  }

  function onChatEvent(e, live) {
    if (e.type === "chat") {
      if (e.history && e.chatId && S.chatId !== e.chatId) {
        store.del(draftKey());
        S.chatId = e.chatId; store.set("chat", e.chatId); loadChats();
      }
      const question = [...S.messages].reverse().find((m) => m.role === "user");
      if (e.userMessageId && question && !question.id) question.id = e.userMessageId; // so it can be edited again
      if (typeof e.userMessageId === "number") live.after = Math.max(live.after ?? 0, e.userMessageId);
      if (e.files?.length) {
        const mine = [...S.messages].reverse().find((m) => m.role === "user" && m.files?.length);
        const unsaved = (mine?.files ?? []).filter((f) => !f.id);
        e.files.forEach((saved, i) => { if (unsaved[i]) unsaved[i].id = saved.id; });
      }
    } else if (e.type === "waiting") { live.meta.waiting = e.message; paintLive(); }
    else if (e.type === "meta") { live.meta = { ...live.meta, ...e.plan, status: "running", waiting: null }; paintLive(); }
    else if (e.type === "delta") { live.content += e.text; paintLiveSoon(); }
    else if (e.type === "thinking") { live.thinking = (live.thinking ?? "") + e.text; live.meta.thinkingChars = live.thinking.length; paintLiveSoon(); }
    else if (e.type === "retry") { live.content = ""; live.thinking = ""; live.meta.thinkingChars = 0; live.meta.retryNote = e.message; paintLive(); } // the answer starts over
    else if (e.type === "error") { live.meta = { ...live.meta, status: "error", error: e.message }; }
    else if (e.type === "done") { live.meta = e.result; live.live = false; }
    else if (e.type === "saved") { live.id = e.messageId; }
    else if (e.type === "notice") { toast(e.message, "error"); }
  }

  let paintQueued = false;
  function paintLiveSoon() { if (!paintQueued) { paintQueued = true; requestAnimationFrame(() => { paintQueued = false; paintLive(); }); } }
  function paintLive() {
    if (!S.live) return;
    const box = $("#messages");
    const index = S.messages.indexOf(S.live.msg);
    const old = box?.querySelector(`.msg.ai[data-i="${index}"]`);
    if (!old) { renderMessages(true); return; }
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    old.replaceWith(messageEl(S.live.msg, index));
    if (nearEnd) box.scrollTop = box.scrollHeight;
  }

  function stopLive() { S.live?.ac.abort(); }

  // The answers to the newest question (they follow the last question of the chat).
  const lastGroup = (index) => S.messages.slice(index + 1).every((x) => x.role !== "user");

  function startAgain(index) {
    const m = S.messages[index];
    if (!m || S.live || !lastGroup(index)) return;
    S.messages.splice(index, 1);
    sendMessage({ action: "again", target: m.id ?? null, model: m.meta?.auto ? "auto" : m.meta?.model?.id ?? S.model, replaces: { index, msg: m } });
  }

  function askAnother(index, model) {
    const m = S.messages[index];
    if (!m || S.live) return;
    const compare = m.meta?.model ? { model: { id: m.meta.model.id, label: m.meta.model.label }, cost: m.meta.cost ?? null } : null;
    sendMessage({ action: "another", target: m.id ?? null, model, compare });
  }

  // What the conversation's files need from a model.
  function filesNeed() {
    const all = S.messages.flatMap((m) => m.files ?? []);
    return { images: all.some((f) => f.kind === "image"), pdfs: all.some((f) => f.kind === "pdf") };
  }

  function anotherPicker(index, meta) {
    const ticked = new Set(S.st.settings.ticked);
    const need = filesNeed();
    const groups = [];
    for (const p of S.st.providers) {
      if (!p.ready) continue;
      const ms = modelsOf(p.id).filter((x) => ticked.has(x.id) && !x.retired && x.id !== meta.model?.id && (!need.images || x.vision) && (!need.pdfs || x.pdf));
      if (ms.length) groups.push(h("optgroup", { label: p.name }, ...ms.map((x) => h("option", { value: x.id, text: `${x.label} · ${x.local || x.free ? "free" : perM(x.input) + " / " + perM(x.output)}` }))));
    }
    if (!groups.length) return null;
    return h("select", { class: "another", "aria-label": "Ask another model", title: "Ask the same question on another model; both answers stay, with both costs", onchange: (e) => { const v = e.target.value; e.target.value = ""; if (v) askAnother(index, v); } },
      h("option", { value: "", text: "Ask another model…" }), ...groups);
  }

  function compareText(meta) {
    const a = meta.compare.cost, b = meta.cost, other = meta.compare.model.label;
    const x = (r) => (r >= 10 ? String(Math.round(r)) : r.toFixed(1));
    if (typeof a !== "number" || typeof b !== "number") return `Compared with ${other}`;
    if (b === 0 && a > 0) return `Free; ${other} cost ${money(a)}`;
    if (a === 0 && b > 0) return `${other} was free`;
    if (a === 0 && b === 0) return `Both free (${other})`;
    const r = a / b;
    if (r >= 1.05) return `${x(r)}× cheaper than ${other}`;
    if (r <= 0.95) return `${x(1 / r)}× the cost of ${other}`;
    return `About the cost of ${other}`;
  }

  function copyText(text) {
    navigator.clipboard?.writeText(text).then(() => toast("Copied.", "done"), () => failed("Could not copy."));
  }

  // Editing a question: change it (and its files), then send it; what came after it goes.
  function editEl(m, index) {
    const ta = h("textarea", { class: "edit-ta", rows: 3, "aria-label": "Edit your message", "data-keep": `edit-${S.chatId ?? "new"}-${m.id ?? index}`, text: m.content });
    const files = (m.files ?? []).slice();
    const filesBox = h("div");
    const drawFiles = () => filesBox.replaceChildren(files.length ? fileChips(files, (i) => { files.splice(i, 1); drawFiles(); }) : null);
    drawFiles();
    const later = S.messages.length - index - 1;
    const cancel = () => { S.editing = null; renderMessages(); };
    const submit = () => {
      const text = ta.value.trim();
      if (!text && !files.length) return;
      if (S.live) { toast("An answer is still being written. Press Esc or Stop to end it first.", "done"); return; }
      S.editing = null;
      S.messages = S.messages.slice(0, index);
      S.messages.push(files.length ? { role: "user", content: text, files } : { role: "user", content: text });
      sendMessage({ action: "edit", target: m.id ?? null });
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    setTimeout(() => { if (document.activeElement !== ta) { ta.focus(); ta.setSelectionRange?.(ta.value.length, ta.value.length); } }, 0);
    return h("div", { class: "msg user editing" }, h("div", { class: "edit-box" }, filesBox, ta,
      h("div", { class: "row" },
        later ? h("span", { class: "warn-text", text: `Sending removes the ${later} message${later === 1 ? "" : "s"} after this one.` }) : null,
        h("span", { class: "grow" }),
        h("button", { class: "btn small", type: "button", text: "Cancel", onclick: cancel }),
        h("button", { class: "btn small primary", type: "button", text: "Send", onclick: submit }))));
  }

  // ---- savings ------------------------------------------------------------------------------------
  async function loadSavings() {
    try {
      S.savings = await api("/api/savings" + (S.month ? `?month=${S.month}` : ""));
      if (S.plans && S.plans.month !== S.savings.month) S.plans = null; // another month: never show this one's numbers under it
      renderSavings();
      if (!S.plans) loadPlans(false).catch(() => {}); // the log files can take a moment: the rest of the page does not wait
      loadTrial();
    } catch (e) { failed(e); }
  }

  // ---- your plans ---------------------------------------------------------------------------------
  const bigTok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : tok(n));
  async function loadPlans(force, signal) {
    const month = S.savings?.month ?? S.month;
    // The plan meter is about now, whatever month is picked; a meter that fails does not hold up the card.
    const [r, meter] = await Promise.all([
      api(`/api/plans?${month ? `month=${month}&` : ""}${force ? "refresh=1" : ""}`, { signal }),
      api("/api/meter", { signal }).catch(() => null),
    ]);
    if (month && S.savings && S.savings.month !== month) return; // the month was changed meanwhile
    S.plans = r;
    S.meter = meter;
    const old = $("#plansCard");
    if (old) old.replaceWith(plansCardEl());
  }

  // "about 234 sessions", "more than 1,000 sessions", "under 1 session"; and a share of the week that
  // never reads 0.0% (a small session is "under 0.1%", not nothing).
  const sessionsText = (n) => n < 1 ? "under 1 session" : n >= 1000 ? "more than 1,000 sessions" : `about ${Math.floor(n).toLocaleString("en-US")} session${Math.floor(n) === 1 ? "" : "s"}`;
  const weekShare = (p) => p < 0.1 ? "under 0.1%" : p < 1 ? `about ${p.toFixed(1)}%` : `about ${Math.round(p)}%`;

  // The plan meter: the plan's two windows, how much of each is used, and what is left in tokens.
  // Dollars of work at API prices only when Settings says to show them.
  const showValue = () => !!S.st?.settings?.showValue;
  const whenShort = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  function leftText(w) {
    const parts = [];
    if (w.tokensLeft) parts.push(`about ${bigTok(w.tokensLeft)} tokens left at your recent mix`);
    if (showValue() && w.left !== null) parts.push(`about ${money(w.left)} of work at API prices${w.leftLo !== null && w.leftHi !== null ? ` (${money(w.leftLo)} to ${money(w.leftHi)})` : ""}`);
    if (!parts.length) return null;
    return `${parts.join(", ")} · ${w.from === "starting estimate" ? "a starting estimate" : `measured from ${w.windows} windows`}`;
  }
  function meterBlock(m) {
    if (!m || !m.windows.length) return null;
    const rows = m.windows.map((w) => h("div", { class: "mt-row" },
      h("span", { class: "n", text: w.kind === "week" ? "This week" : "5 hours" }),
      h("span", { class: "track" + (w.used >= 90 ? " hot" : "") }, h("i", { style: { width: Math.min(100, w.used) + "%" } })),
      h("span", { class: "v", text: `${Math.round(w.used)}% used${w.resets ? ` · resets ${whenShort(w.resets)}` : ""}` }),
      leftText(w) ? h("span", { class: "sub", text: leftText(w) }) : null));
    return h("div", { class: "meter" }, h("div", { class: "mt-head", text: `Right now${m.at ? `, as of ${ago(m.at)}` : ""}` }), ...rows);
  }
  // What the meter knows beyond the two bars: which projects still fit, and use the logs do not show.
  function meterMore(m) {
    if (!m) return [];
    const fits = m.projects.filter((p) => p.sessionsLeft !== null).slice(0, 5).map((p) => h("li", { text: `${p.name}: ${sessionsText(p.sessionsLeft)}${p.pctOfWeek !== null ? ` (a session is ${weekShare(p.pctOfWeek)} of the week)` : ""}` }));
    return [
      fits.length ? h("div", { class: "mt-fits" }, h("b", { text: "What still fits" }), h("ul", {}, ...fits)) : null,
      m.other ? h("p", { class: "pl-note", text: `About ${Math.round(m.other)}% of this week went to use the logs do not show (Claude chats, Cowork, the phone apps).` }) : null,
      m.rough ? h("p", { class: "pl-note", text: "Max 5x was not measured by anyone yet, so this starts from a rough guess until your own windows replace it." }) : null,
    ].filter(Boolean);
  }

  function statuslineRow(st) {
    if (st.broken) return h("p", { class: "pl-note", text: `Claude Code's settings file is not a valid settings file (a JSON object), so Leanfare cannot add its line. Fix ${st.file} first.` });
    return h("div", { class: "row mt-sl" },
      h("span", { class: "grow", text: st.installed ? `Claude's 5 hour and weekly use come from Claude Code's status line${st.keeps ? " (your own line stays first)" : ""}.` : "Add your Claude plan to Claude Code's status line. Leanfare reads the two percentages there, never your words." }),
      runButton(st.installed ? "Remove from the status line" : "Add to the status line", async (signal) => {
        const r = await api("/api/meter/statusline", { body: { on: !st.installed }, signal });
        S.meter = { ...(S.meter ?? {}), statusline: r.statusline };
        toast(r.statusline.installed ? "Added. Claude Code shows it from its next update." : "Removed from Claude Code's status line.", "done");
        const old = $("#plansCard");
        if (old) old.replaceWith(plansCardEl());
      }, "btn small"));
  }

  // Months: "2026-07" reads "Jul 2026"; a plan's months read "since Jul 2026", "Jul to Sep 2026".
  const monthLabel = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const rangeText = (p) => (p.since && p.until ? `${monthLabel(p.since)} to ${monthLabel(p.until)}` : p.since ? `since ${monthLabel(p.since)}` : p.until ? `until ${monthLabel(p.until)}` : "");
  const lastMonths = (n = 36) => { const out = [], d = new Date(); for (let i = 0; i < n; i++) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`); } return out; };
  function monthSelect(value, label, none) {
    const ms = lastMonths();
    if (value && !ms.includes(value)) ms.push(value); // a month from before the list still shows as it is
    const sel = h("select", { "aria-label": label, "data-keep": label }, h("option", { value: "", text: none }), ...ms.map((m) => h("option", { value: m, text: monthLabel(m) })));
    sel.value = value ?? "";
    sel.dataset.start = value ?? ""; // what it was drawn with: a choice made since survives a redraw (keepInputs)
    return sel;
  }
  // The plan of an app Leanfare found: picked in place, with the month it started (the month the app came, at first).
  function planPicker(v) {
    const info = S.st.subscriptions?.[v.provider];
    if (!info) return null;
    const first = v.apps.map((a) => a.first).filter(Boolean).sort()[0] ?? null;
    const name = h("input", { type: "text", placeholder: info.presets.at(-1)?.name ?? info.label, maxlength: "60", autocomplete: "off", "aria-label": `${info.label} plan name, here` });
    const price = moneyInput(null, `${info.label} plan price a month, here`);
    const since = monthSelect(first, `${info.label} plan since, here`, "since always");
    const pick = h("select", { "aria-label": `Pick your ${info.label} plan, here`, onchange: (e) => { const p = info.presets[Number(e.target.value)]; if (p) { name.value = p.name; price.querySelector("input").value = p.price ?? ""; } } },
      h("option", { value: "", text: "Pick a plan…" }), ...info.presets.map((p, i) => h("option", { value: String(i), text: `${p.name}${p.price !== null ? ` · ${money(p.price)}` : ""}` })));
    return h("details", { class: "pl-add" }, h("summary", { text: "Add your plan" }),
      h("div", { class: "row plan-row" }, pick, name, price, since,
        h("button", { class: "btn small", type: "button", text: "Save", onclick: () => patchSettings({ plans: { [v.provider]: { name: name.value, price: price.querySelector("input").value, since: since.value } } }, `${info.label} plan saved.`) })));
  }
  const appsText = (v) => v.apps.map((a) => `${a.name} on this computer${a.first ? `, in use since ${monthLabel(a.first)}` : ""}${a.last && a.last < (S.savings?.month ?? a.last) ? `, last used ${monthLabel(a.last)}` : ""}`).join("; ");

  // One subscription, small: its limits and its tokens first (what a plan is measured in), the rest
  // folded away. Its value at API prices only when Settings says to show it.
  const ratioText = (r) => `${r < 0.05 ? "under 0.1" : r.toFixed(r >= 10 ? 0 : 1)}× what you pay`;
  function planBlock(v) {
    const show = showValue();
    const m = v.logs ? S.meter?.[v.provider] : null;
    const rec = !v.plan && v.recognized ? v.recognized : null; // the plan Codex says you are on
    const named = v.plan?.name ?? rec?.name ?? null;
    const action = v.plan
      ? h("small", { text: `${money(v.plan.price)} a month${rangeText(v.plan) ? ` · ${rangeText(v.plan)}` : ""}` })
      : v.outside
        ? h("small", { text: `${v.outside.name}: ${rangeText(v.outside)}` }) // a plan you entered, for other months
      : rec
        ? rec.price !== null
          ? h("button", { class: "btn small", type: "button", text: "Use this plan", onclick: () => patchSettings({ plans: { [v.provider]: { name: rec.name, price: rec.price } } }, `${v.label} plan saved.`) })
          : h("button", { class: "btn small", type: "button", text: "Enter its price", onclick: () => setTab("settings") })
        : v.logs ? h("button", { class: "btn small", type: "button", text: "Enter your plan", onclick: () => setTab("settings") }) : null;
    const head = h("div", { class: "pl-head" }, h("b", { text: v.label }), named ? h("span", { class: "pl-name", text: named }) : null,
      rec ? h("small", { text: `· ${v.logs} says you are on this plan` }) : null, h("span", { class: "grow" }), action);
    const limits = v.limitsText ? h("div", { class: "sub", text: `Its limits: ${v.limitsText}.` }) : null;
    const tile = (...kids) => h("div", { class: "pl" }, head, ...kids.filter(Boolean));
    if (!v.logs) return tile(v.apps.length ? h("div", { class: "sub", text: appsText(v) + "." }) : null, limits,
      !v.plan && !v.outside ? planPicker(v) : null,
      h("p", { class: "pl-note" }, `${v.label} keeps no usage numbers on this computer, so Leanfare cannot count your use. `,
        v.usageUrl ? h("a", { href: v.usageUrl, target: "_blank", rel: "noopener noreferrer", text: `See it on ${v.label}'s own page ↗` }) : null));
    const bars = meterBlock(m);
    const codexLine = v.limits ? h("div", { class: "sub", text: `${v.logs} limits at its last message (${ago(v.limits.at)}): ${v.limits.windows.map((w) => `${Number(w.used.toFixed(1))}% of the ${w.label} used${w.resets ? `, resets ${whenShort(w.resets)}` : ""}`).join("; ")}` }) : null;
    const codex = bars ? null : codexLine; // the bars say it already: the last message's numbers go in the fold
    if (!v.found) return tile(bars, limits, h("p", { class: "pl-note", text: `No ${v.logs} log files found on this computer.` }));
    if (!v.tokens) return tile(bars, codex, limits, h("p", { class: "pl-note", text: `No ${v.logs} use in this month's log files.` }));
    const tok = h("div", { class: "pl-tok" }, h("span", { class: "big", text: bigTok(v.tokens) }),
      h("span", { class: "sub", text: `tokens ${!S.month || S.month === lastMonths(1)[0] ? "this month" : `in ${monthLabel(v.month)}`} in ${v.logs}: ${bigTok(v.cached)} read from the cache, ${bigTok(v.input)} in, ${bigTok(v.output)} out` }));
    const value = show ? h("div", { class: "pl-val" }, h("span", { class: "sub", text: `If this were pay per use: ${money(v.value)} at API prices` }),
      v.ratio !== null ? h("span", { class: "chip " + (v.ratio >= 1 ? "good" : ""), text: ratioText(v.ratio) }) : null) : null;
    const models = [...v.models].sort((a, b) => b.tokens - a.tokens);
    const maxT = Math.max(...models.map((x) => x.tokens), 0);
    const byModel = h("div", { class: "bars" }, ...models.slice(0, 5).map((x) => h("div", { class: "barrow", title: x.id ? `${x.model}\npriced as ${x.id}` : `${x.model}\nno listed price` },
      h("span", { class: "n", text: x.label }), h("span", { class: "v", text: `${bigTok(x.tokens)} tokens${show ? ` · ${x.value === null ? "no listed price" : money(x.value)}` : ""}` }),
      h("span", { class: "track" }, h("i", { style: { width: (maxT > 0 ? (x.tokens / maxT) * 100 : 0) + "%" } })))));
    const more = h("details", { class: "pl-more" }, h("summary", { text: "By model, and what still fits" }),
      byModel,
      models.length > 5 ? h("div", { class: "sub", text: `and ${models.length - 5} more model${models.length - 5 === 1 ? "" : "s"}` }) : null,
      ...meterMore(m), bars ? codexLine : null, limits,
      show && v.unpricedTokens ? h("p", { class: "pl-note", text: `${bigTok(v.unpricedTokens)} tokens are on models with no listed price and count as $0 here.` }) : null);
    return tile(bars, codex, tok, value, more);
  }

  function plansCardEl() {
    const P = S.plans;
    const card = h("div", { class: "card plans", id: "plansCard" });
    card.append(h("h3", {}, "Your subscriptions", h("small", { text: "a fixed price, with limits" }), h("span", { class: "grow" }),
      P ? runButton("Look again", async (signal) => { await loadPlans(true, signal); toast("Log files read again.", "done"); }, "btn small") : null));
    if (!P) { card.append(h("div", { class: "empty", text: "Reading the Claude Code and Codex log files on this computer…" })); return card; }
    const shown = P.providers.filter((v) => v.plan || v.found || v.apps?.some((a) => a.used));
    if (!shown.length) {
      card.append(h("p", { class: "pl-note", text: "Enter your Claude, ChatGPT or other plan to see its limits, and the tokens your Claude Code and Codex use." }),
        h("div", { class: "row" }, h("button", { class: "btn small", type: "button", text: "Enter a plan", onclick: () => setTab("settings") })));
    } else card.append(h("div", { class: "pl-grid" }, ...shown.map(planBlock)));
    if (S.meter?.statusline) card.append(statuslineRow(S.meter.statusline));
    card.append(h("p", { class: "fine", text: P.note }));
    return card;
  }

  // What Leanfare did for your apps this month (savings.ts: work): the hand offs and plan parts, what stayed out
  // of the app's plan, the cost, how the app graded the answers and what the checks found; then the last few.
  const WHERE = { local: "this computer", free: "free", plan: "your ChatGPT plan", paid: "paid" };
  const pctText = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
  const plural = (n, one, many = one + "s") => `${num(n)} ${n === 1 ? one : many}`;
  function whenText(iso) {
    const d = new Date(iso), today = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return `Today ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  function workCardEl(w, d) {
    if (!w || !w.tasks) return null;
    const graded = w.grades.good + w.grades.partly + w.grades.wrong;
    const checked = w.checks.passed + w.checks.failed;
    const places = [["free", "free"], ["local", "on this computer"], ["plan", "on your ChatGPT plan"], ["paid", "paid"]].filter(([k]) => w.where[k]).map(([k, t]) => `${num(w.where[k])} ${t}`).join(" · ");
    const tiles = h("div", { class: "cards6" },
      stat("kept", "Kept out of your plans", `${tokShort(w.kept)} tokens`, `read by Leanfare's models, not your apps · ${num(w.back)} came back`, w.kept > 0 ? "good" : ""),
      stat("workCost", "Cost of that work", money(w.cost), places),
      stat("quality", "Quality", graded ? `${num(w.grades.good)} of ${num(graded)} good` : "Not graded yet",
        graded ? `${num(w.grades.partly)} partly · ${num(w.grades.wrong)} wrong · graded by your apps` : "your app grades the answers it uses", graded ? (w.grades.good === graded ? "good" : "") : "small"),
      stat("checked", "Checked", checked ? `${num(w.checks.passed)} of ${num(checked)} passed` : "None yet",
        w.checks.again ? `${num(w.checks.again)} ${w.checks.again === 1 ? "was" : "were"} asked again one tier up` : "a stronger model checks a sample", checked ? (w.checks.failed ? "" : "good") : "small"),
      stat("sideBySide", "Side by side", w.side?.compared ? `${num(w.side.asGood)} of ${num(w.side.compared)} as good` : "None yet",
        w.side?.compared ? "as the top model's answer, judged blind" : "the top model answers a sample too", w.side?.compared ? (w.side.asGood === w.side.compared ? "good" : "") : "small"));
    const chips = (r) => r.grades.length ? r.grades.map((g) => h("span", { class: `chip ${g === "good" ? "good" : g === "wrong" ? "bad" : "warn"}`, text: g }))
      : r.checks.length ? r.checks.map((c) => h("span", { class: `chip ${c === "pass" ? "good" : "bad"}`, text: c === "pass" ? "check passed" : "check failed" }))
      : [h("span", { class: "none", text: "not graded" })];
    const what = (r) => `${r.plan ? `Plan, ${plural(r.parts, "part")} here: ` : "Hand off: "}${r.kinds.join(", ")}${r.files ? ` · ${plural(r.files, "file")}` : ""}`;
    const table = h("table", { class: "trial-table work-table" },
      h("thead", {}, h("tr", {}, ...["When", "What", "Where it ran", "Kept out", "Cost", "Quality"].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...w.recent.map((r) => h("tr", {},
        h("td", { "data-label": "When", text: whenText(r.ts) }),
        h("td", { "data-label": "What", class: "what", text: what(r) }),
        h("td", { "data-label": "Where", text: r.models.map((m) => `${WHERE[m.where] ?? m.where}: ${m.label}`).join(" · ") }),
        h("td", { "data-label": "Kept out", text: `${tokShort(r.kept)} tokens` }),
        h("td", { "data-label": "Cost", text: money(r.cost) }),
        h("td", { "data-label": "Quality" }, ...chips(r))))));
    const again = d && d.reruns ? `, ${num(d.failed)} failed and ${d.reruns === d.failed ? (d.failed === 1 ? "was" : "were") : `${num(d.reruns)} ${d.reruns === 1 ? "was" : "were"}`} asked again one tier up` : d && d.failed ? `, ${num(d.failed)} failed` : "";
    const checks = d && d.passed + d.failed > 0
      ? `Checks: ${num(d.passed + d.failed + d.unclear)} run, ${num(d.passed)} passed (${pctText(d.passRate)}, 90% range ${pctText(d.passLo)} to ${pctText(d.passHi)})${again}.${d.weighted !== null && d.passed + d.failed >= 5 ? ` Weighted by each answer's chance of being checked, about ${pctText(d.weighted)} of all answers would pass.` : ""}`
      : "";
    return h("div", { class: "card work", id: "workCard" },
      h("h3", {}, "What Leanfare did for your apps", h("span", { class: "grow" }), h("small", { text: `${plural(w.tasks, "task")} this month, through plan and delegate` })),
      tiles, table,
      h("p", { class: "fine", text: `${checks ? checks + " " : ""}Kept out counts what your app did not have to read; the thinking and writing it did not have to do comes on top. No words are kept, only sizes, models and grades.` }));
  }

  // ---- the delegate trial (trial.ts) ------------------------------------------------------------
  // Before Claude hands work over on its own: questions with known answers, at three efforts.
  async function loadTrial() {
    try { S.trial = await api("/api/trial"); } catch { if (S.trial?.running) pollTrial(); return; } // a missed look: try again
    const old = $("#trialCard");
    if (old) old.replaceWith(trialCardEl());
    if (S.trial.running) pollTrial();
  }
  let trialTimer = null;
  function pollTrial() {
    clearTimeout(trialTimer);
    trialTimer = setTimeout(async () => {
      const was = S.trial?.running;
      await loadTrial();
      if (was && S.trial && !S.trial.running) { toast("The trial is done.", "done"); loadSavings(); }
    }, 2000);
  }
  const secsShort = (x) => (x === null || x === undefined ? "—" : x < 1.5 ? "about a second" : x < 90 ? `${Math.round(x)} s` : `${(x / 60).toFixed(1)} min`);
  function trialCardEl() {
    const t = S.trial;
    const card = h("div", { class: "card trial", id: "trialCard" }, h("h3", {}, "Try the delegate first", h("span", { class: "grow" }), h("small", { text: "the trial" })));
    if (!t) { card.append(h("p", { class: "fine", text: "Loading…" })); return card; }
    const r = t.report;
    const e = t.estimate;
    const about = "10 questions with known answers about files Leanfare makes up (a log, a settings file, orders, code, notes, a long access log), each asked at low, medium and high effort the way Claude asks. Nothing of yours is sent.";
    if (t.running && r) {
      card.append(h("p", { text: `Answer ${r.done} of ${r.total}…` }), trialTable(r),
        runButton("Stop the trial", async () => { S.trial = await api("/api/trial/stop", { body: {} }); toast("Trial stopped.", "done"); loadTrial(); }, "btn small"));
      return card;
    }
    const startBtn = (label) => runButton(label, async () => {
      S.trial = await api("/api/trial/start", { body: {} });
      const old = $("#trialCard");
      if (old) old.replaceWith(trialCardEl());
      pollTrial();
    }, "btn small primary");
    const estText = !e ? "" : !e.models.low ? (e.error ?? "Add a key and tick a model first: the trial asks the models you ticked.")
      : `${e.estimate === 0 ? "$0 on the models you ticked now (free)" : e.estimate === null ? "On the models you ticked now" : `About ${money(e.estimate)} on the models you ticked now`}${typeof e.seconds === "number" ? `, about ${Math.max(1, Math.round(e.seconds / 60))} min` : ""}: ${["low", "medium", "high"].map((k) => `${k} ${labelOf(e.models[k])}`).join(", ")}.`;
    if (!r) {
      card.append(h("p", { text: `Before Claude hands work to Leanfare on its own, see how your models do. ${about}` }), estText ? h("p", { class: "fine", text: estText }) : null,
        e?.models.low ? startBtn("Run the trial") : null);
      return card;
    }
    card.append(h("p", { class: "fine", text: `${r.status === "done" ? "Last run" : `Last run, ${r.status} after ${r.done} of ${r.total} answers`}: ${ago(r.finished ?? r.started)}, Leanfare ${r.version}.` }), trialTable(r));
    const c = r.checks;
    if (c.passed + c.failed + c.other > 0) card.append(h("p", { class: "fine", text: `Checks at high effort: ${c.passed} passed, ${c.failed} failed${c.failed ? ` (right after asking again: ${c.fixed})` : ""}; wrong answers the check passed: ${c.missed}${c.other ? `; not checked or unclear: ${c.other}` : ""}.` }));
    if (r.lowest) card.append(h("div", { class: "trial-verdict" },
      h("p", { text: `${cap(r.lowest)} effort passes (at most one miss): Claude can hand reading work to Leanfare at effort ${r.lowest}. For Claude Code to do it on its own, add this line to CLAUDE.md:` }),
      h("code", { text: r.claudeLine }),
      h("button", { class: "btn small", type: "button", text: "Copy the line", onclick: () => copyText(r.claudeLine) })));
    else if (r.status === "done") card.append(h("p", { text: "No effort passed (at most one miss): keep checking what the delegate hands back, or tick stronger models and run the trial again." }));
    if (r.misses.length) card.append(h("details", {}, h("summary", { text: `Wrong answers (${r.misses.length})` }),
      h("ul", {}, ...r.misses.map((m) => h("li", { text: `${m.effort} · ${m.what}: said "${m.said}", known ${m.known}` })))));
    if (r.errors.length) card.append(h("details", {}, h("summary", { text: `No answer (${r.errors.length})` }),
      h("ul", {}, ...r.errors.map((x) => h("li", { text: `${x.effort} · ${x.q}: ${x.error}` })))));
    card.append(h("div", { class: "row trial-share" },
      h("a", { class: "btn small", href: r.share.url, target: "_blank", rel: "noopener noreferrer", text: "Share on GitHub" }),
      h("button", { class: "btn small", type: "button", text: "Copy the results", onclick: () => copyText(`${r.share.title}\n\n${r.share.body}`) }),
      h("span", { class: "grow" }),
      e?.models.low ? startBtn("Run again") : null),
      h("p", { class: "fine", text: "Share opens a GitHub issue with these numbers filled in; you read it and press Submit yourself. Nothing is sent on its own." }),
      estText && e?.models.low ? h("p", { class: "fine", text: `Again: ${estText.charAt(0).toLowerCase()}${estText.slice(1)}` }) : null);
    return card;
  }
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const labelOf = (id) => { for (const ms of Object.values(S.st?.models ?? {})) { const m = ms.find((x) => x.id === id); if (m) return m.label; } return id ?? "none"; };
  function trialTable(r) {
    const V = { passes: "passes", "does not pass": "does not pass", "not decided": "" };
    return h("table", { class: "trial-table" },
      h("thead", {}, h("tr", {}, ...["Effort", "Right", "Half took under", "Cost", "Models", ""].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...r.arms.map((a) => h("tr", {},
        h("td", { text: a.label }),
        h("td", { text: a.asked ? `${a.right} of ${a.answered}${a.answered < a.asked ? ` (${a.asked - a.answered} no answer)` : ""}` : "—" }),
        h("td", { text: secsShort(a.medianSeconds) }),
        h("td", { text: a.asked ? money(a.cost) : "—" }),
        h("td", { text: a.models.map((m) => `${m.label}${a.models.length > 1 ? ` ×${m.count}` : ""}`).join(", ") || "—" }),
        h("td", { class: a.verdict === "passes" ? "good" : a.verdict === "does not pass" ? "bad" : "", text: a.asked ? V[a.verdict] : "" })))));
  }

  function stat(key, label, value, sub, cls = "") {
    const def = S.savings.definitions[key];
    return h("div", { class: "stat" },
      h("div", { class: "lbl" }, label, h("button", { type: "button", "aria-label": `What "${label}" means`, title: "What this number means", text: "i", onclick: () => { S.defOpen[key] = !S.defOpen[key]; renderSavings(); } })),
      h("div", { class: "val " + cls, text: value }),
      h("div", { class: "sub" }, sub),
      S.defOpen[key] ? h("div", { class: "def", text: def }) : null);
  }

  // ---- the report (report.ts) ------------------------------------------------------------------------
  // What Leanfare did for your apps over a span of time, with filters: four tiles, tokens over time, work by model,
  // quality by kind of work, and each prompt with the parts it handed off. Numbers only, as everywhere.
  const RP_RANGES = [["1h", "1 h"], ["6h", "6 h"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["year", "Year"], ["custom", "Custom…"]];
  const RP_KIND = { read: "Reading", write: "Drafting", reason: "Working out", search: "Search", other: "Other" };
  const RP_WHERE = { local: "this computer", free: "free", plan: "ChatGPT plan", paid: "paid" };
  const RP_GRADE = { good: "✓ good", partly: "~ partly", wrong: "× wrong" };
  const rpProvider = (id) => (id === "local" ? "This computer" : id === "codex" ? "ChatGPT plan (Codex)" : S.st?.providers?.find((p) => p.id === id)?.name ?? id);
  const shortPlan = (name) => (name ? name.replace(/^(Claude|ChatGPT)\s+/i, "") : null);
  S.report = S.report ?? { q: { range: "7d" }, data: null, open: {}, seq: 0, shown: 20 };

  async function loadReport() {
    const seq = ++S.report.seq;
    const params = new URLSearchParams(Object.entries(S.report.q).filter(([, v]) => v));
    try {
      const d = await api("/api/report?" + params);
      if (seq !== S.report.seq) return; // a newer filter was picked meanwhile
      S.report.data = d; S.report.error = null;
    } catch (e) { if (seq !== S.report.seq) return; S.report.error = String(e?.message ?? e); }
    S.report.loading = false;
    const old = $("#reportCard");
    if (old) old.replaceWith(reportCardEl());
  }
  function setReport(patch) {
    Object.assign(S.report.q, patch);
    S.report.loading = true; S.report.shown = 20;
    const old = $("#reportCard");
    if (old) old.replaceWith(reportCardEl());
    loadReport();
  }

  function reportCardEl() {
    if (!S.report.data && !S.report.error && !S.report.loading) { S.report.loading = true; loadReport(); }
    const d = S.report.data, q = S.report.q;
    const pick = (label, key, items) => h("select", { "aria-label": label, onchange: (e) => setReport({ [key]: e.target.value || null }) },
      h("option", { value: "", text: label }), ...items.map(([v, t]) => h("option", { value: v, text: t, selected: q[key] === v })));
    const o = d?.options ?? { apps: [], providers: [], models: [], kinds: [], threads: [] };
    const keep = (list, v) => (v && !list.some(([x]) => x === v) ? [...list, [v, v]] : list); // a picked value stays in its list
    const custom = q.range === "custom" ? h("span", { class: "rp-custom" },
      h("input", { type: "date", "aria-label": "From", value: (q.from ?? "").slice(0, 10) }), h("span", { text: "to" }), h("input", { type: "date", "aria-label": "To", value: (q.to ?? "").slice(0, 10) }),
      h("button", { class: "btn small", type: "button", text: "Show", onclick: (e) => {
        const [a, b] = [...e.target.parentElement.querySelectorAll("input")].map((i) => i.value);
        if (!a || !b) { toast("Pick both days first.", "error"); return; }
        setReport({ from: new Date(a + "T00:00:00").toISOString(), to: new Date(new Date(b + "T00:00:00").getTime() + 86_400_000).toISOString() });
      } })) : null;
    const filters = h("div", { class: "rp-filters" },
      h("div", { class: "seg", role: "group", "aria-label": "Time span" }, ...RP_RANGES.map(([v, t]) => h("button", { type: "button", class: q.range === v ? "on" : "", text: t, "aria-pressed": String(q.range === v),
        onclick: () => (v === "custom" ? setReport({ range: "custom", from: q.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString(), to: q.to ?? new Date().toISOString() }) : setReport({ range: v, from: null, to: null })) }))),
      custom,
      pick("All apps", "app", keep(o.apps.map((a) => [a, a]), q.app)),
      pick("All providers", "provider", keep(o.providers.map((p) => [p, rpProvider(p)]), q.provider)),
      pick("All models", "model", keep(o.models.map((m) => [m.id, m.label]), q.model)),
      pick("All kinds", "kind", keep(o.kinds.map((k) => [k, RP_KIND[k] ?? k]), q.kind)),
      pick("All threads", "thread", keep(o.threads.map((t) => [t.id, `${t.project ?? "Claude Code"} · ${new Date(t.first).toLocaleDateString(undefined, { month: "short", day: "numeric" })} (${t.prompts})`]), q.thread)),
      h("span", { class: "grow" }),
      d?.prompts?.length ? h("button", { class: "btn small", type: "button", text: "Export CSV", onclick: () => download(`leanfare-report-${new Date().toISOString().slice(0, 10)}.csv`, reportCsv(d), "text/csv") }) : null);
    const body = S.report.error ? h("div", { class: "empty", text: `The report could not be read: ${S.report.error}` })
      : !d ? h("div", { class: "empty", text: "Reading the report…" })
      : !d.prompts.length && !d.speed?.length ? h("div", { class: "empty", text: "Nothing in this span yet. Hand offs and plan parts from your apps, and Claude Code's prompts, show here." })
      : !d.prompts.length ? h("div", { class: "rp-body" }, h("div", { class: "empty", text: "No prompts in this span yet. Hand offs and plan parts from your apps, and Claude Code's prompts, show here. The models' speed so far:" }), reportSpeedEl(d))
      : h("div", { class: "rp-body" + (S.report.loading ? " busy" : "") }, reportTiles(d), reportChartEl(d),
          h("div", { class: "rp-two" }, reportModelsEl(d), reportKindsEl(d)), reportSpeedEl(d), reportPromptsEl(d), reportHowEl(d));
    return h("section", { class: "rp", id: "reportCard" },
      h("div", { class: "sv-head" }, h("h2", { text: "Report" }), h("span", { class: "muted", text: "what Leanfare did for your apps" })),
      filters, body);
  }

  function rtile(label, value, sub, cls = "") { return h("div", { class: "rp-tile" }, h("div", { class: "lbl" }, label), h("div", { class: "val " + cls, text: value }), h("div", { class: "sub" }, sub)); }
  // How sure a number is: measured from records, an estimate with its method and range, or not known.
  const BADGE = { m: ["b-m", "measured"], e: ["b-e", "estimate"], n: ["b-n", "not known"] };
  const badge = (k) => h("span", { class: "badge " + BADGE[k][0], text: BADGE[k][1] });
  // The app the report is about, for its words: Claude (its chats, Cowork and Claude Code), one other app, or your app.
  function appWord(d) {
    const apps = [...new Set(d.prompts.map((p) => p.app))];
    return apps.length && apps.every((a) => /^Claude/.test(a)) ? "Claude" : apps.length === 1 && apps[0] !== "Unknown app" ? apps[0] : "Your app";
  }
  const approx = (n) => `≈ ${tokShort(Math.max(0, n))}`;
  function reportTiles(d) {
    const t = d.tiles, app = appWord(d), b = t.both, o = t.outside, q = t.three;
    const apps = t.own.byApp.map((a) => (a.measured ? `${a.app}, from its own files` : [h("span", { text: `${a.app}: ` }), h("span", { class: "nk", text: "not known" })]));
    const sep = (xs) => xs.flatMap((x, i) => (i ? [" · ", x] : [x]));
    const share = (n, of) => (of ? n / of : null);
    const qrow = (label, s, none) => [h("span", { text: label }), h("span", { class: "bar" }, h("i", { style: { width: `${Math.round((s ?? 0) * 100)}%` } })), s === null ? h("span", { class: "nk", text: none }) : h("span", { text: `${pctText(s)} good` })];
    return h("div", { class: "rp-tiles" },
      rtile([`Saved for ${app} `, badge(b ? "e" : "n")], b ? approx(b.saved.mid) : "Not known",
        b ? `${app} alone ≈ ${tokShort(b.alone.mid)}, minus the hand offs' own cost ≈ ${tokShort(b.spent)} (the tasks, and the answers read back). Range ${tokShort(Math.max(0, b.saved.low))} to ${tokShort(Math.max(0, b.saved.high))}.` : "Nothing handed off in this span.", b ? "est" : ""),
      rtile(["Outside models used ", badge(o.measured ? "m" : "n")], o.measured ? `${tokShort(o.read + (o.thought ?? 0) + o.wrote)} tokens` : "Not measured yet",
        [o.measured ? `${tokShort(o.read)} read · ${o.thought === null ? "thinking not split" : `${tokShort(o.thought)} thinking`} · ${tokShort(o.wrote)} written · ` : "",
          `${money(t.cost.usd)}${t.cost.freeShare === 1 ? ", all on free models" : t.cost.freeShare !== null ? `, ${pctText(t.cost.freeShare)} of parts free` : ""}`,
          o.notMeasured ? ` · ${plural(o.notMeasured, "older part")} not measured` : ""]),
      rtile([`${app}'s own use `, badge(t.own.measured ? "m" : "n")], t.own.measured ? `${tokShort(t.own.fresh)} new tokens` : "Not known",
        [sep(apps), t.own.cached ? ` · ${tokShort(t.own.cached)} more read again from the cache` : ""]),
      h("div", { class: "rp-tile" }, h("div", { class: "lbl", text: "Quality, three ways" }),
        h("div", { class: "q3" },
          qrow("Outside answers", share(q.outside.good, q.outside.graded), "not graded"),
          qrow("Together", share(q.together.good, q.together.graded), "not graded"),
          qrow(`${app} alone`, share(q.alone.good, q.alone.graded), "not known")),
        h("div", { class: "sub", text: `${plural(q.outside.graded, "outside answer")} graded, ${plural(q.together.graded, "prompt")} graded together, ${plural(q.alone.sampled, "sampled run")} of ${app} alone` })));
  }

  // Tokens over time, drawn at the width it gets: kept out by Leanfare against what your apps used (new tokens).
  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    for (const k of kids.flat(Infinity)) if (k) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }
  const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v); };
  function stepLabel(iso, step, long) {
    const d = new Date(iso);
    if (step < 86_400_000) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + (long ? ` · ${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}` : "");
    if (step < 7 * 86_400_000) return long ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
    return (long ? "Week of " : "") + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function reportChartEl(d) {
    const box = h("div", { class: "rp-chart" });
    const draw = () => drawLine(box, d, Math.max(280, box.clientWidth || 720));
    const RO = window.ResizeObserver;
    if (RO) { let w = 0; new RO(() => { if (box.clientWidth && box.clientWidth !== w) { w = box.clientWidth; draw(); } }).observe(box); }
    draw();
    const known = d.tiles.own.measured > 0;
    return h("div", { class: "card rp-card" }, h("h3", { text: "Tokens over time" }),
      h("p", { class: "muted", text: known ? "What Leanfare's models read so your apps did not, against what your apps used themselves (new tokens). Hover for both." : "What Leanfare's models read so your apps did not. Your apps here do not say what they used themselves." }),
      h("div", { class: "rp-legend" }, h("span", { class: "k1" }, "Kept out by Leanfare"), known ? h("span", { class: "k2" }, "Used by your apps (measured)") : null),
      box);
  }
  function drawLine(box, d, W) {
    const H = 220, L = 46, R = 54, T = 10, B = 26, pw = W - L - R, ph = H - T - B;
    const s = d.series, n = s.length, known = d.tiles.own.measured > 0;
    const max = niceMax(Math.max(...s.map((p) => Math.max(p.kept, known ? p.used : 0)), 0));
    const x = (i) => L + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw), y = (v) => T + ph - (v / max) * ph;
    const line = (key) => s.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => [svg("line", { x1: L, x2: L + pw, y1: y(max * f), y2: y(max * f), class: f ? "grid" : "axis" }), svg("text", { x: L - 6, y: y(max * f) + 4, "text-anchor": "end", class: "tick" }, tokShort(max * f))]);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 90))));
    const xt = s.map((p, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2) ? svg("text", { x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", class: "tick" }, stepLabel(p.at, d.step, false)) : null);
    const last = s[n - 1];
    const ends = [svg("text", { x: L + pw + 6, y: y(last.kept) + 4, class: "endlab" }, tokShort(last.kept)), known ? svg("text", { x: L + pw + 6, y: y(last.used) + 4 + (Math.abs(y(last.used) - y(last.kept)) < 12 ? (last.used >= last.kept ? -8 : 8) : 0), class: "endlab" }, tokShort(last.used)) : null];
    const cross = svg("line", { y1: T, y2: T + ph, class: "cross", visibility: "hidden" });
    const dot1 = svg("circle", { r: 4, class: "d1", visibility: "hidden" }), dot2 = svg("circle", { r: 4, class: "d2", visibility: "hidden" });
    const area = svg("path", { d: `${line("kept")}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`, class: "a1" });
    const hit = svg("rect", { x: L, y: T, width: pw, height: ph, fill: "transparent" });
    const chart = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Tokens over time" }, grid, area, known ? svg("path", { d: line("used"), class: "l2" }) : null, svg("path", { d: line("kept"), class: "l1" }), xt, ends, cross, dot1, dot2, hit);
    const tip = h("div", { class: "rp-tip", hidden: true });
    const show = (cx) => {
      const i = Math.max(0, Math.min(n - 1, Math.round(((cx - L) / pw) * (n - 1))));
      const p = s[i];
      for (const [el, v] of [[dot1, p.kept], [dot2, p.used]]) { el.setAttribute("cx", x(i)); el.setAttribute("cy", y(v)); el.setAttribute("visibility", el === dot2 && !known ? "hidden" : "visible"); }
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      const share = p.kept + p.used > 0 && known ? ` (${pctText(p.kept / (p.kept + p.used))})` : "";
      tip.replaceChildren(h("div", { class: "when", text: stepLabel(p.at, d.step, true) }),
        known ? h("div", { class: "r2" }, h("b", { text: tokShort(p.used) }), " used by your apps") : null,
        h("div", { class: "r1" }, h("b", { text: tokShort(p.kept) }), ` kept out${share}`));
      tip.hidden = false;
      tip.style.left = `${Math.min(W - 190, Math.max(0, x(i) + 10))}px`;
    };
    const at = (e) => { const r = chart.getBoundingClientRect(); return ((e.touches?.[0]?.clientX ?? e.clientX) - r.left) * (W / (r.width || W)); };
    hit.addEventListener("mousemove", (e) => show(at(e)));
    hit.addEventListener("touchstart", (e) => show(at(e)), { passive: true });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; for (const el of [cross, dot1, dot2]) el.setAttribute("visibility", "hidden"); });
    box.replaceChildren(chart, tip);
  }

  function reportModelsEl(d) {
    const max = Math.max(...d.byModel.map((m) => m.read), 1);
    const dot = (g) => (g === null ? "none" : g >= 0.8 ? "good" : g >= 0.5 ? "warn" : "bad");
    const total = d.byModel.reduce((a, m) => a + m.read, 0), parts = d.byModel.reduce((a, m) => a + m.parts, 0);
    return h("div", { class: "card rp-card" }, h("h3", { text: "Work by model" }), h("p", { class: "muted", text: "Tokens each model read for your apps, its parts, and how good its answers were." }),
      h("div", { class: "rp-bars" }, ...d.byModel.map((m) => h("div", { class: "rp-bar", title: `${m.label}: ${num(m.read)} tokens read, ${plural(m.parts, "part")}, ${money(m.cost)}` },
        h("span", { class: "nm" }, h("span", { text: m.label }), h("small", { text: m.where === "paid" ? money(m.cost) : RP_WHERE[m.where] })),
        h("span", { class: "track" }, h("i", { style: { width: `${Math.max(1.5, (m.read / max) * 100)}%` } })),
        h("span", { class: "v", text: tokShort(m.read) }),
        h("span", { class: "parts", text: plural(m.parts, "part") }),
        h("span", { class: "q" }, h("i", { class: "dot " + dot(m.goodShare) }), m.goodShare === null ? "not graded" : `${pctText(m.goodShare)} good`)))),
      h("p", { class: "fine", text: `All models: ${tokShort(total)} tokens read for your apps · ${plural(parts, "part")}. A model graded below good too often for a kind of work is moved down for it.` }));
  }

  function reportKindsEl(d) {
    return h("div", { class: "card rp-card" }, h("h3", { text: "Quality by kind of work" }),
      h("p", { class: "muted", text: "Each answer's grade: your app's, else a blind check's. Not graded answers are left out of the bar." }),
      ...d.byKind.map((k) => {
        const g = k.good + k.partly + k.wrong;
        return h("div", { class: "rp-kind" },
          h("span", { class: "nm" }, h("b", { text: RP_KIND[k.kind] ?? k.kind }), h("small", { text: plural(k.parts, "part") })),
          h("span", { class: "stack", role: "img", "aria-label": `${k.good} good, ${k.partly} partly, ${k.wrong} wrong` },
            g ? [["good", k.good], ["warn", k.partly], ["bad", k.wrong]].filter(([, v]) => v).map(([c, v]) => h("i", { class: c, style: { width: `${(v / g) * 100}%` } })) : h("i", { class: "none", style: { width: "100%" } })),
          h("span", { class: "meta" }, h("span", { text: g ? `${k.good} good · ${k.partly} partly · ${k.wrong} wrong` : "not graded yet" }), h("span", { class: "best", text: k.best ? `best: ${k.best.label}` : "" })));
      }));
  }

  // Speed, failures, cost and quality per model (0.10): every call in the span. A dot for each model (time for an
  // answer against how often it was graded good), and a table with the numbers behind it.
  const SP_FAIL = { busy: "busy", limit: "rate limited", timeout: "timed out", unreachable: "could not be reached", server: "error on its side", refused: "refused", cut: "cut off or empty", other: "other errors" };
  const spSec = (v) => (v === null || v === undefined ? "—" : v < 10 ? `${v} s` : v < 120 ? `${Math.round(v)} s` : `${Math.round(v / 60)} min`);
  const spFails = (m) => Object.keys(SP_FAIL).filter((k) => m.fails?.[k]).map((k) => `${m.fails[k]} ${SP_FAIL[k]}`).join(" · ");
  const spWhere = (m) => (m.where === "local" ? "this computer · Ollama" : `${RP_WHERE[m.where] ?? m.where} · ${rpProvider(m.provider)}`);
  function spNow(m) {
    const notes = [];
    if (m.movedDown?.length) notes.push(`moved down for ${m.movedDown.map((k) => (RP_KIND[k] ?? k).toLowerCase()).join(" and ")} (graded below good too often)`);
    if (m.rest) {
      const until = new Date(m.rest.until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const wake = async (e) => {
        e.target.disabled = true;
        try { await api("/api/rest/end", { body: { model: m.id } }); } catch {}
        loadReport();
      };
      return [h("span", { class: "chip warn", text: `resting until ${until}` }),
        h("span", { class: "tiny", text: `${m.rest.why[0].toUpperCase()}${m.rest.why.slice(1)}. Auto picks others until then.${notes.length ? ` Also ${notes.join("; ")}.` : ""}` }),
        h("button", { class: "btn small", type: "button", text: "Try it now", onclick: wake })];
    }
    if (m.noQuota) { // your key has no quota for it (quota.ts): left out until Try again or a new key
      const again = async (e) => {
        e.target.disabled = true;
        try { await api("/api/quota/clear", { body: { model: m.id } }); } catch {}
        loadReport();
      };
      return [h("span", { class: "chip warn", text: "left out" }),
        h("span", { class: "tiny", text: `${m.noQuota.why[0].toUpperCase()}${m.noQuota.why.slice(1)}. Auto leaves it out until you try it again or add another key.${notes.length ? ` Also ${notes.join("; ")}.` : ""}` }),
        h("button", { class: "btn small", type: "button", text: "Try again", onclick: again })];
    }
    return [h("span", { class: "chip good", text: "ready" }), notes.length ? h("span", { class: "tiny", text: notes.join("; ") }) : null];
  }
  function reportSpeedEl(d) {
    const rows = d.speed ?? [];
    if (!rows.length) return [];
    const chart = h("div", { class: "rp-chart sp-chart" });
    const draw = () => drawSpeed(chart, rows, Math.max(280, Math.min(560, chart.clientWidth || 520)));
    const RO = window.ResizeObserver;
    if (RO) { let w = 0; new RO(() => { if (chart.clientWidth && chart.clientWidth !== w) { w = chart.clientWidth; draw(); } }).observe(chart); }
    draw();
    const dots = h("div", { class: "card rp-card" }, h("h3", { text: "Models: speed against quality" }),
      h("p", { class: "muted", text: "Each dot is a model: how long its answers took (the middle answer) and how often your app graded them good. Up and left is better. Bigger dots answered more." }),
      h("div", { class: "sp-top" }, chart,
        h("dl", { class: "sp-key" },
          h("dt", { text: "Time" }), h("dd", { text: "From each call's own clock: the first word (time to first token) and the whole answer. The middle one and the slowest 1 in 10." }),
          h("dt", { text: "Failures" }), h("dd", { text: "Busy (503, 529), rate limited (429), timed out, could not be reached, and other errors. Each try counts, also when Auto passed the work on." }),
          h("dt", { text: "Quality" }), h("dd", { text: "Your app's grades of its answers, else the blind checks. Not graded yet: on the bottom line, hollow." }),
          h("dt", { text: "Resting" }), h("dd", { text: "A model that failed or did not start answering in time too often lately rests for a while (amber): Auto picks others while one can take the work, then tries it again." }))));
    const table = h("div", { class: "card rp-card" }, h("h3", { text: "Models: speed, failures, cost and quality" }),
      h("p", { class: "muted", text: "Every call in this span: hand offs, checks, side by side, plans and chats. Most calls first." }),
      h("div", { class: "scroll" }, h("table", { class: "trial-table sp-table" },
        h("thead", {}, h("tr", {}, h("th", { text: "Model" }), h("th", { class: "num", text: "Calls" }), h("th", { text: "Failed" }),
          h("th", { class: "num" }, "First word", h("span", { class: "tiny", text: "middle · slowest 1 in 10" })),
          h("th", { class: "num" }, "Whole answer", h("span", { class: "tiny", text: "middle · slowest 1 in 10" })),
          h("th", { class: "num", text: "Writes" }), h("th", { class: "num", text: "Cost a call" }), h("th", { class: "num", text: "Good" }), h("th", { text: "Now" }))),
        h("tbody", {}, ...rows.map((m) => h("tr", { class: m.rest ? "resting" : m.noQuota ? "resting noquota" : null },
          h("td", { class: "nm" }, h("b", { text: m.label }), h("span", { class: "tiny", text: spWhere(m) })),
          h("td", { class: "num", text: num(m.calls) }),
          h("td", {}, m.failed ? [h("span", { class: "fail", text: `${num(m.failed)} failed` }), h("span", { class: "tiny", text: spFails(m) })] : h("span", { class: "muted", text: "none" })),
          h("td", { class: "num", text: m.first ? `${spSec(m.first.mid)} · ${spSec(m.first.slow)}` : "—" }),
          h("td", { class: "num", text: m.whole ? `${spSec(m.whole.mid)} · ${spSec(m.whole.slow)}` : "—" }),
          h("td", { class: "num", text: m.perSecond ? `${num(m.perSecond)} /s` : "—" }),
          h("td", { class: "num", text: m.costPerCall === null ? "—" : money(m.costPerCall) }),
          h("td", { class: "num" + (m.goodShare === null ? " muted" : ""), text: m.goodShare === null ? "not graded" : pctText(m.goodShare) }),
          h("td", { class: "now" }, spNow(m))))))));
    return [dots, table];
  }
  function drawSpeed(box, rows, W) {
    const H = 300, L = 46, R = 12, T = 14, B = 46, pw = W - L - R, ph = H - T - B;
    const timed = rows.filter((m) => m.whole);
    const secs = timed.map((m) => Math.max(0.1, m.whole.mid));
    const lo = Math.min(1, 10 ** Math.floor(Math.log10(Math.min(...secs, 1)))), hi = Math.max(10, 10 ** Math.ceil(Math.log10(Math.max(...secs, 1))));
    const graded = timed.filter((m) => m.goodShare !== null).map((m) => m.goodShare);
    const yLo = Math.max(0, Math.min(0.4, Math.floor(Math.min(...graded, 1) * 10) / 10));
    const x = (s) => L + ((Math.log10(Math.max(lo, s)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * pw;
    const y = (g) => T + ph - ((Math.max(yLo, g) - yLo) / (1 - yLo)) * ph;
    const ticksX = [];
    for (let p = lo; p <= hi; p *= 10) for (const f of pw < 420 ? [1] : [1, 2, 5]) if (p * f >= lo && p * f <= hi) ticksX.push(p * f); // narrow: tens only
    const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => yLo + f * (1 - yLo));
    const maxCalls = Math.max(...timed.map((m) => m.calls), 1);
    const kids = [
      ...ticksY.map((v) => [svg("line", { x1: L, x2: L + pw, y1: y(v), y2: y(v), class: v === yLo ? "axis" : "grid" }), svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, `${Math.round(v * 100)}%`)]),
      ...ticksX.map((v) => [svg("line", { x1: x(v), x2: x(v), y1: T, y2: T + ph, class: "grid" }), svg("text", { x: x(v), y: T + ph + 15, "text-anchor": v === lo ? "start" : v === hi ? "end" : "middle", class: "tick" }, spSec(v))]),
      svg("text", { x: L + pw / 2, y: H - 8, "text-anchor": "middle", class: "tick" }, "seconds for an answer (the middle one), log scale"),
    ];
    // Labels right of their dot, or left near the edge; one that would cover another is left to the tooltip.
    const placed = [];
    const free = (b) => !placed.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
    const tip = h("div", { class: "rp-tip", hidden: true });
    const order = [...timed].sort((a, b) => b.calls - a.calls);
    for (const m of order) {
      const cx = x(m.whole.mid), cy = y(m.goodShare ?? yLo), r = 5 + 6 * Math.sqrt(m.calls / maxCalls);
      placed.push({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });
      const cls = m.rest ? "spd rest" : m.goodShare === null ? "spd none" : "spd ready";
      const dot = svg("circle", { cx, cy, r, class: cls, tabindex: 0, role: "img", "aria-label": `${m.label}: ${spSec(m.whole.mid)} an answer, ${m.goodShare === null ? "not graded" : pctText(m.goodShare) + " good"}` });
      const show = () => {
        tip.replaceChildren(h("div", { class: "when", text: m.label }),
          h("div", { text: `${spSec(m.whole.mid)} an answer${m.first ? `, first word ${spSec(m.first.mid)}` : ""}` }),
          h("div", { text: m.goodShare === null ? "not graded yet" : `${pctText(m.goodShare)} good of ${num(m.graded)} graded` }),
          h("div", { text: `${num(m.calls)} calls${m.failed ? `, ${num(m.failed)} failed: ${spFails(m)}` : ", none failed"}` }));
        tip.hidden = false;
        tip.style.left = `${Math.min(W - 190, Math.max(0, cx + r + 6))}px`;
        tip.style.top = `${Math.max(0, cy - 30)}px`;
      };
      dot.addEventListener("mouseenter", show); dot.addEventListener("focus", show);
      dot.addEventListener("touchstart", show, { passive: true });
      dot.addEventListener("mouseleave", () => { tip.hidden = true; }); dot.addEventListener("blur", () => { tip.hidden = true; });
      kids.push(dot);
    }
    for (const m of order) {
      const cx = x(m.whole.mid), cy = y(m.goodShare ?? yLo), r = 5 + 6 * Math.sqrt(m.calls / maxCalls);
      const text = m.rest ? `${m.label}, resting` : m.goodShare === null ? `${m.label}, not graded yet` : m.label, w = text.length * 6.4 + 4;
      const right = cx + r + 4 + w <= L + pw;
      const tries = [{ x: right ? cx + r + 4 : cx - r - 4 - w, y: cy - 7 }, { x: cx - w / 2, y: cy - r - 16 }, { x: cx - w / 2, y: cy + r + 2 }];
      const b = tries.map((t) => ({ ...t, w, h: 14 })).find((t) => t.x >= 0 && t.x + w <= W && t.y >= 0 && t.y + 14 <= T + ph + 2 && free(t));
      if (!b) continue;
      placed.push(b);
      kids.push(svg("text", { x: b.x, y: b.y + 11, class: m.rest ? "lab rest" : m.goodShare === null ? "lab none" : "lab" }, text));
    }
    const chart = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Each model's time for an answer against how often it was graded good" }, kids);
    box.replaceChildren(chart, tip);
  }

  // What the outside models used for a part, measured: read, thinking (where known) and written.
  function usedText(u) {
    return u.thought === null ? `${tokShort(u.read)} read, ${tokShort(u.wrote)} written (thinking not split)`
      : `${tokShort(u.read)} read, ${tokShort(u.thought)} thinking${u.estimated ? " (partly from its text)" : ""}, ${tokShort(u.wrote)} written`;
  }
  function gradeChip(g, blind) { return g ? h("span", { class: `chip ${g === "good" ? "good" : g === "wrong" ? "bad" : "warn"}`, title: blind ? "judged blind by another model" : "graded by your app", text: RP_GRADE[g] }) : h("span", { class: "none", text: "—" }); }
  const SIDE_WORD = { same: "as good", worse: "better", better: "not as good" }; // side by side's verdict is the hand off's side; here, the app alone's
  function reportPromptsEl(d) {
    const app = appWord(d);
    const long = Date.parse(d.to) - Date.parse(d.from) > 86_400_000;
    // The day and the time apart, joined with a comma: asked for both at once, some versions of the system's date
    // library write "Oct 20 at 10:05 AM" and others "Oct 20, 10:05 AM".
    const when = (iso) => { const t = new Date(iso), time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); return long ? `${t.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}` : time; };
    const secs = (ms) => (ms === null || ms === undefined ? "" : ` · ${ms < 1500 ? "1 s" : ms < 90_000 ? Math.round(ms / 1000) + " s" : Math.round(ms / 60_000) + " min"}`);
    const two = (main, sub, cls = "") => h("td", { class: "num " + cls }, main, sub ? h("span", { class: "tiny", text: sub }) : null);
    const usedCell = (u, none) => (u ? two(`${tokShort(u.read)} read`, u.thought === null ? `${tokShort(u.wrote)} written, thinking not split` : `${tokShort(u.thought)} thinking · ${tokShort(u.wrote)} written`)
      : h("td", { class: "num muted", text: none }));
    const muted = (text) => h("td", { class: "muted", text });
    const rows = [];
    for (const p of d.prompts.slice(0, S.report.shown)) {
      const open = !!S.report.open[p.key];
      const toggle = () => { S.report.open[p.key] = !open; const old = $("#reportCard"); if (old) old.replaceWith(reportCardEl()); };
      const handed = p.parts.length > 0;
      rows.push(h("tr", { class: "pr" + (open ? " open" : ""), onclick: handed || p.own ? toggle : null },
        h("td", { class: "pid" }, (handed || p.own) ? h("span", { class: "tw", text: open ? "▾" : "▸" }) : null, p.id ?? "—"),
        h("td", { class: "when", text: when(p.ts) }),
        h("td", { class: "nw" }, `${p.app}${p.model ? ` · ${p.model.label}` : ""}${p.plan ? ` · ${shortPlan(p.plan)}` : ""}`),
        handed ? usedCell(p.used, "not measured") : h("td", { class: "num muted", text: "nothing handed off" }),
        p.both ? two(approx(p.both.alone.mid), `range ${tokShort(Math.max(0, p.both.alone.low))} to ${tokShort(p.both.alone.high)}`, "est") : h("td", { class: "num muted", text: "—" }),
        p.both ? two(approx(p.both.saved.mid), null, "est") : h("td", { class: "num", text: "0" }),
        p.own ? two(`${tokShort(p.own.fresh)} new`, "measured") : h("td", { class: "num muted", text: "not known" }),
        h("td", {}, handed ? gradeChip(p.grade, p.parts.some((x) => x.gradedBy === "check")) : h("span", { class: "none", text: "—" })),
        h("td", {}, p.together ? gradeChip(p.together) : h("span", { class: "muted", text: handed ? "not graded" : "—" })),
        h("td", {}, p.alone?.grade ? gradeChip(p.alone.grade, true) : h("span", { class: "muted", text: handed ? "not known" : "—" }))));
      if (!open) continue;
      p.parts.forEach((x, i) => rows.push(h("tr", { class: "part" },
        h("td", { class: "ind pid", text: x.ref ?? `${i + 1}` }), h("td", { class: "when", text: when(x.ts) }),
        h("td", {}, `${(RP_KIND[x.kind] ?? x.kind ?? "part").toLowerCase()} · ${x.label}`, h("span", { class: "tiny", text: `${RP_WHERE[x.where]}${secs(x.ms)}` })),
        usedCell(x.used, "not measured (before 0.10)"),
        two(approx(x.both.alone.mid), `reads what it read, thinks and writes as ${x.label} did (from its numbers)`, "est"),
        two(approx(x.both.saved.mid), `minus ${tokShort(x.back)} read back, ${tokShort(x.both.spent - x.back)} for the call`, "est"),
        h("td", {}),
        h("td", {}, gradeChip(x.grade, x.gradedBy === "check"), x.grade ? h("span", { class: "tiny", text: x.gradedBy === "check" ? `checked blind${x.checker ? ` by ${x.checker}` : ""}` : `by ${p.app}` }) : null),
        h("td", {}),
        h("td", {}, x.alone ? [h("span", { class: "tiny", text: "sampled" }), h("span", { class: x.alone.verdict === "better" ? "gw" : "gg", text: SIDE_WORD[x.alone.verdict] }),
          x.alone.used !== null ? h("span", { class: "tiny", text: `${x.alone.label} used ${tokShort(x.alone.used)}` }) : null]
          : h("span", { class: "muted", text: x.side ? `the best model you have: ${x.side === "worse" ? "better" : x.side === "better" ? "not as good" : "as good"}` : "not sampled" })))));
      rows.push(h("tr", { class: "part own" },
        h("td", {}), h("td", {}), h("td", { class: "nw", text: p.app }),
        h("td", { colspan: 7, class: "muted", text: p.own ? `prompt ${tokShort(p.prompt ?? 0)}, its own work ${tokShort(p.own.fresh)} new tokens (measured)${p.own.cached ? `, ${tokShort(p.own.cached)} more read again from the cache` : ""}` : "its own work: not known (this app does not share it)" })));
      if (handed) {
        const last = p.parts[p.parts.length - 1];
        const grade = async (v) => { try { await api("/api/grades/together", { body: { verdict: v, handoff: last.id } }); } catch {} loadReport(); };
        rows.push(h("tr", { class: "part own" }, h("td", {}), h("td", {}),
          h("td", { colspan: 8 }, h("span", { class: "muted", text: `The whole result, ${p.app} and the hand offs together${p.together ? ` (${p.togetherBy === "you" ? "you said" : `${p.app} said`} ${p.together})` : ""}: ` }),
            ...["good", "partly", "wrong"].map((v) => h("button", { class: "btn small" + (p.together === v ? " on" : ""), type: "button", "aria-pressed": String(p.together === v), text: RP_GRADE[v], onclick: () => grade(v) })))));
      }
    }
    const left = d.prompts.length - S.report.shown + d.more;
    const th = (t, cls = "") => h("th", { class: cls, text: t });
    return h("div", { class: "card rp-card" }, h("h3", { text: "Prompts" }),
      h("p", { class: "muted", text: `Each prompt with both sides: what the outside models used, what ${app} would have used doing it alone (an estimate), and the grades. Open one for its parts (PRM-41.1, PRM-41.2…).` }),
      h("div", { class: "scroll" }, h("table", { class: "trial-table rp-table both" },
        h("thead", {},
          h("tr", {}, h("th", { rowspan: 2, text: "ID" }), h("th", { rowspan: 2, text: "When" }), h("th", { rowspan: 2, text: "App · main model" }), h("th", { colspan: 4, class: "grp", text: "Tokens" }), h("th", { colspan: 3, class: "grp", text: "Grades" })),
          h("tr", {}, th("Outside used", "num"), th(`${app} alone`, "num"), th("Saved", "num"), th(`${app} used, whole prompt`, "num"), th("Outside"), th("Together"), th(`${app} alone`))),
        h("tbody", {}, ...rows))),
      left > 0 ? h("button", { class: "btn small", type: "button", text: `Show ${Math.min(20, left)} more`, onclick: () => { S.report.shown += 20; const old = $("#reportCard"); if (old) old.replaceWith(reportCardEl()); } }) : null,
      h("p", { class: "fine", text: "Claude Code's own tokens come from its own files: numbers only, never your words. New tokens: what it did not read again from its cache. Claude's chats and Cowork do not share theirs, so they show as not known." }));
  }

  // How the app alone is worked out: the step in use, and the ones to come.
  function reportHowEl(d) {
    const app = appWord(d), sampled = d.tiles.three.alone.sampled;
    const step = (n, title, when, text, on) => h("div", { class: "step" + (on ? " on" : "") }, h("b", { text: `${n}. ${title}` }), h("span", { class: "when", text: when }), h("span", { text }));
    return h("div", { class: "card rp-card" }, h("h3", { text: `How "${app} alone" is worked out` }),
      h("p", { class: "muted", text: "Each number says which step it came from. Estimates show with ≈ and a range." }),
      h("div", { class: "rp-how" },
        step(1, "From the outside model's numbers", "in use, from the start", `What it read, thought and wrote, as ${app} would have. Rough: shown with ≈ and a wide range.`, true),
        step(2, `Learned from your own ${app === "Claude" ? "Claude Code" : app}`, "to come (sizes only, never words)", `How much of a file ${app} reads, and how much it thinks and writes for each kind of work, from prompts where it did the reading itself. The range narrows as it learns.`, false),
        step(3, "Measured on a sample", sampled ? `in use: ${plural(sampled, "sample")} so far` : `needs ${app}'s own model in Leanfare (an API key)`, `Now and then side by side runs ${app}'s own model on a hand off too, within its monthly limit: its real tokens, and its grade judged blind against the outside answer. These also check step 1.`, sampled > 0)));
  }

  // The prompts and their parts as rows of a CSV file.
  function reportCsv(d) {
    // A text that starts like a formula (=, +, -, @) is kept as text, so a spreadsheet never runs it.
    const cell = (v) => { let s = v === null || v === undefined ? "" : String(v); if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["prompt_id", "time", "app", "thread", "project", "main_model", "plan", "prompt_tokens", "own_new_tokens", "own_cache_reads", "part_id", "handoff", "kind", "model", "where", "tokens_read", "tokens_back", "kept_out", "saved", "cost_usd", "grade", "graded_by", "side_by_side",
      "outside_read", "outside_thinking", "outside_written", // what the outside models used, measured (empty: not measured; thinking empty: not known)
      "app_alone_est", "app_alone_low", "app_alone_high", "app_spent", "saved_est", "together", "app_alone_grade"]; // both sides (estimates) and the grades
    const used = (u) => (u ? [u.read, u.thought, u.wrote] : ["", "", ""]);
    const both = (b) => (b ? [b.alone.mid, b.alone.low, b.alone.high, b.spent, b.saved.mid] : ["", "", "", "", ""]);
    const lines = [head.join(",")];
    for (const p of d.prompts) {
      const base = [p.id, p.ts, p.app, p.thread, p.project, p.model?.label, p.plan, p.prompt, p.own?.fresh, p.own?.cached];
      lines.push([...base, "", "", "", "", "", "", "", p.kept, p.saved === null ? "" : p.saved.toFixed(4), p.cost.toFixed(6), p.grade, "", "", ...used(p.used), ...both(p.both), p.together, p.alone?.grade].map(cell).join(","));
      p.parts.forEach((x, i) => lines.push([...base, x.ref ?? i + 1, x.id, x.kind, x.label, x.where, x.read, x.back, x.read, "", x.cost === null ? "" : x.cost.toFixed(6), x.grade, x.gradedBy, x.side, ...used(x.used), ...both(x.both), x.together, x.alone?.grade].map(cell).join(",")));
    }
    return lines.join("\n") + "\n";
  }

  function renderSavings() {
    const el = $("#tab-savings");
    const v = S.savings;
    if (!v) { el.replaceChildren(h("div", { class: "empty", text: "Loading…" })); return; }
    const [y, mo] = v.month.split("-").map(Number);
    const title = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const months = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
    const pickMonth = h("select", { "aria-label": "Month", onchange: (e) => { S.month = e.target.value; loadSavings(); } },
      ...months.map((m) => h("option", { value: m, selected: m === v.month, text: new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) })));
    const usualLabel = v.usualLabels.length === 1 ? v.usualLabels[0] : v.usualLabels.length > 1 ? "your usual models" : "your usual model";
    const more = v.more;
    const moreText = more?.ratio ? `${more.ratio.toFixed(more.ratio >= 10 ? 0 : 1)}× more answers for your money than on ${usualLabel}` : more && more.paid === 0 && more.usual > 0 ? `Your answers were free; on ${usualLabel} they would have cost ${money(more.usual)}` : "Shows once you have answers with prices";
    const b = v.budget;
    const cards = h("div", { class: "cards6" },
      stat("spent", "Spent", money(v.spent), `Today ${money(v.today)}`),
      stat("saved", "Saved by Auto", money(v.saved.amount), h("span", { text: moreText }), v.saved.amount > 0 ? "good" : ""),
      v.subscription === null ? null
        : stat("gap", "Against a subscription", money(Math.abs(v.gap)), `${v.gap >= 0 ? "under" : "over"} your ${money(v.subscription)} a month`, v.gap >= 0 ? "good" : ""),
      stat("answers", "Answers", num(v.answers), `${num(v.autoAnswers)} picked by Auto${v.stopped ? ` · ${num(v.stopped)} stopped` : ""}${v.errors ? ` · ${num(v.errors)} failed` : ""}`),
      b.amount === null
        ? stat("budget", "Budget left", "No budget", h("button", { class: "btn small", text: "Set one", onclick: () => setTab("settings") }), "small")
        : stat("budget", "Budget left", money(b.left), `of ${money(b.amount)} · ${Math.floor(b.pct ?? 0)}% used`, b.reached ? "" : ""),
      stat("top", "Top model", v.top ? v.top.label : "—", v.top ? `${Math.round(v.top.share * 100)}% of answers` : "No answers yet", "small"));

    const maxCost = Math.max(...v.byModel.map((r) => r.cost), 0);
    const maxAns = Math.max(...v.byModel.map((r) => r.answers), 0);
    const byModel = v.byModel.length
      ? h("div", { class: "bars" }, ...v.byModel.map((r) => h("div", { class: "barrow", title: `${r.model}\n${num(r.inTok)} input tokens · ${num(r.outTok)} output tokens` },
          h("span", { class: "n", text: r.label }), h("span", { class: "v", text: `${num(r.answers)} answer${r.answers === 1 ? "" : "s"} · ${money(r.cost)}` }),
          h("span", { class: "track" }, h("i", { style: { width: (maxCost > 0 ? (r.cost / maxCost) * 100 : maxAns ? (r.answers / maxAns) * 100 : 0) + "%" } })))))
      : h("div", { class: "empty", text: "No answers this month yet." });
    const maxTask = Math.max(...v.byTask.map((r) => r.answers), 0);
    const byTask = v.byTask.length
      ? h("div", { class: "bars" }, ...v.byTask.map((r) => h("div", { class: "barrow" },
          h("span", { class: "n", text: r.label }), h("span", { class: "v", text: `${num(r.answers)} · ${money(r.cost)}${r.saved > 0 ? ` · saved ${money(r.saved)}` : ""}` }),
          h("span", { class: "track" }, h("i", { style: { width: (maxTask ? (r.answers / maxTask) * 100 : 0) + "%" } })))))
      : h("div", { class: "empty", text: "Tasks show here once you have answers." });
    const daysIn = new Date(y, mo, 0).getDate();
    const perDay = new Map(v.byDay.map((d) => [Number(d.day.slice(8)), d]));
    const maxDay = Math.max(...v.byDay.map((d) => d.cost), 0);
    const days = h("div", { class: "days" }, ...Array.from({ length: daysIn }, (_, i) => {
      const d = perDay.get(i + 1);
      const c = d?.cost ?? 0;
      return h("div", { class: "d" + (c > 0 ? "" : " zero"), title: `${i + 1} ${title}: ${money(c)}${d ? ` · ${d.answers} answers` : ""}`, style: { height: (maxDay > 0 && c > 0 ? Math.max(4, (c / maxDay) * 100) : 2) + "%" } });
    }));
    const notes = [];
    if (v.unpriced) notes.push(`${num(v.unpriced)} answer${v.unpriced === 1 ? " has" : "s have"} no listed price and count as $0 here.`);
    if (v.estimated) notes.push(`Token counts were estimated for ${num(v.estimated)} answer${v.estimated === 1 ? "" : "s"} (the provider did not report them).`);
    const SOURCES = { chat: "Chat", openai: "Apps (OpenAI address)", anthropic: "Apps (Anthropic address)", delegate: "Delegated", check: "Checks", trial: "Trial", plan: "Plans", sidebyside: "Side by side" };
    const src = v.bySource.map((s) => `${SOURCES[s.source] ?? s.source}: ${num(s.answers)}`).join(" · ");
    el.replaceChildren(
      reportCardEl(),
      h("div", { class: "sv-head" }, h("h2", { text: title }), h("span", { class: "grow" }), pickMonth, runButton("Refresh", async (signal) => { await loadSavings(); await loadPlans(true, signal); loadReport(); toast("Up to date.", "done"); })),
      workCardEl(v.work, v.delegate),
      plansCardEl(),
      h("div", { class: "section-title", text: "Pay per use: what your keys and credits spent through Leanfare" }),
      cards,
      trialCardEl(),
      h("div", { class: "sv-grid" },
        h("div", { class: "card" }, h("h3", {}, "By model", h("span", { class: "grow" }), h("small", { text: src })), h("div", { class: "scroll" }, byModel)),
        h("div", { class: "card" }, h("h3", { text: "By task" }), h("div", { class: "scroll" }, byTask)),
        h("div", { class: "card" }, h("h3", {}, "By day", h("span", { class: "grow" }), h("small", { text: `most ${money(maxDay)}` })), days, h("div", { class: "days-axis" }, h("span", { text: "1" }), h("span", { text: String(Math.ceil(daysIn / 2)) }), h("span", { text: String(daysIn) })))),
      h("p", { class: "fine" }, [...notes, "Costs use the providers' list prices; discounts and contracts are not known to Leanfare. Ratings: Arena leaderboard (CC BY 4.0)."].join(" ")));
  }

  // ---- settings -----------------------------------------------------------------------------------
  const LOGO = { openai: "OA", anthropic: "A", google: "G", openrouter: "OR", deepseek: "DS", xai: "X", mistral: "M", ollama: "OL", perplexity: "PX", groq: "GQ", cerebras: "CB", together: "TG", fireworks: "FW", lmstudio: "LM", jan: "J", llamacpp: "LC", vllm: "VL", localai: "LA", koboldcpp: "KC", gpt4all: "G4", lemonade: "LE" };

  async function saveKey(p, input, signal) {
    const key = input.value.trim();
    if (!key) { toast(`Paste your ${p.name} key first.`, "error"); return; }
    const t = toast(`Testing the key with ${p.name}…`);
    try {
      const r = await api("/api/keys", { body: { provider: p.id, key }, signal });
      S.st = r.state;
      if (r.ok) { input.value = ""; t.set(r.message, "done"); } else t.set(r.message, "error");
      renderShell(); renderSettings(); renderComposerBar(); if (!S.messages.length) renderMessages();
    } catch (e) { t.close(); throw e; }
  }

  // Sign in on OpenRouter's page instead of pasting a key. The button becomes its Stop while
  // Leanfare waits for you to press Authorize there; Stop forgets the attempt.
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("Stopped"), { name: "AbortError" })); }, { once: true });
  });
  async function connectOpenRouter(signal) {
    const t = toast("Opening OpenRouter in your browser…");
    try {
      const s = await api("/api/connect/openrouter/start", { body: {}, signal });
      const open = () => window.open(s.url, "_blank", "noopener,noreferrer");
      open();
      t.set("Sign in on OpenRouter and press Authorize. Leanfare connects by itself when you do.", "progress", { action: { label: "Open it again", keep: true, run: open } });
      const until = Date.now() + s.expiresIn * 1000;
      while (Date.now() < until) {
        await pause(1500, signal);
        const r = await api("/api/connect/openrouter/status", { signal });
        if (r.status === "connected") {
          S.st = r.state;
          renderShell(); renderSettings(); renderComposerBar(); if (!S.messages.length) renderMessages();
          t.set(r.message, "done");
          return;
        }
        if (r.status === "failed") { t.set(r.message, "error"); return; }
        if (r.status === "idle") { t.set("Leanfare lost track of the sign in (it may have restarted). Press Connect OpenRouter to start again.", "error"); return; }
      }
      t.set("The sign in was not finished within 10 minutes. Press Connect OpenRouter to start again.", "error");
    } catch (e) {
      t.close();
      if (e?.name === "AbortError") api("/api/connect/openrouter/cancel", { body: {} }).catch(() => {});
      throw e;
    }
  }

  async function removeKey(p) {
    const t = toast(`Removing the ${p.name} key…`);
    try {
      const r = await api(`/api/keys/${p.id}`, { method: "DELETE" });
      S.st = r.state;
      renderShell(); renderSettings(); renderComposerBar();
      t.set(r.env ? (r.from === "shell" ? `Removed. Your shell's settings still set ${r.env}, and Leanfare will use that key after a restart; take that line out of your shell's settings to stop it.` : `Removed. Your ${r.env} environment variable still holds a key, and Leanfare will use it after a restart.`) : `Removed the ${p.name} key.`, "done",
        r.env ? {} : { action: { label: "Undo", run: async () => { try { const x = await api(`/api/keys/${p.id}/restore`, { body: {} }); S.st = x.state; renderSettings(); renderShell(); renderComposerBar(); toast("Key put back.", "done"); } catch (e) { failed(e); } } } });
    } catch (e) { t.set(String(e.message ?? e), "error"); }
  }

  async function refreshList(what, signal) {
    const t = toast(what === "ollama" ? "Looking for Ollama…" : what === "local" ? "Looking for model apps on this computer…" : what === "custom" ? "Updating the model lists…" : what === "openrouter" ? "Updating OpenRouter's model list…" : "Updating prices and ratings…");
    try {
      const r = await api("/api/refresh", { body: { what }, signal });
      S.st = r.state;
      const st = r.status;
      if (what === "local") { const f = S.st.extra?.local?.found ?? []; t.set(f.length ? `Found ${f.map((x) => `${x.name} (${x.models} model${x.models === 1 ? "" : "s"})`).join(", ")}.` : "No other model apps are running on this computer.", "done"); }
      else if (what === "custom") t.set("The model lists are up to date.", "done");
      else if (st.state === "ok") t.set(what === "ollama" ? `Found Ollama with ${modelsOf("ollama").length} models.` : what === "openrouter" ? "OpenRouter's list is up to date." : `Prices and ratings updated (built ${dayLabel(S.st.data.built)}).`, "done");
      else t.set(`${what === "ollama" ? "Ollama" : what === "openrouter" ? "OpenRouter" : "The price update"}: tried ${st.tried}: ${st.error}.`, "error");
      renderShell(); renderSettings(); renderComposerBar(); if (!S.messages.length) renderMessages();
    } catch (e) { t.close(); throw e; }
  }

  // ---- local models (Settings): what Ollama has, Remove, and Download with progress ------------------
  // The download runs inside Leanfare, not in this page, so it goes on if the page is closed and the
  // page picks it up again. The Download button is its own Stop while it runs; a double click
  // does not stop it.
  const gbs = (n) => `${(n / 1e9).toFixed(n < 10e9 ? 1 : 0)} GB`;
  const FIT_HELP = {
    fits: "Fits: runs comfortably, and other apps keep working.",
    tight: "Tight: it runs, but slowly, and other apps may stall.",
    "too big": "Too big for this computer's memory.",
  };
  const fitChip = (fit) => h("span", { class: "chip " + (fit === "fits" ? "good" : fit === "tight" ? "warn" : "bad"), title: FIT_HELP[fit], text: fit });
  let localPoll = null, pullStartedAt = 0;

  async function loadLocal() {
    try {
      const next = await api("/api/local");
      if (JSON.stringify(next) !== JSON.stringify(S.local)) { S.local = next; renderLocal(); }
      if (next.pull?.active) ensurePoll();
      if (next.test?.running) watchTest();
    } catch {}
  }

  function renderLocal() {
    const old = document.getElementById("localCard");
    if (old) keepInputs(old.parentNode, () => old.replaceWith(localCardEl()));
    focusSetting(); // a button of Set up may have asked for this card
  }

  // While a download runs, only its bar and words are repainted in place, so the Stop button under
  // your finger is never replaced.
  function paintPull(p) {
    const bar = document.getElementById("dlBar"), text = document.getElementById("dlText");
    if (bar) { bar.setAttribute("aria-valuenow", String(p.percent ?? 0)); const i = bar.firstChild; if (i) i.style.width = `${p.percent ?? 0}%`; }
    if (text) text.textContent = pullText(p);
    const fit = document.getElementById("dlFit"); // the size, and so whether it fits, is known a moment after the start
    if (fit && fit.dataset.fit !== (p.fit ?? "")) { fit.dataset.fit = p.fit ?? ""; fit.replaceChildren(p.fit ? fitChip(p.fit) : null); }
  }
  const pullText = (p) => `${p.step}${p.percent !== null ? ` · ${p.percent}% · ${gbs(p.completed)} of ${gbs(p.total)}` : ""}`;

  function ensurePoll() {
    if (localPoll) return;
    localPoll = setInterval(async () => {
      try {
        const { pull } = await api("/api/local/pull");
        if (S.local) S.local.pull = pull;
        if (pull?.active) { paintPull(pull); return; }
        clearInterval(localPoll); localPoll = null;
        if (pull) toast(pull.message ?? "The download ended.", pull.status === "done" ? "done" : pull.status === "failed" ? "error" : "done");
        S.st = await api("/api/state");
        await loadLocal();
        renderShell(); renderSettings(); renderComposerBar(); if (!S.messages.length) renderMessages();
      } catch { clearInterval(localPoll); localPoll = null; }
    }, 500);
  }

  async function startDownload(input) {
    const name = input.value.trim();
    if (!name) { toast("Type the model's name first, for example gemma3:12b.", "error"); return; }
    if (await startDownloadOf(name)) input.value = "";
  }
  // The suggested model's Download (and the Plan tab's) passes its size, so a model too big for this
  // computer is refused before anything downloads.
  async function startDownloadOf(name, sizeBytes) {
    try {
      const r = await api("/api/local/pull", { body: { name, ...(sizeBytes ? { sizeBytes } : {}) } });
      pullStartedAt = Date.now();
      if (S.local) S.local.pull = r.pull;
      renderLocal();
      ensurePoll();
      return true;
    } catch (e) { failed(e); return false; }
  }
  async function stopDownload(ev) {
    if (ev.detail > 1 || Date.now() - pullStartedAt < 500) return; // the second click of a double click is not a Stop
    try { const r = await api("/api/local/pull/stop", { body: {} }); if (S.local) S.local.pull = r.pull; renderLocal(); } catch (e) { failed(e); }
  }
  async function dismissDownload() {
    try { await api("/api/local/pull/dismiss", { body: {} }); if (S.local) S.local.pull = null; renderLocal(); } catch (e) { failed(e); }
  }

  // Remove asks first, and says what it frees. It is the one exception to "removals can be undone":
  // the files are gone from the disk, and only downloading them again brings them back.
  async function removeLocal(m) {
    const t = toast(`Removing ${m.name}…`);
    S.confirmRemove = null;
    try {
      const r = await api("/api/local/delete", { body: { name: m.name } });
      S.st = r.state;
      t.set(`Removed ${m.name}. Freed ${gbs(r.freed)}.`, "done");
    } catch (e) { t.set(String(e.message ?? e), "error"); }
    await loadLocal();
    renderShell(); renderSettings(); renderComposerBar(); if (!S.messages.length) renderMessages();
  }

  // A model of yours: what Leanfare knows of its quality, its Arena rating through a cloud twin, or this
  // computer's test of it (localtest.ts), and the test for one Arena does not rate.
  const stModel = (id) => { for (const ms of Object.values(S.st?.models ?? {})) { const m = ms.find((x) => x.id === id); if (m) return m; } return null; };
  function qualityOf(m) {
    const id = `ollama/${m.name}`;
    const T = S.local?.test;
    const now = T?.current?.status === "running" && T.current.model === id ? T.current : null;
    if (now) return [h("span", { class: "chip", text: `testing ${now.done} of ${now.total}` })];
    const r = T?.results?.[id];
    const sm = stModel(id);
    const out = [];
    if (r) out.push(h("span", { class: "chip " + (r.passed ? "good" : "warn"), title: `This computer's test, ${new Date(r.at).toLocaleDateString()}${r.skipped ? `; ${r.skipped} question${r.skipped === 1 ? "" : "s"} too long for it, left out` : ""}`, text: r.passed ? `passed the test: ${r.right} of ${r.asked}` : `missed ${r.asked - r.right} of ${r.asked}` }));
    else if (sm && sm.rating !== null && sm.rating !== undefined) out.push(h("span", { title: sm.ratingFrom ? `Rated like ${sm.ratingFrom}` : "Arena rating", text: `★ ${Math.round(sm.rating)}` }));
    else out.push(h("span", { text: "not rated" }));
    if (!T?.running && (!sm || sm.rating === null || sm.rating === undefined)) out.push(h("button", { class: "btn small quiet", type: "button", title: `Test ${m.name} on known answers, on this computer`, text: r ? "Test again" : "Test", onclick: () => startTest(id) }));
    return out;
  }
  function localRow(m) {
    const facts = [m.params, m.quant].filter(Boolean).map((x) => h("span", { text: x }));
    facts.push(h("span", { text: gbs(m.size) }), fitChip(m.fit), ...qualityOf(m));
    if (m.loaded) facts.push(h("span", { class: "chip good", title: "Loaded in memory right now, so the next answer starts fast", text: "in memory" }));
    const row = h("div", { class: "lrow" },
      h("span", { class: "nm", title: m.name, text: m.name.replace(/:latest$/, "") }),
      h("span", { class: "facts" }, ...facts),
      h("button", { class: "btn small quiet", type: "button", title: `Remove ${m.name}`, "aria-label": `Remove ${m.name}`, text: "Remove", onclick: () => { S.confirmRemove = m.name; renderLocal(); } }));
    if (S.confirmRemove !== m.name) return row;
    return h("div", { class: "lgroup" }, row,
      h("div", { class: "lconfirm", role: "alertdialog", "aria-label": `Remove ${m.name}?` },
        h("span", { class: "grow", text: `Remove ${m.name}? This frees ${gbs(m.size)}. It cannot be undone here: to get it back you download it again.` }),
        h("button", { class: "btn small stop", type: "button", text: "Remove it", onclick: () => removeLocal(m) }),
        h("button", { class: "btn small", type: "button", text: "Keep it", onclick: () => { S.confirmRemove = null; renderLocal(); } })));
  }

  function pullBlock(p) {
    const wrap = h("div", { class: "dl" + (p.status === "failed" ? " bad" : p.status === "done" ? " good" : ""), id: "dlBlock" },
      h("div", { class: "row" }, h("strong", { text: p.name }), h("span", { class: "grow" }), h("span", { id: "dlFit", "data-fit": p.fit ?? "" }, p.fit ? fitChip(p.fit) : null)));
    if (p.active) {
      wrap.append(
        h("div", { class: "progress", id: "dlBar", role: "progressbar", "aria-label": `Downloading ${p.name}`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(p.percent ?? 0) }, h("i", { style: { width: `${p.percent ?? 0}%` } })),
        h("div", { class: "note", id: "dlText", text: pullText(p) }),
        h("div", { class: "note", text: "Stop keeps what is downloaded; press Download again to continue from there." }));
    } else {
      wrap.append(h("div", { class: "note", text: p.message ?? "" }), h("div", { class: "row" }, h("button", { class: "btn small quiet", type: "button", text: "Dismiss", onclick: dismissDownload })));
    }
    return wrap;
  }

  function localCardEl() {
    const L = S.local;
    const card = h("div", { class: "setting", id: "localCard" }, h("h3", { text: "Local models" }));
    if (!L) { card.append(h("p", { text: "Checking Ollama…" })); return card; }
    if (!L.running) {
      card.append(h("p", {}, "Ollama is not running on this computer. ", h("a", { href: L.installUrl, target: "_blank", rel: "noopener noreferrer", text: "Get Ollama ↗" })));
      for (const f of L.found ?? []) card.append(foundBlock(f));
      if (L.pull) card.append(pullBlock(L.pull));
      return card;
    }
    const mac = L.machine ?? "computer";
    card.append(h("div", { class: "section-title", text: "Where your models are" }),
      h("p", { text: whereText(L) }),
      L.remote ? null : h("p", { class: "note", text: `This ${mac} has ${gbs(L.memory.total)} of memory: a model up to about ${gbs((L.memory.total * 0.5) / 1.2)} runs comfortably, up to about ${gbs((L.memory.total * 0.7) / 1.2)} tightly.` }));
    for (const f of L.found ?? []) card.append(foundBlock(f));
    card.append(h("div", { class: "section-title", text: L.installed.length ? `On this computer · ${L.installed.length} model${L.installed.length === 1 ? "" : "s"} · ${gbs(L.total)}` : "On this computer" }),
      L.installed.length ? h("div", { class: "lmodels" }, ...L.installed.map(localRow)) : h("p", { text: "No models yet. Download one below." }));
    const T = L.test?.current;
    if (T && T.status === "running") card.append(h("div", { class: "row test-now" },
      h("span", { class: "grow", text: `Testing ${T.label} on this ${mac}: ${T.done} of ${T.total} questions, ${T.right} right so far.` }),
      h("button", { class: "btn small stop", type: "button", text: "Stop", onclick: stopTest })));
    const busy = !!L.pull?.active;
    if ((L.kinds ?? []).length) {
      card.append(h("div", { class: "section-title", text: "Suggested for each kind of work" }), ...L.kinds.map((k) => kindRow(k, busy)),
        h("p", { class: "fine", text: `Arena rates few small models. One it rates is suggested as rated; one it does not is tested here before Leanfare gives it reading (the test has no drafting questions). Each fits this ${mac}'s memory and the free space where your models are, keeping ${gbs(L.disk.minFree)} free. Apache 2.0 only.` }));
    }
    const input = h("input", { type: "text", placeholder: "gemma3:12b   or   hf.co/user/repo:Q4_K_M", autocomplete: "off", spellcheck: "false", "data-keep": "local-name", "aria-label": "Model to download", disabled: busy, value: busy ? L.pull.name : null,
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); if (!busy) startDownload(input); } } });
    card.append(h("div", { class: "section-title", text: "Download a model" }),
      h("div", { class: "row" }, input, h("button", { class: "btn primary" + (busy ? " stop" : ""), type: "button", text: busy ? "Stop" : "Download", onclick: (ev) => (busy ? stopDownload(ev) : startDownload(input)) })),
      h("p", {}, "A name from ", h("a", { href: "https://ollama.com/library", target: "_blank", rel: "noopener noreferrer", text: "Ollama's library ↗" }), ", or straight from Hugging Face as hf.co/user/repo:quantization. Q4_K_M is the light version: about a quarter of the full size, with a small loss in quality. Check a model's licence before you use it for work."));
    if (L.pull) card.append(pullBlock(L.pull));
    return card;
  }

  // Where Ollama keeps its models (local.ts: whereModels): the drive, its free space, and that downloads go there.
  function whereText(L) {
    if (L.remote || !L.where) return "Ollama runs on another computer, so Leanfare cannot check its disk or memory.";
    const w = L.where, n = L.installed.length;
    if (w.missing) return `Ollama's models folder is a link to ${w.real ?? "a folder"}${w.drive ? `, on the drive ${w.drive}` : ""}, which is not there now. Attach that drive and Ollama finds its models again.`;
    const place = w.drive ? `on the drive ${w.drive}` : `in ${w.real ?? w.dir}, on this ${L.machine ?? "computer"}'s own disk`;
    const room = w.free !== null ? `, with ${gbs(w.free)} free` : "";
    if (!n) return `Ollama has no models yet. Its folder is ${place}${room}, and downloads go there.`;
    return `Ollama keeps your ${n} model${n === 1 ? "" : "s"} (${gbs(L.total)}) ${place}${room}. New downloads go there too.`;
  }
  // Ollama models on a drive that Ollama does not use: Use them links Ollama's models folder there, after a yes.
  function foundBlock(f) {
    const ask = S.confirmFolder === f.path;
    const row = h("div", { class: "srow found" },
      h("span", { class: "nm", title: f.path, text: `${f.models} model${f.models === 1 ? "" : "s"} on ${f.drive}` }),
      h("span", { class: "facts" }, h("span", { text: gbs(f.size) }), h("span", { text: "Ollama does not use them" })),
      h("button", { class: "btn small primary", type: "button", text: "Use them", onclick: () => { S.confirmFolder = ask ? null : f.path; renderLocal(); } }));
    if (!ask) return h("div", {}, row, h("p", { class: "note", text: `In ${f.path}.` }));
    return h("div", { class: "lgroup" }, row,
      h("div", { class: "lconfirm", role: "alertdialog", "aria-label": `Use the models on ${f.drive}?` },
        h("span", { class: "grow", text: `Ollama's models folder will point to ${f.path}, so Ollama uses these models and new downloads go to ${f.drive} too. What is in the folder now is kept under another name; nothing is deleted.` }),
        runButton("Use them", async () => { const r = await api("/api/local/use", { body: { path: f.path } }); S.confirmFolder = null; S.local = r.local; S.st = r.state; toast(r.text, "done"); renderLocal(); renderComposerBar(); }, "btn small primary"),
        h("button", { class: "btn small", type: "button", text: "Not now", onclick: () => { S.confirmFolder = null; renderLocal(); } })));
  }
  // One suggestion for a kind of work (local.ts: kindsFor), with what to do about it.
  function kindRow(k, busy) {
    const p = k.pick;
    const act = !p ? null
      : p.act === "use" ? h("span", { class: "chip good", text: p.test?.passed ? "used first" : "you have it" })
      : p.act === "test" ? (S.local?.test?.running ? null : h("button", { class: "btn small primary", type: "button", text: `Test it on this ${S.local?.machine ?? "computer"}`, onclick: () => startTest(p.id) }))
      : busy ? null : h("button", { class: "btn small primary", type: "button", text: "Download", onclick: () => startDownloadOf(p.name, p.size) });
    return h("div", { class: "krow" },
      h("span", { class: "k", text: k.title }),
      h("div", {},
        p ? h("div", { class: "kpick" }, h("span", { class: "chip model", title: p.name, text: p.name.replace(/:latest$/, "") }), h("span", { text: gbs(p.size) }), p.fit === "tight" ? fitChip("tight") : null, p.rating !== null ? h("span", { title: p.like ? `Rated like ${p.like}` : "", text: `★ ${p.rating}` }) : null) : null,
        h("div", { class: "note", text: k.why })),
      act ?? h("span", {}));
  }
  // The test of a model on this computer: started here or by an app, followed while it runs.
  let testPoll = null;
  async function startTest(id) {
    try { const t = await api("/api/local/test", { body: { model: id } }); if (S.local) S.local.test = t; renderLocal(); watchTest(); }
    catch (e) { failed(e); }
  }
  async function stopTest() {
    try { const t = await api("/api/local/test/stop", { body: {} }); if (S.local) S.local.test = t; renderLocal(); } catch (e) { failed(e); }
  }
  function watchTest() {
    if (testPoll) return;
    testPoll = setInterval(async () => {
      try {
        const t = await api("/api/local/test");
        const was = S.local?.test?.current;
        if (S.local) S.local.test = t;
        if (t.running) { renderLocal(); return; }
        clearInterval(testPoll); testPoll = null;
        const c = t.current;
        if (c && was?.status === "running") {
          const r = t.results?.[c.model];
          toast(c.status === "done" ? `${c.label}: ${c.right} of ${c.total} right. ${r?.passed ? "It passed: plans and the delegate send reading to it first." : "It did not pass, so it gets no reading work."}` : c.status === "failed" ? `The test of ${c.label} failed: ${c.error}` : `The test of ${c.label} was stopped.`, c.status === "failed" ? "error" : "done");
        }
        S.st = await api("/api/state");
        await loadLocal();
        renderLocal(); renderComposerBar();
      } catch { clearInterval(testPoll); testPoll = null; }
    }, 1500);
  }

  async function tick(ids, on) {
    const before = S.st.settings.ticked.slice();
    const set = new Set(before);
    for (const id of ids) on ? set.add(id) : set.delete(id);
    S.st.settings.ticked = [...set]; // shown at once
    renderSettings(); renderComposerBar();
    try { S.st = await api("/api/models/tick", { body: { ids, on } }); renderSettings(); renderComposerBar(); }
    catch (e) { S.st.settings.ticked = before; renderSettings(); renderComposerBar(); failed(e); }
  }

  async function patchSettings(patch, done) {
    try {
      const before = S.st?.settings.instructions ?? "";
      S.st = await api("/api/settings", { body: patch });
      if ("plans" in patch) S.plans = null; // the Savings card is read again with the new plan
      if ("showValue" in patch && S.savings) { S.plans = null; renderSavings(); loadPlans(false).catch(() => {}); }
      if ("codexPlan" in patch) loadPlatforms();
      followDefault(before);
      renderShell(); renderSettings(); renderComposerBar();
      if (done) toast(done, "done");
    } catch (e) { failed(e); }
  }

  // A new chat that has nothing in it yet keeps up with the default instructions,
  // unless its own were changed.
  function followDefault(before) {
    const now = S.st?.settings.instructions ?? "";
    if (now === before || S.chatId || S.messages.length || S.system === null) return;
    if ((S.system ?? "") !== before) return;
    S.system = now;
    renderConvoHead();
  }

  function modelRow(m) {
    const facts = [];
    if (m.local) facts.push(h("span", { class: "chip good", text: "local" }));
    else if (m.free || (m.input === 0 && m.output === 0)) facts.push(h("span", { class: "chip good", text: "free" }));
    else facts.push(h("span", { title: "US dollars per 1M tokens: input / output", text: `${perM(m.input)} / ${perM(m.output)}` }));
    facts.push(h("span", { title: m.rating === null ? "No Arena rating yet: Auto does not pick it" : m.ratingFrom ? `Rating borrowed from ${m.ratingFrom} until Arena rates this model` : "Arena rating, overall", text: m.rating === null ? "unrated" : `★ ${Math.round(m.rating)}${m.ratingFrom ? "*" : ""}` }));
    const notes = [];
    if (m.retired) notes.push("retired " + m.retire);
    else if (m.retiringSoon) notes.push("retires " + m.retire);
    if (m.ratingFrom) notes.push("rating borrowed from " + m.ratingFrom);
    // Left out because your key has no quota for it (quota.ts): why, and Try again.
    const nq = (S.st.noQuota ?? []).find((q) => q.model === m.id);
    if (nq) notes.push(`left out: ${nq.why}`);
    const again = nq ? h("button", { class: "btn small", type: "button", text: "Try again", onclick: async (e) => {
      e.preventDefault(); e.stopPropagation(); e.target.disabled = true;
      try { const r = await api("/api/quota/clear", { body: { model: m.id } }); S.st = r.state; toast(`${m.label} may be picked again.`, "done"); } catch (err) { toast(err.message, "error"); }
      renderSettings();
    } }) : null;
    return h("label", { class: "mrow" + (nq ? " noquota" : ""), title: m.id },
      h("input", { type: "checkbox", checked: m.ticked, onchange: (e) => tick([m.id], e.target.checked) }),
      h("span", { class: "nm" }, m.label, notes.length ? h("small", { text: notes.join(" · ") }) : null, again),
      h("span", { class: "facts" }, ...facts));
  }

  function providerCard(p) {
    const st = S.st;
    const ms = modelsOf(p.id);
    const tickedCount = ms.filter((m) => m.ticked).length;
    const open = S.open[p.id] ?? false;
    let status;
    if (!p.on) status = h("span", { class: "chip", text: "Off" });
    else if (p.ready) status = h("span", { class: "chip good", text: `Ready · ${tickedCount} of ${ms.length} ticked` });
    else if (p.id === "ollama" || p.local) status = h("span", { class: "chip", text: "Not running" });
    else status = h("span", { class: "chip", text: "Add a key" });
    const head = h("div", { class: "prov-head", role: "button", tabindex: "0", "aria-expanded": String(open), onclick: () => { S.open[p.id] = !open; store.set("open", S.open); renderSettings(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } },
      h("span", { class: "logo", text: LOGO[p.id] ?? p.name[0] }), h("span", { class: "name", text: p.name }), h("span", { class: "grow" }), status, h("span", { class: "caret", text: "›" }));
    const card = h("div", { class: "prov" + (p.ready ? " ready" : "") + (open ? " open" : "") }, head);
    if (!open) return card;
    const body = h("div", { class: "prov-body" });
    if (p.needsKey) {
      if (p.key.saved) {
        body.append(h("div", { class: "keyline" }, "Key ", h("code", { text: p.key.hint }),
          h("span", { text: p.key.where === "keychain" ? "in the macOS Keychain" : p.key.where === "environment" ? "from your environment" : p.key.where === "shell" ? "from your shell's settings" : "in a file only you can read" }),
          h("span", { class: "grow" }),
          p.key.where === "environment" || p.key.where === "shell" ? null : h("button", { class: "btn small", text: "Remove key", onclick: () => removeKey(p) })));
      }
      if (p.id === "openrouter") body.append(h("div", { class: "row" },
        runButton(p.key.saved ? "Connect again" : "Connect OpenRouter", connectOpenRouter, "btn primary"),
        h("span", { class: "note grow", text: "Sign in on OpenRouter's page; Leanfare gets a key by itself. Or paste one:" })));
      const input = h("input", { type: "password", placeholder: p.key.saved ? `Paste a new ${p.name} key to replace it` : `Paste your ${p.name} key`, autocomplete: "off", "data-keep": p.id, "aria-label": `${p.name} key` });
      body.append(h("div", { class: "row" }, input, runButton("Test and save", (signal) => saveKey(p, input, signal), "btn primary"),
        h("a", { class: "btn quiet", href: p.keyUrl, target: "_blank", rel: "noopener noreferrer", text: "Get a key ↗" })));
    }
    if (p.note) body.append(h("div", { class: "note", text: p.note }));
    if (p.custom) {
      const c = (S.st.extra?.custom ?? []).find((x) => x.id === p.id);
      body.append(h("div", { class: "row" },
        h("span", { class: "note grow", text: c?.state?.error ? `Its model list did not load: ${c.state.error}.` : `${ms.length} model${ms.length === 1 ? "" : "s"} from its own list${c?.state?.at ? `, ${ago(c.state.at)}` : ""}. Prices come from models.dev when it lists the model.` }),
        runButton("Update list", (signal) => refreshList("custom", signal)),
        h("button", { class: "btn small", type: "button", text: "Remove provider", onclick: () => removeCustom(p) })));
    }
    // A free plan (freeplans.ts): its answers count as $0, and the page says what its terms or limits mean.
    const FREE_PLAN_TEXT = {
      google: "My Google key is on the free plan (count its answers as $0)",
      groq: "My Groq key is on the free plan (count its answers as $0; work above 8,000 tokens a minute goes to another model)",
      mistral: "My Mistral key is on the free Experiment plan (count its answers as $0; Mistral may train on what is sent)",
    };
    if (FREE_PLAN_TEXT[p.id]) body.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.free, onchange: (e) => patchProvider(p.id, { free: e.target.checked }) }), FREE_PLAN_TEXT[p.id]));
    if (p.id === "ollama") {
      const l = p.list;
      body.append(h("div", { class: "row" },
        h("span", { class: "note grow", text: p.ready ? `Found ${ms.length} model${ms.length === 1 ? "" : "s"} at ${l?.tried?.replace(/\/api\/tags$/, "") ?? p.base}.` : `Not found. Leanfare tried ${l?.tried ?? p.base} (${l?.error ?? "not tried yet"}).` }),
        runButton("Look again", (signal) => refreshList("ollama", signal)),
        p.ready ? null : h("a", { class: "btn quiet", href: p.keyUrl, target: "_blank", rel: "noopener noreferrer", text: "Get Ollama ↗" })));
    }
    if (p.id === "openrouter") {
      const l = p.list;
      body.append(h("div", { class: "row" },
        h("span", { class: "note grow", text: l?.state === "ok" ? `${ms.length} models from OpenRouter's own list, updated ${ago(l.at)}.` : l?.state === "failed" ? `The model list did not load: tried ${l.tried}: ${l.error}.` : "The model list loads when you save a key." }),
        runButton("Update list", (signal) => refreshList("openrouter", signal))));
      if (p.key?.saved) body.append(h("div", { class: "note", text: `${p.credit ? `Credit left on OpenRouter: ${money(p.credit.remaining)} of ${money(p.credit.purchased)} bought. ` : ""}OpenRouter may expire unused credits a year after purchase (its terms, section 4.2).` }));
    }
    if (p.needsKey || p.id === "ollama" || p.local || p.custom) body.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.on, onchange: (e) => patchProvider(p.id, { on: e.target.checked }) }), `Use ${p.name}`));
    if (ms.length) {
      const all = S.showAll[p.id];
      const shown = all ? ms : ms.filter((m) => m.top || m.ticked);
      const rest = ms.length - shown.length;
      body.append(h("div", { class: "section-title", text: all ? `All ${ms.length} models` : "Short list: the best price for each level of quality" }),
        h("div", { class: "models" }, ...shown.map(modelRow)),
        rest > 0 || all ? h("button", { class: "more-toggle", type: "button", text: all ? "▾ Show the short list only" : `▸ Show the other ${rest} model${rest === 1 ? "" : "s"}`, onclick: () => { S.showAll[p.id] = !all; renderSettings(); } }) : null);
    } else if (p.id === "ollama" && p.ready) body.append(h("div", { class: "note", text: "Ollama has no models yet. In Terminal: ollama pull llama3.2" }));
    card.append(body);
    return card;
  }

  async function patchProvider(id, patch) {
    try { S.st = await api(`/api/providers/${id}`, { body: patch }); renderShell(); renderSettings(); renderComposerBar(); toast("Saved.", "done"); }
    catch (e) { failed(e); }
  }

  function moneyInput(value, label) {
    return h("span", { class: "money" }, h("span", { text: "$" }), h("input", { type: "number", min: "0", step: "0.01", value: value ?? "", placeholder: "none", "aria-label": label, "data-keep": label }));
  }

  async function setLock(on, rotate = false) {
    try {
      S.st = await api("/api/lock", { body: { on, rotate } });
      renderSettings();
      toast(!on ? "Apps on this computer no longer need a key." : rotate ? "New key made. The old one stopped working." : "Apps now need the access key shown in Settings.", "done");
    } catch (e) { failed(e); }
  }

  function copyBtn(text) {
    return h("button", { class: "btn small", type: "button", text: "Copy", onclick: () => navigator.clipboard?.writeText(text).then(() => toast("Copied.", "done"), () => failed("Could not copy.")) });
  }

  // Your subscriptions: each plan's name and monthly price (picked from the usual ones or typed), so Savings
  // shows its limits and sets its price against what the same use would cost per use.
  function plansSetting(s) {
    const subs = S.st.subscriptions ?? {};
    const keys = Object.keys(subs);
    const found = (k) => !!S.plans?.providers?.some((v) => v.provider === k && v.apps?.length); // one of its apps is on this computer
    const shown = keys.filter((k) => k === "claude" || k === "chatgpt" || s.plans?.[k] || found(k) || S.showAllPlans);
    const rows = shown.map((k) => {
      const info = subs[k], label = info.label, cur = s.plans?.[k];
      const name = h("input", { type: "text", placeholder: info.presets.at(-1)?.name ?? label, value: cur?.name ?? "", maxlength: "60", autocomplete: "off", "aria-label": `${label} plan name`, "data-keep": `plan-${k}-name` });
      const price = moneyInput(cur?.price ?? null, `${label} plan price a month`);
      const pick = h("select", { "aria-label": `Pick your ${label} plan`, onchange: (e) => { const p = info.presets[Number(e.target.value)]; if (p) { name.value = p.name; price.querySelector("input").value = p.price ?? ""; } } },
        h("option", { value: "", text: "Pick a plan…" }), ...info.presets.map((p, i) => h("option", { value: String(i), text: `${p.name}${p.price !== null ? ` · ${money(p.price)}` : ""}` })));
      const since = monthSelect(cur?.since ?? null, `${label} plan since`, "since always");
      const until = monthSelect(cur?.until ?? null, `${label} plan until`, "until now");
      return h("div", { class: "row plan-row" }, h("span", { class: "plan-l", text: label }), pick, name, price, since, until,
        h("button", { class: "btn", type: "button", text: "Save", onclick: () => patchSettings({ plans: { [k]: { name: name.value, price: price.querySelector("input").value, since: since.value, until: until.value } } }, `${label} plan saved.`) }),
        cur ? h("button", { class: "btn", type: "button", text: "Remove", onclick: () => patchSettings({ plans: { [k]: null } }, `${label} plan removed.`) }) : null);
    });
    const hidden = keys.filter((k) => !shown.includes(k));
    return h("div", { class: "setting", id: "plansSetting" }, h("h3", { text: "Your subscriptions" }), ...rows,
      hidden.length ? h("button", { class: "more-toggle", type: "button", text: `▸ More subscriptions (${hidden.map((k) => subs[k].label).join(", ")})`, onclick: () => { S.showAllPlans = true; renderSettings(); } }) : null,
      h("p", { text: "Savings then shows each plan's limits (the 5 hours and the week, where Leanfare can read them) and the tokens your Claude Code and Codex use, in the months the plan covers. Leanfare reads only the token counts in those programs' log files on this computer, never the words; of other AI apps it reads only that they are here and when they were last opened." }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.showValue, onchange: (e) => patchSettings({ showValue: e.target.checked }, e.target.checked ? "Savings also shows what your plan use would cost per use." : "Savings shows your plans in tokens and limits only.") }), "Also show what that use would cost per use, at API prices"),
      h("p", { text: "Leanfare only counts here. Anthropic does not let other apps use a Claude subscription login, so Auto never uses one." }));
  }

  // ---- adding keys and providers with no typing (Settings) -------------------------------------------
  // Paste any key: Leanfare finds its provider by how it looks and tests it there. Find my keys: the
  // keys already on this computer (your environment, your shell's settings, other AI tools), each
  // used only after you tick it. The page only ever sees their last four characters.
  function keysCardEl() {
    const input = h("input", { type: "password", placeholder: "Paste any API key: Leanfare finds its provider", autocomplete: "off", "aria-label": "Any API key", "data-keep": "any-key" });
    return h("div", { class: "setting keys-any", id: "keysCard" },
      h("div", { class: "row" }, input, runButton("Add key", (signal) => addAnyKey(input, signal), "btn primary"), runButton("Find my keys", (signal) => findMyKeys(signal))),
      S.found ? foundListEl() : null);
  }
  async function addAnyKey(input, signal) {
    const key = input.value.trim();
    if (!key) { toast("Paste a key first.", "error"); return; }
    const r = await api("/api/keys/recognize", { body: { key }, signal });
    S.st = r.state;
    // The box may have been drawn again while Leanfare tested the key: clear whichever one is on screen.
    if (r.ok) { input.value = ""; const now = $("input[aria-label='Any API key']"); if (now) now.value = ""; }
    if (r.unknown) { S.open.__add = true; store.set("open", S.open); loadRegistry(); }
    renderShell(); renderSettings(); renderComposerBar();
    toast(r.message, r.ok ? "done" : "error");
  }
  async function findMyKeys(signal) {
    const r = await api("/api/keys/found", { signal });
    // New keys for built-in providers start ticked; one that would add a provider waits for your tick.
    S.found = { keys: r.keys, picked: new Set(r.keys.filter((k) => k.status === "new" && !k.registry).map((k) => k.ref)) };
    renderSettings();
  }
  function foundListEl() {
    const f = S.found;
    if (!f.keys.length) return h("div", { class: "found" }, h("p", { class: "note", text: "No keys found in your environment, your shell's settings, llm, aider, Gemini CLI, Codex CLI, OpenCode or Continue. Subscription sign ins are never used." }),
      h("button", { class: "btn quiet", type: "button", text: "Close", onclick: () => { S.found = null; renderSettings(); } }));
    const rows = f.keys.map((k) => h("label", { class: "check found-row" },
      h("input", { type: "checkbox", checked: f.picked.has(k.ref), disabled: k.status === "same", onchange: (e) => { if (e.target.checked) f.picked.add(k.ref); else f.picked.delete(k.ref); } }),
      h("span", { text: `${k.label} key ${k.hint}` }),
      h("span", { class: "note", text: ` · ${k.where}${k.status === "same" ? " · already in Leanfare" : k.status === "different" ? " · Leanfare has a different key for it" : ""}${k.registry ? ` · would add ${k.registry.name} as a provider, at ${k.registry.api}` : ""}` })));
    return h("div", { class: "found" },
      h("p", { class: "note", text: "Found on this computer. Tick the keys to use: each is tested with its own provider first, and nothing is sent anywhere else." }),
      ...rows,
      h("div", { class: "row" }, runButton("Use the ticked keys", (signal) => importFound(signal), "btn primary"), h("button", { class: "btn quiet", type: "button", text: "Close", onclick: () => { S.found = null; renderSettings(); } })));
  }
  async function importFound(signal) {
    const refs = [...S.found.picked];
    if (!refs.length) { toast("Tick a key first.", "error"); return; }
    const r = await api("/api/keys/import", { body: { refs }, signal });
    S.st = r.state;
    S.found = null;
    const ok = r.results.filter((x) => x.ok).length;
    renderShell(); renderSettings(); renderComposerBar();
    toast(`${ok} of ${r.results.length} key${r.results.length === 1 ? "" : "s"} added.${r.results.filter((x) => !x.ok).map((x) => " " + x.message).join("")}`, ok === r.results.length ? "done" : "error");
  }

  function moreProvidersEl(list) {
    if (!list.length) return null;
    const open = S.open.__more ?? false;
    const head = h("div", { class: "prov-head", role: "button", tabindex: "0", "aria-expanded": String(open), onclick: () => { S.open.__more = !open; store.set("open", S.open); renderSettings(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } },
      h("span", { class: "logo", text: "…" }), h("span", { class: "name", text: `More providers (${list.map((p) => p.name).join(", ")})` }), h("span", { class: "grow" }), h("span", { class: "caret", text: "›" }));
    const card = h("div", { class: "prov" + (open ? " open" : "") }, head);
    if (open) card.append(h("div", { class: "prov-body more-list" }, ...list.map(providerCard)));
    return card;
  }

  async function loadRegistry() {
    if (S.registry) return;
    S.registry = { loading: true, choices: [] };
    try { const r = await api("/api/providers/registry"); S.registry = { choices: r.choices, ok: r.ok }; }
    catch { S.registry = { choices: [], ok: false }; }
    renderSettings();
  }
  function addProviderEl() {
    const open = S.open.__add ?? false;
    const head = h("div", { class: "prov-head", role: "button", tabindex: "0", "aria-expanded": String(open), onclick: () => { S.open.__add = !open; store.set("open", S.open); renderSettings(); if (!open) loadRegistry(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } },
      h("span", { class: "logo", text: "+" }), h("span", { class: "name", text: "Add a provider" }), h("span", { class: "grow" }), h("span", { class: "caret", text: "›" }));
    const card = h("div", { class: "prov" + (open ? " open" : "") }, head);
    if (!open) return card;
    const name = h("input", { type: "text", placeholder: "Name, for example NVIDIA", maxlength: "40", autocomplete: "off", "aria-label": "Provider name", "data-keep": "add-name" });
    const base = h("input", { type: "url", placeholder: "Address, for example https://integrate.api.nvidia.com/v1", autocomplete: "off", "aria-label": "Provider address", "data-keep": "add-base" });
    const key = h("input", { type: "password", placeholder: "Its key, if it needs one", autocomplete: "off", "aria-label": "Provider key", "data-keep": "add-key" });
    let registry = null;
    const choices = S.registry?.choices ?? [];
    const pick = h("select", { "aria-label": "Pick a provider from models.dev", onchange: (e) => { const c = choices.find((x) => x.id === e.target.value); registry = c?.id ?? null; if (c) { name.value = c.name; base.value = c.api; } } },
      h("option", { value: "", text: S.registry?.loading ? "Loading models.dev's list…" : choices.length ? `Pick one of ${choices.length} providers (models.dev), or type below` : "Type the name and address below" }),
      ...choices.map((c) => h("option", { value: c.id, text: `${c.name} · ${c.models} models` })));
    card.append(h("div", { class: "prov-body" },
      h("p", { class: "note", text: "Any provider that speaks OpenAI's format: pick it from the list or type its address. Leanfare reads its model list there, and takes prices from models.dev when it lists the model." }),
      choices.length || S.registry?.loading ? h("div", { class: "row" }, pick) : null,
      h("div", { class: "row" }, name), h("div", { class: "row" }, base), h("div", { class: "row" }, key),
      h("div", { class: "row" }, runButton("Test and add", (signal) => addCustom({ name: name.value, base: base.value, key: key.value, registry }, signal), "btn primary"))));
    return card;
  }
  async function addCustom(fields, signal) {
    const r = await api("/api/providers/custom", { body: fields, signal });
    S.st = r.state;
    if (r.ok) { S.open.__add = false; S.open[r.id] = true; store.set("open", S.open); }
    renderShell(); renderSettings(); renderComposerBar();
    toast(r.message, r.ok ? "done" : "error");
  }
  async function removeCustom(p) {
    try {
      const r = await api("/api/providers/custom/remove", { body: { id: p.id } });
      S.st = r.state;
      renderShell(); renderSettings(); renderComposerBar();
      toast(`Removed ${p.name}.`, "done");
    } catch (e) { failed(e); }
  }

  // Speed: at the same quality (the level above), the cheapest, the cheapest within a time, or the fastest.
  // Times come from how fast each model answered you before (a rough guess until it has answered three times).
  // A plan's paid parts (planner.ts): run without asking up to this much a plan; above it, Leanfare asks.
  function planCapSettingEl(s) {
    const box = moneyInput(s.planAuto || null, "Paid parts of a plan without asking, up to");
    return h("div", { class: "setting" }, h("h3", { text: "Plans in your apps" }),
      h("div", { class: "row" }, h("span", { text: "Run a plan's paid parts without asking, up to" }), box,
        h("button", { class: "btn", type: "button", text: "Save", onclick: () => patchSettings({ planAuto: box.querySelector("input").value || 0 }, "Saved.") })),
      h("p", { text: `When Claude Code or another app runs Leanfare's parts of a plan (plan_run), parts on local and free models run at once. Paid parts run without asking while they come to at most ${money(s.planAuto || 0)} a plan; above that, Leanfare asks you first (in Claude Code, a question in Claude Code). Your monthly budget holds either way.` }));
  }

  // ---- Where Leanfare may send work (Settings) --------------------------------------------------------
  // Each platform on or off for plans and the delegate, and what is left before its nearest limit (platforms.ts).
  async function loadPlatforms() { try { S.platforms = await api("/api/platforms"); } catch { S.platforms = { rows: [] }; } renderSettings(); }
  function resetsText(iso) {
    const d = new Date(iso), t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${t}`;
  }
  const windowText = (w) => `${w.kind}: ${w.left}% left${w.tokensLeft ? ` (about ${tokShort(w.tokensLeft)} tokens)` : ""}${w.resets ? `, resets ${resetsText(w.resets)}` : ""}`;
  function platformsSettingEl() {
    if (S.platforms === undefined) { S.platforms = null; loadPlatforms(); }
    const P = S.platforms;
    const card = h("div", { class: "setting", id: "platformsSetting" }, h("h3", { text: "Where Leanfare may send work" }));
    if (!P) { card.append(h("p", { class: "note", text: "Reading your plans' limits…" })); return card; }
    for (const r of P.rows) {
      const sw = r.ready ? h("button", { class: "hswitch", type: "button", role: "switch", "aria-checked": String(r.on), "aria-label": `${r.label} for plans and the delegate`, onclick: () => setPlatform(r.id, !r.on) },
        h("span", { class: "hs-label", text: r.on ? "Use" : "Off" }), h("span", { class: "track", "aria-hidden": "true" }, h("span", { class: "knob" }))) : null;
      const lims = r.windows.length ? `${r.windows.map(windowText).join(" · ")}${r.source ? ` (${r.source}${r.asOf ? `, ${ago(r.asOf)}` : ""})` : ""}` : null;
      card.append(h("div", { class: "prow" + (r.ready ? "" : " off") },
        h("div", { class: "pinfo" }, h("div", { class: "pname" }, r.label, r.risk ? h("span", { class: "chip warn", text: r.risk }) : null),
          lims ? h("div", { class: "note lim", text: lims }) : null,
          r.stale ? h("div", { class: "note stale", text: r.stale }) : null,
          r.limit ? h("div", { class: "note", text: r.limit }) : null,
          r.needs ? h("div", { class: "note", text: r.needs }) : null,
          r.riskWhy ? h("details", { class: "why" }, h("summary", { text: "Why it says so" }), h("p", { class: "note", text: r.riskWhy })) : null),
        sw ?? h("span", {})));
    }
    // Where your projects' files may go (platforms.ts: mayTake); the details stay folded until asked for.
    const to = S.st?.settings.filesTo ?? "any";
    card.append(h("div", { class: "files-to" },
      h("div", { class: "pname", text: "Your projects' files go to" }),
      h("div", { class: "seg wrap", role: "group", "aria-label": "Your projects' files go to" }, ...[["any", "Any platform that is on"], ["notFree", "Not to a free tier that may be read"], ["local", "Only this computer"]].map(([k, label]) =>
        h("button", { type: "button", "aria-pressed": String(to === k), text: label, onclick: () => patchSettings({ filesTo: k }, k === "any" ? "Files may go to any platform that is on." : k === "notFree" ? "Files skip free tiers that may be read." : "Files stay on this computer.") }))),
      h("details", { class: "why" }, h("summary", { text: "What this does" }),
        h("p", { class: "note", text: "Files from your projects, in a plan's parts or the delegate, go only where this says; work with no files may still go to any platform that is on. A part no model there can take stays with you. Not to a free tier: they skip Gemini's free key and OpenRouter's free models. Only this computer: they go to your models in Ollama. An app can also ask for one task or plan to stay on this computer (private)." }))));
    card.append(h("p", { class: "fine", text: "The nearest limit shows first: the 5 hours before the week. A plan's numbers come only from its own app (Claude Code's status line, Codex's log files). Off: plans and the delegate leave that one out; the chat uses the models you ticked." }));
    return card;
  }
  async function setPlatform(id, on) {
    try { S.platforms = await api("/api/platforms", { body: { id, on } }); renderSettings(); toast(on ? "Plans and the delegate can use it again." : "Plans and the delegate leave it out now.", "done"); } catch (e) { failed(e); }
  }

  // ---- Your ChatGPT plan, through Codex (Settings) ------------------------------------------------
  // A plan's reading, drafting and working out parts on Codex (codex.ts), once you turn it on here.
  async function loadCodex(fresh) {
    try { S.codex = await api(`/api/codex${fresh ? "?fresh=1" : ""}`); } catch { S.codex = { installed: false, signedIn: false, version: null }; }
    renderSettings();
  }
  function codexSettingEl(s) {
    if (S.codex === undefined) { S.codex = null; loadCodex(false); }
    const c = S.codex;
    const v = c?.version ? ` ${c.version}` : "";
    const status = !c ? "Looking for Codex…"
      : !c.installed ? "Codex is not on this computer. To get it, in Terminal: npm install -g @openai/codex, then codex login (sign in with ChatGPT)."
      : c.login === "other" ? `Codex${v} is signed in with an API key or another login, not with ChatGPT, so Leanfare does not use it: that would be billed per use. In Terminal: codex login (sign in with ChatGPT).`
      : !c.signedIn ? `Codex${v} is here, but not signed in. In Terminal: codex login (sign in with ChatGPT).`
      : `Codex${v} is here and signed in.`;
    return h("div", { class: "setting", id: "codexCard" }, h("h3", { text: "Your ChatGPT plan, through Codex" }),
      h("p", { class: "note", text: status }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.codexPlan, onchange: (e) => patchSettings({ codexPlan: e.target.checked }, e.target.checked ? "Plans can run reading and drafting on Codex now." : "Plans no longer use Codex.") }),
        " Let plans run their reading, drafting and working out on Codex, before pay per use"),
      h("p", { text: "Codex runs those parts read only, in the folder of their files, without your MCP servers, apps or plugins, and they count toward your ChatGPT plan's Codex limits; Leanfare pays nothing for them. Codex itself decides what it reads there, as when you use it. Parts that change your project stay with the app you work in. Near 85% of your ChatGPT plan's 5 hours or week, Leanfare leaves Codex alone." }),
      runButton("Look again", () => loadCodex(true), "btn small quiet"));
  }

  // ---- How the models did for you (Settings) ---------------------------------------------------------
  const GRADE_KIND = { read: "reading", write: "drafting", reason: "working things out", search: "searching" };
  async function loadGrades() {
    try { const r = await api("/api/grades"); S.grades = r.standings; S.side = r.side ?? []; S.sideMonth = r.sideMonth ?? null; } catch { S.grades = []; S.side = []; }
    renderSettings();
  }
  function gradesSettingEl() {
    if (S.grades === undefined) { S.grades = null; loadGrades(); }
    const list = S.grades ?? [];
    return h("div", { class: "setting", id: "gradesCard" }, h("h3", { text: "How the models did for you" }),
      h("p", { text: "When the app you work in uses an answer one of Leanfare's models gave for a part, it grades it: good, partly or wrong (you can too, in the Plan tab). Leanfare keeps only the grade, never the words. A model graded below good too often for a kind (at least 3 of its last 20 grades, under half good) is moved down: plans and the delegate skip it for that kind while another model can take it." }),
      !list.length ? h("p", { class: "note", text: S.grades === null ? "Reading the grades…" : "No grades yet." })
        : h("div", { class: "lmodels" }, ...list.map((g) => h("div", { class: "lrow" + (g.down ? " down" : "") },
          h("span", { class: "nm", title: g.model, text: `${g.label} · ${GRADE_KIND[g.kind] ?? g.kind}` }),
          h("span", { class: "facts" }, h("span", { text: `${g.good} good, ${g.partly} partly, ${g.wrong} wrong` }), g.down ? h("span", { class: "chip bad", text: "moved down" }) : null),
          g.down ? runButton("Give it another chance", async () => {
            const r = await api("/api/grades/reset", { body: { model: g.model, kind: g.kind } });
            S.grades = r.standings; renderSettings(); toast(`${g.label} is picked again for ${GRADE_KIND[g.kind] ?? g.kind}.`, "done");
          }, "btn small") : h("span", {})))),
      sideResultsEl());
  }

  // Side by side's results (sidebyside.ts): how close each model's work was to the top model's, judged blind.
  function sideResultsEl() {
    const list = S.side ?? [];
    if (!list.length) return null;
    return h("div", { class: "side-results" }, h("h4", { text: "Side by side with the top model" }),
      h("p", { class: "note", text: "Judged blind by a model of a third company: it was not told which model wrote which answer." }),
      h("div", { class: "lmodels" }, ...list.map((x) => h("div", { class: "lrow side", title: x.text },
        h("span", { class: "nm", title: x.model, text: `${x.label} · ${GRADE_KIND[x.kind] ?? x.kind}` }),
        h("span", { class: "facts" }, h("span", { text: `as good in ${x.same + x.better} of ${x.n}${x.better ? `, better in ${x.better}` : ""}` })),
        h("span", { class: "vs", text: `against ${x.tops.join(", ")} · judged by ${x.judges.join(", ")}` })))));
  }

  // A test (mcp.ts: markedBy): answers handed back to your apps mark which model wrote each paragraph.
  function whoWroteSettingEl(s) {
    return h("div", { class: "setting" }, h("h3", { text: "Show who wrote what (a test)" }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.whoWrote, onchange: (e) => patchSettings({ whoWrote: e.target.checked }, e.target.checked ? "Answers Leanfare hands back now mark which model wrote each paragraph." : "Answers no longer carry the marks.") }),
        "Mark which model wrote each paragraph of the answers Leanfare hands back to your apps"),
      h("p", { text: "For a test: each paragraph of a hand off's or a plan part's answer starts with the model's name in a small mark, and your app is asked to keep the marks and to mark the paragraphs it writes itself, so its reply shows who wrote what. It adds a few words to each paragraph, and works as far as your app follows it. Off at first." }));
  }

  // Side by side (sidebyside.ts): how often the top model answers a hand off too, and the most it may spend a month.
  function sideBySideSettingEl(s) {
    const box = moneyInput(s.sideBySideCap ?? 1, "Side by side, at most a month");
    const often = h("select", { "aria-label": "Side by side, how often", onchange: (e) => patchSettings({ sideBySide: Number(e.target.value) }, Number(e.target.value) ? `Side by side: 1 in ${e.target.value} hand offs.` : "Side by side is off.") },
      ...[[0, "Off"], [20, "1 in 20 hand offs"], [10, "1 in 10 hand offs"], [5, "1 in 5 hand offs"]].map(([v, t]) => h("option", { value: String(v), text: t, selected: (s.sideBySide ?? 10) === v })));
    const m = S.sideMonth;
    return h("div", { class: "setting", id: "sideCard" }, h("h3", { text: "Side by side" }),
      h("div", { class: "row" }, often, h("span", { text: "at most" }), box, h("span", { text: "a month" }),
        h("button", { class: "btn", type: "button", text: "Save", onclick: () => patchSettings({ sideBySideCap: box.querySelector("input").value || 0 }, "Saved.") })),
      h("p", { text: "Now and then the best rated model you ticked answers a hand off too, after its answer went back to your app, and a model of a third company compares the two answers without knowing which model wrote which (in a random order, with what each says of its own model hidden). So you see how close each model's work is to the top model's, for each kind of work. Never for a private task, never past this limit or your budget. Leanfare keeps only the verdicts and costs." }),
      m && m.compared ? h("p", { class: "note", text: `This month: ${num(m.compared)} compared, as good as the top model in ${num(m.asGood)}; ${money(m.cost)} of your ${money(s.sideBySideCap ?? 1)}.` }) : null);
  }

  function speedSettingEl(s) {
    const sel = h("select", { "aria-label": "Speed", onchange: (e) => patchSettings({ speed: speedValue(e.target.value) }, `Speed: ${e.target.selectedOptions[0].textContent.toLowerCase()}.`) },
      ...speedOptions(s.speed ?? "cheapest", 1));
    return h("div", { class: "setting" }, h("h3", { text: "Speed" }), sel,
      h("p", { text: "At the same quality, a cheaper model can be slower, or faster: Leanfare times each model's answers and picks by your choice. Every estimate shows its time next to its price." }));
  }

  // ---- Use Leanfare in your apps (Settings) -----------------------------------------------------------
  // Leanfare's MCP tools in the apps you already use: one press per app, undone the same way.
  const APP_STATUS = { added: "added", old: "added from another copy of Leanfare", "not added": "not added yet", broken: "its settings file is not valid, so Leanfare leaves it alone", "not installed": "not on this computer" };
  async function loadApps() {
    if (S.apps) return;
    S.apps = { loading: true, list: [] };
    try { const r = await api("/api/apps"); S.apps = { list: r.apps }; } catch { S.apps = { list: [] }; }
    renderSettings();
  }
  function appsSettingEl() {
    if (!S.apps) loadApps();
    const list = S.apps?.list ?? [];
    const here = list.filter((a) => a.status !== "not installed");
    const away = list.filter((a) => a.status === "not installed");
    const row = (a) => h("div", { class: "app-row" },
      h("div", { class: "row" },
        h("span", { class: "grow" }, h("b", { text: a.name }), h("span", { class: "note", text: ` · ${APP_STATUS[a.status]}` })),
        a.status === "broken" ? null : runButton(a.status === "added" ? "Remove" : a.status === "old" ? "Update" : "Add", (signal) => toggleApp(a, a.status !== "added", signal), a.status === "added" ? "btn small" : "btn small primary")),
      a.note ? h("div", { class: "note", text: a.note }) : null,
      a.manual && a.status !== "added" ? h("div", { class: "note manual" }, "Or in Terminal: ", h("code", { text: a.manual }), " ", copyBtn(a.manual)) : null,
      // Plan by itself (workers.ts): once Leanfare's tools are in the app, from this copy or another.
      a.auto && (a.status === "added" || a.status === "old" || a.auto.on || a.auto.partly) ? h("div", { class: "row auto-row" },
        h("span", { class: "grow note", text: `${a.auto.what}${a.auto.on ? " · on" : a.auto.partly ? " · partly on" : ""}.${a.auto.reminders?.n ? ` In the last 7 days it reminded Claude Code ${a.auto.reminders.n} time${a.auto.reminders.n === 1 ? "" : "s"} before a big read (${a.auto.reminders.kb >= 1024 ? `${(a.auto.reminders.kb / 1024).toFixed(1)} MB` : `${a.auto.reminders.kb} KB`} of files).` : ""}` }),
        runButton(a.auto.on || a.auto.partly ? "Turn off" : "Turn on", (signal) => toggleAuto(a, !(a.auto.on || a.auto.partly), signal), a.auto.on || a.auto.partly ? "btn small" : "btn small primary")) : null);
    return h("div", { class: "setting apps", id: "appsSetting" }, h("h3", { text: "Use Leanfare in your apps" }),
      h("p", { text: "Adds Leanfare's tools (plan, delegate, ask, spend, models, estimate, trial) to the AI apps you already use, so they work as usual with Leanfare on top. Leanfare changes only its own entry in each app's settings, and keeps a copy of the file as it was." }),
      h("div", { class: "row" }, h("button", { class: "btn small", type: "button", text: "Set up all at once", onclick: () => setTab("setup") }),
        h("span", { class: "note", text: "Every app found, and the first models when none is ticked, with one press" })),
      S.apps?.loading ? h("p", { class: "note", text: "Looking for the AI apps on this computer…" }) : null,
      ...here.map(row),
      !S.apps?.loading && !here.length ? h("p", { class: "note", text: "None of the apps Leanfare knows are on this computer yet." }) : null,
      away.length ? h("button", { class: "more-toggle", type: "button", text: S.showAllApps ? "▾ Hide the apps not on this computer" : `▸ ${away.length} more not found on this computer (${away.map((a) => a.name).join(", ")})`, onclick: () => { S.showAllApps = !S.showAllApps; renderSettings(); } }) : null,
      S.showAllApps ? h("div", { class: "away" }, ...away.map(row)) : null);
  }
  async function toggleAuto(a, on, signal) {
    try {
      const r = await api("/api/apps", { body: { id: a.id, auto: on }, signal });
      S.apps = { list: r.apps };
      renderSettings();
      toast(on ? `${a.name} now plans by itself with Leanfare. ${a.after}` : `${a.name} no longer plans with Leanfare by itself.`, "done");
    } catch (e) { S.apps = null; loadApps(); throw e; }
  }
  async function toggleApp(a, on, signal) {
    try {
      const r = await api("/api/apps", { body: { id: a.id, on }, signal });
      S.apps = { list: r.apps };
      renderSettings();
      toast(on ? `Added Leanfare's tools to ${a.name}. ${a.after}` : `Took Leanfare's tools out of ${a.name}.`, "done");
    } catch (e) {
      S.apps = null;
      loadApps();
      throw e;
    }
  }

  // The model apps Leanfare looks for on this computer, besides Ollama (they show as providers when found).
  function localAppsEl() {
    const x = S.st.extra?.local;
    if (!x) return null;
    const found = x.found ?? [];
    return h("div", { class: "setting" }, h("div", { class: "row" },
      h("span", { class: "note grow", text: found.length
        ? `Also running here: ${found.map((f) => `${f.name} (${f.models} model${f.models === 1 ? "" : "s"})`).join(", ")}. They are listed with the providers above.`
        : `Leanfare also looks for ${x.apps.map((a) => a.name).join(", ")} running on this computer${x.at ? ` (last look ${ago(x.at)})` : ""}.` }),
      runButton("Look again", (signal) => refreshList("local", signal))));
  }

  function renderSettings() {
    const el = $("#tab-settings");
    const st = S.st;
    if (!st) return;
    const scrollL = el.querySelector(".colL")?.scrollTop ?? 0, scrollR = el.querySelector(".colR")?.scrollTop ?? 0;

    // Providers with a key or running come first; the ones kept for later wait under More providers.
    const shown = st.providers.filter((p) => !(p.more && !p.ready && !p.key?.saved) && !(p.local && p.id !== "ollama" && !p.ready));
    const later = st.providers.filter((p) => p.more && !p.ready && !p.key?.saved);
    const left = h("div", { class: "colL" }, h("div", { class: "section-title", text: `Providers · ${st.readyCount} ready` }),
      keysCardEl(), ...shown.map(providerCard), moreProvidersEl(later), addProviderEl(),
      h("div", { class: "section-title", text: "Local models" }), localAppsEl(), localCardEl());

    const s = st.settings;
    const modeSeg = h("div", { class: "seg", role: "group", "aria-label": "How Auto picks" },
      ...Object.entries(st.modes).map(([k, v]) => h("button", { type: "button", "aria-pressed": String(s.mode === k), text: v.label, onclick: () => patchSettings({ mode: k }, `Auto now picks: ${v.label}.`) })));
    const ticked = new Set(s.ticked);
    const usualOpts = [h("option", { value: "", selected: !s.usual, text: `The best rated model I ticked${st.usual && !s.usual ? ` (now ${st.usual.label})` : ""}` })];
    for (const p of st.providers) {
      const ms = modelsOf(p.id).filter((m) => ticked.has(m.id) || m.id === s.usual);
      if (ms.length) usualOpts.push(h("optgroup", { label: p.name }, ...ms.map((m) => h("option", { value: m.id, selected: s.usual === m.id, text: m.label }))));
    }
    const usualSel = h("select", { "aria-label": "Your usual model", onchange: (e) => patchSettings({ usual: e.target.value || null }, "Usual model saved.") }, ...usualOpts);
    const budgetBox = moneyInput(s.budget, "Monthly budget");
    const subBox = moneyInput(s.subscription, "Subscription price");
    const limitSeg = h("div", { class: "seg", role: "group", "aria-label": "When the budget runs out" },
      h("button", { type: "button", "aria-pressed": String(s.atLimit === "cheapest"), text: "Keep going on the cheapest model", onclick: () => patchSettings({ atLimit: "cheapest" }, "Saved.") }),
      h("button", { type: "button", "aria-pressed": String(s.atLimit === "stop"), text: "Stop", onclick: () => patchSettings({ atLimit: "stop" }, "Saved.") }));
    const b = st.budget;
    const addr = st.address;
    const lock = st.lock ?? { on: false, key: null };
    const curl = `curl ${addr}/v1/chat/completions -H "content-type: application/json"${lock.on ? ` -H "authorization: Bearer ${lock.key}"` : ""} -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`;
    const d = st.data;
    const theme = themeNow();
    const right = h("div", { class: "colR" },
      h("div", { class: "section-title", text: "In your apps" }),
      appsSettingEl(),
      h("div", { class: "section-title", text: "Choices" }),
      h("div", { class: "setting" }, h("h3", { text: "How Auto picks" }), modeSeg,
        h("p", { text: `${st.modes[s.mode].label}: ${st.modes[s.mode].blurb}, for the task Leanfare guesses from your message (coding, math, writing, long prompts and more). Ratings come from the Arena leaderboard.` })),
      speedSettingEl(s),
      h("div", { class: "setting" }, h("h3", { text: "Answers in the chat" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.brief !== false, onchange: (e) => patchSettings({ brief: e.target.checked }, e.target.checked ? "Answers will be short: the answer first, a table or a short list." : "Answers will be as long as each model likes.") }), "Short answers: the answer first, a table or a short list, more only when you ask"),
        h("p", { text: "For the chat screen only: other apps get their own instructions as they send them. A chat's own instructions still apply, after this. For a task with several parts, the Plan tab answers with a table of the parts and their models." })),
      h("div", { class: "setting" }, h("h3", { text: "Thinking effort" }),
        h("div", { class: "seg", role: "group", "aria-label": "Thinking effort" }, ...[["auto", "Model's default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([k, label]) =>
          h("button", { type: "button", "aria-pressed": String((s.effort ?? "auto") === k), text: label, onclick: () => patchSettings({ effort: k }, k === "auto" ? "Thinking models think as they do by default." : `Thinking effort: ${label.toLowerCase()}.`) }))),
        h("p", { text: "For models that think before they answer, at the levels each one takes. Thinking is billed as output, so a higher effort costs more and takes longer; the estimate learns from your answers at each level." })),
      planCapSettingEl(s), platformsSettingEl(), codexSettingEl(s), gradesSettingEl(), sideBySideSettingEl(s), whoWroteSettingEl(s),
      h("div", { class: "setting" }, h("h3", { text: "Your usual model" }), usualSel,
        h("p", { text: "The model you would use without Leanfare. Savings are measured against it." })),
      h("div", { class: "setting", id: "budgetSetting" }, h("h3", { text: "Monthly budget" }),
        h("div", { class: "row" }, budgetBox, h("button", { class: "btn", text: "Save", onclick: () => patchSettings({ budget: budgetBox.querySelector("input").value || null }, "Budget saved.") }),
          b.budget !== null ? h("span", { class: "note", text: `${money(b.spent)} spent · ${money(b.left)} left` }) : null),
        h("p", { text: "When it runs out:" }), limitSeg,
        h("p", { text: "Before each request goes out, Leanfare reserves the most it can cost, so requests sent at the same moment cannot pass the budget together. A warning shows at 80%." })),
      h("div", { class: "setting" }, h("h3", { text: "Compare with a subscription" }),
        h("div", { class: "row" }, subBox, h("button", { class: "btn", text: "Save", onclick: () => patchSettings({ subscription: subBox.querySelector("input").value || null }, "Saved.") })),
        h("p", { text: "For example $20 for a monthly chat plan. The Savings page shows how far under or over it you are." })),
      plansSetting(s),
      h("div", { class: "setting" }, h("h3", { text: "Instructions for new chats" }),
        h("textarea", { rows: 3, placeholder: "For example: Answer briefly. I live in Toronto and write Python.", "aria-label": "Instructions for new chats", "data-keep": "instructions", text: s.instructions }),
        h("div", { class: "row" }, h("button", { class: "btn", text: "Save", onclick: (e) => patchSettings({ instructions: e.target.closest(".setting").querySelector("textarea").value }, "Saved. New chats start with these instructions.") })),
        h("p", { text: "Every new chat starts with these (a system prompt). Change them for one chat with Instructions above the conversation." })),
      h("div", { class: "setting" }, h("h3", { text: "Chat history" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.history, onchange: (e) => patchSettings({ history: e.target.checked }, e.target.checked ? "Chats will be kept on this computer." : "Chats will not be kept.").then(loadChats) }), "Keep my chats on this computer"),
        h("div", { class: "row" }, runButton("Export all chats", exportEverything),
          h("label", { class: "btn", title: "Leanfare's export, or the .zip (or conversations.json) ChatGPT or Claude emails you" }, "Import chats",
            h("input", { type: "file", hidden: true, accept: ".json,.zip,application/json,application/zip", onchange: (e) => { importFile(e.target.files[0]); e.target.value = ""; } }))),
        h("p", { text: "Export saves every chat, with its files, as one file. Import reads that file, or the export ChatGPT or Claude emails you (the .zip, or the conversations.json inside it). The cost ledger never keeps what you wrote, only token counts and costs." })),
      h("div", { class: "setting" }, h("h3", { text: "New versions" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.updateCheck !== false, onchange: (e) => patchSettings({ updateCheck: e.target.checked }, e.target.checked ? "Leanfare will say when a new version is out." : "Leanfare will not look for new versions.") }), "Tell me when a new version is out"),
        h("p", { text: `You have Leanfare ${st.version}. Once a day it asks GitHub's public list of releases whether there is a newer one; nothing about you or your use is sent.` })),
      h("div", { class: "setting" }, h("h3", { text: "Use Leanfare from your other apps" }),
        h("p", { text: `Point any app or script that speaks OpenAI's or Anthropic's format here. ${lock.on ? "Use the access key below as its API key." : "Any API key works."} Model: auto, auto-save, auto-best, or a model id such as google/gemini-3.8-flash.` }),
        h("div", { class: "addr" }, h("span", { class: "grow", text: `OpenAI address: ${addr}/v1` }), copyBtn(`${addr}/v1`)),
        h("div", { class: "addr" }, h("span", { class: "grow", text: `Anthropic address: ${addr}` }), copyBtn(addr)),
        h("div", { class: "addr" }, h("span", { class: "grow", text: curl }), copyBtn(curl))),
      h("div", { class: "setting" }, h("h3", { text: "Other apps need a key" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: lock.on, onchange: (e) => setLock(e.target.checked) }), "Ask apps for Leanfare's access key"),
        lock.on ? h("div", { class: "addr" }, h("span", { class: "grow", text: lock.key }), copyBtn(lock.key), h("button", { class: "btn small", type: "button", text: "New key", onclick: () => setLock(true, true) })) : null,
        h("p", { text: lock.on
          ? "Apps send it as their API key (OpenAI's and Anthropic's clients both do). A new key stops the old one at once. This page stays open; another browser asks for the key once."
          : "Off: any app on this computer can use Leanfare's addresses with any key. Turn it on if other people use this computer." })),
      h("div", { class: "setting" }, h("h3", { text: "Prices and ratings" }),
        h("p", { text: `${d.modelCount} models from llmledger's data, built ${dayLabel(d.built)} (${d.from === "built-in" ? "the copy inside this release" : "downloaded"}); ratings from ${d.ratingsDate ?? "—"}. ${d.status.state === "ok" ? `Last checked ${ago(d.status.at)}.` : d.status.state === "failed" ? `The last update failed: tried ${d.status.tried}: ${d.status.error}.` : "Checked once a day."}` }),
        h("div", { class: "row" }, runButton("Update now", (signal) => refreshList("data", signal)))),
      h("div", { class: "setting" }, h("h3", { text: "Look" }),
        h("div", { class: "seg", role: "group", "aria-label": "Theme" }, ...[["light", "Day"], ["auto", "Auto"], ["dark", "Night"]].map(([k, label]) =>
          h("button", { type: "button", "aria-pressed": String(theme === k), text: label, onclick: () => pickTheme(k) }))),
        h("p", { class: "fine", text: "Auto is day from 7 AM to 7 PM by this computer's clock." })),
      h("p", { class: "fine" }, `Leanfare ${st.version} · Bun ${st.bun}${st.bun.startsWith(st.bunTested + ".") ? "" : ` (tested on ${st.bunTested}.x)`} · keys in ${st.keyStore}. Prices: LiteLLM's price list (MIT) via llmledger (MIT)${st.settings.providers.openrouter?.on ? " and OpenRouter's model list" : ""}. Ratings: Arena leaderboard (CC BY 4.0), condensed to each model's best rating per task. Not affiliated with any AI provider.`));
    keepInputs(el, () => el.replaceChildren(left, right)); // what is typed in key boxes survives the redraw
    el.querySelector(".colL").scrollTop = scrollL;
    el.querySelector(".colR").scrollTop = scrollR;
    focusSetting();
  }

  // ---- the first run: Set up, and the switch at the top ----------------------------------------
  // Most people want Leanfare ready and out of the way: Set up puts it in the AI apps on this computer
  // with one press, and the switch at the top turns it off and on in all of them at once.
  const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  // Where the page goes after Set up: the screen you used last (0.6 kept it as "tab"), or Chat.
  const landing = () => SCREEN(store.get("screen", null)) ?? SCREEN(store.get("tab", null)) ?? "chat";

  async function toggleAppsSwitch(want) {
    if (!S.st) return;
    const next = typeof want === "boolean" ? want : S.st.switchOn === false;
    S.st.switchOn = next; // shown at once, confirmed by the server below
    renderShell();
    try {
      const { on, stopped } = await api("/api/switch", { body: { on: next } });
      S.st.switchOn = on;
      renderShell();
      const what = [stopped?.plans ? `${stopped.plans} running plan${stopped.plans === 1 ? "" : "s"}` : "", stopped?.delegates ? `${stopped.delegates} hand off${stopped.delegates === 1 ? "" : "s"} still working` : "", stopped?.trial ? "the trial" : ""].filter(Boolean);
      toast(next ? "Leanfare is on in your apps again." : `Leanfare is off in your apps.${what.length ? ` It stopped ${andList(what)}.` : ""}`, "done"); // the line at the top says the rest
    } catch (e) { S.st.switchOn = !next; renderShell(); failed(e); }
  }

  async function loadSetup(signal) {
    try { S.setup = await api("/api/setup", { signal }); S.setupError = null; }
    catch (e) { if (e?.name === "AbortError") throw e; S.setupError = String(e?.message ?? e); }
    if (S.tab === "setup") renderSetup();
  }
  function renderSetup() {
    const el = $("#tab-setup");
    const v = S.setup;
    const title = h("div", { class: "simple-block" }, h("h1", { class: "simple-h1", text: "Set up Leanfare" }),
      h("p", { class: "big-sub", text: "Leanfare works inside the AI apps you already use. It hands simple work, like reading files and drafting, to cheaper or free models, and you keep working as before." }));
    if (!v) {
      if (!S.setupError && !S.setupLoading) { S.setupLoading = true; loadSetup().finally(() => { S.setupLoading = false; }); }
      el.replaceChildren(h("div", { class: "simple-col" }, title, h("p", { class: "note", text: S.setupError ? `Leanfare could not look at this computer: ${S.setupError}` : "Looking at this computer…" }),
        S.setupError ? runButton("Look again", (signal) => loadSetup(signal)) : null));
      return;
    }
    const apps = v.apps.filter((a) => a.status !== "broken");
    const broken = v.apps.filter((a) => a.status === "broken");
    const row = (name, sub, ok = true) => h("div", { class: "list-row" },
      h("span", { class: "found-mark " + (ok ? "ok" : "warn"), "aria-hidden": "true", text: ok ? "✓" : "!" }),
      h("div", { class: "lr-main" }, h("div", { class: "lr-title", text: name }), h("div", { class: "note", text: sub })));
    const found = h("div", { class: "simple-block" }, h("div", { class: "simple-label", text: "Found on this computer" }),
      h("div", { class: "list-card" },
        ...apps.map((a) => row(a.name, a.status === "added" ? "Leanfare is in here already" : "Leanfare goes in here")),
        ...broken.map((a) => row(a.name, a.note ?? "Its settings file cannot be read, so Leanfare leaves it alone.", false)),
        ...v.models.map((m) => row(m.name, `A model to hand work to: ${m.how}`)),
        !v.apps.length ? row("No AI apps found", "Leanfare works inside Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI and more. Install one, then press Look again.", false) : null));
    const needModel = v.ready ? null : h("div", { class: "simple-block" }, h("div", { class: "simple-label", text: "One more thing" }),
      v.ollama ? h("div", { class: "list-card pad" }, // Ollama runs, with no model yet
        h("p", { class: "lr-title", text: "Get a free model for Ollama" }),
        h("p", { class: "note", text: "Ollama is running on this computer, with no model yet. Leanfare suggests the best free model that fits this computer and has Ollama download it when you say yes. Then press Look again." }),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: "Get a free model", onclick: () => openSetting("localCard") }),
          runButton("Connect OpenRouter", async (signal) => { await connectOpenRouter(signal); await loadSetup(signal); })))
      : h("div", { class: "list-card pad" },
        h("p", { class: "lr-title", text: "Leanfare needs a model to hand work to" }),
        h("p", { class: "note", text: "The quickest is OpenRouter, which has free models: you sign in on its page. Or add a key you have, or install Ollama (ollama.com) for free models on this computer, then press Look again." }),
        h("div", { class: "row" }, runButton("Connect OpenRouter", async (signal) => { await connectOpenRouter(signal); await loadSetup(signal); }, "btn primary"),
          h("button", { class: "btn", type: "button", text: "Add a key", onclick: () => openSetting("keysCard") }))));
    const allIn = apps.length > 0 && apps.every((a) => a.status === "added");
    const planners = apps.filter((a) => a.plansItself).map((a) => a.name);
    const what = `It adds Leanfare's tools to each app${planners.length ? `, and to ${andList(planners)} a few lines on when to hand work over` : ""}. Remove takes them out again (Settings, In your apps).`;
    const why = v.busy ? "Still finishing the app it is on…" : !apps.length ? "Turn on needs an AI app on this computer." : !v.ready ? "Turn on needs a model first (above)." : null;
    // While it runs the button is its own Stop: Set up stops before the next app, and the list then shows what it did.
    const turnOn = runButton(allIn ? "Turn on Leanfare again" : "Turn on Leanfare", (signal) => turnOnLeanfare(signal), "btn primary big-btn");
    if (why) { turnOn.disabled = true; turnOn.title = why; }
    el.replaceChildren(h("div", { class: "simple-col" }, title, found, needModel, h("div", { class: "spacer" }),
      h("div", { class: "simple-block" }, turnOn,
        h("p", { class: "fine center", text: why ?? what }),
        h("p", { class: "fine center", text: "Leanfare reads usage numbers, never your words." }),
        h("div", { class: "row center" }, runButton("Look again", (signal) => loadSetup(signal), "btn quiet small"),
          h("button", { class: "btn quiet small", type: "button", text: v.setupDone ? "Back" : "Skip for now", onclick: skipSetup })))));
  }
  async function turnOnLeanfare(signal) {
    let r;
    try { r = await api("/api/setup", { body: {}, signal }); }
    catch (e) { if (e?.name === "AbortError") followSetup(); throw e; }
    S.setup = r.setup; S.apps = null;
    const ok = r.results.filter((x) => x.ok), bad = r.results.filter((x) => !x.ok);
    const notIn = bad.length ? `Not in ${bad.map((x) => `${x.name} (${x.error})`).join("; ")}.` : "";
    if (!ok.length) { if (S.tab === "setup") renderSetup(); toast(notIn || "There was no AI app to put Leanfare in.", "error"); return; }
    S.afterSetup = ok.map((x) => ({ name: x.name, after: x.after, note: x.note ?? null })); // shown at the top until Done
    if (S.tab === "setup") setTab(landing()); // you may have gone to another screen meanwhile
    else renderShell();
    toast(`Leanfare is on in ${andList(ok.map((x) => x.name))}. ${notIn}`.trim(), bad.length ? "error" : "done");
    refreshState(); // Set up may have ticked the first models
  }
  // After a Stop, Set up finishes the app it is on: the list follows it until it is done.
  async function followSetup() {
    for (let i = 0; i < 120; i++) {
      await new Promise((ok) => setTimeout(ok, i ? 500 : 150));
      if (S.tab !== "setup") return;
      try { await loadSetup(); } catch { return; }
      if (!S.setup?.busy) return;
    }
  }
  async function skipSetup() {
    if (!S.setup?.setupDone) { try { await api("/api/settings", { body: { setupDone: true } }); } catch (e) { failed(e); return; } }
    if (S.tab === "setup") setTab(landing());
  }

  // A button of Set up opens a card in Settings and shows where it is. Settings draws itself again as
  // its cards load (a redraw puts back the scroll it had), so for a few seconds each redraw brings the
  // card back into view and keeps it lit, until you scroll or press something there yourself.
  function openSetting(id) {
    S.focus = { id, until: Date.now() + 4000 };
    setTab("settings");
    focusSetting();
  }
  function focusSetting() {
    const f = S.focus;
    if (!f) return;
    if (Date.now() > f.until) { S.focus = null; return; }
    const el = document.getElementById(f.id);
    if (!el) return;
    try { el.scrollIntoView({ block: "start" }); } catch {}
    el.classList.add("flash");
  }
  for (const ev of ["wheel", "touchstart", "keydown", "mousedown"]) $("#tab-settings")?.addEventListener(ev, () => { S.focus = null; }, { passive: true });

  // Day, Auto or Night (theme.js sets it before the page is drawn). Auto is day from 7 AM to 7 PM by
  // this computer's clock, looked at again every 5 minutes and when the page comes back.
  const THEMES = ["light", "auto", "dark"]; // the header's order: sun, clock, moon
  const themeNow = () => { const t = store.get("theme", "auto"); return THEMES.includes(t) ? t : "auto"; };
  function applyTheme() {
    const t = themeNow();
    const hour = new Date().getHours();
    const shown = t === "auto" ? (hour >= 7 && hour < 19 ? "light" : "dark") : t;
    document.documentElement.setAttribute("data-theme", shown);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", shown === "dark" ? "#16191a" : "#ffffff"));
    document.querySelectorAll("#themeSwitch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === t)));
  }
  function pickTheme(t) { store.set("theme", t); applyTheme(); if (S.tab === "settings") renderSettings(); }

  // ---- start ----------------------------------------------------------------------------------
  applyTheme();
  // Three buttons; on a phone only the current one shows, and a tap moves it on.
  document.querySelectorAll("#themeSwitch button").forEach((b) => b.addEventListener("click", () =>
    pickTheme(isPhone() ? THEMES[(THEMES.indexOf(themeNow()) + 1) % THEMES.length] : b.dataset.mode)));
  setInterval(applyTheme, 5 * 60_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") applyTheme(); });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#spendPill").addEventListener("click", () => setTab("savings"));
  $("#pauseBtn").addEventListener("click", togglePause);
  // Esc stops the answer being written, unless it was meant for something else: a box being
  // typed in (search, a name, an edit, instructions), the picture viewer or the lock screen.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !S.live || e.defaultPrevented) return;
    if (document.querySelector(".lightbox, #lockScreen")) return;
    const a = document.activeElement;
    if (a && a !== composer?.ta && (a.matches?.("input, textarea, select") || a.isContentEditable)) return;
    stopLive();
  });
  $("#appsSwitch").addEventListener("click", (e) => { if (e.detail > 1) return; toggleAppsSwitch(); }); // a double click is one press
  (async () => {
    const first = S.tab ? null : api("/api/setup").catch(() => null); // with no screen kept: Set up until it is done
    await refreshState();
    if (!S.st) return;
    await loadChats();
    renderChat();
    if (S.chatId) await openChat(S.chatId);
    if (!S.tab) { const v = await first; S.tab = v && !v.setupDone ? "setup" : landing(); }
    setTab(S.tab);
    setInterval(() => { if (document.visibilityState === "visible") refreshState(); }, 4000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshState(); });
  })();
})();
