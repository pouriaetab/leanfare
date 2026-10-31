// 0.12, what Leanfare keeps (words.ts): numbers only at first; the task, the answer, the files' names and their text as
// the knob goes up; kept for the days chosen; Delete all; and the knob in Settings.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { db } from "../src/db";
import { draw } from "../src/delegate";
import { settings } from "../src/settings";
import { wordsKept, wordsOf } from "../src/words";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp as open, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); draw.next = () => 0.5; await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral"); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };
const hand = () => ui(url, "/api/delegate", { task: "Find the errors.", files: [LOG], kind: "read", effort: "low", check: "never" });

test("numbers only at first: no words are kept", async () => {
  expect(settings().keep).toBe(1);
  await hand();
  expect(wordsKept()).toEqual({ count: 0, bytes: 0 });
});

test("as the knob goes up: the task, then the answer, then the files' names, then their text", async () => {
  await ui(url, "/api/settings", { keep: 2 });
  const a = (await hand()).json.row;
  expect(wordsOf(a)).toEqual({ task: "Find the errors.", answer: null, files: null, texts: null });
  await ui(url, "/api/settings", { keep: 4 });
  const b = (await hand()).json.row;
  expect(wordsOf(b)).toMatchObject({ task: "Find the errors.", answer: "Hello from deepseek-v4-flash.", files: [{ name: "app.log", size: LOG.text.length }], texts: null });
  await ui(url, "/api/settings", { keep: 5 });
  const c = (await hand()).json.row;
  expect(wordsOf(c)!.texts).toEqual([{ name: "app.log", text: LOG.text }]);
  expect((await ui(url, "/api/settings", { keep: 6 })).status).toBe(400);
  expect((await ui(url, "/api/settings", { keepDays: 10 })).status).toBe(400);
});

test("kept for the days chosen, and Delete all clears them", async () => {
  await ui(url, "/api/settings", { keep: 3, keepDays: 7 });
  db.query("INSERT INTO words(handoff, ts, task) VALUES (999, '2026-10-01T00:00:00Z', 'old task')").run();
  await hand(); // a new one prunes the old
  expect(wordsOf(999)).toBeNull();
  expect(wordsKept().count).toBe(1);
  const st = (await ui(url, "/api/state")).json.keep;
  expect(st.kept.count).toBe(1);
  const d = await ui(url, "/api/words/delete", {});
  expect(d.json).toMatchObject({ deleted: 1, kept: { count: 0, bytes: 0 } });
});

test("Settings: the keep knob turns with the keys, and Delete all is there when words are kept", async () => {
  await ui(url, "/api/settings", { keep: 3 });
  await hand();
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  await waitFor(() => !!doc.querySelector('[aria-label="What Leanfare keeps"]'));
  const knob = doc.querySelector('[aria-label="What Leanfare keeps"]');
  expect(knob.getAttribute("aria-valuenow")).toBe("3");
  knob.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await waitFor(() => settings().keep === 2);
  expect(settings().keep).toBe(2);
  await waitFor(() => [...doc.querySelectorAll("button")].some((b: any) => b.textContent === "Delete all kept words" && !b.disabled));
  [...doc.querySelectorAll("button")].find((b: any) => b.textContent === "Delete all kept words")!.click();
  await waitFor(() => wordsKept().count === 0);
  expect(wordsKept().count).toBe(0);
}, 30000);
