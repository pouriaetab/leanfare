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
  const S = {
    st: null,
    tab: isPhone() ? "chat" : store.get("tab", "chat"),
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
      if (S.tab === "settings") renderSettings();
      if (S.tab === "chat") { renderComposerBar(); if (!S.messages.length && !busyIn($("#messages"))) renderMessages(); }
    } catch (e) {
      if (!e?.locked) renderOffline(e);
    }
  }

  // Redraw a part of the screen without losing what is typed in its boxes.
  function keepInputs(container, draw) {
    const kept = {};
    let focused = null;
    const sel = "input[data-keep], textarea[data-keep]";
    container?.querySelectorAll(sel).forEach((i) => { if (i.value !== i.defaultValue) kept[i.dataset.keep] = i.value; if (document.activeElement === i) focused = i.dataset.keep; });
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
    if (st.pause.paused) list.push(h("div", { class: "notice warn" }, h("span", { class: "grow", text: `Paused. New requests wait until you press Start again${st.pause.waiting ? ` (${st.pause.waiting} waiting now)` : ""}. Answers already running finish.` }), h("button", { class: "btn small", text: "Start again", onclick: togglePause })));
    for (const x of st.notices) {
      list.push(h("div", { class: "notice " + x.level }, h("span", { class: "grow", text: x.text }),
        x.kind === "retire" ? h("button", { class: "btn small", text: "Settings", onclick: () => setTab("settings") }) : null,
        x.kind === "budget" ? h("button", { class: "btn small", text: "Budget", onclick: () => setTab("settings") }) : null));
    }
    n.replaceChildren(...list);
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
    if (!isPhone()) store.set("tab", t);
    renderShell();
    if (t === "chat") renderChat();
    if (t === "savings") loadSavings();
    if (t === "settings") { renderSettings(); loadLocal(); }
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
      if (meta.estimate !== undefined && meta.estimate !== null) line.append(h("span", { text: `≈ ${money(meta.estimate)} (estimate)` }));
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
    if (meta.alternatives?.length) rows.push(h("div", {}, h("b", { text: "Other choices: " }), meta.alternatives.map((a) => `${a.label} (rated ${a.rating ?? "—"}, ≈ ${money(a.estimate)})`).join(" · ")));
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
    const est = h("div", { class: "est" });
    const send = h("button", { class: "btn primary send", type: "submit", text: "Send" });
    const back = h("button", { class: "btn small back", type: "button", text: "Chats", onclick: () => chatEl().classList.add("list-open") });
    const picker = h("input", { type: "file", multiple: true, hidden: true, accept: "image/*,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.swift,.sql,.sh,.heic", onchange: (e) => { addFiles([...e.target.files]); e.target.value = ""; } });
    const attach = h("button", { class: "attach", type: "button", "aria-label": "Attach files", title: "Attach images, PDFs or text files (or drop them here, or paste an image)", text: "+", onclick: () => picker.click() });
    const pending = h("div", { class: "pending" });
    const form = h("form", { class: "composer" },
      h("div", { class: "box" }, pending, ta, h("div", { class: "bar" }, back, attach, picker, pick, effort, est, send)),
      h("div", { class: "hint", text: "Enter sends · Shift+Enter adds a line · Esc stops an answer · drop or paste files to attach" }));
    composer = { form, ta, pick, est, send, pending, effort };
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
    send.disabled = !ready() && !S.live;
    send.textContent = S.live ? "Stop" : "Send";
    send.classList.toggle("stop", !!S.live);
    if (!ready()) est.textContent = "To send, add a key in Settings or start Ollama, and tick at least one model.";
    else if (!composer.ta.value.trim() && !S.pending.length) est.textContent = S.model === "auto" ? `Auto picks ${st.modes[mode].blurb}.` : "";
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
      composer.est.textContent = `≈ ${money(r.estimate)} on ${p.model.label}${p.auto ? ` · ${S.st.tasks.find((t) => t[0] === p.task)?.[1] ?? p.task}` : ""}${p.effort ? ` · thinking ${p.effort}` : ""}${nf ? ` · ${nf} file${nf === 1 ? "" : "s"}` : ""} · estimate`;
      composer.est.title = p.reason;
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

  // The plan meter: the plan's two windows, what is left of each in work, and what still fits.
  function meterBlock(m) {
    if (!m || (!m.windows.length && !m.projects.length)) return null;
    const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    const rows = m.windows.map((w) => h("div", { class: "mt-row" },
      h("span", { class: "n", text: w.kind === "week" ? "This week" : "5 hours" }),
      h("span", { class: "track" + (w.used >= 90 ? " hot" : "") }, h("i", { style: { width: Math.min(100, w.used) + "%" } })),
      h("span", { class: "v", text: `${Math.round(w.used)}% used${w.resets ? ` · resets ${when(w.resets)}` : ""}` }),
      w.left !== null ? h("span", { class: "sub", text: `about ${money(w.left)} of work left${w.leftLo !== null && w.leftHi !== null ? ` (${money(w.leftLo)} to ${money(w.leftHi)})` : ""}${w.tokensLeft ? `, about ${bigTok(w.tokensLeft)} tokens at your recent mix` : ""} · ${w.from === "starting estimate" ? "a starting estimate" : `measured from ${w.windows} windows`}` }) : null));
    const fits = m.projects.filter((p) => p.sessionsLeft !== null).slice(0, 5).map((p) => h("li", { text: `${p.name}: ${sessionsText(p.sessionsLeft)}${p.pctOfWeek !== null ? ` (a session is ${weekShare(p.pctOfWeek)} of the week)` : ""}` }));
    return h("div", { class: "meter" },
      h("div", { class: "mt-head", text: `Right now${m.at ? `, as of ${ago(m.at)}` : ""}` }),
      ...rows,
      fits.length ? h("div", { class: "mt-fits" }, h("b", { text: "What still fits" }), h("ul", {}, ...fits)) : null,
      m.other ? h("p", { class: "pl-note", text: `About ${Math.round(m.other)}% of this week went to use the logs do not show (Claude chats, Cowork, the phone apps).` }) : null,
      m.rough ? h("p", { class: "pl-note", text: "Max 5x was not measured by anyone yet, so this starts from a rough guess until your own windows replace it." }) : null);
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

  function planBlock(v) {
    const mb = meterBlock(S.meter?.[v.provider]);
    const head = v.plan
      ? h("div", { class: "pl-head" }, h("b", { text: v.plan.name }), h("span", { class: "grow" }), h("small", { text: `${money(v.plan.price)} a month` }))
      : h("div", { class: "pl-head" }, h("b", { text: v.logs }), h("span", { class: "grow" }), h("button", { class: "btn small", type: "button", text: "Enter your plan", onclick: () => setTab("settings") }));
    if (!v.found) return h("div", { class: "pl" }, head, mb, h("p", { class: "pl-note", text: `No ${v.logs} log files found on this computer.` }));
    if (!v.tokens) return h("div", { class: "pl" }, head, mb, h("p", { class: "pl-note", text: `No ${v.logs} use in this month's log files.` }));
    const maxV = Math.max(...v.models.map((m) => m.value ?? 0), 0);
    return h("div", { class: "pl" }, head, mb,
      h("div", { class: "pl-val" }, h("span", { class: "big", text: money(v.value) }), h("span", { class: "sub", text: "at API prices" }),
        v.ratio !== null ? h("span", { class: "chip " + (v.ratio >= 1 ? "good" : ""), text: `${v.ratio < 0.05 ? "under 0.1" : v.ratio.toFixed(v.ratio >= 10 ? 0 : 1)}× what you pay` }) : null),
      h("div", { class: "sub", text: `${bigTok(v.tokens)} tokens in ${v.logs}: ${bigTok(v.input)} in, ${bigTok(v.cached)} from the cache, ${bigTok(v.output)} out` }),
      v.limits ? h("div", { class: "sub", text: `${v.logs} limits at its last message (${ago(v.limits.at)}): ${v.limits.windows.map((w) => `${Number(w.used.toFixed(1))}% of the ${w.label} used${w.resets ? `, resets ${new Date(w.resets).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}`).join("; ")}` }) : null,
      h("div", { class: "bars" }, ...v.models.slice(0, 5).map((m) => h("div", { class: "barrow", title: m.id ? `${m.model}\npriced as ${m.id}` : `${m.model}\nno listed price` },
        h("span", { class: "n", text: m.label }), h("span", { class: "v", text: `${bigTok(m.tokens)} tokens · ${m.value === null ? "no listed price" : money(m.value)}` }),
        h("span", { class: "track" }, h("i", { style: { width: (maxV > 0 && m.value ? (m.value / maxV) * 100 : 0) + "%" } }))))),
      v.models.length > 5 ? h("div", { class: "sub", text: `and ${v.models.length - 5} more model${v.models.length - 5 === 1 ? "" : "s"}` }) : null,
      v.unpricedTokens ? h("p", { class: "pl-note", text: `${bigTok(v.unpricedTokens)} tokens are on models with no listed price and count as $0 here.` }) : null);
  }

  function plansCardEl() {
    const P = S.plans;
    const card = h("div", { class: "card plans", id: "plansCard" });
    card.append(h("h3", {}, "Your plans", h("small", { text: "an estimate" }), h("span", { class: "grow" }),
      P ? runButton("Look again", async (signal) => { await loadPlans(true, signal); toast("Log files read again.", "done"); }, "btn small") : null));
    if (!P) { card.append(h("div", { class: "empty", text: "Reading the Claude Code and Codex log files on this computer…" })); return card; }
    const shown = P.providers.filter((v) => v.plan || v.found);
    if (!shown.length) {
      card.append(h("p", { class: "pl-note", text: "Enter your Claude or ChatGPT plan to see what your Claude Code and Codex use would cost at API prices, next to what you pay." }),
        h("div", { class: "row" }, h("button", { class: "btn small", type: "button", text: "Enter a plan", onclick: () => setTab("settings") })));
    } else card.append(h("div", { class: "pl-grid" }, ...shown.map(planBlock)));
    if (S.meter?.statusline) card.append(statuslineRow(S.meter.statusline));
    card.append(h("p", { class: "fine", text: P.note }));
    return card;
  }

  // Delegated tasks (delegate.ts): what other apps handed over, and what the checks found.
  function delegateCardEl(d) {
    if (!d) return null;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const ran = d.passed + d.failed + d.unclear;
    const again = d.reruns ? `, ${num(d.failed)} failed and ${d.reruns === d.failed ? (d.failed === 1 ? "was" : "were") : `${num(d.reruns)} ${d.reruns === 1 ? "was" : "were"}`} asked again one tier up` : d.failed ? `, ${num(d.failed)} failed` : "";
    return h("div", { class: "card", id: "delegateCard" },
      h("h3", {}, "Delegated tasks", h("span", { class: "grow" }), h("small", { text: "through the delegate tool" })),
      h("p", { text: `${num(d.tasks)} task${d.tasks === 1 ? "" : "s"} handed over this month, ${money(d.cost)} in all${d.checkCost > 0 ? ` (checks ${money(d.checkCost)})` : ""}.` }),
      d.kept > 0 ? h("p", { text: `Leanfare read about ${num(d.kept)} tokens of files so the app that asked did not have to; the answers came to about ${num(d.answerTokens)}.` }) : null,
      d.passed + d.failed > 0
        ? h("p", { text: `Checks: ${num(ran)} run, ${num(d.passed)} passed (${pct(d.passRate)}, 90% range ${pct(d.passLo)} to ${pct(d.passHi)})${again}.` })
        : h("p", { text: ran ? `Checks: ${num(ran)} run, none with a clear verdict.` : "No answer was checked yet." }),
      d.weighted !== null && d.passed + d.failed >= 5 ? h("p", { class: "fine", text: `Weighted by each answer's chance of being checked, about ${pct(d.weighted)} of all handed over answers would pass.` }) : null);
  }

  function stat(key, label, value, sub, cls = "") {
    const def = S.savings.definitions[key];
    return h("div", { class: "stat" },
      h("div", { class: "lbl" }, label, h("button", { type: "button", "aria-label": `What "${label}" means`, title: "What this number means", text: "i", onclick: () => { S.defOpen[key] = !S.defOpen[key]; renderSavings(); } })),
      h("div", { class: "val " + cls, text: value }),
      h("div", { class: "sub" }, sub),
      S.defOpen[key] ? h("div", { class: "def", text: def }) : null);
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
      v.subscription === null
        ? stat("gap", "Against a subscription", "—", h("button", { class: "btn small", text: "Enter a price", onclick: () => setTab("settings") }), "small")
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
    const SOURCES = { chat: "Chat", openai: "Apps (OpenAI address)", anthropic: "Apps (Anthropic address)", delegate: "Delegated", check: "Checks" };
    const src = v.bySource.map((s) => `${SOURCES[s.source] ?? s.source}: ${num(s.answers)}`).join(" · ");
    el.replaceChildren(
      h("div", { class: "sv-head" }, h("h2", { text: title }), h("span", { class: "grow" }), pickMonth, runButton("Refresh", async (signal) => { await loadSavings(); await loadPlans(true, signal); toast("Up to date.", "done"); })),
      cards,
      plansCardEl(),
      delegateCardEl(v.delegate),
      h("div", { class: "sv-grid" },
        h("div", { class: "card" }, h("h3", {}, "By model", h("span", { class: "grow" }), h("small", { text: src })), h("div", { class: "scroll" }, byModel)),
        h("div", { class: "card" }, h("h3", { text: "By task" }), h("div", { class: "scroll" }, byTask)),
        h("div", { class: "card" }, h("h3", {}, "By day", h("span", { class: "grow" }), h("small", { text: `most ${money(maxDay)}` })), days, h("div", { class: "days-axis" }, h("span", { text: "1" }), h("span", { text: String(Math.ceil(daysIn / 2)) }), h("span", { text: String(daysIn) })))),
      h("p", { class: "fine" }, [...notes, "Costs use the providers' list prices; discounts and contracts are not known to Leanfare. Ratings: Arena leaderboard (CC BY 4.0)."].join(" ")));
  }

  // ---- settings -----------------------------------------------------------------------------------
  const LOGO = { openai: "OA", anthropic: "A", google: "G", openrouter: "OR", deepseek: "DS", xai: "X", mistral: "M", ollama: "OL" };

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
      t.set(r.env ? `Removed. Your ${r.env} environment variable still holds a key, and Leanfare will use it after a restart.` : `Removed the ${p.name} key.`, "done",
        r.env ? {} : { action: { label: "Undo", run: async () => { try { const x = await api(`/api/keys/${p.id}/restore`, { body: {} }); S.st = x.state; renderSettings(); renderShell(); renderComposerBar(); toast("Key put back.", "done"); } catch (e) { failed(e); } } } });
    } catch (e) { t.set(String(e.message ?? e), "error"); }
  }

  async function refreshList(what, signal) {
    const t = toast(what === "ollama" ? "Looking for Ollama…" : what === "openrouter" ? "Updating OpenRouter's model list…" : "Updating prices and ratings…");
    try {
      const r = await api("/api/refresh", { body: { what }, signal });
      S.st = r.state;
      const st = r.status;
      if (st.state === "ok") t.set(what === "ollama" ? `Found Ollama with ${modelsOf("ollama").length} models.` : what === "openrouter" ? "OpenRouter's list is up to date." : `Prices and ratings updated (built ${dayLabel(S.st.data.built)}).`, "done");
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
    } catch {}
  }

  function renderLocal() {
    const old = document.getElementById("localCard");
    if (old) keepInputs(old.parentNode, () => old.replaceWith(localCardEl()));
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
    try {
      const r = await api("/api/local/pull", { body: { name } });
      pullStartedAt = Date.now();
      if (S.local) S.local.pull = r.pull;
      input.value = "";
      renderLocal();
      ensurePoll();
    } catch (e) { failed(e); }
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

  function localRow(m) {
    const facts = [m.params, m.quant].filter(Boolean).map((x) => h("span", { text: x }));
    facts.push(h("span", { text: gbs(m.size) }), fitChip(m.fit));
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
      if (L.pull) card.append(pullBlock(L.pull));
      return card;
    }
    const where = L.remote
      ? "Ollama runs on another computer, so Leanfare cannot check its disk or memory."
      : `This computer has ${gbs(L.memory.total)} of memory, about ${gbs(L.memory.usable)} of it usable for a model.${L.disk.known ? ` ${gbs(L.disk.free)} of disk is free; Leanfare keeps ${gbs(L.disk.minFree)} free.` : ""}`;
    card.append(h("p", { text: where }),
      h("div", { class: "section-title", text: L.installed.length ? `On this computer · ${L.installed.length} model${L.installed.length === 1 ? "" : "s"} · ${gbs(L.total)}` : "On this computer" }),
      L.installed.length ? h("div", { class: "lmodels" }, ...L.installed.map(localRow)) : h("p", { text: "No models yet. Download one below." }));
    const busy = !!L.pull?.active;
    const input = h("input", { type: "text", placeholder: "gemma3:12b   or   hf.co/user/repo:Q4_K_M", autocomplete: "off", spellcheck: "false", "data-keep": "local-name", "aria-label": "Model to download", disabled: busy, value: busy ? L.pull.name : null,
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); if (!busy) startDownload(input); } } });
    card.append(h("div", { class: "section-title", text: "Download a model" }),
      h("div", { class: "row" }, input, h("button", { class: "btn primary" + (busy ? " stop" : ""), type: "button", text: busy ? "Stop" : "Download", onclick: (ev) => (busy ? stopDownload(ev) : startDownload(input)) })),
      h("p", {}, "A name from ", h("a", { href: "https://ollama.com/library", target: "_blank", rel: "noopener noreferrer", text: "Ollama's library ↗" }), ", or straight from Hugging Face as hf.co/user/repo:quantization. Q4_K_M is the light version: about a quarter of the full size, with a small loss in quality. Check a model's licence before you use it for work."));
    if (L.pull) card.append(pullBlock(L.pull));
    return card;
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
    return h("label", { class: "mrow", title: m.id },
      h("input", { type: "checkbox", checked: m.ticked, onchange: (e) => tick([m.id], e.target.checked) }),
      h("span", { class: "nm" }, m.label, notes.length ? h("small", { text: notes.join(" · ") }) : null),
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
    else if (p.id === "ollama") status = h("span", { class: "chip", text: "Not running" });
    else status = h("span", { class: "chip", text: "Add a key" });
    const head = h("div", { class: "prov-head", role: "button", tabindex: "0", "aria-expanded": String(open), onclick: () => { S.open[p.id] = !open; store.set("open", S.open); renderSettings(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } },
      h("span", { class: "logo", text: LOGO[p.id] ?? p.name[0] }), h("span", { class: "name", text: p.name }), h("span", { class: "grow" }), status, h("span", { class: "caret", text: "›" }));
    const card = h("div", { class: "prov" + (p.ready ? " ready" : "") + (open ? " open" : "") }, head);
    if (!open) return card;
    const body = h("div", { class: "prov-body" });
    if (p.needsKey) {
      if (p.key.saved) {
        body.append(h("div", { class: "keyline" }, "Key ", h("code", { text: p.key.hint }),
          h("span", { text: p.key.where === "keychain" ? "in the macOS Keychain" : p.key.where === "environment" ? "from your environment" : "in a file only you can read" }),
          h("span", { class: "grow" }),
          p.key.where === "environment" ? null : h("button", { class: "btn small", text: "Remove key", onclick: () => removeKey(p) })));
      }
      if (p.id === "openrouter") body.append(h("div", { class: "row" },
        runButton(p.key.saved ? "Connect again" : "Connect OpenRouter", connectOpenRouter, "btn primary"),
        h("span", { class: "note grow", text: "Sign in on OpenRouter's page; Leanfare gets a key by itself. Or paste one:" })));
      const input = h("input", { type: "password", placeholder: p.key.saved ? `Paste a new ${p.name} key to replace it` : `Paste your ${p.name} key`, autocomplete: "off", "data-keep": p.id, "aria-label": `${p.name} key` });
      body.append(h("div", { class: "row" }, input, runButton("Test and save", (signal) => saveKey(p, input, signal), "btn primary"),
        h("a", { class: "btn quiet", href: p.keyUrl, target: "_blank", rel: "noopener noreferrer", text: "Get a key ↗" })));
    }
    if (p.note) body.append(h("div", { class: "note", text: p.note }));
    if (p.id === "google") body.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.free, onchange: (e) => patchProvider(p.id, { free: e.target.checked }) }), "My Google key is on the free plan (count its answers as $0)"));
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
    if (p.needsKey || p.id === "ollama") body.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.on, onchange: (e) => patchProvider(p.id, { on: e.target.checked }) }), `Use ${p.name}`));
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

  // Your plans: the name and the monthly price of what you pay for Claude and ChatGPT, to set against the use in their log files.
  function plansSetting(s) {
    const rows = [["claude", "Claude", "Claude Max"], ["chatgpt", "ChatGPT", "ChatGPT Plus"]].map(([k, label, example]) => {
      const cur = s.plans?.[k];
      const name = h("input", { type: "text", placeholder: example, value: cur?.name ?? "", maxlength: "60", autocomplete: "off", "aria-label": `${label} plan name`, "data-keep": `plan-${k}-name` });
      const price = moneyInput(cur?.price ?? null, `${label} plan price a month`);
      return h("div", { class: "row plan-row" }, h("span", { class: "plan-l", text: label }), name, price,
        h("button", { class: "btn", type: "button", text: "Save", onclick: () => patchSettings({ plans: { [k]: { name: name.value, price: price.querySelector("input").value } } }, `${label} plan saved.`) }),
        cur ? h("button", { class: "btn", type: "button", text: "Remove", onclick: () => patchSettings({ plans: { [k]: null } }, `${label} plan removed.`) }) : null);
    });
    return h("div", { class: "setting" }, h("h3", { text: "Your Claude and ChatGPT plans" }), ...rows,
      h("p", { text: "The Savings page then shows what your Claude Code and Codex use this month would cost at API prices, next to the price you pay. Leanfare reads only the token counts in those programs' log files on this computer, never the words." }),
      h("p", { text: "Leanfare only counts here. Anthropic does not let other apps use a Claude subscription login, so Auto never uses one." }));
  }

  function renderSettings() {
    const el = $("#tab-settings");
    const st = S.st;
    if (!st) return;
    const scrollL = el.querySelector(".colL")?.scrollTop ?? 0, scrollR = el.querySelector(".colR")?.scrollTop ?? 0;

    const left = h("div", { class: "colL" }, h("div", { class: "section-title", text: `Providers · ${st.readyCount} ready` }), ...st.providers.map(providerCard), h("div", { class: "section-title", text: "Local models" }), localCardEl());

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
    const theme = store.get("theme", "auto");
    const right = h("div", { class: "colR" },
      h("div", { class: "section-title", text: "Choices" }),
      h("div", { class: "setting" }, h("h3", { text: "How Auto picks" }), modeSeg,
        h("p", { text: `${st.modes[s.mode].label}: ${st.modes[s.mode].blurb}, for the task Leanfare guesses from your message (coding, math, writing, long prompts and more). Ratings come from the Arena leaderboard.` })),
      h("div", { class: "setting" }, h("h3", { text: "Thinking effort" }),
        h("div", { class: "seg", role: "group", "aria-label": "Thinking effort" }, ...[["auto", "Model's default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([k, label]) =>
          h("button", { type: "button", "aria-pressed": String((s.effort ?? "auto") === k), text: label, onclick: () => patchSettings({ effort: k }, k === "auto" ? "Thinking models think as they do by default." : `Thinking effort: ${label.toLowerCase()}.`) }))),
        h("p", { text: "For models that think before they answer, at the levels each one takes. Thinking is billed as output, so a higher effort costs more and takes longer; the estimate learns from your answers at each level." })),
      h("div", { class: "setting" }, h("h3", { text: "Your usual model" }), usualSel,
        h("p", { text: "The model you would use without Leanfare. Savings are measured against it." })),
      h("div", { class: "setting" }, h("h3", { text: "Monthly budget" }),
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
        h("div", { class: "seg", role: "group", "aria-label": "Theme" }, ...[["auto", "Match my computer"], ["light", "Light"], ["dark", "Dark"]].map(([k, label]) =>
          h("button", { type: "button", "aria-pressed": String(theme === k), text: label, onclick: () => { store.set("theme", k); applyTheme(); renderSettings(); } })))),
      h("p", { class: "fine" }, `Leanfare ${st.version} · Bun ${st.bun}${st.bun.startsWith(st.bunTested + ".") ? "" : ` (tested on ${st.bunTested}.x)`} · keys in ${st.keyStore}. Prices: LiteLLM's price list (MIT) via llmledger (MIT)${st.settings.providers.openrouter?.on ? " and OpenRouter's model list" : ""}. Ratings: Arena leaderboard (CC BY 4.0), condensed to each model's best rating per task. Not affiliated with any AI provider.`));
    keepInputs(el, () => el.replaceChildren(left, right)); // what is typed in key boxes survives the redraw
    el.querySelector(".colL").scrollTop = scrollL;
    el.querySelector(".colR").scrollTop = scrollR;
  }

  function applyTheme() {
    const t = store.get("theme", "auto");
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  // ---- start ----------------------------------------------------------------------------------
  applyTheme();
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
  (async () => {
    await refreshState();
    if (!S.st) return;
    await loadChats();
    renderChat();
    if (S.chatId) await openChat(S.chatId);
    setTab(S.tab);
    setInterval(() => { if (document.visibilityState === "visible") refreshState(); }, 4000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshState(); });
  })();
})();
