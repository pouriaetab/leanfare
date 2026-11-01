// 0.12, a prompt's words: the kept words of each part in Savings (Read the words, with Copy), in the CSV with the words,
// in the report tool's prompt, and in /api/words.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { draw } from "../src/delegate";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp as open } from "./dom";
import { runToolFor } from "../src/mcp";
import { setNow } from "../src/util";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED, keep: 3 }); draw.next = () => 0.5; await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral"); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
// Handed off an hour before the tests' now, so the report's today (up to now, not including it) has it.
const hand = (task: string) => (setNow("2026-10-21T11:00:00Z"), ui(url, "/api/delegate", { task, files: [{ name: "app.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "low", check: "never", app: "Claude" })).finally(() => setNow("2026-10-21T12:00:00Z"));

test("/api/words gives each hand off's kept words, and the report marks the parts that have them", async () => {
  const a = (await hand("Find the errors.")).json.row;
  const w = (await ui(url, `/api/words?handoffs=${a},999`)).json.words;
  expect(w[a]).toMatchObject({ task: "Find the errors.", answer: "Hello from deepseek-v4-flash." });
  expect(w[999]).toBeNull();
  const r = (await ui(url, "/api/report?range=today")).json;
  expect(r.prompts[0].parts[0]).toMatchObject({ id: a, words: true });
});

test("the report tool's prompt shows each part's task and answer", async () => {
  await hand("Find the errors.");
  const r = (await ui(url, "/api/report?range=today")).json;
  const id = r.prompts[0].id;
  const t = await runToolFor({ client: "Claude", cwd: process.env.LEANFARE_DATA_DIR!, canAsk: false }, "report", { prompt: id }, new AbortController().signal);
  expect(t.content[0].text).toContain("Kept words:");
  expect(t.content[0].text).toContain("the task:\nFind the errors.");
  expect(t.content[0].text).toContain("the answer:\nHello from deepseek-v4-flash.");
});

test("Savings: Read the words opens the task and the answer under the part", async () => {
  await hand("Find the errors.");
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="savings"]').click();
  await waitFor(() => !!doc.querySelector("#reportCard tr.pr"));
  doc.querySelector("#reportCard tr.pr").click();
  await waitFor(() => [...doc.querySelectorAll("#reportCard button")].some((b: any) => b.textContent === "Read the words"));
  [...doc.querySelectorAll("#reportCard button")].find((b: any) => b.textContent === "Read the words")!.click();
  await waitFor(() => !!doc.querySelector("#reportCard tr.wd"));
  const row = doc.querySelector("#reportCard tr.wd");
  expect(row.textContent).toContain("The task Claude wrote");
  expect(row.textContent).toContain("Find the errors.");
  expect(row.textContent).toContain("Hello from deepseek-v4-flash.");
  expect([...doc.querySelectorAll("#reportCard button")].some((b: any) => b.textContent === "Export CSV with the words")).toBe(true);
}, 30000);
