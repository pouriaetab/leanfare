// Plan first in every app that lets Leanfare hook in (firsthook.ts, 0.14.1): at levels 4 and 5 the first tool call of a
// prompt that is not Leanfare's plan is turned back once with the reason, and the next goes through; Codex and Gemini
// CLI hear the level with each prompt; each app's hook file holds Leanfare's entries next to the user's own.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { denyOutput, FIRST_WORDS, firstReminder, lineOutput, promptLine } from "../src/firsthook";
import { noteSession } from "../src/sessionlog";
import { autoView, firstHookCommand, promptHookCommand, setAuto } from "../src/workers";
import { boot, reset } from "./app";

beforeAll(async () => { await boot(); });
// No plan numbers from another test file: a plan read as low raises the level these tests set (modes.ts).
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  await reset();
});
// What these tests turn on in the apps' own files is taken out again, and the apps' folders they made go too, so no
// other test file finds Gemini CLI or Cursor.
afterEach(() => {
  for (const id of ["codex", "gemini-cli", "cursor"]) { try { setAuto(id, false); } catch {} }
  for (const d of [".gemini", ".cursor"]) rmSync(join(process.env.HOME!, d), { recursive: true, force: true });
});
const T = Date.parse("2026-10-21T12:00:00Z");
let n = 0;
const sid = () => `s-first-${++n}`;
const at4 = { level: 4 }, at3 = { level: 3 }, at5 = { level: 5 };

describe("plan first", () => {
  test("at 4, the first tool call of a prompt that is not the plan is turned back once; the next goes through; a new prompt starts again", () => {
    const s = sid();
    noteSession(s, [["s", 1]], T);
    expect(firstReminder({ session_id: s, tool_name: "Read" }, "claude-code", T + 1000, at4)).toBe(FIRST_WORDS(4));
    expect(FIRST_WORDS(4)).toContain("call Leanfare's plan tool (its name ends in leanfare__plan) with your own split in parts");
    expect(firstReminder({ session_id: s, tool_name: "Read" }, "claude-code", T + 2000, at4)).toBe(null); // once a prompt
    noteSession(s, [["s", 1]], T + 3000); // the next prompt
    expect(firstReminder({ session_id: s, tool_name: "mcp__leanfare__plan" }, "claude-code", T + 4000, at4)).toBe(null); // planned first
    expect(firstReminder({ session_id: s, tool_name: "Bash" }, "claude-code", T + 5000, at4)).toBe(null);
    noteSession(s, [["s", 1]], T + 6000);
    for (const tool of ["ToolSearch", "TaskCreate", "mcp__remote-devices__leanfare__delegate", "Skill"]) expect(firstReminder({ session_id: s, tool_name: tool }, "claude-code", T + 7000, at4)).toBe(null);
    expect(firstReminder({ session_id: s, tool_name: "Grep" }, "claude-code", T + 8000, at5)).toContain("and Leanfare makes the split");
  });

  test("below 4, or with no prompt seen, nothing is turned back", () => {
    const s = sid();
    expect(firstReminder({ session_id: s, tool_name: "Read" }, "claude-code", T, at4)).toBe(null); // its prompt hook is off
    noteSession(s, [["s", 1]], T);
    expect(firstReminder({ session_id: s, tool_name: "Read" }, "claude-code", T + 1000, at3)).toBe(null);
  });

  test("each app reads its own answer: Claude Code and Codex a PreToolUse denial, Gemini CLI a decision, Cursor a permission for its agent", () => {
    expect(denyOutput("codex", "x")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x" } });
    expect(denyOutput("gemini-cli", "x")).toEqual({ decision: "deny", reason: "x" });
    expect(denyOutput("cursor", "x")).toMatchObject({ permission: "deny", agent_message: "x" });
    expect(JSON.parse(lineOutput("gemini-cli", "L"))).toEqual({ hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "L" } });
    expect(lineOutput("codex", "L")).toBe("L");
    const s = sid();
    expect(promptLine({ session_id: s }, "gemini-cli", T, at4)).toStartWith("Leanfare: level 4 (Most) in this session.");
    expect(firstReminder({ session_id: s, tool_name: "read_file" }, "gemini-cli", T + 1000, at4)).toBe(FIRST_WORDS(4)); // the prompt line noted the prompt
  });

  test("Codex, Gemini CLI and Cursor: Leanfare's hooks go in next to the user's own and come out again", () => {
    const codex = join(process.env.CODEX_HOME!, "hooks.json");
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    writeFileSync(codex, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    expect(setAuto("codex", true).on).toBe(true);
    const c = JSON.parse(readFileSync(codex, "utf8"));
    expect(c.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: promptHookCommand("codex"), timeout: 5 }] }]);
    expect(c.hooks.PreToolUse).toEqual([{ matcher: "^Bash$", hooks: [{ type: "command", command: firstHookCommand("codex"), timeout: 5 }] }]);
    expect(c.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "say done" }] }]);
    setAuto("codex", false);
    expect(JSON.parse(readFileSync(codex, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });

    const gemini = join(process.env.HOME!, ".gemini", "settings.json");
    mkdirSync(join(process.env.HOME!, ".gemini"), { recursive: true });
    writeFileSync(gemini, JSON.stringify({ mcpServers: { leanfare: { command: "leanfare", args: ["mcp"] } } }));
    expect(setAuto("gemini-cli", true).on).toBe(true);
    const g = JSON.parse(readFileSync(gemini, "utf8"));
    expect(g.mcpServers.leanfare.command).toBe("leanfare");
    expect(g.hooks.BeforeAgent[0].hooks[0]).toEqual({ type: "command", command: promptHookCommand("gemini-cli"), timeout: 5000 });
    expect(g.hooks.BeforeTool[0]).toMatchObject({ matcher: ".*", hooks: [{ type: "command", command: firstHookCommand("gemini-cli"), timeout: 5000 }] });

    const cursor = join(process.env.HOME!, ".cursor", "hooks.json");
    expect(autoView("cursor")!.on).toBe(false);
    expect(setAuto("cursor", true).on).toBe(true);
    expect(JSON.parse(readFileSync(cursor, "utf8"))).toEqual({ hooks: { beforeShellExecution: [{ command: firstHookCommand("cursor") }], beforeMCPExecution: [{ command: firstHookCommand("cursor") }] }, version: 1 });
    expect(setAuto("cursor", false).on).toBe(false);
    writeFileSync(cursor, "{ not json");
    expect(() => setAuto("cursor", true)).toThrow("does not read as JSON, so Leanfare changed nothing in it.");
  });

  test("the hook command answers Gemini CLI in its own words, end to end", async () => {
    await reset({ level: 4 });
    const s = sid();
    noteSession(s, [["s", 1]], Date.now() - 1000);
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "hook", "first", "--app", "gemini-cli"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    p.stdin.write(JSON.stringify({ session_id: s, tool_name: "read_file", tool_input: { path: "a.ts" } }));
    p.stdin.end();
    const out = await new Response(p.stdout as ReadableStream).text();
    expect(await p.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({ decision: "deny", reason: FIRST_WORDS(4) });
  }, 20000);
});

describe("the mod for Cowork and Claude Desktop", () => {
  test("puts the level in the system prompt and turns back the first tool call at 4 and 5, reading only the level", () => {
    const dir = join(import.meta.dir, "..", "mods", "leanfare-level");
    const src = readFileSync(join(dir, "hooks", "register.ts"), "utf8");
    expect(JSON.parse(readFileSync(join(dir, "hooks", "hooks.json"), "utf8"))).toEqual({ modules: ["./register.ts"] });
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("leanfare-level");
    expect(src).toContain("on('prompt.compose'");
    expect(src).toContain("on('tool.call'");
    expect(src).toContain("[['leanfare', 'level'], ['remote-devices', 'leanfare__level']]");
    expect(src).toContain("return { deny: firstWords(l.n) }");
    expect(src).toContain(".catch(($, e, next) => next(e))"); // a failed hook lets everything through
    expect(src).not.toMatch(/fetch\(|\$\.process|\$\.fs/); // it reads the level and sends nothing anywhere
  });
});
