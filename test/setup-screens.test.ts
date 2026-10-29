// The first run as a new person meets it: Set up (Leanfare in the AI apps found, with one press), then
// the app's screens, with the one step each app needs at the top; and the switch at the top of every
// screen, which turns Leanfare off and on in all the apps at once.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { entry } from "../src/apps";
import { paths } from "../src/config";
import { store } from "../src/data";
import { setSwitch } from "../src/switch";
import { fakeClaude } from "./fakeclaude";
import { ALL_TICKED, boot, keys, reset, ui } from "./app";
import { closeApp, openApp, win } from "./dom";

let url = "";
const real = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
let home = "";
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => { Object.assign(process.env, real); setSwitch(true); });
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  setSwitch(true);
  home = mkdtempSync(join(tmpdir(), "leanfare-setup-screens-"));
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, "no-codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude");
});
const noClaude = process.env.LEANFARE_CLAUDE_BIN; // setup.ts: no claude command
afterEach(async () => { await closeApp(); Object.assign(process.env, real); process.env.LEANFARE_CLAUDE_BIN = noClaude; });

async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const on = (doc: any, tab: string) => doc.querySelector(`#tab-${tab}`).classList.contains("on");
const text = (doc: any, sel: string) => doc.querySelector(sel)?.textContent ?? "";
const press = (doc: any, label: string, within = "main") => [...doc.querySelector(within).querySelectorAll("button")].find((b: any) => b.textContent.trim() === label || b.querySelector(".lr-title")?.textContent === label)?.click();
const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
// How the screens list apps ("Cursor", "Claude Desktop and Cursor"). A Mac also has the apps in /Applications.
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const api = async (path: string) => (await ui(url, path)).json;
const notices = (doc: any) => text(doc, "#notices");
const added = (apps: any[]) => apps.filter((a: any) => a.status === "added").map((a: any) => a.name);

describe("Set up, the first time", () => {
  test("an app and a model here: one press puts Leanfare in, then Chat, with the one step the app needs at the top", async () => {
    await reset({ ticked: [] }); // a new person: no model ticked, a Google key already on this computer
    mkdirSync(join(home, ".cursor"), { recursive: true });
    await keys("google");
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && text(doc, "#tab-setup").includes("Cursor"));
    expect(doc.querySelector("#app").classList.contains("simple")).toBe(true); // no tabs, no pills, no switch
    expect(text(doc, "#tab-setup .simple-h1")).toBe("Set up Leanfare");
    const found = text(doc, "#tab-setup");
    expect(found).toContain("CursorLeanfare goes in here");
    expect(found).toContain("Google GeminiA model to hand work to: your key, saved in Leanfare");
    expect(found).toContain("Leanfare reads usage numbers, never your words.");
    expect(found).toContain("It adds Leanfare's tools to each app. Remove takes them out again (Settings, In your apps)."); // Cursor does not plan by itself
    const turnOn = [...doc.querySelectorAll("#tab-setup button")].find((b: any) => b.textContent === "Turn on Leanfare") as any;
    expect(turnOn.disabled).toBe(false);
    expect(bad(doc)).toBe(false);
    turnOn.click();
    await waitFor(() => on(doc, "chat") && notices(doc).includes("One last step"));
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.leanfare.args.at(-1)).toBe("mcp");
    expect(doc.querySelector("#app").classList.contains("simple")).toBe(false); // the tabs and the switch are there
    expect(doc.querySelector("#appsSwitch").getAttribute("aria-checked")).toBe("true");
    expect(notices(doc)).toContain("Cursor picks it up by itself");
    const names = added((await api("/api/setup")).apps);
    expect(names).toContain("Cursor");
    expect(toasts(doc)).toContain(`Leanfare is on in ${andList(names)}.`);
    press(doc, "Done", "#notices");
    await waitFor(() => !notices(doc).includes("One last step"));
    expect(notices(doc)).not.toContain("One last step");
    expect(bad(doc)).toBe(false);
    // The page knows at once that Set up ticked Google's first model.
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => on(doc, "settings") && text(doc, "#tab-settings").includes("1 of 1 ticked"));
    expect(text(doc, "#tab-settings")).toContain("1 of 1 ticked");
  }, 30000);

  test("no model yet: Turn on waits and says why, and Add a key opens that card in Settings", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && text(doc, "#tab-setup").includes("Leanfare needs a model"));
    const turnOn = [...doc.querySelectorAll("#tab-setup button")].find((b: any) => b.textContent === "Turn on Leanfare") as any;
    expect(turnOn.disabled).toBe(true);
    expect(text(doc, "#tab-setup")).toContain("Turn on needs a model first (above).");
    expect([...doc.querySelectorAll("#tab-setup button")].map((b: any) => b.textContent)).toContain("Connect OpenRouter");
    press(doc, "Add a key", "#tab-setup");
    await waitFor(() => on(doc, "settings") && !!doc.querySelector("#keysCard"));
    expect(doc.querySelector("#keysCard").classList.contains("flash")).toBe(true);
    expect(doc.querySelector("#app").classList.contains("simple")).toBe(false); // the tabs are back
    // Settings draws itself again as its cards load: the card stays lit (and in view) through that.
    await Bun.sleep(900);
    expect(doc.querySelector("#keysCard").classList.contains("flash")).toBe(true);
    expect(bad(doc)).toBe(false);
  }, 30000);

  test("an app that plans by itself: the fine print says it also gets a few lines on when to hand work over", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    await keys("google");
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && text(doc, "#tab-setup").includes("Gemini CLI"));
    expect(text(doc, "#tab-setup")).toContain("It adds Leanfare's tools to each app, and to Gemini CLI a few lines on when to hand work over. Remove takes them out again (Settings, In your apps).");
  }, 30000);

  test("an app that gets Leanfare but cannot plan by itself: One last step says why", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    fakeClaude(home); // Claude Code's claude command, stood in for
    put(join(home, "claude", ".claude.json"), "{}");
    put(join(home, "claude", "agents", "leanfare-worker.md"), "my own agent\n");
    await keys("google");
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && text(doc, "#tab-setup").includes("Claude Code"));
    press(doc, "Turn on Leanfare", "#tab-setup");
    await waitFor(() => on(doc, "chat") && notices(doc).includes("One last step"));
    expect(notices(doc)).toContain("Start Claude Code again (type /exit, then claude).");
    expect(doc.querySelector("#notices .notice.next .warn-text").textContent).toStartWith("Claude Code does not plan by itself yet: ");
    expect(toasts(doc)).toContain("Leanfare is on in");
  }, 30000);

  test("Turn on is its own Stop: Set up stops before the next app, and the list then shows what it did", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const gate = join(home, "claude-gate");
    fakeClaude(home, { gate }); // Claude Code's command runs until the test lets it end, however busy the computer is
    put(join(home, "claude", ".claude.json"), "{}");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    await keys("google");
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && text(doc, "#tab-setup").includes("Claude Code"));
    const button = () => [...doc.querySelectorAll("#tab-setup button")].find((b: any) => ["Turn on Leanfare", "Stop"].includes(b.textContent)) as any;
    button().click();
    await waitFor(() => button()?.textContent === "Stop");
    expect(button().textContent).toBe("Stop");
    await waitFor(() => existsSync(gate + ".started"), 15000); // Set up is on Claude Code now
    await Bun.sleep(600); // a second click this soon would be a double click, which is not a Stop
    button().click();
    await waitFor(() => toasts(doc).includes("Stopped."));
    // It finishes the app it is on (Claude Code's slow command), and says so meanwhile.
    await waitFor(() => text(doc, "#tab-setup").includes("Still finishing the app it is on…"));
    expect(text(doc, "#tab-setup")).toContain("Still finishing the app it is on…");
    writeFileSync(gate, ""); // Claude Code's command ends
    await waitFor(() => text(doc, "#tab-setup").includes("Claude CodeLeanfare is in here already"), 8000);
    expect(text(doc, "#tab-setup")).not.toContain("Still finishing");
    expect(on(doc, "setup")).toBe(true); // still here, not sent on
    const rows = [...doc.querySelectorAll("#tab-setup .list-row")].map((r: any) => r.textContent);
    expect(rows).toContain("✓Claude CodeLeanfare is in here already"); // the one it was doing
    expect(rows).toContain("✓CursorLeanfare goes in here"); // the next one was left as it was
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  }, 30000);

  test("Ollama running with no model yet: Set up offers the free model that fits this computer", async () => {
    await reset({ ticked: [] });
    store.ollamaFound = true; // running, nothing downloaded
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && text(doc, "#tab-setup").includes("Get a free model for Ollama"));
    expect(text(doc, "#tab-setup")).toContain("Ollama is running on this computer, with no model yet.");
    expect(([...doc.querySelectorAll("#tab-setup button")].find((b: any) => b.textContent === "Turn on Leanfare") as any).disabled).toBe(true);
    press(doc, "Get a free model", "#tab-setup");
    await waitFor(() => on(doc, "settings") && !!doc.querySelector("#localCard"));
    expect(doc.querySelector("#localCard").classList.contains("flash")).toBe(true);
  }, 30000);

  test("Skip for now goes to Chat; Set up all at once, in Settings, opens it again, and Back goes to the screen used last", async () => {
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "setup") && !!doc.querySelector("#tab-setup .found-mark"));
    const found = (await api("/api/setup")).apps.map((a: any) => a.name); // none here; a Mac has its /Applications ones
    expect(text(doc, "#tab-setup")).toContain(found.length ? `✓${found[0]}` : "No AI apps found");
    press(doc, "Skip for now", "#tab-setup");
    await waitFor(() => on(doc, "chat"));
    expect(on(doc, "chat")).toBe(true);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => on(doc, "settings") && [...doc.querySelectorAll("#appsSetting button")].some((b: any) => b.textContent === "Set up all at once"));
    press(doc, "Set up all at once", "#appsSetting");
    // Set up is done (skipped), so its last button says Back.
    await waitFor(() => on(doc, "setup") && [...doc.querySelectorAll("#tab-setup button")].some((b: any) => b.textContent === "Back"));
    press(doc, "Back", "#tab-setup");
    await waitFor(() => on(doc, "settings"));
    expect(on(doc, "settings")).toBe(true);
  }, 30000);

  test("someone who used 0.6 goes to the screen they used last there, after Set up", async () => {
    const doc = await openApp(url, { screen: null });
    win.localStorage.setItem("leanfare.tab", JSON.stringify("savings")); // 0.6 kept the last screen as "tab"
    await waitFor(() => on(doc, "setup") && !!doc.querySelector("#tab-setup .found-mark"));
    press(doc, "Skip for now", "#tab-setup");
    await waitFor(() => on(doc, "savings"));
    expect(on(doc, "savings")).toBe(true);
  }, 30000);

  test("someone with Leanfare in an app already is not sent to Set up", async () => {
    put(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { leanfare: entry() } }));
    const doc = await openApp(url, { screen: null });
    await waitFor(() => on(doc, "chat"));
    expect(on(doc, "chat")).toBe(true);
    expect(on(doc, "setup")).toBe(false);
  }, 30000);
});

describe("the switch at the top", () => {
  beforeEach(async () => {
    await reset({ ticked: ALL_TICKED, setupDone: true });
    put(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { leanfare: entry() } }));
  });

  test("off: the tools in your apps go quiet, a line at the top says so, and its Turn on turns it back on", async () => {
    const doc = await openApp(url);
    const sw = () => doc.querySelector("#appsSwitch");
    await waitFor(() => on(doc, "chat") && sw().getAttribute("aria-checked") === "true");
    expect(sw().textContent).toBe("In your apps");
    expect(sw().title).toContain("Leanfare is on in your apps");
    sw().click();
    await waitFor(() => existsSync(paths.off) && sw().getAttribute("aria-checked") === "false");
    expect(sw().title).toContain("Leanfare is off in your apps");
    await waitFor(() => toasts(doc).includes("Leanfare is off"));
    expect(toasts(doc)).toContain("Leanfare is off in your apps.");
    expect(notices(doc)).toContain("Leanfare is off in your apps: they do all the work themselves until you turn it on.");
    press(doc, "Turn on", "#notices");
    await waitFor(() => !existsSync(paths.off) && sw().getAttribute("aria-checked") === "true");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => !notices(doc).includes("Leanfare is off"));
    expect(notices(doc)).not.toContain("Leanfare is off");
    expect(bad(doc)).toBe(false);
  }, 30000);

  test("switched off somewhere else: the page shows it within a few seconds", async () => {
    const doc = await openApp(url);
    const sw = () => doc.querySelector("#appsSwitch");
    await waitFor(() => on(doc, "chat") && sw().getAttribute("aria-checked") === "true");
    setSwitch(false);
    await waitFor(() => sw().getAttribute("aria-checked") === "false", 9000);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(notices(doc)).toContain("Leanfare is off in your apps");
  }, 30000);
});

describe("the header", () => {
  // Auto is day from 7 AM to 7 PM by this computer's clock.
  const byClock = () => { const h = new Date().getHours(); return h >= 7 && h < 19 ? "light" : "dark"; };
  const pressed = (doc: any) => [...doc.querySelectorAll("#themeSwitch button")].filter((b: any) => b.getAttribute("aria-pressed") === "true").map((b: any) => b.dataset.mode);
  test("Day, Auto and Night: three buttons, the current one marked, kept in this browser; Settings names them the same", async () => {
    const doc = await openApp(url, { screen: null });
    await waitFor(() => pressed(doc).length === 1);
    expect([...doc.querySelectorAll("#themeSwitch button")].map((b: any) => b.getAttribute("aria-label"))).toEqual(["Day", "Auto: day from 7 AM to 7 PM", "Night"]);
    expect(pressed(doc)).toEqual(["auto"]);
    expect(doc.documentElement.getAttribute("data-theme")).toBe(byClock());
    doc.querySelector('#themeSwitch [data-mode="dark"]').click();
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(pressed(doc)).toEqual(["dark"]);
    expect(win.localStorage.getItem("leanfare.theme")).toBe('"dark"');
    doc.querySelector('#themeSwitch [data-mode="light"]').click();
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
    doc.querySelector('#themeSwitch [data-mode="auto"]').click();
    expect(doc.documentElement.getAttribute("data-theme")).toBe(byClock());
    expect(pressed(doc)).toEqual(["auto"]);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => on(doc, "settings") && text(doc, "#tab-settings").includes("Auto is day from 7 AM to 7 PM"));
    const seg = [...doc.querySelectorAll('#tab-settings .seg[aria-label="Theme"] button')];
    expect(seg.map((b: any) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Day", "false"], ["Auto", "true"], ["Night", "false"]]);
    (seg[2] as any).click();
    expect(pressed(doc)).toEqual(["dark"]);
  }, 20000);

  test("on a phone only the current one shows, and a tap moves it on: Day, Auto, Night", async () => {
    const doc = await openApp(url, { screen: null, width: 390 });
    await waitFor(() => pressed(doc).length === 1);
    const cur = () => doc.querySelector('#themeSwitch button[aria-pressed="true"]');
    expect(cur().dataset.mode).toBe("auto");
    cur().click();
    expect(cur().dataset.mode).toBe("dark");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    cur().click();
    expect(cur().dataset.mode).toBe("light");
    cur().click();
    expect(cur().dataset.mode).toBe("auto");
  }, 20000);
});
