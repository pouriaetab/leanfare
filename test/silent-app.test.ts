// When Claude Code hands nothing off (silentapp.ts, 0.13.8): its own files show its prompts, so Leanfare says why none
// came: its line never reached Claude Code, Claude Code never opened Leanfare's tools, or it had both and still handed
// nothing off. The prompt hook notes each prompt it reaches; the MCP door says which app opened it.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, putSetting } from "../src/db";
import { forgetLogs } from "../src/plans";
import { heardSessions, noteSession, sessionFile } from "../src/sessionlog";
import { forgetSilent, noteDoor, silentCheck, silentNotice, silentNow } from "../src/silentapp";
import { hookLine } from "../src/statusline";
import { boot, reset, ui } from "./app";

const DAY = 86_400_000, AT = Date.parse("2026-10-24T12:00:00Z");
let url = "";
beforeAll(async () => { url = (await boot()).url; });
const root = () => process.env.CLAUDE_CONFIG_DIR!;
const user = (ts: number, text: string) => ({ type: "user", timestamp: new Date(ts).toISOString(), cwd: "/Users/you/app", message: { role: "user", content: text } });
function session(name: string, n: number, start: number) {
  const path = join(root(), "projects", "-Users-you-app", `${name}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Array.from({ length: n }, (_, i) => JSON.stringify(user(start + i * 60_000, `Prompt ${i}`))).join("\n") + "\n");
}
beforeEach(async () => {
  rmSync(root(), { recursive: true, force: true });
  rmSync(sessionFile(), { force: true });
  await reset();
  forgetLogs(); forgetSilent();
  db.query("DELETE FROM doors").run();
  db.query("DELETE FROM delegations").run();
  putSetting("silentSince", AT - 3 * DAY);
  putSetting("silentHidden", null);
  session("s-one", 8, AT - 2 * DAY);
  session("s-two", 6, AT - DAY);
});

describe("why Claude Code handed nothing off", () => {
  test("its line never reached Claude Code", async () => {
    const s = await silentCheck(AT);
    expect([s?.why, s?.prompts, s?.sessions, s?.heard]).toEqual(["line", 14, 2, 0]);
    expect(s?.text).toStartWith("Claude Code ran 14 prompts in the last 3 days and handed nothing to Leanfare: Leanfare's line never reached it, so it was never told the level.");
  });
  test("it heard the level but never opened Leanfare's tools", async () => {
    noteSession("s-one", [["s", 1]], AT - 2 * DAY + 1000);
    const s = await silentCheck(AT);
    expect(s?.why).toBe("tools");
    expect(s?.text).toContain("it heard the level in 1 of its 2 sessions but never opened Leanfare's tools. In Claude Code, type /mcp");
  });
  test("it had both and still handed nothing off", async () => {
    noteSession("s-two", [["s", 1]], AT - DAY + 1000);
    noteDoor("Claude Code", new Date(AT - 3_600_000));
    const s = await silentCheck(AT);
    expect(s?.why).toBe("chose");
    expect(s?.text).toContain("heard the level and had Leanfare's tools, but handed nothing off");
  });
  test("quiet once it hands something off, before a day has passed, and under 10 prompts", async () => {
    db.query("INSERT INTO delegations(ts, month, day, task, kind, effort, model, cost, status, app) VALUES (?, '2026-10', '2026-10-24', 'longer_query', 'read', 'low', 'google/gemini-3.8-flash', 0, 'ok', 'Claude Code')").run(new Date(AT - 3_600_000).toISOString());
    expect(await silentCheck(AT)).toBe(null);
    db.query("DELETE FROM delegations").run();
    putSetting("silentSince", AT - 3_600_000);
    expect(await silentCheck(AT)).toBe(null);
    putSetting("silentSince", AT - 3 * DAY);
    rmSync(join(root(), "projects", "-Users-you-app", "s-two.jsonl"));
    forgetLogs();
    expect(await silentCheck(AT)).toBe(null);
  });
});

describe("what it counts", () => {
  test("the prompt hook notes each prompt it reaches", () => {
    hookLine(AT, { session_id: "s-hook" }, {});
    expect(heardSessions(AT - 1000).has("s-hook")).toBe(true);
    expect(heardSessions(AT + 1000).has("s-hook")).toBe(false);
  });
  test("the door's hello is noted, and the notice has a × that hides it until it changes", async () => {
    expect((await ui(url, "/api/mcp/hello", { client: "Claude Code" })).json.ok).toBe(true);
    expect((db.query("SELECT opens FROM doors WHERE app = 'Claude Code'").get() as { opens: number }).opens).toBe(1);
    await silentNow(AT);
    expect(silentNotice(AT)).toMatchObject({ kind: "silent", level: "info", provider: "Claude Code" });
    expect((await ui(url, "/api/notices/hide", { provider: "Claude Code", kind: "silent" })).json.ok).toBe(true);
    expect(silentNotice(AT)).toBe(null);
  });
});
