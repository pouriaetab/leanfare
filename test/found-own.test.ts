// Leanfare's own writes in an app's folders are not use of that app.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookForApps, forgetFound, hooks, usedIn } from "../src/found";
import { setApp } from "../src/apps";
import { setAuto } from "../src/workers";
import { localMonth } from "../src/util";

const HOME = () => process.env.HOME!;
const real = hooks.spotlight;
const june = new Date("2026-06-10T10:00:00Z");
beforeEach(() => {
  for (const d of ["Applications", "Library", ".gemini", ".grok", ".cursor", ".vscode"]) rmSync(join(HOME(), d), { recursive: true, force: true });
  forgetFound();
});
afterEach(() => { hooks.spotlight = real; forgetFound(); for (const d of ["Applications", ".cursor", ".gemini"]) rmSync(join(HOME(), d), { recursive: true, force: true }); });

describe("Leanfare's own writes are not use of an app", () => {
  test("Leanfare's edit of Cursor's mcp.json does not count as using Cursor", async () => {
    mkdirSync(join(HOME(), "Applications", "Cursor.app"), { recursive: true });
    hooks.spotlight = () => ({ added: Date.parse("2026-03-02T10:00:00Z"), used: june.getTime() }); // last opened in June
    mkdirSync(join(HOME(), ".cursor"), { recursive: true });
    writeFileSync(join(HOME(), ".cursor", "argv.json"), "{}");
    utimesSync(join(HOME(), ".cursor", "argv.json"), june, june);
    utimesSync(join(HOME(), ".cursor"), june, june);
    const before = (await lookForApps(true)).find((a) => a.id === "cursor")!;
    await setApp("cursor", true); // Settings, Use Leanfare in your apps: Add, for Cursor
    expect(statSync(join(HOME(), ".cursor")).mtimeMs).toBe(june.getTime()); // Leanfare's write left the folder's time as it was
    const after = (await lookForApps(true)).find((a) => a.id === "cursor")!;
    const month = localMonth(new Date()); // the real month: the file was just written
    expect(after.last).toBe(before.last);
  });

  test("Plan by itself's GEMINI.md does not count as using Gemini CLI", async () => {
    mkdirSync(join(HOME(), ".gemini"), { recursive: true });
    writeFileSync(join(HOME(), ".gemini", "settings.json"), "{}");
    utimesSync(join(HOME(), ".gemini", "settings.json"), june, june);
    utimesSync(join(HOME(), ".gemini"), june, june);
    const before = (await lookForApps(true)).find((a) => a.id === "gemini-cli")!;
    setAuto("gemini-cli", true);
    expect(statSync(join(HOME(), ".gemini")).mtimeMs).toBe(june.getTime()); // on macOS the folder's own time dates a folder like this one
    const after = (await lookForApps(true)).find((a) => a.id === "gemini-cli")!;
    setAuto("gemini-cli", false);
    expect(statSync(join(HOME(), ".gemini")).mtimeMs).toBe(june.getTime());
    expect(after.last).toBe(before.last); // what found.ts reads: Leanfare's own GEMINI.md and the folder's time do not count
  });
});
