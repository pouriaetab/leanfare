// The first run's Set up, server side: what is on this computer, and one press that puts Leanfare in
// every AI app found. The switch has its own tests (switch.test.ts), and so do the screens (setup-screens).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { store } from "../src/data";
import { settings } from "../src/settings";
import { setSwitch, switchedOn } from "../src/switch";
import { setUp } from "../src/setup";
import { APPS } from "../src/apps";
import { fakeClaude } from "./fakeclaude";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
const real = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => { Object.assign(process.env, real); setSwitch(true); });
let home = "";
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  setSwitch(true);
  // A computer of the test's own: no AI app until a test puts one there.
  home = mkdtempSync(join(tmpdir(), "leanfare-setup-"));
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, "no-codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude");
});
const noClaude = process.env.LEANFARE_CLAUDE_BIN; // setup.ts: no claude command
afterEach(() => { Object.assign(process.env, real); process.env.LEANFARE_CLAUDE_BIN = noClaude; });

const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
// Claude's apps are the ones Set up offers (0.15: Leanfare lives in Claude only); the archived ones it never touches.
// Claude Desktop's settings file, where this platform keeps it (a Mac also has Claude in /Applications).
const desk = () => APPS.find((a) => a.id === "claude-desktop")!.file();
const MINE = ["claude-desktop", "claude-code"];
const claudeCode = () => { process.env.CLAUDE_CONFIG_DIR = join(home, "claude"); fakeClaude(home); put(join(home, "claude", ".claude.json"), "{}"); };
const mine = (xs: any[]) => xs.filter((x) => MINE.includes(x.id));
const appsInApplications = process.platform === "darwin" && ["Claude", "Cursor"].some((a) => existsSync(`/Applications/${a}.app`));

describe("Set up", () => {
  test("someone who has Leanfare in an app already, from this copy or another, is not sent to Set up", async () => {
    put(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    expect((await ui(url, "/api/setup")).json.setupDone).toBe(false); // Cursor is here, without Leanfare
    const old = JSON.stringify({ mcpServers: { leanfare: { command: "/old/bun", args: ["/old/cli.ts", "mcp"] } } });
    put(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), old); // macOS
    put(join(home, ".config", "Claude", "claude_desktop_config.json"), old); // Linux
    expect((await ui(url, "/api/setup")).json.setupDone).toBe(true);
  });
  test("what is on this computer: Claude's apps (a broken one said), never an archived one, and the models Leanfare can hand work to", async () => {
    put(desk(), "{ not json");
    put(join(home, ".cursor", "mcp.json"), "{}"); // Cursor is here, and archived: Set up does not offer it
    mkdirSync(join(home, ".gemini"), { recursive: true });
    let v = (await ui(url, "/api/setup")).json;
    expect(v.apps.map((a: any) => a.id).filter((id: string) => !MINE.includes(id))).toEqual([]);
    expect(mine(v.apps).map((a: any) => [a.name, a.status])).toEqual([["Claude Desktop", "broken"]]);
    expect(v.apps.find((a: any) => a.id === "claude-desktop").note).toContain("is not valid JSON");
    expect(v).toMatchObject({ models: [], ready: false, setupDone: false, busy: false });
    await keys("google");
    v = (await ui(url, "/api/setup")).json;
    expect(v.models).toEqual([{ id: "google", name: "Google Gemini", how: "your key, saved in Leanfare" }]);
    expect(v.ready).toBe(true);
  });
  test("one press: Leanfare in Claude's apps, planning by itself where the app can, Set up done and the switch on; an archived app is left alone", async () => {
    put(desk(), JSON.stringify({ mcpServers: { other: { command: "x", args: ["y"] } } }));
    claudeCode();
    put(join(home, ".cursor", "mcp.json"), "{}");
    await keys("google");
    setSwitch(false);
    const r = (await ui(url, "/api/setup", {})).json;
    expect(r.results.map((x: any) => [x.id, x.ok])).toEqual([["claude-desktop", true], ["claude-code", true]]);
    expect(r.results[0].after).toContain("Claude Desktop");
    const d = JSON.parse(readFileSync(desk(), "utf8"));
    expect(d.mcpServers.other).toEqual({ command: "x", args: ["y"] });
    expect(d.mcpServers.leanfare.args.at(-1)).toBe("mcp");
    expect(JSON.parse(readFileSync(join(home, "claude", ".claude.json"), "utf8")).mcpServers.leanfare.args.at(-1)).toBe("mcp");
    expect(readFileSync(join(home, "claude", "CLAUDE.md"), "utf8")).toContain("Leanfare"); // Claude Code plans by itself
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{}"); // archived: untouched
    expect(settings().setupDone).toBe(true);
    expect(switchedOn()).toBe(true);
    expect(mine(r.setup.apps).map((a: any) => [a.id, a.status])).toEqual([["claude-desktop", "added"], ["claude-code", "added"]]);
    expect(r.setup.setupDone).toBe(true);
    // A second press changes nothing that is there already.
    const again = (await ui(url, "/api/setup", {})).json;
    expect(again.results.map((x: any) => x.ok)).toEqual([true, true]);
    expect(Object.keys(JSON.parse(readFileSync(desk(), "utf8")).mcpServers)).toEqual(["other", "leanfare"]);
  });
  test("an app that cannot be written is said, with its reason, and the other still gets Leanfare", async () => {
    put(join(home, "a-file"), "not a folder");
    mkdirSync(dirname(desk()), { recursive: true });
    symlinkSync(join(home, "a-file", "config.json"), desk()); // its settings file is a link into a file, so it can never be written
    claudeCode();
    const r = (await ui(url, "/api/setup", {})).json;
    const d = r.results.find((x: any) => x.id === "claude-desktop");
    expect(d.ok).toBe(false);
    expect(d.error.length).toBeGreaterThan(10);
    expect(r.results.find((x: any) => x.id === "claude-code").ok).toBe(true);
    expect(settings().setupDone).toBe(true); // Claude Code has it
  });
  test("when only planning by itself cannot be written (a worker file that is not Leanfare's), the app still gets Leanfare, and the reason is said", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    fakeClaude(home); // Claude Code's claude command, stood in for
    put(join(home, "claude", ".claude.json"), "{}");
    put(join(home, "claude", "agents", "leanfare-worker.md"), "my own agent\n");
    const r = (await ui(url, "/api/setup", {})).json;
    const cc = r.results.find((x: any) => x.id === "claude-code");
    expect(cc.ok).toBe(true);
    expect(cc.note).toStartWith("Claude Code does not plan by itself yet: ");
    expect(cc.note).toContain("is not Leanfare's, so Leanfare left it alone");
    expect(JSON.parse(readFileSync(join(home, "claude", ".claude.json"), "utf8")).mcpServers.leanfare.args.at(-1)).toBe("mcp");
    expect(readFileSync(join(home, "claude", "agents", "leanfare-worker.md"), "utf8")).toBe("my own agent\n");
    expect(existsSync(join(home, "claude", "CLAUDE.md"))).toBe(false);
    expect(settings().setupDone).toBe(true);
  });
  test("a folder where an app's settings file should be: that app is left alone, and Set up still answers", async () => {
    mkdirSync(desk(), { recursive: true });
    const r = await ui(url, "/api/setup");
    expect(r.status).toBe(200);
    expect(mine(r.json.apps).map((a: any) => [a.id, a.status])).toEqual([["claude-desktop", "broken"]]);
  });
  test("the first time, a key found on this computer but no model ticked: Set up is ready, and its press ticks that provider's short list", async () => {
    await reset({ ticked: [] }); // a new person: nothing ticked yet
    await keys("google"); // as a key in the Keychain, the environment or the shell is: never through Leanfare's Add a key
    put(desk(), "{}");
    const v = (await ui(url, "/api/setup")).json;
    expect(v.models.map((m: any) => m.id)).toEqual(["google"]);
    expect(v.ready).toBe(true);
    const r = (await ui(url, "/api/setup", {})).json;
    expect(r.results.find((x: any) => x.id === "claude-desktop").ok).toBe(true);
    expect(settings().ticked).toEqual(["google/gemini-3.8-flash"]); // Google's short list
    expect(r.setup.ready).toBe(true);
  });
  test("with a model of yours ready, Set up ticks nothing more, and lists only the providers Leanfare will use", async () => {
    await reset({ ticked: ["google/gemini-3.8-flash"] });
    await keys("google", "deepseek"); // DeepSeek has none of its models ticked
    put(desk(), "{}");
    expect((await ui(url, "/api/setup")).json.models.map((m: any) => m.id)).toEqual(["google"]);
    await ui(url, "/api/setup", {});
    expect(settings().ticked).toEqual(["google/gemini-3.8-flash"]);
  });
  test("a provider here with nothing to hand work to (Ollama with no model yet) does not make Set up ready", async () => {
    await reset({ ticked: [] });
    store.ollamaFound = true; // running, but no model downloaded
    const v = (await ui(url, "/api/setup")).json;
    expect(v.models).toEqual([]);
    expect(v.ready).toBe(false);
  });
  test("stopped before it starts, Set up changes nothing", async () => {
    put(desk(), "{}");
    const r = await setUp(AbortSignal.abort());
    expect(r.results).toEqual([]);
    expect(JSON.parse(readFileSync(desk(), "utf8")).mcpServers).toBeUndefined();
    expect(settings().setupDone).toBe(false);
  });
  test.skipIf(appsInApplications)("with no AI app here, a press puts Leanfare nowhere and Set up stays to do", async () => {
    const r = (await ui(url, "/api/setup", {})).json;
    expect(r.results).toEqual([]);
    expect(settings().setupDone).toBe(false);
  });
});
