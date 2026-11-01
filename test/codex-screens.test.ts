// Your ChatGPT plan through Codex, on the screens: the ChatGPT row next to your apps says whether Codex is there and
// signed in, with one button (Connect, Turn on or Turn off); the Plan tab shows a part on Codex as such.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetCodex } from "../src/codex";
import { settings } from "../src/settings";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp as open, win } from "./dom";

let url = "", dir = "";
const was = process.env.LEANFARE_CODEX_BIN;
beforeAll(async () => {
  url = (await boot()).url;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-fakecodex-ui-")));
  writeFileSync(join(dir, "codex"), `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.159.0" ;; login) [ -f "${dir}/signed-out" ] && exit 1; [ -f "${dir}/apikey" ] && { echo "API key configured - sk-***abcde" >&2; exit 0; }; echo "Logged in using ChatGPT" >&2 ;; mcp) echo "[]" ;; *) exit 2 ;; esac\n`);
  chmodSync(join(dir, "codex"), 0o755);
});
afterAll(() => { if (was === undefined) delete process.env.LEANFARE_CODEX_BIN; else process.env.LEANFARE_CODEX_BIN = was; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { forgetCodex(); await reset({ ticked: ALL_TICKED }); process.env.LEANFARE_CODEX_BIN = join(dir, "codex"); for (const f of ["signed-out", "apikey"]) rmSync(join(dir, f), { force: true }); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const card = (doc: any) => doc.querySelector("#codexCard");

describe("Settings: the ChatGPT row, next to your apps", () => {
  test("signed in with ChatGPT: Turn on and Turn off switch hand offs on the ChatGPT plan (off until you turn it on)", async () => {
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!card(doc)?.textContent.includes("signed in"));
    expect(card(doc).textContent).toContain("ChatGPT · signed in");
    expect(card(doc).textContent).toContain("Codex is signed in with ChatGPT: turn it on to hand work to your ChatGPT plan.");
    expect(card(doc).querySelector("details").textContent).toContain("they count toward your ChatGPT plan's Codex limits");
    expect(settings().codexPlan).toBe(false); // off until you turn it on
    ([...card(doc).querySelectorAll("button")].find((b: any) => b.textContent === "Turn on") as any).click();
    await waitFor(() => settings().codexPlan === true);
    await waitFor(() => !!card(doc)?.textContent.includes("· connected"));
    expect(card(doc).textContent).toContain("Hand offs and web searches can run on your ChatGPT plan, before any paid model.");
    ([...card(doc).querySelectorAll("button")].find((b: any) => b.textContent === "Turn off") as any).click();
    await waitFor(() => settings().codexPlan === false);
  }, 20000);
  test("signed out, or not on this computer: one Connect button", async () => {
    writeFileSync(join(dir, "signed-out"), "");
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!card(doc)?.textContent.includes("not connected"));
    expect(card(doc).textContent).toContain("Hand reading, drafting and web searches to your ChatGPT plan. A free account works.");
    expect([...card(doc).querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Connect"]);
  }, 20000);
  test("signed in with an API key: says Leanfare uses only a ChatGPT sign in, and how to change it", async () => {
    writeFileSync(join(dir, "apikey"), "");
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!card(doc)?.textContent.includes("API key"));
    expect(card(doc).textContent).toContain("Codex is signed in with an API key, which bills per use. In Terminal: codex logout, then press Connect.");
  }, 20000);
});

describe("the Plan tab", () => {
  test("a part on Codex: where it runs, its model, and its cost in your ChatGPT plan", async () => {
    await keys("openai");
    await ui(url, "/api/settings", { codexPlan: true });
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="plan"]').click();
    await waitFor(() => !!doc.querySelector("#tab-plan textarea"));
    doc.querySelector("#tab-plan textarea[aria-label='What do you want to do?']").value = "Work out why the nightly job is slow";
    doc.querySelector("#tab-plan input[aria-label='Split by rules']").checked = true;
    doc.querySelector("#planGo").click();
    await waitFor(() => !!doc.querySelector("#planResult"));
    const t = doc.querySelector("#planResult").textContent;
    expect(t).toContain("Leanfare, through Codex");
    expect(t).toContain("Codex (your ChatGPT plan)");
    expect(t).toContain("in your ChatGPT plan");
  }, 20000);
});
