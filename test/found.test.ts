// The AI apps Savings finds on this computer (found.ts): where they are, and the months they were in
// use, from the times the computer keeps, never from what is in their files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFolders, foundApps, forgetFound, hooks, mdlsDate, spotlight, usedIn } from "../src/found";

const HOME = () => process.env.HOME!;
const at = (iso: string) => new Date(iso);
function folder(path: string, mtime?: string) {
  mkdirSync(path, { recursive: true });
  if (mtime) utimesSync(path, at(mtime), at(mtime));
}
function file(path: string, mtime: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  utimesSync(path, at(mtime), at(mtime));
}
const real = hooks.spotlight;
beforeEach(() => {
  for (const d of ["Applications", "Library", ".gemini", ".grok", ".cursor", ".vscode"]) rmSync(join(HOME(), d), { recursive: true, force: true });
  forgetFound();
});
afterEach(() => { hooks.spotlight = real; forgetFound(); });

describe("apps found on this computer", () => {
  test("the tests look only in their own Applications folder", () => {
    expect(appFolders()).toEqual([join(HOME(), "Applications")]);
  });

  test("nothing there, nothing found", () => {
    expect(foundApps(true)).toEqual([]);
  });

  test("a Mac app: its months from Spotlight (added, last opened)", () => {
    folder(join(HOME(), "Applications", "Perplexity.app"));
    hooks.spotlight = () => ({ added: Date.parse("2026-03-02T10:00:00Z"), used: Date.parse("2026-10-20T09:00:00Z") });
    expect(foundApps(true)).toEqual([{ id: "perplexity-app", name: "Perplexity app", provider: "perplexity", first: "2026-03", last: "2026-10" }]);
  });

  test("a Mac app Spotlight knows only the arrival of: its own folders in ~/Library say when it was last used", () => {
    folder(join(HOME(), "Applications", "ChatGPT.app"), "2025-12-10T10:00:00Z"); // the time it was built, kept by the copy
    file(join(HOME(), "Library", "Application Support", "com.openai.chat", "prefs"), "2026-09-05T10:00:00Z");
    folder(join(HOME(), "Library", "Application Support", "com.openai.chat"), "2026-09-04T10:00:00Z"); // the folder itself, as the app left it
    hooks.spotlight = () => ({ added: Date.parse("2026-02-01T10:00:00Z"), used: null });
    expect(foundApps(true)).toEqual([{ id: "chatgpt-app", name: "ChatGPT app", provider: "chatgpt", first: "2026-02", last: "2026-09" }]);
  });

  test("nothing says when a Mac app was last used: it counts as in use until now", () => {
    folder(join(HOME(), "Applications", "Perplexity.app"), "2025-12-10T10:00:00Z");
    hooks.spotlight = () => ({ added: Date.parse("2026-03-02T10:00:00Z"), used: null });
    const [a] = foundApps(true);
    expect(a).toEqual({ id: "perplexity-app", name: "Perplexity app", provider: "perplexity", first: "2026-03", last: null });
    expect(usedIn(a, "2026-10")).toBe(true);
    expect(usedIn(a, "2026-02")).toBe(false);
  });

  test("an app's last use is never before it came", () => {
    folder(join(HOME(), "Applications", "Perplexity.app"));
    hooks.spotlight = () => ({ added: Date.parse("2026-05-02T10:00:00Z"), used: Date.parse("2026-04-20T10:00:00Z") }); // a clock that was off
    expect(foundApps(true)[0]).toMatchObject({ first: "2026-05", last: "2026-05" });
  });

  test("a support folder alone does not mean the app is here", () => {
    file(join(HOME(), "Library", "Containers", "ai.perplexity.mac", "x"), "2026-09-05T10:00:00Z");
    expect(foundApps(true)).toEqual([]);
  });

  test("command line tools and an editor's add-on: by their folders", () => {
    file(join(HOME(), ".gemini", "settings.json"), "2026-10-01T10:00:00Z");
    folder(join(HOME(), ".vscode", "extensions", "github.copilot-1.300.0"), "2026-06-01T10:00:00Z");
    folder(join(HOME(), ".vscode", "extensions", "ms-python.python-2026.1.0"), "2026-06-01T10:00:00Z");
    folder(join(HOME(), ".grok"), "2026-10-02T10:00:00Z");
    const apps = foundApps(true);
    expect(apps.map((a) => [a.id, a.provider])).toEqual([["gemini-cli", "google"], ["copilot", "copilot"], ["grok-build", "grok"]]);
    expect(apps[0].last).toBe("2026-10");
    // A folder's birth time cannot be set here (it is now), and a last use is never before the first.
    for (const a of apps) expect(a.last! >= a.first!).toBe(true);
  });

  test("an app is in use from its first month to its last, and always when the times are not known", () => {
    const a = { id: "x", name: "X", provider: "perplexity" as const, first: "2026-03", last: "2026-08" };
    expect(usedIn(a, "2026-02")).toBe(false);
    expect(usedIn(a, "2026-03")).toBe(true);
    expect(usedIn(a, "2026-08")).toBe(true);
    expect(usedIn(a, "2026-09")).toBe(false);
    expect(usedIn({ ...a, first: null, last: null }, "2020-01")).toBe(true);
  });

  test("looking again is at most every ten minutes, unless asked", () => {
    expect(foundApps()).toEqual([]);
    folder(join(HOME(), ".grok"));
    expect(foundApps()).toEqual([]); // the last look still holds
    expect(foundApps(true).map((a) => a.id)).toEqual(["grok-build"]);
  });

  test("Spotlight's dates as mdls prints them, and none off a Mac", () => {
    expect(mdlsDate("2026-03-02 10:11:12 +0000")).toBe(Date.parse("2026-03-02T10:11:12Z"));
    expect(mdlsDate("2026-03-02 10:11:12 -0530")).toBe(Date.parse("2026-03-02T15:41:12Z"));
    expect(mdlsDate("(null)")).toBeNull();
    expect(mdlsDate(undefined)).toBeNull();
    if (process.platform !== "darwin") expect(spotlight("/Applications/Perplexity.app")).toEqual({ added: null, used: null });
  });
});
