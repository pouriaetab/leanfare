// Where Leanfare may send work for your apps (platforms.ts): each platform on or off for plans and the
// delegate, and what is left before its nearest limit: a Claude plan's windows from Claude Code's status line,
// a free Gemini key's count today, a budget, no limit on this computer.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makePlan } from "../src/planner";
import { saveSettings } from "../src/settings";
import { saveSnap } from "../src/statusline";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  for (const f of ["limits-last.json", "limits.jsonl"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true }); // no status line numbers from another test
  await reset({ ticked: ALL_TICKED });
});
const T = Date.parse("2026-10-21T12:00:00Z"); // the tests' clock
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };
const row = (v: any, id: string) => v.rows.find((r: any) => r.id === id);

describe("each platform, and what is left before its nearest limit", () => {
  test("Claude's plan from the status line, the 5 hours first; with no key Leanfare sends Claude no work", async () => {
    saveSnap({ at: T - 60_000, five: { used: 38, resets: T + 2 * 3600_000 }, week: { used: 19, resets: T + 3 * 86_400_000 } });
    const v = (await ui(url, "/api/platforms")).json;
    expect(v.rows.map((r: any) => r.id).slice(0, 5)).toEqual(["anthropic", "chatgpt", "google", "xai", "local"]);
    const c = row(v, "anthropic");
    expect(c).toMatchObject({ label: "Claude", ready: false, on: true, source: "your plan, from Claude Code's status line" });
    expect(c.windows.map((w: any) => [w.kind, w.left])).toEqual([["5 hours", 62], ["week", 81]]);
    expect(c.needs).toBe("No Anthropic key: Leanfare sends Claude's models no work, and only shows your plan's limits.");
    expect(v.lines[0]).toMatch(/^Claude \(not used: no anthropic key: leanfare sends claude's models no work, and only shows your plan's limits\): 5 hours: 62% left, resets .+ · week: 81% left, resets .+ \(your plan, from Claude Code's status line\)\.$/);
  });

  test("a free Gemini key: its requests through Leanfare today; a key paid per use: the budget; no key: what it needs", async () => {
    await keys("google");
    saveSettings({ providers: { google: { on: true, free: true } }, budget: 20 });
    const d = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(d.json.model.id.startsWith("google/")).toBe(true);
    await keys("xai");
    const v = (await ui(url, "/api/platforms")).json;
    expect(row(v, "google")).toMatchObject({ ready: true, limit: "Free key: 1 request through Leanfare today (Google sets its free limits and does not say them ahead)." });
    expect(row(v, "xai").limit).toBe("Pay per use: $20.00 of your $20.00 monthly budget left.");
    expect(row(v, "chatgpt")).toMatchObject({ ready: false, needs: "Add an OpenAI key, or let plans use Codex on your ChatGPT plan (Your ChatGPT plan, through Codex)." });
    expect(row(v, "local")).toMatchObject({ ready: false, needs: "Start Ollama (Settings, Local models)." });
  });
});

describe("a platform turned off", () => {
  test("the delegate leaves it out, and says so when nothing else could take it", async () => {
    await keys("google", "deepseek");
    expect((await ui(url, "/api/platforms", { id: "google", on: false })).json.rows.find((r: any) => r.id === "google").on).toBe(false);
    const r = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(r.json.model.id.startsWith("google/")).toBe(false);
    await ui(url, "/api/platforms", { id: "deepseek", on: false });
    const none = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(none.status).toBe(409);
    expect(none.json.error).toContain("on platforms turned off for plans and the delegate (Settings, Where Leanfare may send work)");
    await ui(url, "/api/platforms", { id: "google", on: true });
    expect((await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" })).json.model.id.startsWith("google/")).toBe(true);
  });

  test("a plan: no part goes to it, and a part nothing else can take stays with you and says why", async () => {
    await keys("google");
    await ui(url, "/api/platforms", { id: "google", on: false });
    const plan = await makePlan({ task: "Summarize the release notes and draft a short announcement", files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    for (const p of plan.parts) expect(p.model?.id?.startsWith("google/") ?? false).toBe(false);
    const stays = plan.parts.filter((p) => p.where === "you" && /turned off for plans/.test(p.why));
    expect(stays.length).toBeGreaterThan(0);
    expect(stays[0].why).toContain("the platforms that could take it are turned off for plans and the delegate (Settings, Where Leanfare may send work)");
  });

  test("only a platform it lists, and on must be true or false", async () => {
    expect((await ui(url, "/api/platforms", { id: "nosuch", on: false })).status).toBe(400);
    expect((await ui(url, "/api/platforms", { id: "google", on: "no" })).status).toBe(400);
  });
});

describe("on the screen and in the apps", () => {
  test("Settings: a row per platform with what is left, and a switch for the ones Leanfare can use", async () => {
    await keys("google");
    saveSnap({ at: T - 60_000, five: { used: 38, resets: T + 2 * 3600_000 }, week: { used: 19, resets: T + 3 * 86_400_000 } });
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#platformsSetting .prow"); i++) await Bun.sleep(50);
    const rows = [...doc.querySelectorAll("#platformsSetting .prow")] as any[];
    expect(rows.map((r) => r.querySelector(".pname").textContent).slice(0, 5)).toEqual(["Claude", "ChatGPT", "Gemini", "Grok", "On this computer"]);
    expect(rows[0].textContent).toContain("5 hours: 62% left");
    expect(rows[0].querySelector("[role=switch]")).toBeNull(); // no key: nothing to switch
    const sw = rows[2].querySelector("[role=switch]");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    sw.click();
    for (let i = 0; i < 100 && (await ui(url, "/api/platforms")).json.rows.find((r: any) => r.id === "google").on; i++) await Bun.sleep(50);
    expect((await ui(url, "/api/platforms")).json.rows.find((r: any) => r.id === "google").on).toBe(false);
    for (let i = 0; i < 100 && doc.querySelectorAll("#platformsSetting .prow")[2]?.querySelector("[role=switch]")?.getAttribute("aria-checked") !== "false"; i++) await Bun.sleep(50);
    expect(doc.querySelectorAll("#platformsSetting .prow")[2].querySelector(".hs-label").textContent).toBe("Off");
    closeApp();
  }, 20000);

  test("the spend tool lists them, with what is left", async () => {
    await keys("google");
    saveSettings({ providers: { google: { on: true, free: true } } });
    const child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" } });
    try {
      (child.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spend", arguments: {} } }) + "\n"); (child.stdin as any).flush?.();
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      while (!buf.includes("\n")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
      const r = JSON.parse(buf.slice(0, buf.indexOf("\n"))).result;
      expect(r.content[0].text).toContain("Where Leanfare may send work, and what is left before each one's nearest limit:\n- Gemini: Free key: 0 requests through Leanfare today");
      expect(r.structuredContent.platforms.find((p: any) => p.id === "google")).toMatchObject({ on: true, ready: true });
    } finally { child.kill(); }
  });
});
