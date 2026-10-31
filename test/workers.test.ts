// Plan by itself (workers.ts): the line in CLAUDE.md, AGENTS.md and GEMINI.md, Claude Code's worker
// subagent and its prompt hook, each added and taken out without touching anything else.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END, START, WORKER, autoView, hookCommand, setAuto, stopHookCommand, withBlock } from "../src/workers";
import { hookLine, saveSnap } from "../src/statusline";
import { boot, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR!;
let settingsFile = "";
beforeEach(async () => {
  rmSync(claudeDir(), { recursive: true, force: true });
  rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
  rmSync(join(process.env.HOME!, ".gemini"), { recursive: true, force: true });
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  settingsFile = join(mkdtempSync(join(tmpdir(), "claude-settings-")), "settings.json");
  process.env.LEANFARE_CLAUDE_SETTINGS = settingsFile;
  await reset();
});

describe("the block in a markdown file", () => {
  test("added at the end, put in place of an old one, and taken out leaving the rest as it was", () => {
    expect(withBlock("", "x")).toBe(`${START}\nx\n${END}\n`);
    const mine = "# My rules\n\nUse tabs.\n";
    const once = withBlock(mine, "Plan first.");
    expect(once).toBe(`# My rules\n\nUse tabs.\n\n${START}\nPlan first.\n${END}\n`);
    expect(withBlock(once, "Plan first, always.")).toBe(`# My rules\n\nUse tabs.\n\n${START}\nPlan first, always.\n${END}\n`);
    expect(withBlock(once, null)).toBe(mine);
    const middle = `# A\n\n${START}\nold\n${END}\n\n# B\n`;
    expect(withBlock(middle, null)).toBe("# A\n\n# B\n");
    expect(withBlock(mine, null)).toBe(mine);
  });
});

describe("Claude Code plans by itself", () => {
  test("on: the worker, the line in CLAUDE.md and the prompt hook; the user's own settings, hooks and rules stay", () => {
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(join(claudeDir(), "CLAUDE.md"), "# Mine\n\nBe brief.\n");
    const theirs = { model: "opus", statusLine: { type: "command", command: "my-line" }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-hook.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }] } };
    writeFileSync(settingsFile, JSON.stringify(theirs));
    expect(autoView("claude-code")!.on).toBe(false);
    expect(setAuto("claude-code", true).on).toBe(true);
    expect(readFileSync(join(claudeDir(), "agents", "leanfare-worker.md"), "utf8")).toBe(WORKER);
    expect(WORKER).toContain("tools: mcp__leanfare__delegate, mcp__leanfare__ask, mcp__leanfare__plan_status");
    expect(WORKER).toContain("model: haiku");
    const md = readFileSync(join(claudeDir(), "CLAUDE.md"), "utf8");
    expect(md.startsWith("# Mine\n\nBe brief.\n\n" + START)).toBe(true);
    expect(md).toContain("call Leanfare's plan tool first");
    const j = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(j.model).toBe("opus");
    expect(j.statusLine).toEqual(theirs.statusLine);
    expect(j.hooks.Stop[0]).toEqual(theirs.hooks.Stop[0]); // theirs first, then Leanfare's stop hook (0.12)
    expect(j.hooks.Stop[1]).toEqual({ hooks: [{ type: "command", command: stopHookCommand(), timeout: 10 }] });
    expect(j.hooks.UserPromptSubmit[0]).toEqual(theirs.hooks.UserPromptSubmit[0]);
    expect(j.hooks.UserPromptSubmit[1]).toEqual({ hooks: [{ type: "command", command: hookCommand(), timeout: 5 }] });
    expect(existsSync(settingsFile + ".leanfare-backup")).toBe(true);
    setAuto("claude-code", true); // twice: still one entry
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).hooks.UserPromptSubmit.length).toBe(2);
    // off: only Leanfare's own goes
    expect(setAuto("claude-code", false).on).toBe(false);
    expect(existsSync(join(claudeDir(), "agents", "leanfare-worker.md"))).toBe(false);
    expect(readFileSync(join(claudeDir(), "CLAUDE.md"), "utf8")).toBe("# Mine\n\nBe brief.\n");
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual(theirs);
  });

  test("a settings file that is not valid JSON stops it before anything changes, and a worker file of the user's is never written over", () => {
    writeFileSync(settingsFile, "{ not json");
    expect(() => setAuto("claude-code", true)).toThrow("not a valid settings file");
    expect(existsSync(join(claudeDir(), "CLAUDE.md"))).toBe(false);
    writeFileSync(settingsFile, "{}");
    mkdirSync(join(claudeDir(), "agents"), { recursive: true });
    writeFileSync(join(claudeDir(), "agents", "leanfare-worker.md"), "my own agent");
    expect(() => setAuto("claude-code", true)).toThrow("is not Leanfare's");
    expect(readFileSync(join(claudeDir(), "agents", "leanfare-worker.md"), "utf8")).toBe("my own agent");
    expect(readFileSync(settingsFile, "utf8")).toBe("{}");
  });

  test("the hook's line: the plan's windows as numbers, and the plan tool; running low it says what to hand off", () => {
    const T = (iso: string) => Date.parse(iso);
    expect(hookLine()).toBe("Leanfare: Leanfare's plan tool splits a task with several parts across cheaper models, and its delegate reads big files you will not change.");
    saveSnap({ at: T("2026-10-21T11:00:00Z"), five: { used: 48.4, resets: T("2026-10-21T15:00:00Z") }, week: { used: 21, resets: T("2026-10-27T12:00:00Z") } });
    expect(hookLine()).toBe("Leanfare: the Claude plan: its 5 hour window is 48% used, its week 21% used. Leanfare's plan tool splits a task with several parts across cheaper models, and its delegate reads big files you will not change.");
    saveSnap({ at: T("2026-10-21T11:30:00Z"), five: { used: 91, resets: T("2026-10-21T15:00:00Z") }, week: { used: 22, resets: T("2026-10-27T12:00:00Z") } });
    expect(hookLine()).toStartWith("Leanfare: your Claude plan is very low: the 5 hours 91% used, the week 22% used. Hand everything you can to Leanfare");
  });

  test("leanfare hook prompt prints the line, reads nothing of the prompt, and always exits 0", async () => {
    const p = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "hook", "prompt"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    (p.stdin as any).write(JSON.stringify({ prompt: "SECRET PROMPT TEXT", session_id: "s" }));
    (p.stdin as any).end();
    const out = await new Response(p.stdout as ReadableStream).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain("Leanfare's plan tool");
    expect(out).not.toContain("SECRET");
  });
});

describe("Codex and Gemini CLI plan by themselves", () => {
  test("a block in AGENTS.md and in GEMINI.md, in and out", () => {
    expect(setAuto("codex", true).on).toBe(true);
    expect(readFileSync(join(process.env.CODEX_HOME!, "AGENTS.md"), "utf8")).toContain("call Leanfare's plan tool first");
    expect(readFileSync(join(process.env.CODEX_HOME!, "AGENTS.md"), "utf8")).not.toContain("leanfare-worker"); // Codex has no worker of Leanfare's
    expect(setAuto("gemini-cli", true).on).toBe(true);
    expect(readFileSync(join(process.env.HOME!, ".gemini", "GEMINI.md"), "utf8")).toContain(START);
    expect(setAuto("codex", false).on).toBe(false);
    expect(readFileSync(join(process.env.CODEX_HOME!, "AGENTS.md"), "utf8")).toBe("");
    expect(() => setAuto("cursor", true)).toThrow("cannot plan by itself");
  });

  test("the screen's address: In your apps shows it per app and turns it on and off", async () => {
    const r = await ui(url, "/api/apps", { id: "codex", auto: true });
    expect(r.status).toBe(200);
    expect(r.json.apps.find((a: any) => a.id === "codex").auto).toMatchObject({ on: true });
    expect(r.json.apps.find((a: any) => a.id === "cursor").auto).toBeNull();
    const off = await ui(url, "/api/apps", { id: "codex", auto: false });
    expect(off.json.apps.find((a: any) => a.id === "codex").auto.on).toBe(false);
  });
});
