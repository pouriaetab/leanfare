// Your chats, in and out: search across them, export them (all as one JSON
// file; one as Markdown is made by the page), and import them from Leanfare's
// own export or from a ChatGPT or Claude export (the .zip they send you, or
// the conversations.json inside it). Imported chats cost nothing and do not
// touch the cost ledger.
import { inflateRawSync } from "node:zlib";
import { VERSION } from "./config";
import { db } from "./db";
import { now, randomId } from "./util";

// ---- search ---------------------------------------------------------------------

export interface Hit { id: string; title: string; updated: string; snippet: string | null }

const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

// The words around the first match, so a result shows why it matched.
export function snippetOf(text: string, term: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return flat.slice(0, 120);
  let from = Math.max(0, at - 40);
  let to = Math.min(flat.length, at + term.length + 80);
  // Start and end on whole words.
  if (from > 0) { const sp = flat.indexOf(" ", from); if (sp >= 0 && sp < at) from = sp + 1; }
  if (to < flat.length) { const sp = flat.lastIndexOf(" ", to); if (sp > at + term.length) to = sp; }
  return (from > 0 ? "…" : "") + flat.slice(from, to) + (to < flat.length ? "…" : "");
}

export function searchChats(q: string, limit = 50): Hit[] {
  const term = q.replace(/\s+/g, " ").trim().slice(0, 200);
  if (term.length < 2) return [];
  const like = `%${escLike(term)}%`;
  const rows = db.query(`
    SELECT c.id, c.title, c.updated,
      (SELECT m.content FROM messages m WHERE m.chat_id = c.id AND m.deleted IS NULL AND m.content LIKE ?1 ESCAPE '\\' ORDER BY m.id LIMIT 1) AS hit
    FROM chats c
    WHERE c.deleted IS NULL AND (c.title LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.deleted IS NULL AND m.content LIKE ?1 ESCAPE '\\'))
    ORDER BY c.updated DESC LIMIT ?2`).all(like, limit) as { id: string; title: string; updated: string; hit: string | null }[];
  return rows.map((r) => ({ id: r.id, title: r.title, updated: r.updated, snippet: r.hit ? snippetOf(r.hit, term) : null }));
}

// ---- export -------------------------------------------------------------------------

export function exportAll() {
  const chats = db.query("SELECT id, title, created, updated, system FROM chats WHERE deleted IS NULL ORDER BY created").all() as any[];
  const msgs = db.query("SELECT id, chat_id, role, content, meta, ts FROM messages WHERE deleted IS NULL ORDER BY id").all() as any[];
  const files = db.query("SELECT message_id, name, type, kind, size, pages, data FROM files WHERE message_id IS NOT NULL ORDER BY id").all() as any[];
  const filesOf = new Map<number, any[]>();
  for (const f of files) {
    (filesOf.get(f.message_id) ?? filesOf.set(f.message_id, []).get(f.message_id)!).push({ name: f.name, type: f.type, kind: f.kind, size: f.size, pages: f.pages ?? undefined, data: Buffer.from(f.data).toString("base64") });
  }
  const byChat = new Map<string, any[]>();
  for (const m of msgs) {
    const out: any = { role: m.role, content: m.content, ts: m.ts };
    if (m.meta) { try { out.meta = JSON.parse(m.meta); } catch {} }
    const fs = filesOf.get(m.id);
    if (fs) out.files = fs;
    (byChat.get(m.chat_id) ?? byChat.set(m.chat_id, []).get(m.chat_id)!).push(out);
  }
  return {
    app: "leanfare", format: 1, version: VERSION, exported: now().toISOString(),
    chats: chats.map((c) => ({ id: c.id, title: c.title, created: c.created, updated: c.updated, system: c.system ?? undefined, messages: byChat.get(c.id) ?? [] })),
  };
}

// ---- import ---------------------------------------------------------------------------

interface InChat { source: string; title: string; created: string; updated: string; system?: string | null; messages: { role: "user" | "assistant"; content: string; ts: string; meta?: any; files?: any[] }[] }
export interface ImportResult { from: "leanfare" | "chatgpt" | "claude"; chats: number; messages: number; skipped: number }

const iso = (v: unknown, fallback: string): string => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback;
};
const cut = (s: unknown, n: number) => (typeof s === "string" ? s : "").replace(/\u0000/g, "").slice(0, n);

// ChatGPT: each conversation is a tree of messages; the conversation you saw is
// the path from its current message back to the first one.
function fromChatGPT(list: any[]): InChat[] {
  const out: InChat[] = [];
  const at = now().toISOString();
  for (const c of list) {
    const mapping = c?.mapping;
    if (!mapping || typeof mapping !== "object") continue;
    let node = c.current_node && mapping[c.current_node] ? c.current_node : Object.keys(mapping).find((k) => !mapping[k]?.children?.length);
    const path: any[] = [];
    const seen = new Set<string>();
    while (node && mapping[node] && !seen.has(node)) { seen.add(node); path.push(mapping[node]); node = mapping[node].parent; }
    path.reverse();
    const messages: InChat["messages"] = [];
    for (const n of path) {
      const m = n?.message;
      const role = m?.author?.role;
      if ((role !== "user" && role !== "assistant") || m?.metadata?.is_visually_hidden_from_conversation) continue;
      const ct = m?.content?.content_type;
      if (ct !== "text" && ct !== "multimodal_text") continue;
      const parts: unknown[] = Array.isArray(m.content.parts) ? m.content.parts : [];
      const text = parts.map((p) => (typeof p === "string" ? p : p && typeof p === "object" && (p as any).content_type === "image_asset_pointer" ? "[an image was attached here in ChatGPT]" : "")).filter(Boolean).join("\n").trim();
      if (!text) continue;
      const model = typeof m.metadata?.model_slug === "string" ? m.metadata.model_slug : null;
      messages.push({ role, content: cut(text, 2_000_000), ts: iso(m.create_time, iso(c.create_time, at)), ...(role === "assistant" ? { meta: { imported: "ChatGPT", model: model ? { id: `chatgpt/${model}`, label: model } : null } } : {}) });
    }
    if (!messages.length) continue;
    out.push({ source: `chatgpt:${c.conversation_id ?? c.id ?? randomId()}`, title: cut(c.title, 80).trim() || "Imported from ChatGPT", created: iso(c.create_time, at), updated: iso(c.update_time, iso(c.create_time, at)), messages });
  }
  return out;
}

// Claude: each conversation has its messages in order.
function fromClaude(list: any[]): InChat[] {
  const out: InChat[] = [];
  const at = now().toISOString();
  for (const c of list) {
    if (!Array.isArray(c?.chat_messages)) continue;
    const messages: InChat["messages"] = [];
    for (const m of c.chat_messages) {
      const role = m?.sender === "human" ? "user" : m?.sender === "assistant" ? "assistant" : null;
      if (!role) continue;
      let text = typeof m.text === "string" && m.text.trim() ? m.text : Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";
      for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
        if (typeof a?.extracted_content === "string" && a.extracted_content) text += `\n\n[File: ${cut(a.file_name, 200) || "file"}]\n${a.extracted_content}\n[End of ${cut(a.file_name, 200) || "file"}]`;
      }
      text = text.trim();
      if (!text) continue;
      messages.push({ role, content: cut(text, 2_000_000), ts: iso(m.created_at, iso(c.created_at, at)), ...(role === "assistant" ? { meta: { imported: "Claude", model: null } } : {}) });
    }
    if (!messages.length) continue;
    out.push({ source: `claude:${c.uuid ?? randomId()}`, title: cut(c.name, 80).trim() || "Imported from Claude", created: iso(c.created_at, at), updated: iso(c.updated_at, iso(c.created_at, at)), messages });
  }
  return out;
}

function fromLeanfare(j: any): InChat[] {
  const at = now().toISOString();
  return (Array.isArray(j?.chats) ? j.chats : []).map((c: any): InChat => ({
    source: `leanfare:${cut(c.id, 100) || randomId()}`,
    title: cut(c.title, 80).trim() || "Imported chat",
    created: iso(c.created, at), updated: iso(c.updated, iso(c.created, at)),
    system: typeof c.system === "string" ? cut(c.system, 20_000) : null,
    messages: (Array.isArray(c.messages) ? c.messages : []).filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: cut(m.content, 2_000_000), ts: iso(m.ts, at), meta: m.meta && typeof m.meta === "object" ? m.meta : undefined, files: Array.isArray(m.files) ? m.files : undefined })),
  })).filter((c: InChat) => c.messages.length);
}

// The one file Leanfare wants from an export .zip: conversations.json (ChatGPT,
// Claude) or a Leanfare export. A small reader: no library needed for this.
export function fromZip(buf: Uint8Array): Uint8Array | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  let best: { score: number; method: number; size: number; local: number } | null = null;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const base = name.split("/").pop() ?? "";
    const score = base === "conversations.json" ? 2 : /^leanfare.*\.json$/i.test(base) ? 1 : 0;
    if (score && (!best || score > best.score)) best = { score, method, size, local };
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!best || dv.getUint32(best.local, true) !== 0x04034b50) return null;
  const start = best.local + 30 + dv.getUint16(best.local + 26, true) + dv.getUint16(best.local + 28, true);
  const data = buf.subarray(start, start + best.size);
  if (best.method === 0) return data;
  if (best.method === 8) return new Uint8Array(inflateRawSync(data));
  return null;
}

export function readArchive(bytes: Uint8Array): { from: ImportResult["from"]; chats: InChat[] } | string {
  let raw = bytes;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const inner = fromZip(bytes);
    if (!inner) return "This .zip has no conversations.json (ChatGPT, Claude) or Leanfare export in it.";
    raw = inner;
  }
  let j: any;
  try { j = JSON.parse(new TextDecoder().decode(raw)); } catch { return "This file is not JSON. Choose Leanfare's export, or the conversations.json (or .zip) from ChatGPT or Claude."; }
  if (j?.app === "leanfare") return { from: "leanfare", chats: fromLeanfare(j) };
  const list = Array.isArray(j) ? j : Array.isArray(j?.conversations) ? j.conversations : null;
  if (list?.some((c: any) => c?.mapping)) return { from: "chatgpt", chats: fromChatGPT(list) };
  if (list?.some((c: any) => Array.isArray(c?.chat_messages))) return { from: "claude", chats: fromClaude(list) };
  return "Leanfare does not recognise this file. It reads its own export, and the conversations.json (or .zip) from ChatGPT or Claude.";
}

// Chats already imported once (same source) are skipped, so importing twice adds nothing.
export function importChats(from: ImportResult["from"], chats: InChat[]): ImportResult {
  let added = 0, messages = 0, skipped = 0;
  const has = db.query("SELECT 1 FROM chats WHERE source = ?");
  const putChat = db.query("INSERT INTO chats(id, title, created, updated, system, source) VALUES (?, ?, ?, ?, ?, ?)");
  const putMsg = db.query("INSERT INTO messages(chat_id, role, content, meta, ts) VALUES (?, ?, ?, ?, ?)");
  const putFile = db.query("INSERT INTO files(chat_id, message_id, name, type, kind, size, pages, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const c of chats) {
      if (has.get(c.source)) { skipped++; continue; }
      const id = randomId();
      putChat.run(id, c.title, c.created, c.updated, c.system || null, c.source);
      for (const m of c.messages) {
        const mid = Number(putMsg.run(id, m.role, m.content, m.meta ? JSON.stringify(m.meta) : null, m.ts).lastInsertRowid);
        for (const f of m.files ?? []) {
          if (typeof f?.data !== "string" || !["image", "pdf", "text"].includes(f.kind)) continue;
          const bytes = Buffer.from(f.data, "base64");
          putFile.run(id, mid, cut(f.name, 200) || "file", cut(f.type, 100) || "application/octet-stream", f.kind, bytes.length, typeof f.pages === "number" ? f.pages : null, bytes, m.ts);
        }
        messages++;
      }
      added++;
    }
  })();
  return { from, chats: added, messages, skipped };
}
