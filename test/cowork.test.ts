// Cowork (0.11.2): its door gives Leanfare the name "local-agent-mode-leanfare", which Leanfare showed as it was and
// did not know as one of Claude's apps. Now it is Cowork in the report and in plans, and a Claude app: plans name
// your Claude plan and Anthropic's models for the parts that stay with you, and follow your plan's mode. Hand offs
// saved under the old name read Cowork from the next start.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, renameApps } from "../src/db";
import { clientLabel } from "../src/mcp";
import { CLAUDE_APPS, makePlan, makersOf, planFor } from "../src/planner";
import { saveSettings } from "../src/settings";
import { ALL_TICKED, boot, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); await keys("google", "deepseek"); });

describe("Cowork", () => {
  test("is named Cowork, from the name its door gives; the other apps keep theirs", () => {
    expect(clientLabel("local-agent-mode-leanfare")).toBe("Cowork");
    expect(clientLabel("local_agent_mode")).toBe("Cowork");
    expect(clientLabel("claude-ai")).toBe("Claude");
    expect(clientLabel("claude-code")).toBe("Claude Code");
    expect(clientLabel("codex-mcp-client")).toBe("Codex");
  });

  test("is one of Claude's apps: your Claude plan, and Anthropic's models", () => {
    saveSettings({ plans: { claude: { name: "Claude Max", price: 100 } } });
    expect(CLAUDE_APPS.test("Cowork")).toBe(true);
    expect(planFor("Cowork")).toBe("Claude Max");
    expect(makersOf("Cowork")).toEqual(["anthropic"]);
    expect(planFor("Cursor")).toBeNull();
  });

  test("a plan made from Cowork names your Claude plan for the parts that stay with you", async () => {
    saveSettings({ plans: { claude: { name: "Claude Max", price: 100 } } });
    const p = await makePlan({ task: "Fix the login bug in the app and add a test", files: [], manager: "Cowork", split: "rules", yourModel: "claude-opus-5-5", signal: new AbortController().signal });
    expect(p.you).toEqual({ model: "claude-opus-5-5", label: "Claude Opus 5.5", plan: "Claude Max" });
    const mine = p.table.split("\n").filter((l) => l.includes("you ("));
    expect(mine.length).toBeGreaterThan(0);
    for (const l of mine) expect(l).toContain("you (Cowork, on your Claude Max plan)");
  });

  test("hand offs saved under its old name read Cowork; others stay as they are", () => {
    const add = (app: string | null) => db.query("INSERT INTO delegations(ts, month, day, task, effort, status, app) VALUES ('2026-10-21T11:00:00.000Z', '2026-10', '2026-10-21', 'chat', 'low', 'ok', ?)").run(app);
    add("local-agent-mode-leanfare"); add("Claude Code"); add(null);
    renameApps(db);
    renameApps(db); // once more: nothing changes
    expect((db.query("SELECT app FROM delegations ORDER BY id").all() as any[]).map((r) => r.app)).toEqual(["Cowork", "Claude Code", null]);
  });
});
