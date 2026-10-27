// Your ChatGPT plan through Codex, on the screens: Settings says whether Codex is there and signed in and
// has the switch (off until you turn it on); the Plan tab shows a part on Codex as such.
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
  writeFileSync(join(dir, "codex"), `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.159.0" ;; login) [ -f "${dir}/signed-out" ] && exit 1; echo ok ;; *) exit 2 ;; esac\n`);
  chmodSync(join(dir, "codex"), 0o755);
});
afterAll(() => { if (was === undefined) delete process.env.LEANFARE_CODEX_BIN; else process.env.LEANFARE_CODEX_BIN = was; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { forgetCodex(); await reset({ ticked: ALL_TICKED }); process.env.LEANFARE_CODEX_BIN = join(dir, "codex"); rmSync(join(dir, "signed-out"), { force: true }); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const card = (doc: any) => doc.querySelector("#codexCard");

describe("Settings: your ChatGPT plan, through Codex", () => {
  test("says Codex is here and signed in, and the switch turns plans' use of it on and off", async () => {
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!card(doc)?.textContent.includes("signed in"));
    expect(card(doc).textContent).toContain("Your ChatGPT plan, through Codex");
    expect(card(doc).textContent).toContain("Codex 0.159.0 is here and signed in.");
    expect(card(doc).textContent).toContain("they count toward your ChatGPT plan's Codex limits");
    const box = card(doc).querySelector("input[type=checkbox]");
    expect(box.checked).toBe(false); // off until you turn it on
    box.checked = true; box.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => settings().codexPlan === true);
    expect(settings().codexPlan).toBe(true);
  }, 20000);
  test("signed out, or not on this computer: says what to run", async () => {
    writeFileSync(join(dir, "signed-out"), "");
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!card(doc)?.textContent.includes("not signed in"));
    expect(card(doc).textContent).toContain("Codex 0.159.0 is here, but not signed in. In Terminal: codex login (sign in with ChatGPT).");
    process.env.LEANFARE_CODEX_BIN = "";
    [...card(doc).querySelectorAll("button")].find((b: any) => b.textContent === "Look again").click();
    await waitFor(() => !!card(doc)?.textContent.includes("not on this computer"));
    expect(card(doc).textContent).toContain("Codex is not on this computer. To get it, in Terminal: npm install -g @openai/codex, then codex login (sign in with ChatGPT).");
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
