// Files attached to a message on the chat screen: images, PDFs and text files.
//
// A text file is pasted into the message itself, so every model can read it.
// Images go to models that see images; PDFs to the models that read them
// through Leanfare (Claude, GPT, and OpenRouter models that take files). With
// chat history on, files are kept in the database next to their chat; with it
// off they live only in the page and are sent again with each message.
import type { Model } from "./data";
import { pdfPages } from "./cost";

export type FileKind = "image" | "pdf" | "text";
export interface Attachment { id?: number; name: string; type: string; kind: FileKind; size: number; pages?: number; data: string } // data: base64

export const FILE_LIMITS = { image: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, text: 1024 * 1024, count: 10, total: 20 * 1024 * 1024 };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|cfg|conf|log|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|r|scala|lua|pl|dart|vue|svelte|tex|rst|env)$/i;
const TEXT_NAMES = /^(Dockerfile|Makefile|README|LICENSE|\.gitignore|\.env\.example)$/i;

export function kindOf(type: string, name: string): FileKind | null {
  const t = type.toLowerCase();
  if (IMAGE_TYPES.has(t)) return "image";
  if (t === "application/pdf" || (!t.startsWith("image/") && /\.pdf$/i.test(name))) return "pdf";
  if (t.startsWith("text/") || /^application\/(json|ld\+json|xml|x-yaml|yaml|toml|javascript|typescript|x-sh|sql|x-python)/.test(t) || TEXT_EXT.test(name) || TEXT_NAMES.test(name)) return "text";
  return null;
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const KIND_WORD: Record<FileKind, string> = { image: "an image", pdf: "a PDF", text: "a text file" };

// A file is what its name says: checked by its first bytes, not only its type.
function looksRight(kind: FileKind, type: string, b: Uint8Array): boolean {
  if (kind === "pdf") return ascii(b, 0, 5) === "%PDF-";
  if (kind === "text") return !b.subarray(0, 8192).includes(0);
  if (type === "image/png") return b[0] === 0x89 && ascii(b, 1, 4) === "PNG";
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/gif") return ascii(b, 0, 4) === "GIF8";
  if (type === "image/webp") return ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP";
  return false;
}

// One file from the page: the clean attachment, or a sentence saying what is wrong.
export function checkFile(f: any): Attachment | string {
  if (!f || typeof f !== "object") return "A file could not be read.";
  const name = String(f.name ?? "file").replace(/[\u0000-\u001f/\\]/g, "").trim().slice(0, 200) || "file";
  const type = String(f.type ?? "").toLowerCase().trim().slice(0, 100);
  const kind = kindOf(type, name);
  if (!kind) return `${name}: Leanfare takes images (PNG, JPEG, WebP, GIF), PDFs and text files.`;
  if (typeof f.data !== "string" || !f.data) return `${name} arrived without its contents.`;
  const bytes = Uint8Array.from(Buffer.from(f.data, "base64"));
  if (!bytes.length) return `${name} is empty.`;
  // Base64 is 4 characters for every 3 bytes; anything far from that was not base64.
  if (Math.abs(bytes.length - Math.floor((f.data.replace(/[\s=]/g, "").length * 3) / 4)) > 2) return `${name} arrived damaged.`;
  if (bytes.length > FILE_LIMITS[kind]) return `${name} is ${mb(bytes.length)}; the most for ${KIND_WORD[kind]} is ${mb(FILE_LIMITS[kind])}.`;
  if (!looksRight(kind, type, bytes)) return `${name} does not look like ${KIND_WORD[kind]}${kind === "image" ? ` of type ${type}` : ""}.`;
  const out: Attachment = { name, type: kind === "pdf" ? "application/pdf" : kind === "text" ? type || "text/plain" : type, kind, size: bytes.length, data: Buffer.from(bytes).toString("base64") };
  if (kind === "pdf") out.pages = pdfPages(bytes);
  return out;
}

export function checkFiles(list: unknown): Attachment[] | string {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return "files must be a list";
  if (list.length > FILE_LIMITS.count) return `At most ${FILE_LIMITS.count} files go with one message.`;
  const out: Attachment[] = [];
  for (const f of list) {
    const a = checkFile(f);
    if (typeof a === "string") return a;
    out.push(a);
  }
  const total = out.reduce((n, a) => n + a.size, 0);
  if (total > FILE_LIMITS.total) return `These files add up to ${mb(total)}; one message takes at most ${mb(FILE_LIMITS.total)}.`;
  return out;
}

// A text file as it is pasted into the message.
export function textFileBlock(a: Attachment): string {
  const text = Buffer.from(a.data, "base64").toString("utf8").replace(/\u0000/g, "");
  return `[File: ${a.name}]\n${text.replace(/\n+$/, "")}\n[End of ${a.name}]`;
}

// One message in OpenAI's chat format: a plain string when it has only text
// (every provider takes that), parts when it has images or PDFs (those first:
// models read a document before the question about it best).
export function contentFor(text: string, files: Attachment[]): string | any[] {
  const body = [text, ...files.filter((f) => f.kind === "text").map(textFileBlock)].filter((t) => t).join("\n\n");
  const media = files.filter((f) => f.kind !== "text");
  if (!media.length) return body;
  const parts: any[] = media.map((f) => f.kind === "image"
    ? { type: "image_url", image_url: { url: `data:${f.type};base64,${f.data}` } }
    : { type: "file", file: { filename: f.name, file_data: `data:application/pdf;base64,${f.data}` } });
  if (body) parts.push({ type: "text", text: body });
  return parts;
}

// Which models take what is attached. Local models: your call (Ollama does not say).
export const takesImages = (m: Model) => !!m.local || m.skills.includes("vision");
const PDF_PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);
export const takesPdfs = (m: Model) => PDF_PROVIDERS.has(m.provider) && m.skills.includes("pdf");

export interface ChatMsg { role: "user" | "assistant" | "system"; content: string; files: Attachment[] }

// What one request may carry in files across the whole conversation: Claude's
// API takes at most 32 MB a request, and files travel as base64 (4/3 larger).
export const CONTEXT_FILE_BYTES = 22 * 1024 * 1024;

// A chat's messages as the engine sends them. When the conversation's files
// pass what one request carries, the oldest are left out and the model is told
// where they were; text files always stay (they are part of the words).
export function prepareMessages(msgs: ChatMsg[], limit = CONTEXT_FILE_BYTES): { messages: { role: string; content: string | any[] }[]; dropped: string[] } {
  let room = limit;
  const dropped: string[] = [];
  const keep = new Set<Attachment>();
  for (let i = msgs.length - 1; i >= 0; i--) {
    for (const f of msgs[i].files) {
      if (f.kind === "text" || f.size <= room) { keep.add(f); if (f.kind !== "text") room -= f.size; }
      else dropped.push(f.name);
    }
  }
  const messages = msgs.map((m) => {
    const files = m.files.filter((f) => keep.has(f));
    const left = m.files.filter((f) => !keep.has(f)).map((f) => `[${f.name} was attached here earlier; it is left out now to keep this request within the providers' size limits.]`);
    const text = [m.content, ...left].filter(Boolean).join("\n\n");
    return { role: m.role, content: files.length ? contentFor(text, files) : text };
  });
  return { messages, dropped };
}
