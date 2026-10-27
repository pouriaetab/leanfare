// The suggested local model on the screens: Settings' Local models card shows it with Download, and a
// plan whose reading goes to pay per use names it with Download it. Pressing either is the yes.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { store, type Model } from "../src/data";
import { probe, SUGGESTED } from "../src/local";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp as open } from "./dom";

const GB = 1e9;
let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
const twin = (provider: string, name: string, label: string, overall: number): Model => ({
  id: `${provider}/${name}`, provider: provider as any, apiId: name, source: "test", maker: "m", name, label, input: 0.2, output: 0.6, cacheRead: null, cacheWrite: null,
  context: 128_000, skills: [], added: "2026-06-01", retire: null, ratings: { overall },
});
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  store.catalog.models.push(twin("cerebras", "gemma-4-31b", "Gemma 4 31B", 1452), twin("groq", "qwen3.8-27b", "Qwen3.8-27B", 1437));
  await ui(url, "/api/refresh", { what: "ollama" });
  for (const s of SUGGESTED) fake.ollama.library[s.name] = s.size;
  fake.ollama.holding = true; // the download waits, so the screens can be read while it runs
  Object.assign(probe, { memory: () => 64 * GB, free: () => 200 * GB });
});
afterEach(() => { fake.ollama.holding = false; });
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
const pulled = () => fake.seen.filter((s) => s.path === "/ollama/api/pull").map((s) => s.body.model);

describe("the suggested local model", () => {
  test("Settings: the model, its size, whether it fits, its rating and licence, and why; Download downloads that one", async () => {
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    const row = () => doc.querySelector("#localCard .srow");
    await waitFor(() => !!row());
    const t = row().textContent;
    expect(t).toContain("gemma4:31b-it-qat");
    expect(t).toContain("19 GB");
    expect(t).toContain("fits");
    expect(t).toContain("★ 1437");
    expect(t).toContain("Apache-2.0");
    expect(doc.querySelector("#localCard").textContent).toContain("Suggested for this computer");
    expect(doc.querySelector("#localCard").textContent).toContain("is rated like Gemma 4 31B");
    expect([...doc.querySelectorAll("#localCard .lrow .nm")].map((n: any) => n.textContent)).toEqual(["llama3.2"]); // the installed list is apart
    row().querySelector("button").click();
    await waitFor(() => pulled().includes("gemma4:31b-it-qat"));
    expect(pulled()).toEqual(["gemma4:31b-it-qat"]);
    expect((await ui(url, "/api/local/pull")).json.pull).toMatchObject({ name: "gemma4:31b-it-qat", active: true, size: 19 * GB }); // its size was passed: checked before anything downloaded
    await waitFor(() => !doc.querySelector("#localCard .srow"));
    expect(doc.querySelector("#localCard .srow")).toBeNull(); // while it downloads, the suggestion steps aside
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("Settings with nothing to suggest says why, in one line", async () => {
    Object.assign(probe, { memory: () => 16 * GB });
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector("#localCard")?.textContent.includes("On this computer"));
    expect(doc.querySelector("#localCard .srow")).toBeNull();
    expect(doc.querySelector("#localCard").textContent).toContain("Suggested for this computer: none. None of the rated open models on Leanfare's list runs in 16 GB of memory.");
  }, 20000);

  test("the Plan tab: a plan whose reading goes to pay per use names it, and Download it downloads it", async () => {
    await keys("openai");
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="plan"]').click();
    await waitFor(() => !!doc.querySelector("#tab-plan textarea"));
    doc.querySelector("#tab-plan textarea[aria-label='What do you want to do?']").value = "Find out why the nightly job fails and fix it";
    doc.querySelector("#tab-plan input[aria-label='Split by rules']").checked = true;
    doc.querySelector("#planGo").click();
    await waitFor(() => !!doc.querySelector("#planResult .plan-local"));
    const note = doc.querySelector("#planResult .plan-local");
    expect(note.textContent).toContain("A local model fits this computer: gemma4:31b-it-qat (19 GB), rated like Gemma 4 31B, free to run.");
    [...note.querySelectorAll("button")].find((b: any) => b.textContent === "Download it").click();
    await waitFor(() => toasts(doc).includes("Downloading gemma4:31b-it-qat"));
    expect(toasts(doc)).toContain("Downloading gemma4:31b-it-qat: Settings, Local models shows how it goes.");
    expect(pulled()).toEqual(["gemma4:31b-it-qat"]);
    expect(bad(doc)).toBe(false);
  }, 30000);
});
