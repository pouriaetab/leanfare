// 0.12, the level: one number from 1 to 5 for how much Leanfare takes first. Which one is in effect (a chat's or
// session's own, an app's, the default, raised as a Claude plan runs low), what each says, Settings, the level tool and
// leanfare level, the rows that keep it, the checks it asks for, the plans it sends out, and Claude Code's hooks.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { draw } from "../src/delegate";
import { appKey, levelAdvice, levelFor, LEVEL_READ } from "../src/level";
import { runToolFor } from "../src/mcp";
import type { ModeView } from "../src/modes";
import { makePlan } from "../src/planner";
import { readReminder, readsFile } from "../src/readhook";
import { noteHandoffs } from "../src/reviewhook";
import { sessionFile } from "../src/sessionlog";
import { DEFAULTS, JOB_DEFAULTS, saveSettings, settings } from "../src/settings";
import { hookLine, saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";

const T = (iso: string) => Date.parse(iso);
const DATA = () => process.env.LEANFARE_DATA_DIR!;
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(DATA(), f), { force: true }); // plenty
  rmSync(sessionFile(), { force: true });
  rmSync(readsFile(), { force: true });
  await reset({ ticked: ALL_TICKED });
  draw.next = () => 0.5;
});
afterEach(() => { draw.next = () => Math.random(); });

const mode = (m: ModeView["mode"], why = "your Claude plan is running low: the week 74% used"): ModeView => ({ mode: m, why, five: null, week: 74, runsOut: null, resets: null, at: null });

describe("which level is in effect", () => {
  test("a chat's own first, then the app's, then the default; 3 when nothing says", () => {
    expect(DEFAULTS.level).toBe(3);
    expect(levelFor({}, "Claude").level).toBe(3);
    const s = { level: 2, levels: { codex: 4, claude: 5 } };
    expect(levelFor(s, "Codex")).toEqual({ level: 4, base: 4, from: "app", raised: null });
    expect(levelFor(s, "Cowork")).toMatchObject({ level: 5, from: "app" }); // Claude Desktop and Cowork share one
    expect(levelFor(s, "Cursor")).toMatchObject({ level: 2, from: "default" });
    expect(levelFor(s, "Codex", 1)).toEqual({ level: 1, base: 1, from: "chat", raised: null });
    expect([appKey("Claude Code"), appKey("Claude"), appKey("Gemini CLI"), appKey("Windsurf"), appKey(null)]).toEqual(["claude-code", "claude", "gemini-cli", null, null]);
  });

  test("raised as a Claude plan runs low (4, then 5), never past a chat's own, never for another company's app, and not when turned off", () => {
    expect(levelFor({ level: 2 }, "Claude Code", null, mode("low"))).toEqual({ level: 4, base: 2, from: "default", raised: "raised from 2: your Claude plan is running low: the week 74% used" });
    expect(levelFor({ level: 2 }, "Claude Code", null, mode("very low", "your Claude plan is very low: the week 93% used")).level).toBe(5);
    expect(levelFor({ level: 5 }, "Claude", null, mode("low")).raised).toBeNull(); // already above
    expect(levelFor({ level: 2 }, "Claude Code", 2, mode("very low")).level).toBe(2); // the chat set it
    expect(levelFor({ level: 2 }, "Codex", null, mode("very low")).level).toBe(2); // not a Claude plan
    expect(levelFor({ level: 2, raiseWhenLow: false }, "Claude Code", null, mode("very low")).level).toBe(2);
  });

  test("what the app is told at 1 and 3, and when raised", () => {
    expect(levelAdvice({ level: 1, base: 1, from: "chat", raised: null }, "chat")).toBe("Leanfare: level 1 (Off) in this chat. Use Leanfare only when the user asks for it.");
    expect(levelAdvice({ level: 3, base: 3, from: "default", raised: null }, "session")).toBe("Leanfare: level 3 (More) in this session. Hand reading over about 10 KB that you will not change, project wide searches, summaries, reviews and first drafts to Leanfare first (delegate, or plan for several parts); keep decisions, changes to files and the final answer. Pass level 3 to delegate and plan.");
    expect(levelAdvice(levelFor({ level: 3 }, "Claude Code", null, mode("low")), "session")).toStartWith("Leanfare: level 4 (Most) in this session (raised from 3: your Claude plan is running low: the week 74% used). Call Leanfare's plan tool first");
  });
});

describe("Settings, the level tool and leanfare level", () => {
  test("Settings checks what it keeps; an app's level goes back to the default with null", async () => {
    expect((await ui(url, "/api/settings", { level: 6 })).status).toBe(400);
    expect((await ui(url, "/api/settings", { level: 2.5 })).status).toBe(400);
    expect((await ui(url, "/api/settings", { levels: { windsurf: 3 } })).status).toBe(400);
    expect((await ui(url, "/api/settings", { levels: { codex: 9 } })).status).toBe(400);
    expect((await ui(url, "/api/settings", { level: 4, levels: { codex: 1, claude: 5 }, raiseWhenLow: false, askEachChat: true })).status).toBe(200);
    expect(settings()).toMatchObject({ level: 4, levels: { codex: 1, claude: 5 }, raiseWhenLow: false, askEachChat: true });
    await ui(url, "/api/settings", { levels: { codex: null } });
    expect(settings().levels).toEqual({ claude: 5 });
  });

  test("the level tool: learns the level, sets it for this chat (kept in the chat only), for the app, or as the default", async () => {
    const ctx = { client: "Claude", cwd: DATA(), canAsk: false };
    const call = (args: any) => runToolFor(ctx, "level", args, new AbortController().signal);
    const now = await call({});
    expect(now.content[0].text).toStartWith("Leanfare: level 2 (Light) in this chat. Hand big reads");
    expect(now.content[0].text).toEndWith("The levels: 1 Off, 2 Light, 3 More, 4 Most, 5 All it can.");
    const chat = await call({ set: 4 });
    expect(chat.content[0].text).toContain("Leanfare: level 4 (Most) in this chat.");
    expect(chat.content[0].text).toContain("Set for this chat only: follow it until the user changes it. Leanfare's default stays 2 (Light).");
    expect(chat.structuredContent).toMatchObject({ level: 4, name: "Most", from: "chat", default: 2 });
    // Some apps read only the structured part (Cowork does): what to do at this level is there too.
    expect(chat.structuredContent.advice).toStartWith("Leanfare: level 4 (Most) in this chat. Call Leanfare's plan tool first");
    expect(chat.structuredContent.note).toContain("Set for this chat only");
    expect(settings().level).toBe(2); // nothing kept
    const app = await call({ set: 5, scope: "app" });
    expect(app.content[0].text).toContain("Kept for Claude from now on");
    expect(settings().levels).toEqual({ claude: 5 });
    await call({ set: 1, scope: "default" });
    expect(settings().level).toBe(1);
    expect((await call({ set: 7 })).isError).toBe(true);
    expect((await call({ set: 3, scope: "everywhere" })).isError).toBe(true);
    const other = await runToolFor({ client: "Windsurf", cwd: DATA(), canAsk: false }, "level", { set: 3, scope: "app" }, new AbortController().signal);
    expect(other.content[0].text).toContain("A level can be kept for Claude Code, Claude Desktop and Cowork, Codex, Gemini CLI and Cursor, and this app is Windsurf.");
    saveSettings({ askEachChat: true });
    expect((await call({})).content[0].text).toContain("Ask the user which level they want for this chat");
  });

  test("leanfare level shows and sets the default and an app's", async () => {
    const run = async (...a: string[]) => {
      const p = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "level", ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" } });
      return { out: await new Response(p.stdout as ReadableStream).text(), err: await new Response(p.stderr as ReadableStream).text(), code: await p.exited };
    };
    const a = await run();
    expect(a.out).toStartWith("Leanfare's level: 2 (Light).");
    expect(a.out).toContain("  Codex: the default");
    const b = await run("4", "--app", "codex");
    expect(b.out).toContain("  Codex: 4 (Most)");
    const c = await run("5");
    expect(c.out).toStartWith("Leanfare's level: 5 (All it can).");
    const d = await run("3", "--app", "windsurf");
    expect(d.code).toBe(2);
    expect(d.err).toContain("--app takes one of: claude-code, claude, codex, gemini-cli, cursor.");
  });
});

describe("what a level changes in Leanfare", () => {
  const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };
  test("each hand off keeps the level it ran at, and higher levels check more answers", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    const d2 = await ui(url, "/api/delegate", { task: "Find the errors.", files: [LOG], kind: "read", effort: "medium" });
    expect(d2.json.check.chance).toBe(0.25);
    saveSettings({ level: 3 });
    const d3 = await ui(url, "/api/delegate", { task: "Find the errors.", files: [LOG], kind: "read", effort: "medium" });
    expect(d3.json.check.chance).toBe(0.5);
    const d5 = await ui(url, "/api/delegate", { task: "Find the errors.", files: [LOG], kind: "read", effort: "low", level: 5 });
    expect(d5.json.check).toMatchObject({ chance: 1, picked: true });
    expect((await ui(url, "/api/delegate", { task: "x", level: 9 })).status).toBe(400);
    const rows = db.query("SELECT level FROM delegations ORDER BY id").all() as { level: number }[];
    expect(rows.map((r) => r.level)).toEqual([2, 3, 5]);
  });

  test("a plan at 4 sends out what your rules send out only when the plan runs low; at 5 also what they keep with your app", async () => {
    await reset({ ticked: ALL_TICKED, jobs: JOB_DEFAULTS });
    await keys("openai", "google", "deepseek", "anthropic");
    const task = "Write a short guide for the settings screen: work out what each setting does, then draft it.";
    const plan = (level?: 2 | 4 | 5) => makePlan({ task, files: [], manager: "Claude Code", split: "rules", ...(level ? { level } : {}), signal: new AbortController().signal });
    const placeOf = (r: any, kind: string) => r.parts.filter((p: any) => p.kind === kind).map((p: any) => (p.where === "you" ? "you" : "out"))[0];
    const at2 = await plan(2);
    expect([placeOf(at2, "write"), placeOf(at2, "reason"), at2.level]).toEqual(["you", "you", 2]);
    const at4 = await plan(4);
    expect([placeOf(at4, "write"), placeOf(at4, "reason")]).toEqual(["out", "you"]);
    expect(at4.parts.find((p: any) => p.kind === "write")!.why).not.toContain("near its limit");
    const at5 = await plan(5);
    expect([placeOf(at5, "write"), placeOf(at5, "reason")]).toEqual(["out", "out"]);
  });
});

describe("Claude Code's hooks follow the session's level", () => {
  const at = T("2026-10-21T12:00:00Z");
  const setLevel = (session: string, set: number) => noteHandoffs({ session_id: session, tool_name: "mcp__leanfare__level", tool_input: { set }, tool_response: { structuredContent: { level: set } } }, at);

  test("the prompt hook says the session's level once the level tool set one; a chat's level is not raised", () => {
    saveSnap({ at: at - 60_000, five: null, week: { used: 74, resets: at + 3 * 86_400_000 } });
    expect(hookLine(at, { session_id: "s-a" })).toStartWith("Leanfare: level 4 (Most) in this session (raised from 2:");
    setLevel("s-a", 1);
    expect(hookLine(at, { session_id: "s-a" })).toBe("Leanfare: level 1 (Off) in this session. Use Leanfare only when the user asks for it. The Claude plan: its week 74% used.");
    noteHandoffs({ session_id: "s-a", tool_name: "mcp__leanfare__level", tool_input: { set: 5, scope: "default" } }, at); // not this session's
    expect(hookLine(at, { session_id: "s-a" })).toStartWith("Leanfare: level 1 (Off)");
    expect(hookLine(at, { session_id: "s-b" })).toStartWith("Leanfare: level 4 (Most)"); // another session: the default, raised
  });

  test("asked at the start of each new chat: only on the session's first prompt, and not once it has a level", () => {
    saveSettings({ askEachChat: true });
    const ask = "Ask the user which Leanfare level to use for this session";
    expect(hookLine(at, { session_id: "s-c" })).toContain(ask);
    expect(hookLine(at + 1000, { session_id: "s-c" })).not.toContain(ask);
    setLevel("s-d", 3);
    expect(hookLine(at, { session_id: "s-d" })).not.toContain(ask);
  });

  test("the read hook reminds sooner at higher levels, and never at 1", () => {
    const dir = DATA();
    const file = (name: string, kb: number) => { const p = join(dir, name); writeFileSync(p, "x".repeat(kb * 1024)); return p; };
    const read = (p: string, session: string) => ({ session_id: session, cwd: dir, tool_name: "Read", tool_input: { file_path: p } });
    const log12 = file("twelve.log", 12), log5 = file("five.log", 5);
    expect(LEVEL_READ[3]).toEqual({ data: 10 * 1024, other: 50 * 1024 });
    expect(readReminder(read(log12, "r-1"), at)).toBeNull(); // 2 (Light): 40 KB
    setLevel("r-2", 3);
    expect(readReminder(read(log12, "r-2"), at)).toContain("twelve.log is about 3k tokens (12 KB)");
    expect(readReminder(read(log5, "r-2"), at)).toBeNull();
    setLevel("r-3", 5);
    expect(readReminder(read(log5, "r-3"), at)).not.toBeNull();
    setLevel("r-4", 1);
    expect(readReminder(read(file("big.log", 300), "r-4"), at)).toBeNull();
  });
});
