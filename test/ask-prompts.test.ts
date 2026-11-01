// 0.12, ask about these prompts (askreport.ts): a question over Savings' span and filters, read by a model on this
// computer unless you pick another of yours; it keeps no row and nothing of the question or the answer.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { CUT_NOTE, promptsText } from "../src/askreport";
import { draw } from "../src/delegate";
import { db } from "../src/db";
import { saveSettings } from "../src/settings";
import { setNow } from "../src/util";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp as open } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED, keep: 3 }); draw.next = () => 0.5; await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral"); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const local = async () => { await ui(url, "/api/refresh", { what: "ollama" }); saveSettings({ ticked: [...ALL_TICKED, "ollama/llama3.2:latest"] }); };
const hand = (task: string) => (setNow("2026-10-21T11:00:00Z"), ui(url, "/api/delegate", { task, files: [{ name: "app.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "low", check: "never", app: "Claude" })).finally(() => setNow("2026-10-21T12:00:00Z"));
const rows = () => (db.query("SELECT COUNT(*) AS n FROM delegations").get() as any).n;
const chats = () => fake.seen.filter((s) => s.path.includes("/chat/completions") || s.path.includes("/api/chat") || s.path.includes("/messages") || s.path.includes("generateContent"));

test("a model on this computer answers from the span's prompts, with the sums worked out; no row, nothing kept", async () => {
  await hand("Find the errors.");
  await local();
  const before = rows(), sent = chats().length;
  fake.hooks.answer = (p) => (p.includes("The question: Which prompt cost the most?") ? "PRM-1 cost the most ($0)." : null);
  const r = await ui(url, "/api/report/ask", { question: "Which prompt cost the most?", q: { range: "today" } });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ answer: "PRM-1 cost the most ($0).", model: { id: "ollama/llama3.2:latest" }, local: true, shown: 1, total: 1 });
  const asked = chats().slice(sent);
  expect(asked.length).toBe(1);
  expect(asked[0].path.startsWith("/ollama")).toBe(true); // it never left this computer
  const text = JSON.stringify(asked[0].body);
  expect(text).toContain("1 prompt, 1 part handed off");
  expect(text).toContain("task: Find the errors."); // the kept words go with it (keep is 3)
  expect(text).toContain("answer: Hello from deepseek-v4-flash.");
  expect(rows()).toBe(before); // not a hand off: the report does not grow
  expect((db.query("SELECT COUNT(*) AS n FROM words").get() as any).n).toBe(1); // only the hand off's own words
});

test("with no model here it says what to do and sends nothing; another of your models answers only when picked", async () => {
  await hand("Find the errors.");
  const sent = chats().length;
  const none = await ui(url, "/api/report/ask", { question: "What did I hand off?", q: { range: "today" } });
  expect(none.status).toBe(409);
  expect(none.json.error).toContain("No model on this computer is ready to answer");
  expect(chats().length).toBe(sent);
  const models = (await ui(url, "/api/report/ask")).json.models;
  expect(models.some((m: any) => m.id === "openai/gpt-5-mini")).toBe(true);
  const r = await ui(url, "/api/report/ask", { question: "What did I hand off?", q: { range: "today" }, model: "openai/gpt-5-mini" });
  expect(r.status).toBe(200);
  expect(r.json.model.id).toBe("openai/gpt-5-mini");
  expect(chats().slice(sent).every((s) => s.provider === "openai")).toBe(true);
  // A model that may not take your projects' files is not offered, and is refused when named.
  saveSettings({ filesTo: "local" });
  expect((await ui(url, "/api/report/ask")).json.models.some((m: any) => m.id === "openai/gpt-5-mini")).toBe(false);
  expect((await ui(url, "/api/report/ask", { question: "x", q: { range: "today" }, model: "openai/gpt-5-mini" })).status).toBe(400);
  // Checks on what is asked.
  expect((await ui(url, "/api/report/ask", { question: " ", q: { range: "today" } })).json.error).toBe("Write a question first.");
  expect((await ui(url, "/api/report/ask", { question: "x".repeat(2001), q: { range: "today" } })).status).toBe(400);
  expect((await ui(url, "/api/report/ask", { question: "x", q: { range: "custom" } })).status).toBe(400);
});

test("only the newest prompts that fit are sent, and the text says how many were left out", () => {
  const prompt = (n: number) => ({ key: String(n), id: `PRM-${n}`, ts: new Date(Date.UTC(2026, 9, 21, 10, n)).toISOString(), app: "Claude Code", thread: null, project: "app", model: null, plan: null, prompt: 1000, own: null, parts: [], kept: 0, back: 0, cost: 0, saved: null, grade: null, used: null, both: null, together: null, togetherBy: null, alone: null });
  const r: any = { from: "2026-10-21T00:00:00Z", to: "2026-10-21T12:00:00Z", prompts: Array.from({ length: 50 }, (_, i) => prompt(i)), more: 0 };
  const t = promptsText(r, 2000);
  expect(t.total).toBe(50);
  expect(t.shown).toBeLessThan(50);
  expect(t.text).toContain(`Shown: the newest ${t.shown} prompts; ${50 - t.shown} older ones did not fit.`);
  expect(t.text).toContain("PRM-49"); // the newest first
  expect(t.text).not.toContain("PRM-0 ");
});

test("a newest prompt longer than the model's room is cut to its first whole lines, with a note, not refused", () => {
  const part = (i: number) => ({ id: i, ref: `PRM-9.${i}`, ts: "2026-10-21T10:00:00Z", kind: "read", model: "x/y", label: "Some Model", provider: "x", where: "free", read: 50_000, back: 300, cost: 0, ms: 4000, grade: "good", gradedBy: "app", check: null, checker: null, side: null, plan: "P1", used: null, both: { alone: { mid: 1, low: 1, high: 1 }, spent: 1, saved: { mid: 1, low: 1, high: 1 }, how: "outside" }, together: null, togetherBy: null, level: 4, fixed: null, fixOf: null, words: false, alone: null });
  const big: any = { key: "9", id: "PRM-9", ts: "2026-10-21T10:00:00Z", app: "Claude Code", thread: null, project: "app", model: null, plan: null, prompt: 1000, own: null, parts: Array.from({ length: 200 }, (_, i) => part(i + 1)), kept: 0, back: 0, cost: 0, saved: null, grade: null, used: null, both: null, together: null, togetherBy: null, alone: null };
  const r: any = { from: "2026-10-21T00:00:00Z", to: "2026-10-21T12:00:00Z", prompts: [big], more: 0 };
  const t = promptsText(r, 4000);
  expect([t.shown, t.total, t.cut]).toEqual([1, 1, true]);
  expect(t.text.length).toBeLessThanOrEqual(4000);
  expect(t.text).toContain("Shown: the prompt, cut to fit.");
  expect(t.text).toContain("PRM-9 · ");
  expect(t.text.trimEnd().endsWith(CUT_NOTE.trim())).toBe(true);
  expect(t.text).not.toContain("PRM-9.200"); // the last parts did not fit
  // Room enough: nothing is cut.
  expect(promptsText(r, 1_000_000).cut).toBe(false);
});

test("Savings: the ask box, its sample questions, and the answer with who answered", async () => {
  await hand("Find the errors.");
  await local();
  fake.hooks.answer = (p) => (p.includes("The question:") ? "One prompt, PRM-1, read app.log." : null);
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="savings"]').click();
  await waitFor(() => !!doc.querySelector("#rpAsk"));
  await waitFor(() => doc.querySelector("#rpAsk select")?.textContent.includes("A model on this computer"));
  expect(doc.querySelector("#rpAsk").textContent).toContain("Ask about these prompts");
  expect(doc.querySelector("#rpAsk").textContent).toMatch(/\d+ prompts? in this span/); // Savings opens on 7 days, which can hold other tests' Claude Code prompts
  [...doc.querySelectorAll("#rpAsk .chip-btn")].find((b: any) => b.textContent === "Where did Leanfare save the most?")!.click();
  await waitFor(() => !!doc.querySelector("#rpAsk .rp-ask-text"));
  expect(doc.querySelector("#rpAsk .rp-ask-text").textContent).toBe("One prompt, PRM-1, read app.log.");
  expect(doc.querySelector("#rpAsk").textContent).toContain("on this computer");
  expect(doc.querySelector("#rpAsk").textContent).toContain("not kept");
}, 30000);
