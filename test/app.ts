// One Leanfare server per test run, with the fixed test catalogue.
import { unlinkSync } from "node:fs";
import { paths } from "../src/config";
import { db, openDb, putSetting } from "../src/db";
import { loadCatalog, store } from "../src/data";
import { loadKeys, saveKey, removeKey } from "../src/keys";
import { startServer } from "../src/server";
import { resetSettingsCache, saveSettings, type Settings } from "../src/settings";
import { resetBudget } from "../src/budget";
import { forgetHistoryCache, setPaused, stopRunning } from "../src/engine";
import { forgetSpeeds } from "../src/speed";
import { forgetGrades } from "../src/grades";
import { sideBySideIdle, stopSideBySide } from "../src/sidebyside";
import { stopTrial } from "../src/trial";
import { forgetTests } from "../src/localtest";
import { setNow } from "../src/util";
import { KEYS, type startFake } from "./fake";
import * as connect from "../src/connect";
import * as local from "../src/local";

export const FIXTURE = new URL("./fixtures/catalog.json", import.meta.url).pathname;
export const fake = (globalThis as any).__fake as ReturnType<typeof startFake>;
export const outgoing = (globalThis as any).__outgoing as string[];

let booted: { url: string; port: number } | null = null;

export async function boot() {
  if (booted) return booted;
  openDb(paths.db);
  loadCatalog(FIXTURE);
  await loadKeys();
  const srv = startServer(0, "test-token");
  booted = { url: `http://127.0.0.1:${srv.port}`, port: srv.port! };
  return booted;
}

export async function reset(patch: Partial<Settings> = {}) {
  stopRunning();
  stopSideBySide();
  await sideBySideIdle();
  setPaused(false);
  setNow("2026-10-21T12:00:00Z");
  await stopTrial();
  db.exec("DELETE FROM ledger; DELETE FROM messages; DELETE FROM chats; DELETE FROM settings; DELETE FROM files; DELETE FROM delegations; DELETE FROM trials; DELETE FROM grades; DELETE FROM comparisons; DELETE FROM prompts;");
  forgetGrades();
  resetSettingsCache();
  resetBudget();
  forgetHistoryCache();
  forgetSpeeds();
  for (const f of [paths.catalog, paths.openrouter]) { try { unlinkSync(f); } catch {} }
  loadCatalog(FIXTURE);
  store.ollama = []; store.ollamaFound = false; store.openrouter = [];
  connect.cancel(); connect.forgetCredit();
  local.stopPull(); local.dismissPull(); fake.ollama.reset();
  Object.assign(local.probe, { free: () => 200e9, memory: () => 16e9, roots: () => [] }); // fixed numbers: tests never depend on this computer's disk, memory or drives
  forgetTests();
  for (const id of Object.keys(KEYS)) await removeKey(id as any);
  fake.seen.length = 0;
  fake.hooks.answer = null;
  fake.hooks.fail = null;
  fake.hooks.slow = null;
  Object.assign(fake.oauth, { expireNext: false, deny: false, failExchange: 0, failMessage: "fake failure", badKey: false, credits: true });
  fake.oauth.codes.clear();
  // Short answers (on by default) add an instruction to every chat request; the tests that check
  // what a provider gets turn it off, and chat.test.ts checks it on its own.
  // Side by side is off unless a test turns it on: it would add answers to every hand off now and then.
  saveSettings({ brief: false, sideBySide: 0, ...patch });
}

export async function keys(...ids: string[]) {
  for (const id of ids) await saveKey(id as any, KEYS[id]);
}

export const ALL_TICKED = [
  "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5", "openai/gpt-5-mini", "openai/gpt-4.1",
  "google/gemini-3.8-flash", "deepseek/deepseek-v4-flash", "xai/grok-4.20-beta", "mistral/mistral-large-4",
];

export async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

export async function ui(url: string, path: string, body?: unknown, method?: string) {
  const r = await fetch(url + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { "x-leanfare": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}

export function ledger(): any[] {
  return db.query("SELECT * FROM ledger ORDER BY id").all() as any[];
}

export async function readSSE(res: Response): Promise<{ events: any[]; raw: string }> {
  const raw = await res.text();
  const events = raw.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => b.slice(6)).map((d) => { try { return JSON.parse(d); } catch { return d; } });
  return { events, raw };
}

export { putSetting };

// A small llmledger data.json (schema 1 wants at least 100 models).
export function syntheticData(built = "2026-10-21T13:00:00+00:00") {
  const padding = Array.from({ length: 120 }, (_, i) => ({ key: `pad-${i}`, maker: "x", name: `pad-${i}`, host: "nowhere", mode: "chat", input: 1, output: 1 }));
  return {
    schema: 1, built, litellm: { commit: "0123456789abcdef" },
    credits: { prices: "LiteLLM's model_prices_and_context_window.json (MIT)", ratings: "Arena leaderboard (CC BY 4.0)" },
    ratings: { date: "2026-10-20", tasks: { overall: [["openai / gpt-5-mini", "GPT-5 mini", 1440], ["google / gemini-3.8-flash", "Gemini 3.8 Flash (High)", 1496]] } },
    models: [
      ...padding,
      { key: "gpt-5-mini", maker: "openai", name: "gpt-5-mini", host: "openai", mode: "chat", input: 0.25, output: 2, cache_read: 0.025, added: "2025-08-07" },
      { key: "gemini/gemini-3.8-flash", maker: "google", name: "gemini-3.8-flash", host: "gemini", mode: "chat", input: 0.75, output: 3.75, cache_read: 0.075, added: "2026-09-03" },
    ],
  };
}
