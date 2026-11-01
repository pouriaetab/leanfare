// The local web server: the app's screens, the screens' own API (/api/...)
// and the engine addresses other apps use (/v1/...). It listens on 127.0.0.1
// only, answers only to its own host name (so a web page cannot reach it by
// pointing a domain at 127.0.0.1), and refuses browser requests from other
// sites unless you allowed them in Settings.
import { deleteWords, KEEP_DAYS, KEEP_NAMES, KEEP_SAYS, wordsKept, wordsOf } from "./words";
import { probeState } from "./usageprobe";
import { lastSnap } from "./statusline";
import { APP_LEVELS, appKey, DEFAULT_LEVEL, isLevel, LEVEL_MEANS, LEVEL_NAME, LEVEL_SAYS, levelFor } from "./level";
import { planMode } from "./modes";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUN_TESTED, DATA_ID, HOST, PORT, VERSION, allProviders, baseOf, paths, provider, runtime, type ProviderId } from "./config";
import { TASKS, allModels, getModel, isRetired, refreshCatalog, refreshOllama, refreshOpenRouter, retiresWithin, served, store, type Model } from "./data";
import * as extra from "./providers";
import { UI_FILES } from "./assets";
import { findKeys, readFound, recognize } from "./findkeys";
import { appsView, setApp } from "./apps";
import { SUBSCRIPTIONS } from "./subscriptions";
import { db, lastRepair } from "./db";
import { allKeys, getKey, keyWhere, keychainNote, removeKey, saveKey, storeName } from "./keys";
import { BRIEF, MAX_INSTRUCTIONS, MODES, saveSettings, settings, validatePatch } from "./settings";
import { budgetState } from "./budget";
import * as connect from "./connect";
import * as local from "./local";
import { CODEX_ID, codexState } from "./codex";
import { GRADED_KINDS, VERDICTS, addGrade, giveAnotherChance, standing, standingText, standings } from "./grades";
import { plansBrief, plansView } from "./plans";
import { meterViews, setStatusline } from "./meter";
import { checkDelegate, fixHandOff, gradeRow, gradeTogether, handOffRow, markFixed, planRow, runDelegate, startDelegate, stopDelegates, waitDelegate } from "./delegate";
import { sideMonth, sideStandings, sideText, stopSideBySide } from "./sidebyside";
import { endRest } from "./rest";
import { clearNoQuota, noQuotaNow, noQuotaWhy } from "./quota";
import { TOOLS, clientLabel, resourceContents, runToolFor } from "./mcp";
import { setSelf } from "./client";
import { checkReport, report } from "./report";
import { askModels, askReport, checkAsk } from "./askreport";
import { checkPlan, gradePart, makePlan, runView, startRun, stopAllRuns, stopRun } from "./planner";
import { setAuto } from "./workers";
import { setUp, setupView } from "./setup";
import { OFF_TEST, OFF_TEXT, OFF_TRIAL, setSwitch, switchedOn } from "./switch";
import { startTest, stopTest, testRunning, testView } from "./localtest";
import { platformsView, setPlatform } from "./platforms";
import { retirementNotices } from "./retire";
import { savings } from "./savings";
import { checkKey, effortLevels, UserError } from "./upstream";
import { FILE_LIMITS, checkFile, prepareMessages, takesImages, takesPdfs, type Attachment, type ChatMsg } from "./files";
import type { Msg } from "./router";
import { exportAll, importChats, readArchive, searchChats } from "./archive";
import { clearCookie, controlOk, engineAllowed, keyOk, locked, newAccessKey, pageAllowed, sessionCookie } from "./lock";
import { chargeOf, errorResponse, handleAnthropic, handleOpenAI, idle, pauseState, plan, planView, providerReady, runChat, runningList, setPaused, stopRunning, tickTop, usableModels, usualModel } from "./engine";
import { guessTask } from "./router";
import { parseSpeed } from "./speed";
import { startTrial, stopTrial, trialRunning, trialView } from "./trial";
import { updateNotice } from "./update";
import { dollars, localDay, now, randomId, redact } from "./util";

// The system's name as people say it, for Report a problem's form (Settings): only the name, never its version.
const SYSTEM_NAME: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const EFFORTS = ["auto", "low", "medium", "high"];
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: message }, status);

// While Leanfare is switched off (switch.ts), work handed over by another process is refused here too:
// an app's door (an older copy's door does not know the switch), a yes that came after the switch went
// off, and leanfare trial. They all hold the control token; the page's own buttons and your scripts do
// not, so they still work.
const offForApps = (req: Request) => !switchedOn() && controlOk(req, controlToken);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/theme.js": ["theme.js", "text/javascript; charset=utf-8"],
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
  const models = allModels().filter((m) => (!isRetired(m, day) || ticked.has(m.id)) && served(m));
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
  const up = updateNotice(s.updateCheck);
  if (up) notices.push(up);
  const ready = allProviders().filter((p) => providerReady(p.id));
  return {
    version: VERSION,
    system: SYSTEM_NAME[process.platform] ?? process.platform, // for Report a problem's form, by its name only
    bun: Bun.version,
    bunTested: BUN_TESTED,
    address: `http://127.0.0.1:${serverPort}`,
    settings: s,
    modes: MODES,
    tasks: TASKS,
    providers: allProviders().map((p) => ({
      id: p.id, name: p.name, needsKey: p.needsKey, keyUrl: p.keyUrl, note: p.note ?? null,
      local: !!p.local, custom: !!p.custom, more: !!p.more,
      ready: providerReady(p.id), on: s.providers[p.id]?.on !== false, free: !!s.providers[p.id]?.free,
      key: p.needsKey ? { saved: !!getKey(p.id), where: keyWhere(p.id), hint: keyHint(p.id), canUndo: (removedKeys.get(p.id)?.until ?? 0) > Date.now() } : null,
      list: p.id === "openrouter" ? store.status.openrouter : p.id === "ollama" ? store.status.ollama : null,
      credit: p.id === "openrouter" && getKey("openrouter") ? connect.credit : null,
      base: baseOf(p.id),
    })),
    models: byProvider,
    usual: usual ? { id: usual.id, label: usual.label } : null,
    readyCount: ready.length,
    usableCount: usableModels().length,
    // Models left out because your key has no quota for them (quota.ts): which, and why, for Settings' model lists.
    noQuota: noQuotaNow().map((q) => ({ model: q.model, since: q.since, why: noQuotaWhy(q, provider(q.provider as ProviderId)?.name) })),
    switchOn: switchedOn(), // Leanfare in your apps, on or off (switch.ts): the switch at the top of the page
    // The level (level.ts, 0.12): the names, what each does, the apps that keep their own, and the one in effect for
    // a Claude app now (raised while the plan runs low, when that is on).
    level: { names: LEVEL_NAME, says: LEVEL_SAYS, apps: APP_LEVELS, now: levelFor(s, "Claude Code", null, planMode()), plan: planReading() },
    keep: { names: KEEP_NAMES, says: KEEP_SAYS, days: KEEP_DAYS, kept: wordsKept() }, // what Leanfare keeps of the words (words.ts)
    budget: b,
    month: (() => { const v = savings(); return { spent: v.spent, today: v.today, answers: v.answers }; })(),
    notices,
    data: {
      built: store.catalog.built, from: store.catalogFrom, ratingsDate: store.catalog.ratingsDate,
      litellmCommit: store.catalog.litellmCommit, credits: store.catalog.credits, status: store.status.data, url: store.status.data.tried,
      modelCount: store.catalog.models.length,
    },
    extra: extra.extraView(),
    subscriptions: SUBSCRIPTIONS,
    pause: pauseState(),
    running: runningList(),
    local: { pull: local.pullView() },
    keyStore: storeName(),
    keychainNote: keychainNote(),
    lock: { on: locked(), key: s.accessKey },
  };
}

// What the menu bar and the MCP door show: today, this month, the budget. Small, so it can be asked often.
const barMoney = (v: number) => (v <= 0 ? "$0" : v < 0.01 ? "<$0.01" : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);
export function summary() {
  const v = savings();
  const b = budgetState();
  return {
    app: "leanfare", version: VERSION, address: `http://127.0.0.1:${serverPort}`,
    today: v.today, month: v.spent, answers: v.answers, saved: v.saved.amount, top: v.top?.label ?? null,
    todayText: barMoney(v.today), monthText: barMoney(v.spent),
    budget: b.budget === null ? null : { amount: b.budget, left: b.left, pct: b.pct, warn: b.warn, reached: b.reached },
    paused: pauseState().paused, running: runningList().length, locked: locked(),
    plans: plansBrief(),
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
// ones (with their contents), checked the same way either way. A kept file
// that is gone stops the new message (strict), or is left out of an earlier one.
function resolveFiles(list: unknown, chatId: string | null, strict: boolean): { files: Attachment[]; missing: string[] } | string {
  if (!Array.isArray(list) || !list.length) return { files: [], missing: [] };
  if (list.length > FILE_LIMITS.count) return `At most ${FILE_LIMITS.count} files go with one message.`;
  const out: Attachment[] = [];
  const missing: string[] = [];
  for (const f of list as any[]) {
    if (f && typeof f.id === "number" && typeof f.data !== "string") {
      const row = chatId ? db.query("SELECT id, name, type, kind, size, pages, data FROM files WHERE id = ? AND chat_id = ?").get(f.id, chatId) as any : null;
      if (!row) {
        if (strict) return `${String(f.name ?? "A file")} is no longer there. Remove it and send again.`;
        missing.push(String(f.name ?? "a file").slice(0, 200));
        continue;
      }
      out.push({ id: row.id, name: row.name, type: row.type, kind: row.kind, size: row.size, pages: row.pages ?? undefined, data: Buffer.from(row.data).toString("base64") });
    } else {
      const a = checkFile(f);
      if (typeof a === "string") return a;
      out.push(a);
    }
  }
  return { files: out, missing };
}

async function chatRoute(req: Request, body: any): Promise<Response> {
  const s = settings();
  let chatId: string | null = typeof body?.chatId === "string" ? body.chatId : null;
  const raw: any[] = Array.isArray(body?.messages) ? body.messages.filter((m: any) => (m?.role === "user" || m?.role === "assistant" || m?.role === "system") && typeof m.content === "string") : [];
  // Kept files are found by their chat, even after history was turned off.
  const known = chatId && db.query("SELECT 1 FROM chats WHERE id = ?").get(chatId) ? chatId : null;
  const msgs: ChatMsg[] = [];
  const gone: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    const r = m.role === "user" ? resolveFiles(m.files, known, i === raw.length - 1) : { files: [], missing: [] };
    if (typeof r === "string") return fail(400, r);
    gone.push(...r.missing);
    msgs.push({ role: m.role, content: m.content, files: r.files });
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
  let fresh = false; // a chat the server has not seen before
  const putFile = () => db.query("INSERT INTO files(chat_id, message_id, name, type, kind, size, pages, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  if (s.history) try {
    if (!chatId || !db.query("SELECT 1 FROM chats WHERE id = ?").get(chatId)) {
      fresh = true;
      // A new chat takes the name the page gave it (so a Stop before this answer
      // starts still knows its chat), if it is a name of that form.
      chatId = chatId && /^[A-Za-z0-9_-]{8,64}$/.test(chatId) ? chatId : randomId();
      const firstUser = msgs.find((m) => m.role === "user")!;
      const first = firstUser.content.trim() || firstUser.files[0]?.name || "New chat";
      db.query("INSERT INTO chats(id, title, created, updated, system) VALUES (?, ?, ?, ?, ?)").run(chatId, first.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat", ts, ts, system || null);
      // What came before the new message is kept too: a question the server never
      // read (stopped at once), or a chat from before history was turned on.
      const put = db.query("INSERT INTO messages(chat_id, role, content, ts) VALUES (?, ?, ?, ?)");
      const file = putFile();
      for (const m of msgs.slice(0, -1)) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        const id = Number(put.run(chatId, m.role, m.content, ts).lastInsertRowid);
        for (const f of m.files) if (f.data) f.id = Number(file.run(chatId, id, f.name, f.type, f.kind, f.size, f.pages ?? null, Buffer.from(f.data, "base64"), ts).lastInsertRowid);
      }
    } else if (typeof body.system === "string") db.query("UPDATE chats SET system = ? WHERE id = ?").run(system || null, chatId);
    const lastSaved = db.query("SELECT id, role, content FROM messages WHERE chat_id = ? AND deleted IS NULL ORDER BY id DESC LIMIT 1").get(chatId) as any;
    if (action === "again" && !fresh) {
      // The answer asked again is replaced only once a new one is there (below).
    } else if (action === "another" && !fresh) {
      const row = target === null ? null : db.query("SELECT meta FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant' AND deleted IS NULL").get(target, chatId) as any;
      if (row?.meta) { try { compare = cleanCompare(JSON.parse(row.meta)); } catch {} }
    } else {
      if (action === "edit" && target !== null && db.query("SELECT 1 FROM messages WHERE id = ? AND chat_id = ? AND role = 'user' AND deleted IS NULL").get(target, chatId)) {
        db.query("UPDATE messages SET deleted = ? WHERE chat_id = ? AND id >= ? AND deleted IS NULL").run(ts, chatId, target);
      } else if (action === "send" && lastSaved?.role === "user" && lastSaved.content === last.content) {
        // The same words again after a failed send: the same question, unless new files came with it.
        if (last.files.some((f) => f.id === undefined)) db.query("UPDATE messages SET deleted = ? WHERE id = ?").run(ts, lastSaved.id);
        else userMessageId = lastSaved.id;
      }
      userMessageId ??= Number(db.query("INSERT INTO messages(chat_id, role, content, ts) VALUES (?, 'user', ?, ?)").run(chatId, last.content, ts).lastInsertRowid);
      const already = db.query("SELECT COUNT(*) AS n FROM files WHERE message_id = ?").get(userMessageId) as { n: number };
      if (!already.n) {
        const put = putFile();
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
        if (gone.length) send({ type: "notice", message: `No longer there, so left out: ${gone.join(", ")} (attached earlier).` });
        let title = "Chat";
        try { if (chatId) title = (db.query("SELECT title FROM chats WHERE id = ?").get(chatId) as any)?.title ?? title; } catch {}
        // Short answers (Settings): said first, then the chat's own instructions, which win where they differ.
        const told = [s.brief ? BRIEF : "", system].filter(Boolean).join("\n\n");
        const out = await runChat(messages, asked, req.signal, send, title, { system: told, effort, meta: compare ? { compare } : undefined });
        // Asked again: the new answer takes the old one's place only if it came
        // (words, and no failure on the way); otherwise the old one stays.
        const keep = action === "again" ? !!out.text && out.status !== "error" : !!(out.text || out.status !== "error");
        if (s.history && chatId && keep) {
          try {
            const id = Number(db.query("INSERT INTO messages(chat_id, role, content, meta, ts) VALUES (?, 'assistant', ?, ?, ?)").run(chatId, out.text, JSON.stringify(out.meta), now().toISOString()).lastInsertRowid);
            if (action === "again" && target !== null) db.query("UPDATE messages SET deleted = ? WHERE id = ? AND chat_id = ? AND role = 'assistant'").run(now().toISOString(), target, chatId);
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

// Seconds to wait for a hand off, from 0 to 50; null when none was asked.
const waitOf = (x: unknown) => { if (x === undefined || x === null || x === "") return null; const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.min(50, n) : null; };
// A hand off as the door gets it: its answer once done (an error as before), or that it still works.
function handOff(job: Awaited<ReturnType<typeof waitDelegate>>): Response {
  if (!job) return fail(404, "No hand off with that id: Leanfare was restarted, or it is more than 2 hours old.");
  if (job.done && job.error) return fail(job.error.status, job.error.message);
  return json(handOffBody(job));
}
// A hand off's answer for the door, or that it is still working; review: whether the receipt asks the app to review,
// grade and fix it (0.12, Settings).
function handOffBody(job: NonNullable<Awaited<ReturnType<typeof waitDelegate>>>): any {
  if (!job.done) return { id: job.id, running: true, seconds: Math.round((Date.now() - job.started) / 1000) };
  if (job.error) return { error: job.error.message };
  return { ...job.result, id: job.id, running: false, whoWrote: settings().whoWrote, review: settings().review };
}

// The Claude plan's last reading (statusline.ts, usageprobe.ts): the two windows' use, when it was read, and how.
function planReading() {
  const snap = lastSnap(), p = probeState();
  const live = (w: { used: number; resets: number | null } | null | undefined) => (w && (w.resets === null || w.resets > Date.now()) ? Math.round(w.used) : null);
  return snap ? { five: live(snap.five), week: live(snap.week), at: snap.at, check: p ? { ok: p.ok, why: p.why, at: p.at } : null } : { five: null, week: null, at: null, check: p ? { ok: p.ok, why: p.why, at: p.at } : null };
}

// The level as an app sees it: in effect (a chat's own first), the default, each app's own, and the two switches.
function levelState(app: string | null, chat: string | null) {
  const s = settings();
  const n = chat === null ? null : Number(chat);
  const view = levelFor(s, app && app.trim() ? app.trim().slice(0, 60) : null, isLevel(n) ? n : null, planMode());
  return { view, default: isLevel(s.level) ? s.level : DEFAULT_LEVEL, levels: s.levels ?? {}, raiseWhenLow: s.raiseWhenLow !== false, ask: s.askEachChat === true, names: LEVEL_NAME, means: LEVEL_MEANS, apps: APP_LEVELS, plan: planReading() };
}

async function readBody(req: Request): Promise<any> {
  const t = await req.text();
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw new UserError(400, "The request body is not JSON."); }
}

// A key was saved, pasted or by signing in: switch the provider on, load
// OpenRouter's list and balance, and tick the provider's short list.
async function keySaved(id: ProviderId, signal?: AbortSignal, liveModels?: string[] | null) {
  removedKeys.delete(id);
  clearNoQuota({ provider: id }); // a new key may have the quota the last one lacked
  if (liveModels && provider(id)?.more) store.live.set(id, new Set(liveModels));
  saveSettings({ providers: { ...settings().providers, [id]: { ...(settings().providers[id] ?? {}), on: true } } });
  if (id === "openrouter") {
    await refreshOpenRouter(signal);
    await connect.refreshCredit(getKey("openrouter"), signal);
  }
  tickTop(id);
}

let refreshing: Partial<Record<string, AbortController>> = {};

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/state" && m === "GET") return json(state());
  if (p === "/api/summary" && m === "GET") return json(summary());
  // The one switch for Leanfare in your apps (switch.ts), and the first run's Set up (setup.ts).
  if (p === "/api/switch" && m === "POST") {
    const b = await readBody(req);
    if (typeof b?.on !== "boolean") return fail(400, "on must be true or false");
    setSwitch(b.on);
    // Off stops what is already going too: the parts of running plans, hand offs still working, and the trial
    // (and a local model's test, which is one).
    const stopped = { plans: 0, delegates: 0, trial: false };
    if (!b.on) { stopped.plans = stopAllRuns(); stopped.delegates = stopDelegates(); stopSideBySide(); stopped.trial = trialRunning() || testRunning(); await stopTrial(); stopTest(); }
    return json({ on: switchedOn(), stopped });
  }
  if (p === "/api/setup" && m === "GET") return json(setupView());
  if (p === "/api/setup" && m === "POST") return json(await setUp(req.signal));
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
    await keySaved(def.id, req.signal, check.models);
    return json({ ok: true, message: `${check.message} Saved in ${where === "keychain" ? "the macOS Keychain" : "a file only you can read"}.`, state: state() });
  }
  // Sign in with OpenRouter instead of pasting a key (see connect.ts). The page
  // starts it, opens the link in your browser, and asks for the outcome.
  if (p === "/api/connect/openrouter/start" && m === "POST") return json(connect.start(serverPort));
  if (p === "/api/connect/openrouter/status" && m === "GET") {
    const st = connect.status();
    return json(st.status === "connected" ? { ...st, state: state() } : st);
  }
  if (p === "/api/connect/openrouter/cancel" && m === "POST") { connect.cancel(); return json({ ok: true }); }
  // Local models (see local.ts): what Ollama has, removing one, and a download that goes on
  // in the background while the page polls its progress.
  if (p === "/api/local" && m === "GET") return json({ ...(await local.overview()), test: testView() });
  if (p === "/api/local/test" && m === "GET") return json(testView());
  // Where Leanfare may send work for your apps: each platform on or off, and what is left before its nearest limit.
  if (p === "/api/platforms" && m === "GET") return json(await platformsView());
  if (p === "/api/platforms" && m === "POST") {
    const b = await readBody(req);
    const v = await platformsView();
    if (typeof b?.id !== "string" || !v.rows.some((r) => r.id === b.id)) return fail(400, "Say which platform: one of " + v.rows.map((r) => r.id).join(", ") + ".");
    if (typeof b.on !== "boolean") return fail(400, "on must be true or false.");
    setPlatform(b.id, b.on);
    return json(await platformsView());
  }
  if (p === "/api/local/pull" && m === "GET") return json({ pull: local.pullView() });
  if (p === "/api/local/suggest" && m === "GET") return json(local.suggestLocal());
  // The report (report.ts): a span of time and filters, everything Leanfare did for your apps in it.
  if (p === "/api/report" && m === "GET") {
    const q = checkReport(url.searchParams);
    if (typeof q === "string") return fail(400, q);
    const r = await report(q);
    // One prompt (the report tool's prompt): each part with its kept words, so the app can read them (words.ts, 0.12).
    if (url.searchParams.get("prompt")) for (const pr of r.prompts) for (const x of pr.parts as any[]) if (x.words) x.text = wordsOf(x.id);
    return json(r);
  }
  // Ask about these prompts (askreport.ts, 0.12): the models that may answer, and a question over Savings' span and filters.
  if (p === "/api/report/ask" && m === "GET") return json({ models: askModels() });
  if (p === "/api/report/ask" && m === "POST") {
    const v = checkAsk(await readBody(req));
    if (typeof v === "string") return fail(400, v);
    return json(await askReport(v, req.signal));
  }
  // A hand off's kept words (words.ts, 0.12): Savings opens a part, or exports the CSV with the words.
  if (p === "/api/words" && m === "GET") {
    const ids = String(url.searchParams.get("handoffs") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 1000);
    return json({ words: Object.fromEntries(ids.map((id) => [id, wordsOf(id)])) });
  }
  // The manager's grades (grades.ts): a part's answer graded, the standings, and another chance.
  if (p === "/api/grades" && m === "GET") return json({ standings: standings().map((x) => ({ ...x, text: standingText(x) })), side: sideStandings().map((x) => ({ ...x, text: sideText(x) })), sideMonth: sideMonth() });
  if (p === "/api/grades" && m === "POST") {
    const b = await readBody(req);
    if (!VERDICTS.includes(b?.verdict)) return fail(400, "verdict must be good, partly or wrong.");
    const source = b.source === "you" ? "you" : "manager";
    // 0.12: graded partly or wrong, the app fixed it itself (fix myself), or Leanfare asks again one tier up (fix leanfare).
    const fix = b.fix === "myself" || b.fix === "leanfare" ? (b.fix as "myself" | "leanfare") : null;
    if (b.fix !== undefined && b.fix !== null && !fix) return fail(400, "fix must be myself or leanfare.");
    if (fix && b.verdict === "good") return fail(400, "fix goes with partly or wrong: a good answer needs no fix.");
    const fixed = async (row: number | null) => {
      if (!fix || row === null) return null;
      if (fix === "myself") { markFixed(row, "myself"); return null; }
      if (!switchedOn()) return { error: "Leanfare is switched off, so it did not ask again. Fix it yourself." };
      const f = fixHandOff(row, b.verdict, typeof b.why === "string" ? b.why : null);
      if ("error" in f) return { error: f.error };
      return { ...handOffBody((await waitDelegate(f.job.id, waitOf(b.wait) ?? 0, req.signal))!), fixOf: row };
    };
    if (typeof b.id === "string" && Number.isInteger(b.part)) {
      const g = gradePart(b.id, b.part, b.verdict, source);
      return json(fix && !(g as any).error ? { ...g, fix: await fixed(planRow(b.id, b.part)) } : g);
    }
    // A hand off named only by its number: its model and kind from its row.
    if (Number.isInteger(b.handoff) && typeof b.model !== "string") {
      const r = handOffRow(b.handoff);
      if (!r) return fail(404, `No hand off ${b.handoff} with an answer to grade.`);
      b.model = r.model; b.kind = r.kind; b.effort ??= r.effort;
    }
    if (typeof b.model === "string" && GRADED_KINDS.includes(b.kind)) {
      if (b.model !== CODEX_ID && !getModel(b.model)) return fail(404, `Leanfare does not know the model ${String(b.model).slice(0, 80)}.`);
      addGrade({ model: b.model, kind: b.kind, effort: typeof b.effort === "string" ? b.effort.slice(0, 10) : null, verdict: b.verdict, source });
      // Kept with the hand off's row too (the one the app names, else its last of that model and kind).
      gradeRow(b.verdict, Number.isInteger(b.handoff) ? { row: b.handoff } : { model: b.model, kind: b.kind });
      const st = standing(b.model, b.kind);
      return json({ text: standingText(st), standing: st, fix: Number.isInteger(b.handoff) ? await fixed(b.handoff) : fix ? { error: "A fix needs the hand off's number, from its receipt." } : null });
    }
    return fail(400, "Grade a plan's part (id and part) or a model's answer (model and kind: read, write, reason or search).");
  }
  // The level (level.ts, 0.12): for an app (and a chat's own, when the level tool set one), with the default and each
  // app's; POST keeps one as the default or for an app.
  if (p === "/api/level" && m === "GET") return json(levelState(url.searchParams.get("app"), url.searchParams.get("chat")));
  if (p === "/api/level" && m === "POST") {
    const b = await readBody(req);
    if (!isLevel(b?.set)) return fail(400, "set must be a level from 1 to 5.");
    if (b.scope === "default") saveSettings({ level: b.set });
    else if (b.scope === "app") {
      const k = typeof b.key === "string" && b.key in APP_LEVELS ? b.key : appKey(typeof b.app === "string" ? b.app : null);
      if (!k) return fail(400, "That app cannot keep a level of its own.");
      saveSettings({ levels: { ...(settings().levels ?? {}), [k]: b.set } });
    }
    else return fail(400, "scope must be default or app (a chat's level stays in the chat).");
    return json(levelState(typeof b.app === "string" ? b.app : null, null));
  }
  // A model resting after failing too often (rest.ts): end its rest now, so Auto may pick it again.
  // What Leanfare keeps (words.ts, 0.12): Delete all.
  if (p === "/api/words/delete" && m === "POST") return json({ deleted: deleteWords(), kept: wordsKept() });
  if (p === "/api/rest/end" && m === "POST") {
    const b = await readBody(req);
    if (typeof b?.model !== "string" || b.model.length > 200) return fail(400, "model is needed.");
    return json({ ended: endRest(b.model) });
  }
  // A door older than this app (an app kept it running after an update, mcp.ts): the tools as this version has them,
  // a call run here for that door's app and folder, and an MCP App's page. A call reads files and may spend, so only
  // Leanfare's own door makes one: it carries the control token.
  if (p === "/api/mcp/tools" && m === "GET") return json({ version: VERSION, tools: TOOLS });
  if (p === "/api/mcp/resource" && m === "POST") { const b = await readBody(req); return json({ contents: resourceContents(b?.uri) }); }
  if (p === "/api/mcp/call" && m === "POST") {
    if (!controlOk(req, controlToken)) return fail(403, "Wrong control token.");
    const b = await readBody(req);
    if (typeof b?.name !== "string" || !TOOLS.some((t) => t.name === b.name)) return fail(404, `Leanfare has no tool named ${String(b?.name)}.`);
    const folder = typeof b.folder === "string" && b.folder.trim() ? b.folder : homedir();
    return json(await runToolFor({ client: clientLabel(b.client), cwd: folder, canAsk: false }, b.name, b.arguments ?? {}, req.signal));
  }
  // Try again for a model left out because the key had no quota for it (quota.ts): it may be picked again.
  if (p === "/api/quota/clear" && m === "POST") {
    const b = await readBody(req);
    if (typeof b?.model !== "string" || b.model.length > 200) return fail(400, "model is needed.");
    return json({ cleared: clearNoQuota({ model: b.model }) > 0, state: state() });
  }
  // A prompt's whole result, the app and its hand offs together (report.ts): from the app (its last hand off in the
  // last 6 hours), or from you in the report (a hand off of that prompt, by its number).
  if (p === "/api/grades/together" && m === "POST") {
    const b = await readBody(req);
    if (!VERDICTS.includes(b?.verdict)) return fail(400, "verdict must be good, partly or wrong.");
    return json({ ok: gradeTogether(b.verdict, Number.isInteger(b.handoff) ? { row: b.handoff, by: "you" } : { app: typeof b.app === "string" ? b.app.slice(0, 60) : null, by: "app" }) });
  }
  if (p === "/api/grades/reset" && m === "POST") {
    const b = await readBody(req);
    if (typeof b?.model !== "string" || !GRADED_KINDS.includes(b?.kind)) return fail(400, "model and kind are needed.");
    giveAnotherChance(b.model, b.kind);
    return json({ standings: standings().map((x) => ({ ...x, text: standingText(x) })) });
  }
  if (p === "/api/codex" && m === "GET") return json({ ...(await codexState(url.searchParams.get("fresh") === "1")), on: settings().codexPlan });
  if (p === "/api/local/pull" && m === "POST") { const b = await readBody(req); return json({ pull: await local.startPull(b.name, b.sizeBytes) }); }
  if (p === "/api/local/pull/stop" && m === "POST") { local.stopPull(); return json({ pull: local.pullView() }); }
  if (p === "/api/local/pull/dismiss" && m === "POST") { local.dismissPull(); return json({ pull: null }); }
  // A model on this computer tested on known answers (localtest.ts); one that passes takes reading first.
  if (p === "/api/local/test" && m === "POST") { if (offForApps(req)) return fail(409, OFF_TEST); const b = await readBody(req); return json(startTest(b.model)); }
  if (p === "/api/local/test/stop" && m === "POST") { stopTest(); return json(testView()); }
  // Ollama's models folder linked to one found on a drive (local.ts: useFolder).
  if (p === "/api/local/use" && m === "POST") { const b = await readBody(req); const r = await local.useFolder(b.path); return json({ ...r, local: { ...(await local.overview()), test: testView() }, state: state() }); }
  if (p === "/api/local/delete" && m === "POST") {
    const b = await readBody(req);
    const r = await local.remove(typeof b.name === "string" ? b.name : "");
    return json({ ok: true, ...r, state: state() });
  }
  // Paste any key: Leanfare finds its provider by how it looks, tests it there, and saves it.
  if (p === "/api/keys/recognize" && m === "POST") {
    const b = await readBody(req);
    const key = String(b.key ?? "").trim();
    if (key.length < 8 || /\s/.test(key)) return fail(400, "That does not look like a key: it should be one word with no spaces.");
    const r = recognize(key);
    if (r.refuse) return json({ ok: false, message: r.refuse, state: state() });
    if (!r.providers.length) return json({ ok: false, unknown: true, message: "Leanfare does not recognize this key's provider. If it speaks OpenAI's format, add it under Add a provider with its address.", state: state() });
    const tried: string[] = [];
    for (const id of r.providers) {
      const def = provider(id)!;
      const check = await checkKey(id, key, req.signal);
      if (!check.ok) { tried.push(`${def.name}: ${redact(check.message, [key])}`); if (check.status === 0) break; continue; }
      const where = await saveKey(id, key);
      await keySaved(id, req.signal, check.models);
      return json({ ok: true, provider: id, message: `A ${def.name} key. ${check.message} Saved in ${where === "keychain" ? "the macOS Keychain" : "a file only you can read"}.`, state: state() });
    }
    return json({ ok: false, message: `It looks like a ${r.providers.map((id) => provider(id)!.name).join(" or ")} key, but it did not work. ${tried.join(" ")}`, state: state() });
  }
  // Find my keys: what is already on this computer (see findkeys.ts). Only names, places and the
  // last four characters come to the screen; importing reads the key again where it was found.
  if (p === "/api/keys/found" && m === "GET") return json({ keys: await findKeys() });
  if (p === "/api/keys/import" && m === "POST") {
    const b = await readBody(req);
    const refs: string[] = Array.isArray(b.refs) ? b.refs.filter((x: unknown) => typeof x === "string").slice(0, 40) : [];
    const found = await findKeys();
    const results: { ref: string; ok: boolean; message: string }[] = [];
    for (const ref of refs) {
      const f = found.find((x) => x.ref === ref);
      const key = f ? await readFound(ref) : null;
      if (!f || !key) { results.push({ ref, ok: false, message: "That key is not there any more." }); continue; }
      if (f.provider) {
        const check = await checkKey(f.provider, key, req.signal);
        if (!check.ok) { results.push({ ref, ok: false, message: `${f.label}: ${redact(check.message, [key])}` }); continue; }
        await saveKey(f.provider, key);
        await keySaved(f.provider, req.signal, check.models);
        results.push({ ref, ok: true, message: `${f.label}: ${check.message}` });
      } else if (f.registry) {
        const already = extra.customFor(f.registry.id, f.registry.api);
        if (already) { // added before: the key goes to it, not to a second provider
          await saveKey(already.id, key);
          await keySaved(already.id, req.signal);
          results.push({ ref, ok: true, message: `${f.label}: key saved.` });
          continue;
        }
        const added = await extra.addCustomProvider({ name: f.registry.name, base: f.registry.api, key, registry: f.registry.id });
        if (!added.ok) { results.push({ ref, ok: false, message: `${f.label}: ${redact(added.message, [key])}` }); continue; }
        await saveKey(added.id, key);
        await keySaved(added.id, req.signal);
        results.push({ ref, ok: true, message: `${f.label}: added, ${added.models} models.` });
      }
    }
    return json({ results, state: state() });
  }
  // Use Leanfare in your apps: its MCP server in Claude Desktop, Claude Code, Cursor and the rest (apps.ts).
  if (p === "/api/apps" && m === "GET") return json({ apps: appsView() });
  if (p === "/api/apps" && m === "POST") {
    const b = await readBody(req);
    try {
      if (typeof b.auto === "boolean") { setAuto(String(b.id ?? ""), b.auto); return json({ app: appsView().find((a) => a.id === b.id) ?? null, apps: appsView() }); }
      return json({ app: await setApp(String(b.id ?? ""), !!b.on), apps: appsView() });
    }
    catch (e: any) { return json({ error: String(e?.message ?? e), apps: appsView() }, 409); }
  }
  // Providers you add: any address that speaks OpenAI's format (see providers.ts).
  if (p === "/api/providers/registry" && m === "GET") {
    const r = await extra.registry();
    return json({ choices: r ? extra.registryChoices(r) : [], from: "models.dev", ok: !!r });
  }
  if (p === "/api/providers/custom" && m === "POST") {
    const v = extra.checkCustomInput(await readBody(req));
    if (typeof v === "string") return fail(400, v);
    const added = await extra.addCustomProvider(v);
    if (!added.ok) return json({ ok: false, message: v.key ? redact(added.message, [v.key]) : added.message, state: state() });
    if (v.key) await saveKey(added.id, v.key);
    await keySaved(added.id, req.signal);
    return json({ ok: true, id: added.id, message: `${v.name} added: ${added.models} model${added.models === 1 ? "" : "s"}.`, state: state() });
  }
  if (p === "/api/providers/custom/remove" && m === "POST") {
    const b = await readBody(req);
    const id = String(b.id ?? "");
    if (!extra.removeCustomProvider(id)) return fail(404, "No provider you added has that id.");
    await removeKey(id);
    return json({ ok: true, state: state() });
  }
  const keyMatch = /^\/api\/keys\/([a-z0-9-]+)(\/restore)?$/.exec(p);
  if (keyMatch) {
    const def = provider(keyMatch[1]);
    if (!def || !def.needsKey) return fail(404, "Unknown provider.");
    if (keyMatch[2] && m === "POST") {
      const r = removedKeys.get(def.id);
      if (!r || r.until < Date.now()) return fail(410, "Too late to undo; paste the key again.");
      await saveKey(def.id, r.key);
      removedKeys.delete(def.id);
      if (def.id === "openrouter") await connect.refreshCredit(r.key, req.signal);
      return json({ ok: true, state: state() });
    }
    if (m === "DELETE") {
      const old = getKey(def.id);
      if (old && keyWhere(def.id) !== "environment" && keyWhere(def.id) !== "shell") removedKeys.set(def.id, { key: old, until: Date.now() + 30_000 });
      const still = await removeKey(def.id);
      if (def.id === "openrouter") connect.forgetCredit();
      return json({ ok: true, env: still?.env ?? null, from: still?.from ?? null, state: state() });
    }
  }
  const provMatch = /^\/api\/providers\/([a-z0-9-]+)$/.exec(p);
  if (provMatch && m === "POST") {
    const def = provider(provMatch[1]);
    if (!def) return fail(404, "Unknown provider.");
    const b = await readBody(req);
    const cur = settings().providers[def.id] ?? { on: true };
    const next = { ...cur, ...(typeof b.on === "boolean" ? { on: b.on } : {}), ...(typeof b.free === "boolean" ? { free: b.free } : {}) };
    saveSettings({ providers: { ...settings().providers, [def.id]: next } });
    return json(state());
  }
  // Claude's delegate (see delegate.ts): a task and its files, handed over by the MCP door. Asked with a
  // wait (the door's: under the minute an app waits), it runs on its own, and the answer comes back within the
  // wait or later through its id. Without one, as before: the answer when it is done.
  if (p === "/api/delegate" && m === "POST") {
    if (offForApps(req)) return fail(409, OFF_TEXT);
    const b = await readBody(req);
    const v = checkDelegate(b);
    if (typeof v === "string") return fail(400, v);
    const wait = waitOf(b?.wait);
    if (wait === null) return json({ ...(await runDelegate(v, req.signal)), whoWrote: settings().whoWrote, review: settings().review });
    return handOff(await waitDelegate(startDelegate(v).id, wait, req.signal));
  }
  if (p === "/api/delegate" && m === "GET") return handOff(await waitDelegate(url.searchParams.get("id") ?? "", waitOf(url.searchParams.get("wait")) ?? 0, req.signal));
  // The plan (planner.ts): a task split into parts, each with where it runs and on which model.
  if (p === "/api/plan" && m === "POST") {
    if (offForApps(req)) return fail(409, OFF_TEXT);
    // The MCP door holds the control token: it measured the files itself and says where each is.
    const v = checkPlan(await readBody(req), controlOk(req, controlToken));
    if (typeof v === "string") return fail(400, v);
    return json(await makePlan({ ...v, signal: req.signal }));
  }
  if (p === "/api/plan/run" && m === "POST") { if (offForApps(req)) return fail(409, OFF_TEXT); const b = await readBody(req); return json({ ...startRun(String(b?.id ?? ""), { paid: b?.paid === true || b?.paid === "yes" }), whoWrote: settings().whoWrote, review: settings().review }); }
  if (p === "/api/plan/run" && m === "GET") { const v = runView(url.searchParams.get("id") ?? ""); return v ? json({ ...v, whoWrote: settings().whoWrote, review: settings().review }) : fail(404, "No run of that plan."); }
  if (p === "/api/plan/stop" && m === "POST") { const b = await readBody(req); const v = stopRun(String(b?.id ?? "")); return v ? json(v) : fail(404, "No run of that plan."); }
  // The delegate trial (trial.ts): its estimate and last report, start, stop.
  if (p === "/api/trial" && m === "GET") return json(await trialView(req.signal));
  if (p === "/api/trial/start" && m === "POST") {
    if (offForApps(req)) return fail(409, OFF_TRIAL);
    if (testRunning()) return fail(409, "A model on this computer is being tested. Wait until it is done, or stop it in Settings, Local models.");
    startTrial(); return json(await trialView(req.signal, false));
  }
  if (p === "/api/trial/stop" && m === "POST") { await stopTrial(); return json(await trialView(req.signal)); }
  if (p === "/api/estimate" && m === "POST") {
    const b = await readBody(req);
    const messages = Array.isArray(b.messages) ? describeFiles(b.messages) : [];
    if (!messages.length) return json({ estimate: null });
    try {
      // As the chat will send it: the short answers instruction first, when it is on.
      const own = typeof b.system === "string" && b.system.trim() ? b.system.slice(0, MAX_INSTRUCTIONS) : "";
      const system = [settings().brief ? BRIEF : "", own].filter(Boolean).join("\n\n") || undefined;
      const pl = await plan({ source: "chat", asked: typeof b.model === "string" ? b.model : "auto", messages, system, maxOut: null, signal: req.signal, dry: true, effort: EFFORTS.includes(b.effort) ? b.effort : settings().effort, speed: parseSpeed(b.speed) ?? undefined });
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
  // Your plans (see plans.ts): the month's tokens in the Claude Code and Codex logs on this computer, at API prices.
  if (p === "/api/plans" && m === "GET") {
    const month = url.searchParams.get("month");
    return json(await plansView(month && /^\d{4}-\d{2}$/.test(month) ? month : undefined, url.searchParams.get("refresh") === "1"));
  }
  // The plan meter (see meter.ts): what is left of each plan, in work and tokens, and which project still fits.
  if (p === "/api/meter" && m === "GET") return json(await meterViews());
  if (p === "/api/meter/statusline" && m === "POST") { const b = await readBody(req); return json({ statusline: setStatusline(!!b.on) }); }
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
    if (b.what === "local") { await extra.refreshLocalServers(); await refreshOllama(); return json({ status: { state: "ok", error: null }, state: state() }); }
    if (b.what === "custom") { await extra.refreshCustom(); return json({ status: { state: "ok", error: null }, state: state() }); }
    const what = b.what === "openrouter" ? "openrouter" : b.what === "ollama" ? "ollama" : "data";
    refreshing[what]?.abort();
    const ac = new AbortController();
    refreshing[what] = ac;
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const st = what === "openrouter" ? await refreshOpenRouter(ac.signal) : what === "ollama" ? await refreshOllama(ac.signal) : await refreshCatalog(ac.signal);
    if (what === "openrouter") await connect.refreshCredit(getKey("openrouter"), ac.signal);
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
    "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-leanfare-mode, x-leanfare-speed",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "x-leanfare-model, x-leanfare-cost-usd, x-leanfare-estimate-usd, x-leanfare-estimate-seconds, x-leanfare-reason, x-leanfare-auto, x-leanfare-task",
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

  if (url.pathname === "/healthz") return json({ ok: true, app: "leanfare", version: VERSION, pid: process.pid, locked: locked(), data: DATA_ID });
  // Leanfare's own command and Mac app open the page through this link, so a locked page opens unlocked.
  if (url.pathname === "/unlock" && req.method === "GET") {
    const t = url.searchParams.get("t") ?? "";
    const ok = locked() && (keyOk(t) || controlOk(new Request(req.url, { headers: { "x-leanfare-token": t } }), controlToken));
    return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer", ...(ok ? { "set-cookie": sessionCookie(settings().accessKey!) } : {}) } });
  }

  // Where OpenRouter sends your browser after you press Authorize. It carries no
  // page cookie (your browser may not be the Mac app), so it is allowed by the
  // one use state that Leanfare gave out when you pressed Connect. The host
  // check above still applies.
  if (url.pathname === "/connect/openrouter/callback" && req.method === "GET") {
    server?.timeout(req, 0); // trading the code, testing the key and loading the list wait on OpenRouter
    return connectCallback(url);
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
    if ((url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages") && req.method === "POST" && offForApps(req)) {
      res = url.pathname === "/v1/messages" ? json({ type: "error", error: { type: "leanfare_off", message: OFF_TEXT } }, 409) : json({ error: { message: OFF_TEXT, type: "leanfare_off" } }, 409);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
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
    // Requests that can wait a long time on providers or other programs: no idle cut-off.
    if (["/api/mcp/call", "/api/chat", "/api/delegate", "/api/plan", "/api/keys", "/api/refresh", "/api/import", "/api/keys/import", "/api/keys/recognize", "/api/keys/found", "/api/providers/custom", "/api/providers/registry", "/api/apps", "/api/setup", "/api/switch", "/api/trial/stop"].includes(url.pathname)) server?.timeout(req, 0);
    try { return await api(req, url); }
    catch (e: any) { return fail(e instanceof UserError ? e.status : 500, e instanceof UserError ? e.message : `Leanfare hit an unexpected problem: ${String(e?.message ?? e)}`); }
  }

  const file = STATIC[url.pathname];
  if (file && req.method === "GET") {
    const f = Bun.file(UI_FILES[file[0]]);
    if (await f.exists()) {
      return new Response(f, { headers: { "content-type": file[1], "cache-control": "no-cache", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
  }
  return new Response("Not found", { status: 404 });
}

async function connectCallback(url: URL): Promise<Response> {
  const got = await connect.finish(url.searchParams.get("code"), url.searchParams.get("state"));
  if (!got.ok) return connectPage(false, got.message);
  try {
    const where = await saveKey("openrouter", got.key);
    await keySaved("openrouter");
    connect.record(true, `Connected to OpenRouter. The key is saved in ${where === "keychain" ? "the macOS Keychain" : "a file only you can read"}.`);
  } catch (e: any) {
    const message = `OpenRouter signed in, but Leanfare could not save the key: ${String(e?.message ?? e).slice(0, 160)}`;
    connect.record(false, message);
    return connectPage(false, message);
  }
  return connectPage(true, "You can close this tab.");
}

// The small page your browser lands on. Only fixed words and OpenRouter's error
// text (escaped); nothing from the address is printed back.
function connectPage(ok: boolean, message: string): Response {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Leanfare</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f7;color:#16191a}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0;color:#4a5356}@media(prefers-color-scheme:dark){body{background:#16191a;color:#f1f3f3}p{color:#b6bdbf}}</style></head>
<body><main><h1>${ok ? "Connected." : "Not connected."}</h1><p>${esc(message)}</p></main></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
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
  setSelf({ base: `http://127.0.0.1:${serverPort}`, token }); // a call run here for an older door reaches this app (client.ts)
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
