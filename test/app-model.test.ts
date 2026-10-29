// The app's own model and plan, named (planner.ts: modelName, planFor; the plan and delegate tools' your_model):
// a plan's parts that stay with you say who runs them ("you (Claude, on your Claude Max plan)", Claude Opus 5.5)
// instead of "you" and "your model", and every hand off keeps the app it came from and the model that app runs on,
// for the report.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { checkPlan, makePlan, modelName, runView, startRun } from "../src/planner";
import { saveSettings } from "../src/settings";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); await keys("google", "deepseek"); });
const rows = () => db.query("SELECT model, app, app_model, plan FROM delegations ORDER BY id").all() as any[];
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };

describe("the model an app says it runs on", () => {
  test("named from the price list when it has it, else from the id", () => {
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelName("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelName("claude-opus-4-1-20250805")).toBe("Claude Opus 4.1");
    expect(modelName("gpt-5.4")).toBe("GPT-5.4");
    expect(modelName("google/gemini-3.8-flash")).toBe("Gemini 3.8 Flash"); // in the price list
  });

  test("a plan names it, and your plan, for the parts that stay with you", async () => {
    saveSettings({ plans: { claude: { name: "Claude Max", price: 100 } } });
    const p = await makePlan({ task: "Fix the login bug in the app and add a test", files: [], manager: "Claude", split: "rules", yourModel: "claude-opus-5-5", signal: new AbortController().signal });
    expect(p.you).toEqual({ model: "claude-opus-5-5", label: "Claude Opus 5.5", plan: "Claude Max" });
    const mine = p.table.split("\n").filter((l) => l.includes("you ("));
    expect(mine.length).toBeGreaterThan(0);
    for (const l of mine) { expect(l).toContain("you (Claude, on your Claude Max plan)"); expect(l).toContain("Claude Opus 5.5"); }
    expect(p.table).not.toContain("your model");
    expect(p.next).not.toContain("subagent"); // Claude's chats run one model: no other model is suggested for a part
  });

  test("Claude Code can run a part on another model in a subagent, so its plan still names the one to use", async () => {
    const p = await makePlan({ task: "Fix the login bug in the app and add a test", files: [], manager: "Claude Code", split: "rules", yourModel: "claude-opus-5-5", signal: new AbortController().signal });
    const mine = p.parts.filter((x) => x.where === "you");
    expect(mine.some((x) => x.use && x.use.label !== "Claude Opus 5.5")).toBe(true);
    for (const x of mine) expect(p.table.split("\n").find((l) => l.startsWith(`| ${x.n} |`))).toContain(x.use?.label ?? "Claude Opus 5.5");
  });

  test("without it, the plan says what it said before", async () => {
    const p = await makePlan({ task: "Fix the login bug in the app and add a test", files: [], manager: "Claude", split: "rules", signal: new AbortController().signal });
    expect(p.you).toEqual({ model: null, label: null, plan: null });
    expect(p.table).toContain("you (Claude)");
  });

  test("only a short name", () => {
    expect(checkPlan({ task: "x", your_model: 5 })).toBe("your_model must be a model's name, like claude-opus-5-5.");
    expect(checkPlan({ task: "x", your_model: "y".repeat(81) })).toBe("your_model must be a model's name, like claude-opus-5-5.");
    expect(checkPlan({ task: "x", your_model: " claude-opus-5-5 " })).toMatchObject({ yourModel: "claude-opus-5-5" });
  });
});

describe("each hand off keeps the app and its model", () => {
  test("a hand off: from the app that asked, with the model it said", async () => {
    const r = await ui(url, "/api/delegate", { task: "List the errors.", files: [LOG], kind: "read", effort: "low", check: "never", app: "Claude", your_model: "claude-opus-5-5" });
    expect(r.status).toBe(200);
    expect(rows().at(-1)).toMatchObject({ app: "Claude", app_model: "claude-opus-5-5", plan: null });
    expect((await ui(url, "/api/delegate", { task: "x", files: [], app: { name: "Claude" } })).status).toBe(400);
  });

  test("a plan's parts: the plan's app and model", async () => {
    const p = await makePlan({ task: "Summarize the release notes and draft a short announcement", files: [], manager: "Claude Code", split: "rules", yourModel: "claude-sonnet-4-6", signal: new AbortController().signal });
    startRun(p.id, { paid: true }); // Gemini on a key paid per use here: the yes is given
    for (let i = 0; i < 200 && runView(p.id)?.running; i++) await Bun.sleep(25);
    const ran = rows().filter((r) => r.plan?.startsWith(p.id + ":"));
    expect(ran.length).toBeGreaterThan(0);
    for (const r of ran) expect(r).toMatchObject({ app: "Claude Code", app_model: "claude-sonnet-4-6" });
  });
});
