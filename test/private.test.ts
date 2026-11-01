// Free tiers marked, and private work kept on this computer (platforms.ts: readRisk, mayTake): a free Gemini key is
// marked "people may read it" in Settings, in a plan and in a receipt; your projects' files go where Settings says;
// a task or plan an app marks private goes only to models on this computer.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { makePlan, tableOf } from "../src/planner";
import { saveSettings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };
const freeGemini = async () => { await keys("google"); saveSettings({ providers: { google: { on: true, free: true } } }); };
const local = async () => { await ui(url, "/api/refresh", { what: "ollama" }); saveSettings({ ticked: [...ALL_TICKED, "ollama/llama3.2:latest"] }); };

describe("a free tier is marked", () => {
  test("Settings: Gemini on a free key, with why", async () => {
    await freeGemini();
    const g = (await ui(url, "/api/platforms")).json.rows.find((r: any) => r.id === "google");
    expect(g.risk).toBe("people may read it");
    expect(g.riskWhy).toContain("Google's terms for a free Gemini key: people may read what is sent");
    await keys("deepseek");
    const d = (await ui(url, "/api/platforms")).json.rows.find((r: any) => r.id === "deepseek");
    expect(d.risk).toBeNull();
  });

  test("a hand off's receipt, and a plan's part on it", async () => {
    await freeGemini();
    const r = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(r.json.model.id.startsWith("google/")).toBe(true);
    expect(r.json.receipt).toContain("is on a free tier: people may read it. For anything private, ask Leanfare to keep it on this computer.");
    const plan = await makePlan({ task: "Summarize the release notes and draft a short announcement", files: [], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    const out = plan.parts.filter((p) => p.where !== "you");
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) expect(p.risk).toBe("people may read it");
    expect(plan.table).toContain("Leanfare, free model (people may read it)");
    expect(plan.table).toContain("Parts on a free tier: people may read it. For anything private, plan it with private: it stays on this computer.");
  });
});

describe("where your projects' files go", () => {
  test("not to a free tier: files skip the free key, work with no files may still use it", async () => {
    await freeGemini();
    await keys("deepseek");
    await ui(url, "/api/settings", { filesTo: "notFree" });
    const withFiles = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(withFiles.json.model.id.startsWith("google/")).toBe(false);
    const none = await ui(url, "/api/delegate", { task: "Write a haiku about logs.", files: [], kind: "write", effort: "low", check: "never" });
    expect(none.status).toBe(200);
  });

  test("only this computer (since 0.12 all work, not only files): with no model here, the hand off says so and sends nothing", async () => {
    await freeGemini();
    await ui(url, "/api/settings", { filesTo: "local" });
    const before = fake.seen.length;
    const r = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("Work goes only to this computer (Settings, Where Leanfare may send work), and no model there can take this.");
    expect(fake.seen.length).toBe(before);
    expect((await ui(url, "/api/settings", { filesTo: "nowhere" })).status).toBe(400);
  });
});

describe("private work stays on this computer", () => {
  test("a private hand off: a model here takes it, the check too; with none here, nothing is sent", async () => {
    await freeGemini();
    const before = fake.seen.length;
    const none = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never", private: true });
    expect(none.status).toBe(409);
    expect(none.json.error).toContain("This task is to stay on this computer, and none of your models here can take it.");
    expect(fake.seen.length).toBe(before);
    await local();
    const r = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "always", private: true });
    expect(r.status).toBe(200);
    expect(r.json.model.id).toBe("ollama/llama3.2:latest");
    expect(r.json.check.checker).toBeNull(); // no stronger model here: nothing leaves to check it
    expect(fake.seen.filter((s) => s.path.includes("/chat/completions") || s.path.includes("/api/chat")).every((s) => s.path.startsWith("/ollama"))).toBe(true);
    expect((await ui(url, "/api/delegate", { task: "x", files: [], private: "yes" })).status).toBe(400);
  });

  test("a private plan: split by rules (no model here), its parts here or with you, and it says so", async () => {
    await freeGemini();
    await local();
    const plan = await makePlan({ task: "Summarize the release notes and draft a short announcement", files: [], manager: "Claude Code", private: true, signal: new AbortController().signal });
    expect(plan.private).toBe(true);
    for (const p of plan.parts) expect(["local", "you"]).toContain(p.where);
    expect(plan.table).toContain("This plan stays on this computer.");
    expect(fake.seen.some((s) => s.path.startsWith("/google"))).toBe(false); // the task never went to Gemini, not even to split it
  });
});

describe("on the screen", () => {
  test("Settings: the mark with its reasons folded, and the files choice", async () => {
    await freeGemini();
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#platformsSetting .where-knob"); i++) await Bun.sleep(50);
    const g = [...doc.querySelectorAll("#platformsSetting .prow")].find((r: any) => r.querySelector(".pname").textContent.startsWith("Gemini")) as any;
    expect(g.querySelector(".chip.warn").textContent).toBe("people may read it");
    const why = g.querySelector("details.why");
    expect(why.open).toBe(false); // folded until asked for
    expect(why.querySelector("summary").textContent).toBe("Why it says so");
    const stops = [...doc.querySelectorAll("#platformsSetting .where-knob .lv-defs button")];
    expect(stops.map((b: any) => [b.querySelector(".d b").textContent.trim(), b.getAttribute("aria-pressed")])).toEqual([["Only this computer.", "false"], ["Also paid models that do not train.", "false"], ["Also free tiers, not your files.", "false"], ["Anywhere you ticked.", "true"]]);
    (stops[0] as any).click();
    for (let i = 0; i < 100 && (await ui(url, "/api/state")).json.settings.where !== 1; i++) await Bun.sleep(50);
    expect((await ui(url, "/api/state")).json.settings.where).toBe(1);
    closeApp();
  }, 20000);
});
