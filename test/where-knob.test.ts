// 0.12, where work may go (platforms.ts: whereStop, mayTake): four stops, from only this computer to anywhere you
// ticked; the older files setting maps onto them; Settings shows a small knob with each stop's models and a warning.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { getModel } from "../src/data";
import { mayTake, whereStop } from "../src/platforms";
import { saveSettings, settings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
afterEach(closeApp);
const LOG = { name: "app.log", text: "10:01 error: disk full\n" };
const freeGemini = async () => { await keys("google"); saveSettings({ providers: { google: { on: true, free: true } } }); };
const local = async () => { await ui(url, "/api/refresh", { what: "ollama" }); saveSettings({ ticked: [...ALL_TICKED, "ollama/llama3.2:latest"] }); };
const chats = () => fake.seen.filter((s) => s.path.includes("/chat/completions") || s.path.includes("/api/chat") || s.path.includes("/messages") || s.path.includes("generateContent"));

test("the older files setting maps onto the stops, and a stop you pick wins until the older one is said again", async () => {
  expect(whereStop({ filesTo: "any" })).toBe(4);
  expect(whereStop({ filesTo: "notFree" })).toBe(3);
  expect(whereStop({ filesTo: "local" })).toBe(1);
  expect(whereStop({ filesTo: "local", where: 2 })).toBe(2);
  expect((await ui(url, "/api/settings", { where: 2 })).status).toBe(200);
  expect(whereStop()).toBe(2);
  await ui(url, "/api/settings", { filesTo: "notFree" });
  expect(settings().where).toBeNull();
  expect(whereStop()).toBe(3);
  expect((await ui(url, "/api/settings", { where: 5 })).status).toBe(400);
  expect((await ui(url, "/api/settings", { where: "1" })).status).toBe(400);
});

test("each stop lets the right models take work, with files and without", async () => {
  await freeGemini(); await keys("deepseek"); await local();
  const g = [...ALL_TICKED].map((id) => getModel(id)!).find((m) => m.provider === "google")!;
  const paid = getModel("deepseek/deepseek-v4-flash")!, here = getModel("ollama/llama3.2:latest")!;
  const may = (w: 1 | 2 | 3 | 4, files: boolean) => { saveSettings({ where: w }); return [mayTake(g, { files }), mayTake(paid, { files }), mayTake(here, { files })]; };
  expect(may(1, false)).toEqual([false, false, true]);
  expect(may(2, true)).toEqual([false, true, true]);
  expect(may(3, false)).toEqual([true, true, true]);
  expect(may(3, true)).toEqual([false, true, true]);
  expect(may(4, true)).toEqual([true, true, true]);
  saveSettings({ where: 4 });
  expect(mayTake(paid, { private: true })).toBe(false); // private stays here whatever the knob says
});

test("only this computer keeps work without files in too; with no model there, nothing is sent", async () => {
  await freeGemini();
  saveSettings({ where: 1 });
  const before = chats().length;
  const r = await ui(url, "/api/delegate", { task: "Write a haiku about logs.", files: [], kind: "write", effort: "low", check: "never" });
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("Work goes only to this computer (Settings, Where Leanfare may send work), and no model there can take this. Do it yourself, or turn that knob up.");
  expect(chats().length).toBe(before);
  saveSettings({ where: 2, ticked: [g()] });
  const r2 = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
  expect(r2.status).toBe(409);
  expect(r2.json.error).toContain("Work goes only to this computer and to paid models that do not train");
  await local();
  saveSettings({ where: 1 });
  const ok = await ui(url, "/api/delegate", { task: "Summarize.", files: [LOG], kind: "read", effort: "low", check: "never" });
  expect(ok.json.model.id).toBe("ollama/llama3.2:latest");
});
const g = () => ALL_TICKED.find((id) => id.startsWith("google/"))!;

test("Settings: the small knob, each stop's models, the warning, and the keys", async () => {
  await keys("openai", "deepseek");
  const doc = await openApp(url);
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  for (let i = 0; i < 160 && !doc.querySelector("#platformsSetting .where-knob .lvknob"); i++) await Bun.sleep(50);
  const card = doc.querySelector("#platformsSetting .where-knob");
  const knob = card.querySelector(".lvknob");
  expect(knob.className).toBe("lvknob small");
  expect([knob.getAttribute("aria-valuemax"), knob.getAttribute("aria-valuenow"), knob.getAttribute("aria-valuetext")]).toEqual(["4", "4", "4, Anywhere"]);
  const tags = [...card.querySelectorAll(".lv-defs li")].map((li: any) => li.querySelector(".lv-tag").textContent);
  expect(tags[0]).toBe("no model"); // nothing on this computer yet
  expect(tags[3]).toMatch(/^\d+ models$/);
  knob.dispatchEvent(new (doc.defaultView as any).KeyboardEvent("keydown", { key: "1", bubbles: true }));
  for (let i = 0; i < 100 && !doc.querySelector("#platformsSetting .where-knob .note.warn"); i++) await Bun.sleep(50);
  expect(settings().where).toBe(1);
  expect(doc.querySelector("#platformsSetting .where-knob .note.warn").textContent).toContain("No model you have can take work at this stop");
  doc.querySelector("#platformsSetting .where-knob .lvknob").dispatchEvent(new (doc.defaultView as any).KeyboardEvent("keydown", { key: "End", bubbles: true }));
  for (let i = 0; i < 100 && settings().where !== 4; i++) await Bun.sleep(50);
  expect(settings().where).toBe(4);
}, 30000);
