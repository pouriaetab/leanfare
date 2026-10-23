// Small shared helpers: the clock, dates, number formats, ids and a parser for
// server-sent events (the "data: ..." stream format AI providers use).

// The clock. Tests fix it with setNow() or LEANFARE_NOW so retirement and
// month boundaries can be checked on a known day.
let fixedNow: Date | null = process.env.LEANFARE_NOW ? new Date(process.env.LEANFARE_NOW) : null;
export const now = (): Date => (fixedNow ? new Date(fixedNow) : new Date());
export const setNow = (d: Date | string | null) => { fixedNow = d === null ? null : new Date(d); };

const pad = (n: number) => String(n).padStart(2, "0");
// Calendar day and month in the computer's own time zone: a budget month is the
// month on the user's calendar, not in London.
export const localDay = (d = now()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localMonth = (d = now()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export const usd8 = (v: number) => v.toFixed(8);
// A dollar amount in a sentence: cents from $1 up, up to four decimals below.
export const dollars = (v: number) => (Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : `$${Number(v.toFixed(4))}`);

export function randomId(bytes = 9): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(b).toString("base64url");
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Server-sent events arrive in arbitrary pieces. Feed it bytes; it calls back
// once per complete event with the event name and its joined data lines.
export class SSEParser {
  private buf = "";
  private dec = new TextDecoder();
  constructor(private onEvent: (event: string, data: string) => void) {}
  push(chunk: Uint8Array | string) {
    this.buf += typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.nextBreak()) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i).replace(/^(\r\n|\r|\n){2}/, "");
      this.emit(block);
    }
  }
  end() { if (this.buf.trim()) this.emit(this.buf); this.buf = ""; }
  private nextBreak(): number {
    const m = /(\r\n|\r|\n)(\r\n|\r|\n)/.exec(this.buf);
    return m ? m.index : -1;
  }
  private emit(block: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? "" : line.slice(c + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) this.onEvent(event, data.join("\n"));
  }
}

// Provider error bodies come in several shapes. Pull out the human sentence.
export function providerMessage(body: string): string {
  try {
    let j: any = JSON.parse(body);
    if (Array.isArray(j)) j = j[0];
    const e = j?.error ?? j;
    const msg = typeof e === "string" ? e : e?.message ?? j?.detail ?? j?.message ?? e?.type;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 400);
    if (Array.isArray(j?.detail) && j.detail[0]?.msg) return String(j.detail[0].msg).slice(0, 400);
  } catch {}
  return body.replace(/\s+/g, " ").trim().slice(0, 200) || "no details";
}

// Never let a key reach a log line or the screen, even inside a provider's own
// error message (OpenAI echoes part of a wrong key back).
export function redact(text: string, secrets: string[] = []): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join("[key]");
  return t.replace(/\b(sk-[A-Za-z0-9_\-*]{6,}|sk-ant-[A-Za-z0-9_\-*]{6,}|sk-or-[A-Za-z0-9_\-*]{6,}|AIza[0-9A-Za-z_\-]{20,}|xai-[A-Za-z0-9_\-*]{10,})/g, "[key]");
}
