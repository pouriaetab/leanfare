// Claude Code's read hook (readhook.ts, 0.11): before Claude Code reads a big file itself, it is reminded once that
// Leanfare's delegate can read it, so only the answer comes into its context. Plan by itself adds the hook with its
// prompt hook and a block by size in CLAUDE.md, takes them out together, and brings an older install up to date.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIG, readReminder, readsFile, remindersLately } from "../src/readhook";
import { END, START, autoView, hookCommand, readHookCommand, refreshAuto, setAuto } from "../src/workers";
import { setSwitch } from "../src/switch";
import { boot, reset } from "./app";

const dir = mkdtempSync(join(tmpdir(), "leanfare-reads-"));
const file = (name: string, kb: number) => { const p = join(dir, name); writeFileSync(p, "x".repeat(kb * 1024)); return p; };
const read = (file_path: string, more: Record<string, unknown> = {}, session = "s1") => ({ session_id: session, cwd: dir, tool_name: "Read", tool_input: { file_path, ...more } });
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR!;
let settingsFile = "";
beforeAll(async () => { await boot(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  rmSync(readsFile(), { force: true });
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true }); // plenty: the usual sizes
  rmSync(claudeDir(), { recursive: true, force: true });
  settingsFile = join(mkdtempSync(join(tmpdir(), "claude-settings-")), "settings.json");
  process.env.LEANFARE_CLAUDE_SETTINGS = settingsFile;
  await reset();
});

describe("which reads it reminds about", () => {
  test("a big log once a session: said with its size, and the second read goes through; another session is reminded again", () => {
    const log = file("app.log", 360);
    const said = readReminder(read(log))!;
    expect(said).toBe(`Leanfare: app.log is about 92k tokens (360 KB). If you need facts from it rather than to change it, hand it to Leanfare's delegate (files: ["${log}"], kind: read, and a task that says what to find): only the answer comes back, and the file stays out of your context. To read it yourself anyway, read it again: it goes through.`);
    expect(readReminder(read(log))).toBeNull();
    expect(readReminder(read("app.log", {}, "s2"))).not.toBeNull(); // a path from the session's folder
    expect(remindersLately()).toEqual({ n: 2, kb: 720 });
  });
  test("not for small files, code under 200 KB, files over Leanfare's 2 MB, images and PDFs, slices, other tools or missing files", () => {
    expect(readReminder(read(file("small.log", BIG.data / 1024 - 1)))).toBeNull();
    expect(readReminder(read(file("mid.ts", 150)))).toBeNull();
    expect(readReminder(read(file("big.ts", 250)))).not.toBeNull(); // any text file of 200 KB or more
    expect(readReminder(read(file("huge.log", 2100)))).toBeNull();
    expect(readReminder(read(file("scan.pdf", 500)))).toBeNull();
    expect(readReminder(read(file("shot.png", 500)))).toBeNull();
    const log = file("slice.log", 300);
    expect(readReminder(read(log, { limit: 200 }))).toBeNull();
    expect(readReminder(read(log, { offset: 3000 }))).toBeNull();
    expect(readReminder({ ...read(log), tool_name: "Grep" })).toBeNull();
    expect(readReminder(read(join(dir, "nothing.log")))).toBeNull();
    expect(readReminder(null)).toBeNull();
  });
  test("the hook's own command: Claude Code's JSON in, a denial with the reminder out; nothing when Leanfare is off", async () => {
    const log = file("hook.log", 64);
    const run = async () => {
      const p = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "hook", "read"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
      (p.stdin as any).write(JSON.stringify(read(log, {}, `x${Math.random()}`))); (p.stdin as any).end();
      const out = await new Response(p.stdout as ReadableStream).text();
      return [await p.exited, out] as const;
    };
    const [code, out] = await run();
    expect(code).toBe(0);
    const j = JSON.parse(out);
    expect(j.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(j.hookSpecificOutput.permissionDecisionReason).toStartWith("Leanfare: hook.log is about 16k tokens (64 KB).");
    setSwitch(false);
    try { expect(await run()).toEqual([0, ""]); } finally { setSwitch(true); }
  });
});

describe("Plan by itself in Claude Code", () => {
  test("adds the read hook with the prompt hook and the block by size; Turn off takes them all out", () => {
    const v = setAuto("claude-code", true);
    expect(v.on).toBe(true);
    const j = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(j.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: hookCommand(), timeout: 5 }] }]);
    expect(j.hooks.PreToolUse).toEqual([{ matcher: "Read", hooks: [{ type: "command", command: readHookCommand(), timeout: 5 }] }]);
    const md = readFileSync(join(claudeDir(), "CLAUDE.md"), "utf8");
    expect(md).toContain("Before you read a file you will not change that is big (a log, data, docs or notes of about 40 KB or more, any other file over about 200 KB)");
    expect(setAuto("claude-code", false).on).toBe(false);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).hooks).toBeUndefined();
  });
  test("an older install (the old block, the prompt hook only) is brought up to date at start; an app without it is left alone", () => {
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(join(claudeDir(), "CLAUDE.md"), `# Mine\n\n${START}\n## Leanfare\n\nFor a task with several parts, call Leanfare's plan tool first.\n${END}\n`);
    writeFileSync(settingsFile, JSON.stringify({ model: "opus", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(), timeout: 5 }] }] } }));
    expect(autoView("claude-code")).toMatchObject({ on: false, partly: true });
    expect(refreshAuto()).toEqual(["claude-code"]); // Codex and Gemini CLI have no block: left alone
    expect(autoView("claude-code")).toMatchObject({ on: true, partly: false });
    const md = readFileSync(join(claudeDir(), "CLAUDE.md"), "utf8");
    expect(md.startsWith("# Mine\n")).toBe(true);
    expect(md).toContain("hand the reading to Leanfare's delegate tool");
    const j = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect([j.model, j.hooks.PreToolUse[0].matcher]).toEqual(["opus", "Read"]);
    expect(refreshAuto()).toEqual(["claude-code"]); // again: nothing changes
  });
  test("Settings says how often it reminded", () => {
    setAuto("claude-code", true);
    readReminder(read(file("seen.csv", 100)));
    expect(autoView("claude-code")!.reminders).toEqual({ n: 1, kb: 100 });
  });
});
