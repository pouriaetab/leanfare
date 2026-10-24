// The local web server: the app's screens, the screens' own API (/api/...)
// and the engine addresses other apps use (/v1/...). It listens on 127.0.0.1
// only, answers only to its own host name (so a web page cannot reach it by
// pointing a domain at 127.0.0.1), and refuses browser requests from other
// sites unless you allowed them in Settings.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BUN_TESTED, HOST, PORT, PROVIDERS, UI_DIR, VERSION, baseOf, paths, provider, runtime, type ProviderId } from "./config";
import { TASKS, allModels, getModel, isRetired, refreshCatalog, refreshOllama, refreshOpenRouter, retiresWithin, store, type Model } from "./data";
import { db, lastRepair } from "./db";
import { allKeys, getKey, keyWhere, keychainNote, removeKey, saveKey, storeName } from "./keys";
import { MAX_INSTRUCTIONS, MODES, saveSettings, settings, validatePatch } from "./settings";
import { budgetState } from "./budget";
import { retirementNotices } from "./retire";
import { savings } from "./savings";
import { checkKey, effortLevels, UserError } from "./upstream";
import { FILE_LIMITS, checkFile, prepareMessages, takesImages, takesPdfs, type Attachment, type ChatMsg } from "./files";
import type { Msg } from "./router";
import { exportAll, importChats, readArchive, searchChats } from "./archive";
import { clearCookie, controlOk, engineAllowed, keyOk, locked, newAccessKey, pageAllowed, sessionCookie } from "./lock";
import { chargeOf, errorResponse, handleAnthropic, handleOpenAI, idle, pauseState, plan, planView, providerReady, runChat, runningList, setPaused, stopRunning, usableModels, usualModel } from "./engine";
import { guessTask } from "./router";
import { dollars, localDay, now, randomId, redact } from "./util";

const EFFORTS = ["auto", "low", "medium", "high"];
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: message }, status);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};

// ---- what the screens read -------------------------------------------------------

function modelView(m: Model, ticked: Set<string>, day: string) {
  return {
    id: m.id, label: m.label, provider: m.provider, apiId: m.apiId,
    input: m.input, output: m.output, cacheRead: m.cacheRead,
    rating: m.ratings.overall ?? null, ratings: m.ratings,
    top: !!m.top, ticked: ticked.has(m.id), free: !!m.free, local: !!m.local,
    retire: m.retire, retired: isRetired(m, day), retiringSoon: retiresWithin(m, day, 30),
    reasoning: m.skills.includes("reasoning"), vision: takesImages(m), pdf: takesPdfs(m), effort: effortLevels(m),
    context: m.context, added: m.added,
  };
}

const removedKeys = new Map<ProviderId, { key: string; until: number }>(); // Undo for a removed key, 30 seconds

function keyHint(id: ProviderId) {
  const k = getKey(id);
  return k ? `…${k.slice(-4)}` : null;
}

export function state() {
  const s = settings();
  const day = localDay();
  const ticked = new Set(s.ticked);
  const models = allModels().filter((m) => !isRetired(m, day) || ticked.has(m.id));
  const byProvider: Record<string, any[]> = {};
  for (const m of models) (byProvider[m.provider] ??= []).push(modelView(m, ticked, day));
  for (const list of Object.values(byProvider)) list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.label.localeCompare(b.label));
  const usual = usualModel();
  const notices: any[] = [];
  const inUse = [...s.ticked, ...(usual ? [usual.id] : [])];
  for (const n of retirementNotices(inUse, day)) {
    notices.push({ kind: "retire", level: n.retired ? "error" : "warn", model: n.model, successor: n.successor,
      text: n.retired
        ? `${n.label} retired on ${n.retire}. ${n.successorLabel ? `Leanfare now sends its requests to ${n.successorLabel}.` : "Leanfare found no successor; untick it and pick another model."}`
        : `${n.label} retires on ${n.retire}, in ${n.daysLeft} day${n.daysLeft === 1 ? "" : "s"}. ${n.successorLabel ? `On that day Leanfare will switch to ${n.successorLabel}.` : "Leanfare found no successor yet."}` });
  }
  const b = budgetState();
  if (b.reached) notices.push({ kind: "budget", level: "error", text: `Your ${dollars(b.budget!)} budget for this month is used up. ${s.atLimit === "stop" ? "New requests are refused until next month or until you raise it." : "Leanfare keeps going on the cheapest model you ticked."}` });
  else if (b.warn) notices.push({ kind: "budget", level: "warn", text: `You have used ${Math.floor(b.pct!)}% of this month's ${dollars(b.budget!)} budget.` });
  if (lastRepair) notices.push({ kind: "repair", level: "warn", text: `The history file was damaged and was moved to ${lastRepair.moved} (${(lastRepair.bytes / 1e6).toFixed(1)} MB). Leanfare started from ${lastRepair.restored === "backup" ? "the newest daily backup" : "an empty file"}.` });
  const ds = store.status.data;
  const ageDays = Math.floor((now().getTime() - Date.parse(store.catalog.built)) / 86_400_000);
  if (ageDays >= 3) notices.push({ kind: "data", level: "warn", text: `Prices are ${ageDays} days old${ds.state === "failed" ? ` (the daily update failed: ${ds.error})` : ""}.` });
  const ready = PROVIDERS.filter((p) => providerReady(p.id));
  return {
    version: VERSION,
    bun: Bun.version,
    bunTested: BUN_TESTED,
    address: `http://127.0.0.1:${serverPort}`,
    settings: s,
    modes: MODES,
    tasks: TASKS,
    providers: PROVIDERS.map((p) => ({
      id: p.id, name: p.name, needsKey: p.needsKey, keyUrl: p.keyUrl, note: p.note ?? null,
      ready: providerReady(p.id), on: s.providers[p.id]?.on !== false, free: !!s.providers[p.id]?.free,
      key: p.needsKey ? { saved: !!getKey(p.id), where: keyWhere(p.id), hint: keyHint(p.id), canUndo: (removedKeys.get(p.id)?.until ?? 0) > Date.now() } : null,
      list: p.id === "openrouter" ? store.status.openrouter : p.id === "ollama" ? store.status.ollama : null,
      base: baseOf(p.id),
    })),
    models: byProvider,
    usual: usual ? { id: usual.id, label: usual.label } : null,
    readyCount: ready.length,
    usableCount: usableModels().length,
    budget: b,
    month: (() => { const v = savings(); return { spent: v.spent, today: v.today, answers: v.answers }; })(),
    notices,
    data: {
      built: store.catalog.built, from: store.catalogFrom, ratingsDate: store.catalog.ratingsDate,
      litellmCommit: store.catalog.litellmCommit, credits: store.catalog.credits, status: store.status.data, url: store.status.data.tried,
      modelCount: store.catalog.models.length,
    },
    pause: pauseState(),
    running: runningList(),
    keyStore: storeName(),
    keychainNote: keychainNote(),
    lock: { on: locked(), key: s.accessKey },
  };
}

// ---- chats -------------------------------------------------------------------------

function chatList() {
  return db.query("SELECT id, title, created, updated FROM chats WHERE deleted IS NULL ORDER BY updated DESC LIMIT 200").all();
}
const fileView = (f: any) => ({ id: f.id, name: f.name, type: f.type, kind: f.kind, size: f.size, pages: f.pages ?? null });
function chatMessages(id: string) {
  const files = new Map<number, any[]>();
  for (const f of db.query("SELECT id, message_id, name, type, kind, size, pages FROM files WHERE chat_id = ? ORDER BY id").all(id) as any[]) {
    if (f.message_id !== null) (files.get(f.message_id) ?? files.set(f.message_id, []).get(f.message_id)!).push(fileView(f));
  }
  return (db.query("SELECT id, role, content, meta, ts FROM messages WHERE chat_id = ? AND deleted IS NULL ORDER BY id").all(id) as any[])
    .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null, files: files.get(m.id) ?? [] }));
}

// A message's files: ones kept from earlier (by id, from this chat) and new
// ones (with their contents), checked the same way either way.
function resolveFiles(list: unknown, chatId: string | null): Attachment[] | string {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > FILE_LIMITS.count) return `At most ${FILE_LIMITS.count} files go with one message.`;
  const out: Attachment[] = [];
  for (const f of list as any[]) {
    if (f && typeof f.id === "number" && typeof f.data !== "string") {
      const row = chatId ? db.query("SELECT id, name, type, kind, size, pages, data FROM files WHERE id = ? AND chat_id = ?").get(f.id, chatId) as any : null;
      if (!row) return `${String(f.name ?? "A file")} from earlier in this chat is no longer there. Remove it and send again.`;
      out.push({ id: row.id, name: row.name, type: row.type, kind: row.kind, size: row.size, pages: row.pages ?? undefined, data: Buffer.from(row.data).toString("base64") });
    } else {
      const a = checkFile(f);
      if (typeof a === "string") return a;
      out.push(a);
    }
  }
  return out;
}

async function chatRoute(req: Request, body: any): Promise<Response> {
  const s = settings();
  let chatId: string | null = typeof body?.chatId === "string" ? body.chatId : null;
  const raw: any[] = Array.isArray(body?.messages) ? body.messages.filter((m: any) => (m?.role === "user" || m?.role === "assistant" || m?.role === "system") && typeof m.content === "string") : [];
  const known = s.history && chatId ? chatId : null;
  const msgs: ChatMsg[] = [];
  for (const m of raw) {
    const files = m.role === "user" ? resolveFiles(m.files, known) : [];
    if (typeof files === "string") return fail(400, files);
    msgs.push({ role: m.role, content: m.content, files });
  }
  const last = msgs.at(-1);
  if (!last || last.role !== "user" || (!last.content.trim() && !last.files.length)) return fail(400, "The chat needs a message to send.");
  const total = last.files.reduce((n, f) => n + f.size, 0);
  if (total > FILE_LIMITS.total) return fail(400, `These files add up to ${(total / 1048576).toFixed(1)} MB; one message takes at most ${FILE_LIMITS.total / 1048576} MB.`);
  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_INSTRUCTIONS) : "";
  // send: a new question. again: answer the question again (the old answer goes).
  // another: answer it on another model too (both answers stay, with both costs).
  // edit: the question was changed (it and everything after it go).
  const action: "send" | "again" | "another" | "edit" = ["again", "another", "edit"].includes(body.action) ? body.action : typeof body.retryOf === "number" ? "again" : "send";
  const target: number | null = typeof body.target === "number" ? body.target : typeof body.retryOf === "number" ? body.retryOf : null;
  let compare: { model: { id: string; label: string }; cost: number | null } | null = null;
  const cleanCompare = (c: any) => (c && typeof c === "object" && typeof c.model?.id === "string"
    ? { model: { id: String(c.model.id).slice(0, 200), label: String(c.model.label ?? c.model.id).slice(0, 200) }, cost: typeof c.cost === "number" && Number.isFinite(c.cost) ? c.cost : null }
    : null);
  const ts = now().toISOString();
  let userMessageId: number | null = null;
  let savedFiles: any[] = [];
  if (s.history) try {
    if (!chatId || !db.query("SELECT 1 FROM chats WHERE id = ?").get(chatId)) {
      chatId = chatId ?? randomId();
      const firstUser = msgs.find((m) => m.role === "user")!;
      const first = firstUser.content.trim() || firstUser.files[0]?.name || "New chat";
      db.query("INSERT INTO chats(id, title, created, updated, system) VALUES (?, ?, ?, ?, ?)").run(chatId, first.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat", ts, ts, system || null);
    } else if (typeof body.system === "string") db.query("UPDATE chats SET system = ? WHERE id = ?").run(system || null, chatId);
    const lastSaved = db.query("SELECT id, role, content FROM messages WHERE chat_id = ? AND deleted IS NULL ORDER BY id DESC LIMIT 1").get(chatId) as any;
    if (action === "again") {
      if (target !== null) db.query("UPDATE messages SET deleted = ? WHERE id = ? AND chat_id = ? AND role = 'assistant'").run(ts, target, chatId);
    } else if (action === "another") {
      const row = target === null ? null : db.query("SELECT meta FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant' AND deleted IS NULL").get(target, chatId) as any;
      if (row?.meta) { try { compare = cleanCompare(JSON.parse(row.meta)); } catch {} }
    } else {
      if (action === "edit" && target !== null && db.query("SELECT 1 FROM messages WHERE id = ? AND chat_id = ? AND role = 'user' AND deleted IS NULL").get(target, chatId)) {
        db.query("UPDATE messages SET deleted = ? WHERE chat_id = ? AND id >= ? AND deleted IS NULL").run(ts, chatId, target);
      } else if (action === "send" && lastSaved?.role === "user" && lastSaved.content === last.content) userMessageId = lastSaved.id; // a retry after a failed send
      userMessageId ??= Number(db.query("INSERT INTO messages(chat_id, role, content, ts) VALUES (?, 'user', ?, ?)").run(chatId, last.content, ts).lastInsertRowid);
      const already = db.query("SELECT COUNT(*) AS n FROM files WHERE message_id = ?").get(userMessageId) as { n: number };
      if (!already.n) {
        const put = db.query("INSERT INTO files(chat_id, message_id, name, type, kind, size, pages, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const move = db.query("UPDATE files SET message_id = ? WHERE id = ? AND chat_id = ?");
        for (const f of last.files) {
          if (f.id !== undefined) { move.run(userMessageId, f.id, chatId); continue; } // a kept file goes with the edited question
          f.id = Number(put.run(chatId, userMessageId, f.name, f.type, f.kind, f.size, f.pages ?? null, Buffer.from(f.data, "base64"), ts).lastInsertRowid);
          savedFiles.push(fileView(f));
        }
      }
    }
    db.query("UPDATE chats SET updated = ?, deleted = NULL WHERE id = ?").run(ts, chatId);
  } catch (e) {
    return fail(503, `Leanfare's history file is busy or locked by another program (${String((e as any)?.message ?? e)}). Close that program, or turn chat history off, and send again.`);
  }
  if (action === "another" && !compare) compare = cleanCompare(body.compare); // history off: the page says what it is compared with
  const { messages, dropped } = prepareMessages(msgs);
  const asked = typeof body.model === "string" ? body.model : "auto";
  const effort = EFFORTS.includes(body.effort) ? body.effort : s.effort;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: unknown) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {} };
      const keepAlive = setInterval(() => { try { controller.enqueue(enc.encode(": still here\n\n")); } catch {} }, 15_000);
      try {
        send({ type: "chat", chatId, userMessageId, history: s.history, files: savedFiles });
        if (dropped.length) send({ type: "notice", message: `Left out of this message to stay within the providers' size limits: ${dropped.join(", ")} (attached earlier).` });
        let title = "Chat";
        try { if (chatId) title = (db.query("SELECT title FROM chats WHERE id = ?").get(chatId) as any)?.title ?? title; } catch {}
        const out = await runChat(messages, asked, req.signal, send, title, { system, effort, meta: compare ? { compare } : undefined });
        if (s.history && chatId && (out.text || out.status !== "error")) {
          try {
            const id = Number(db.query("INSERT INTO messages(chat_id, role, content, meta, ts) VALUES (?, 'assistant', ?, ?, ?)").run(chatId, out.text, JSON.stringify(out.meta), now().toISOString()).lastInsertRowid);
            send({ type: "saved", messageId: id });
          } catch (e) {
            send({ type: "notice", message: `The answer could not be saved to your history: ${String((e as any)?.message ?? e)}` });
          }
        }
      } catch (e) {
        send({ type: "error", message: `Leanfare hit an unexpected problem: ${String((e as any)?.message ?? e)}`, status: 500 });
      } finally {
        clearInterval(keepAlive);
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

// For an estimate the page sends what its files are, not their contents.
function describeFiles(messages: any[]): Msg[] {
  return messages.filter((m) => m && typeof m.content === "string").map((m) => {
    const files: any[] = Array.isArray(m.files) ? m.files : [];
    if (!files.length) return { role: m.role, content: m.content };
    const texts = files.filter((f) => f?.kind === "text").map((f) => " ".repeat(Math.min(Number(f.size) || 0, FILE_LIMITS.text)));
    const parts: any[] = files.filter((f) => f?.kind === "image" || f?.kind === "pdf").map((f) => (f.kind === "image" ? { type: "image" } : { type: "file", pages: Math.max(1, Number(f.pages) || 1) }));
    const text = [m.content, ...texts].filter(Boolean).join("\n\n");
    return { role: m.role, content: parts.length ? [...parts, { type: "text", text }] : text };
  });
}

// ---- the screens' API ----------------------------------------------------------------

async function readBody(req: Request): Promise<any> {
  const t = await req.text();
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw new UserError(400, "The request body is not JSON."); }
}

function tickTop(pid: ProviderId) {
  const s = settings();
  const mine = allModels().filter((m) => m.provider === pid);
  if (mine.some((m) => s.ticked.includes(m.id))) return; // you already chose for this provider
  const pick = pid === "ollama" ? mine : mine.filter((m) => m.top);
  if (pick.length) saveSettings({ ticked: [...s.ticked, ...pick.map((m) => m.id)] });
}

let refreshing: Partial<Record<string, AbortController>> = {};

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/state" && m === "GET") return json(state());
  if (p === "/api/chat" && m === "POST") return chatRoute(req, await readBody(req));
  if (p === "/api/settings" && m === "POST") {
    const v = validatePatch(await readBody(req));
    if ("error" in v) return fail(400, v.error);
    saveSettings(v.patch);
    return json(state());
  }
  if (p === "/api/models/tick" && m === "POST") {
    const b = await readBody(req);
    const ids: string[] = Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === "string" && getModel(x as string)) : [];
    if (!ids.length) return fail(400, "No known model ids to tick.");
    const set = new Set(settings().ticked);
    for (const id of ids) b.on ? set.add(id) : set.delete(id);
    saveSettings({ ticked: [...set] });
    return json(state());
  }
  if (p === "/api/keys" && m === "POST") {
    const b = await readBody(req);
    const def = provider(b.provider);
    if (!def || !def.needsKey) return fail(400, "Unknown provider.");
    const key = String(b.key ?? "").trim();
    if (key.length < 8 || /\s/.test(key)) return fail(400, "That does not look like a key: it should be one word with no spaces.");
    const check = await checkKey(def.id, key, req.signal);
    if (!check.ok) return json({ ok: false, message: redact(check.message, [key]), state: state() }, 200);
    const where = await saveKey(def.id, key);
    removedKeys.delete(def.id);
    const ps = { ...settings().providers, [def.id]: { ...(settings().providers[def.id] ?? {}), on: true } };
    saveSettings({ providers: ps });
    if (def.id === "openrouter") await refreshOpenRouter(req.signal);
    tickTop(def.id);
    return json({ ok: true, message: `${check.message} Saved in ${where === "keychain" ? "the macOS Keychain" : "a file only you can read"}.`, state: state() });
  }
  const keyMatch = /^\/api\/keys\/([a-z]+)(\/restore)?$/.exec(p);
  if (keyMatch) {
    const def = provider(keyMatch[1]);
    if (!def || !def.needsKey) return fail(404, "Unknown provider.");
    if (keyMatch[2] && m === "POST") {
      const r = removedKeys.get(def.id);
      if (!r || r.until < Date.now()) return fail(410, "Too late to undo; paste the key again.");
      await saveKey(def.id, r.key);
      removedKeys.delete(def.id);
      return json({ ok: true, state: state() });
    }
    if (m === "DELETE") {
      const old = getKey(def.id);
      if (old && keyWhere(def.id) !== "environment") removedKeys.set(def.id, { key: old, until: Date.now() + 30_000 });
      const env = await removeKey(def.id);
      return json({ ok: true, env, state: state() });
    }
  }
  const provMatch = /^\/api\/providers\/([a-z]+)$/.exec(p);
  if (provMatch && m === "POST") {
    const def = provider(provMatch[1]);
    if (!def) return fail(404, "Unknown provider.");
    const b = await readBody(req);
    const cur = settings().providers[def.id] ?? { on: true };
    const next = { ...cur, ...(typeof b.on === "boolean" ? { on: b.on } : {}), ...(typeof b.free === "boolean" ? { free: b.free } : {}) };
    saveSettings({ providers: { ...settings().providers, [def.id]: next } });
    return json(state());
  }
  if (p === "/api/estimate" && m === "POST") {
    const b = await readBody(req);
    const messages = Array.isArray(b.messages) ? describeFiles(b.messages) : [];
    if (!messages.length) return json({ estimate: null });
    try {
      const system = typeof b.system === "string" && b.system.trim() ? b.system.slice(0, MAX_INSTRUCTIONS) : undefined;
      const pl = await plan({ source: "chat", asked: typeof b.model === "string" ? b.model : "auto", messages, system, maxOut: null, signal: req.signal, dry: true, effort: EFFORTS.includes(b.effort) ? b.effort : settings().effort });
      return json({ estimate: pl.estimate, plan: planView(pl) });
    } catch (e: any) {
      return json({ estimate: null, error: e instanceof UserError ? e.message : String(e?.message ?? e), guess: guessTask(messages) });
    }
  }
  if (p === "/api/chats" && m === "GET") return json({ chats: chatList(), history: settings().history });
  if (p === "/api/search" && m === "GET") return json({ results: searchChats(url.searchParams.get("q") ?? "") });
  if (p === "/api/export" && m === "GET") {
    return json(exportAll(), 200, { "content-disposition": `attachment; filename="leanfare-chats-${localDay()}.json"` });
  }
  if (p === "/api/import" && m === "POST") {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return fail(400, "The file is empty.");
    const read = readArchive(bytes);
    if (typeof read === "string") return fail(400, read);
    const result = importChats(read.from, read.chats);
    return json({ ...result, chats: chatList(), imported: result.chats });
  }
  const fileMatch = /^\/api\/files\/(\d+)$/.exec(p);
  if (fileMatch && m === "GET") {
    const f = db.query("SELECT id, name, type, kind, size, pages, data FROM files WHERE id = ?").get(Number(fileMatch[1])) as any;
    if (!f) return fail(404, "That file is no longer there.");
    return json({ ...fileView(f), data: Buffer.from(f.data).toString("base64") });
  }
  const chatMatch = /^\/api\/chats\/([A-Za-z0-9_-]+)(\/restore)?$/.exec(p);
  if (chatMatch) {
    const id = chatMatch[1];
    if (chatMatch[2] && m === "POST") { db.query("UPDATE chats SET deleted = NULL WHERE id = ?").run(id); return json({ ok: true, chats: chatList() }); }
    if (m === "GET") return json({ chat: db.query("SELECT id, title, created, updated, system FROM chats WHERE id = ?").get(id), messages: chatMessages(id) });
    if (m === "PATCH") {
      const b = await readBody(req);
      if ("title" in b) {
        const title = String(b.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!title) return fail(400, "A chat needs a name.");
        db.query("UPDATE chats SET title = ? WHERE id = ?").run(title, id);
      }
      if ("system" in b) {
        if (typeof b.system !== "string" || b.system.length > MAX_INSTRUCTIONS) return fail(400, `Instructions are text of at most ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters.`);
        db.query("UPDATE chats SET system = ? WHERE id = ?").run(b.system.trim() || null, id);
      }
      return json({ ok: true, chats: chatList(), chat: db.query("SELECT id, title, created, updated, system FROM chats WHERE id = ?").get(id) });
    }
    if (m === "DELETE") { db.query("UPDATE chats SET deleted = ? WHERE id = ?").run(now().toISOString(), id); return json({ ok: true, chats: chatList() }); }
  }
  if (p === "/api/chats/clear" && m === "POST") {
    // Removes every chat from the list; they stay restorable from "Removed chats".
    db.query("UPDATE chats SET deleted = ? WHERE deleted IS NULL").run(now().toISOString());
    return json({ ok: true, chats: chatList() });
  }
  if (p === "/api/chats/removed" && m === "GET") return json({ chats: db.query("SELECT id, title, deleted FROM chats WHERE deleted IS NOT NULL ORDER BY deleted DESC LIMIT 100").all() });
  if (p === "/api/savings" && m === "GET") {
    const month = url.searchParams.get("month");
    return json(savings(month && /^\d{4}-\d{2}$/.test(month) ? month : undefined));
  }
  if (p === "/api/recent" && m === "GET") {
    return json({ rows: db.query("SELECT ts, source, model, task, auto, mode, in_tokens, cached, out_tokens, cost, usual, usual_cost, price_status, usage_status, status, error, ms, switched_from FROM ledger ORDER BY id DESC LIMIT 50").all() });
  }
  if (p === "/api/lock" && m === "POST") {
    // On: other apps need the key (a new one if asked); this page keeps working (it gets the cookie).
    const b = await readBody(req);
    if (b.on === false) { saveSettings({ accessKey: null }); return json(state(), 200, { "set-cookie": clearCookie() }); }
    const key = b.rotate || !settings().accessKey ? newAccessKey() : settings().accessKey!;
    saveSettings({ accessKey: key });
    return json(state(), 200, { "set-cookie": sessionCookie(key) });
  }
  if (p === "/api/unlock" && m === "POST") {
    const b = await readBody(req);
    if (!locked()) return json({ ok: true });
    if (!keyOk(typeof b.key === "string" ? b.key.trim() : null)) { await Bun.sleep(400); return json({ error: "That is not Leanfare's access key.", locked: true }, 401); }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(settings().accessKey!) });
  }
  if (p === "/api/pause" && m === "POST") {
    const b = await readBody(req);
    setPaused(!!b.paused);
    return json(state());
  }
  if (p === "/api/running/stop" && m === "POST") {
    const b = await readBody(req);
    stopRunning(typeof b.id === "string" ? b.id : undefined);
    return json(state());
  }
  if (p === "/api/refresh" && m === "POST") {
    const b = await readBody(req);
    const what = b.what === "openrouter" ? "openrouter" : b.what === "ollama" ? "ollama" : "data";
    refreshing[what]?.abort();
    const ac = new AbortController();
    refreshing[what] = ac;
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const st = what === "openrouter" ? await refreshOpenRouter(ac.signal) : what === "ollama" ? await refreshOllama(ac.signal) : await refreshCatalog(ac.signal);
    if (what === "ollama" && st.state === "ok") tickTop("ollama");
    return json({ status: st, state: state() });
  }
  if (p === "/api/control/stop" && m === "POST") {
    if (!controlOk(req, controlToken)) return fail(403, "Wrong control token.");
    setTimeout(() => shutdown("stop command"), 10);
    return json({ ok: true, running: runningList().length });
  }
  return fail(404, "No such address.");
}

// ---- the server ---------------------------------------------------------------------

let serverPort = PORT;
let controlToken = "";
let bunServer: ReturnType<typeof Bun.serve> | null = null;
let onShutdown: (() => void) | null = null;

function corsFor(origin: string | null): Record<string, string> {
  if (!origin || !settings().allowOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-leanfare-mode",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "x-leanfare-model, x-leanfare-cost-usd, x-leanfare-estimate-usd, x-leanfare-reason, x-leanfare-auto, x-leanfare-task",
    vary: "origin",
  };
}

export async function handle(req: Request, server: { timeout(r: Request, s: number): void } | null): Promise<Response> {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? "";
  const own = [`127.0.0.1:${serverPort}`, `localhost:${serverPort}`, `[::1]:${serverPort}`];
  if (!own.includes(host)) return new Response("Leanfare answers only at http://127.0.0.1:" + serverPort, { status: 403 });
  const origin = req.headers.get("origin");
  const ownOrigin = !origin || own.some((h) => origin === `http://${h}`);

  if (url.pathname === "/healthz") return json({ ok: true, app: "leanfare", version: VERSION, pid: process.pid, locked: locked() });
  // Leanfare's own command and Mac app open the page through this link, so a locked page opens unlocked.
  if (url.pathname === "/unlock" && req.method === "GET") {
    const t = url.searchParams.get("t") ?? "";
    const ok = locked() && (keyOk(t) || controlOk(new Request(req.url, { headers: { "x-leanfare-token": t } }), controlToken));
    return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer", ...(ok ? { "set-cookie": sessionCookie(settings().accessKey!) } : {}) } });
  }

  if (url.pathname.startsWith("/v1/")) {
    const cors = corsFor(origin);
    if (!ownOrigin && !cors["access-control-allow-origin"]) return json({ error: { message: `Leanfare does not answer web pages from ${origin}. Allow it in Settings if you trust it.`, type: "origin_not_allowed" } }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!engineAllowed(req, controlToken)) {
      const message = "Leanfare needs its access key: send it as the API key (Authorization: Bearer lf-..., or x-api-key). It is in Leanfare's Settings, under Other apps need a key.";
      const res = url.pathname.startsWith("/v1/messages") ? json({ type: "error", error: { type: "authentication_error", message } }, 401) : json({ error: { message, type: "authentication_error", code: "invalid_api_key" } }, 401);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
    server?.timeout(req, 0); // answers can take minutes; no idle cut-off
    let res: Response;
    try {
      if (url.pathname === "/v1/models" && req.method === "GET") res = json(v1Models());
      else if (url.pathname === "/v1/chat/completions" && req.method === "POST") res = await handleOpenAI(req, await readBody(req));
      else if (url.pathname === "/v1/messages" && req.method === "POST") res = await handleAnthropic(req, await readBody(req));
      else if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") res = await countTokensRoute(req);
      else res = json({ error: { message: `Leanfare has no ${req.method} ${url.pathname}. It answers /v1/chat/completions, /v1/messages and /v1/models.`, type: "not_found" } }, 404);
    } catch (e) { res = errorResponse(e); }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!ownOrigin) return fail(403, "Only Leanfare's own page can use this.");
    if (url.pathname !== "/api/control/stop" && req.headers.get("x-leanfare") !== "1") return fail(403, "Missing the x-leanfare header.");
    if (url.pathname !== "/api/unlock" && !url.pathname.startsWith("/api/control/") && !pageAllowed(req, controlToken)) return json({ error: "Leanfare is locked. Paste its access key to open it.", locked: true }, 401);
    if (url.pathname === "/api/chat" || url.pathname === "/api/keys" || url.pathname === "/api/refresh" || url.pathname === "/api/import") server?.timeout(req, 0);
    try { return await api(req, url); }
    catch (e: any) { return fail(e instanceof UserError ? e.status : 500, e instanceof UserError ? e.message : `Leanfare hit an unexpected problem: ${String(e?.message ?? e)}`); }
  }

  const file = STATIC[url.pathname];
  if (file && req.method === "GET") {
    const f = Bun.file(join(UI_DIR, file[0]));
    if (await f.exists()) {
      return new Response(f, { headers: { "content-type": file[1], "cache-control": "no-cache", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
  }
  return new Response("Not found", { status: 404 });
}

function v1Models() {
  const created = Math.floor(Date.parse(store.catalog.built) / 1000) || 0;
  const autos = ["auto", "auto-save", "auto-balanced", "auto-best"].map((id) => ({ id, object: "model", created, owned_by: "leanfare" }));
  const ticked = usableModels().map((m) => ({ id: m.id, object: "model", created, owned_by: m.provider, name: m.label }));
  return { object: "list", data: [...autos, ...ticked] };
}

async function countTokensRoute(req: Request): Promise<Response> {
  const body = await readBody(req);
  const key = getKey("anthropic");
  if (!key) return errorResponse(new UserError(400, "There is no Anthropic key in Leanfare yet."), "anthropic");
  const m = typeof body.model === "string" ? getModel(`anthropic/${body.model}`) ?? null : null;
  const res = await fetch(`${baseOf("anthropic")}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...(req.headers.get("anthropic-beta") ? { "anthropic-beta": req.headers.get("anthropic-beta")! } : {}) },
    body: JSON.stringify({ ...body, model: m?.apiId ?? body.model }),
    signal: req.signal,
  });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}

export function startServer(port = PORT, token = randomId(24)) {
  controlToken = token;
  bunServer = Bun.serve({
    hostname: HOST,
    port,
    idleTimeout: 120,
    maxRequestBodySize: 300 * 1024 * 1024, // a ChatGPT export can be large
    fetch: (req, server) => handle(req, server),
    error: (e) => errorResponse(e),
  });
  serverPort = bunServer.port ?? port;
  runtime.port = serverPort;
  return bunServer;
}

export const setShutdownHook = (f: () => void) => { onShutdown = f; };

let shuttingDown = false;
export async function shutdown(why: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`leanfare: stopping (${why})...`);
  bunServer?.stop(false); // no new connections; running answers may finish
  const until = Date.now() + 10_000;
  while (!idle() && Date.now() < until) await Bun.sleep(100);
  if (!idle()) { console.log("leanfare: stopping the answers still running."); stopRunning(); await Bun.sleep(200); }
  try { db.close(); } catch {}
  for (const f of [paths.pid, paths.token]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  onShutdown?.();
  console.log("leanfare: stopped.");
  process.exit(0);
}

export const currentPort = () => serverPort;
export { chargeOf };
