// Your Google account through Gemini CLI (geminicli.ts, 0.14.1): found and signed in, turned on in Settings, a plan's
// part runs read only in plan mode (gemini -p, JSON out) before any paid model; working in Gemini CLI itself, its parts
// go to a lighter Gemini model; an older Gemini CLI without plan mode, or a model the account lacks, still answers.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiAnswer, geminiArgs, geminiCliFor, geminiCliState, runGeminiCli } from "../src/geminicli";
import { forgetPlans, makePlan, runView, startRun } from "../src/planner";
import { saveSettings } from "../src/settings";
import { boot, fake, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
const dir = mkdtempSync(join(tmpdir(), "lf-gem-"));
const bin = join(dir, "gemini");
const said = join(dir, "args.txt");
// A stand-in Gemini CLI: writes the arguments it got, answers in JSON; GEM_OLD refuses plan mode, GEM_NOMODEL a model.
writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" >> "${said}"
case " $* " in *" plan "*) if [ -n "$GEM_OLD" ]; then echo 'Invalid values: approval-mode plan' >&2; exit 1; fi;; esac
case " $* " in *" -m "*) if [ -n "$GEM_NOMODEL" ]; then echo 'model not found' >&2; exit 1; fi;; esac
echo '{"response": "From Gemini: the cap is read in src/cap.ts.", "stats": {}}'
`);
chmodSync(bin, 0o755);
beforeEach(async () => {
  fake.hooks.answer = null;
  forgetPlans();
  await reset({ ticked: [] }); // no model of Leanfare's: what Gemini CLI does not take stays
  process.env.LEANFARE_GEMINI_BIN = bin;
  delete process.env.GEM_OLD; delete process.env.GEM_NOMODEL;
  writeFileSync(said, "");
  mkdirSync(join(process.env.HOME!, ".gemini"), { recursive: true });
  writeFileSync(join(process.env.HOME!, ".gemini", "oauth_creds.json"), "{}");
}, 20000);
// The sign in file goes again, so no other test file finds Gemini CLI as used.
afterEach(async () => { delete process.env.LEANFARE_GEMINI_BIN; rmSync(join(process.env.HOME!, ".gemini"), { recursive: true, force: true }); await closeApp(); }, 20000);
const signal = () => new AbortController().signal;
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

describe("Gemini CLI on your Google account", () => {
  test("off until you turn it on; then a plan's reading part runs on it, read only, before anything paid", async () => {
    expect(await geminiCliFor("Claude Code")).toEqual({ ok: false, why: null, own: false });
    saveSettings({ geminiCliPlan: true });
    expect(await geminiCliState()).toEqual({ installed: true, signedIn: true, on: true });
    const r = await makePlan({ task: "Summarize the notes in this folder for the README", files: [], manager: "Claude Code", split: "rules", level: 4, signal: signal() });
    const part = r.parts.find((p) => p.where === "gemini")!;
    expect(part.model).toEqual({ id: "gemini-cli/auto", label: "Gemini CLI" });
    expect(r.table).toContain("| Leanfare, through Gemini CLI (Google's terms for a free account: people may read it) |");
    expect(r.table).toContain("in your Google account");
    startRun(r.id, { paid: true });
    await until(() => !runView(r.id)!.running);
    const done = runView(r.id)!.parts.find((p) => p.n === part.n)!;
    expect([done.status, done.answer, done.model]).toEqual(["done", "From Gemini: the cap is read in src/cap.ts.", "Gemini CLI"]);
    expect(done.receipt).toContain("read only");
    const args = readFileSync(said, "utf8").split("\n");
    expect(args).toContain("--approval-mode");
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("plan");
    expect(args).not.toContain("-m"); // Gemini CLI's own pick, for another app's part
  });

  test("working in Gemini CLI, its parts go to a lighter Gemini model; one the account lacks falls back to Gemini CLI's pick", async () => {
    saveSettings({ geminiCliPlan: true });
    expect((await geminiCliFor("Gemini CLI")).own).toBe(true);
    const light = await runGeminiCli({ n: 1, title: "Read", task: "Find the cap.", folder: null, files: [] }, signal(), { light: true });
    expect(light.model).toBe("gemini-3.8-flash");
    process.env.GEM_NOMODEL = "1";
    const back = await runGeminiCli({ n: 1, title: "Read", task: "Find the cap.", folder: null, files: [] }, signal(), { light: true });
    expect([back.model, back.answer]).toEqual([null, "From Gemini: the cap is read in src/cap.ts."]);
  });

  test("an older Gemini CLI without plan mode runs in its default mode; what it prints is read as JSON", async () => {
    process.env.GEM_OLD = "1";
    const r = await runGeminiCli({ n: 1, title: "Read", task: "Find the cap.", folder: null, files: [] }, signal());
    expect(r.answer).toBe("From Gemini: the cap is read in src/cap.ts.");
    expect(readFileSync(said, "utf8")).toContain("default");
    expect(geminiArgs("x", null)).toEqual(["-p", "x", "--output-format", "json", "--approval-mode", "plan"]);
    expect(geminiAnswer('Loaded cached credentials.\n{"response": "hi"}')).toEqual({ answer: "hi", error: null });
    expect(geminiAnswer('{"error": {"message": "Quota exceeded"}}')).toEqual({ answer: null, error: "Quota exceeded" });
  });

  test("not signed in, it says how; Settings shows a row with one switch", async () => {
    saveSettings({ geminiCliPlan: true });
    rmSync(join(process.env.HOME!, ".gemini", "oauth_creds.json"));
    expect((await geminiCliFor("Claude Code")).why).toBe("Gemini CLI is not signed in with a Google account (run gemini once in Terminal and choose Sign in with Google)");
    writeFileSync(join(process.env.HOME!, ".gemini", "oauth_creds.json"), "{}");
    saveSettings({ geminiCliPlan: false });
    expect((await ui(url, "/api/gemini-cli")).json).toEqual({ installed: true, signedIn: true, on: false });
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 200 && !doc.querySelector("#geminiCliCard button"); i++) await Bun.sleep(50);
    const row = doc.querySelector("#geminiCliCard")!;
    expect(row.querySelector(".note")!.textContent).toBe(" · signed in");
    (row.querySelector("button") as any).click();
    for (let i = 0; i < 100 && !(await ui(url, "/api/state")).json.settings.geminiCliPlan; i++) await Bun.sleep(30);
    expect((await ui(url, "/api/state")).json.settings.geminiCliPlan).toBe(true);
  }, 30000);
});
