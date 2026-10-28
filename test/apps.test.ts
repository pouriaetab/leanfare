// Use Leanfare in your apps: its MCP entry added to and removed from each app's own settings
// file, with everything else in the file left as it was.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { APPS, appStatus, appsView, claudeAddLine, entry, setApp } from "../src/apps";
import { boot, reset, ui } from "./app";

let url = "";
let home = "";
const realHome = process.env.HOME;
const realCodex = process.env.CODEX_HOME; // the tests' own Codex folder (setup.ts), put back after
beforeAll(async () => { url = (await boot()).url; });
const realClaudeBin = process.env.LEANFARE_CLAUDE_BIN; // nothing (setup.ts), so no test runs the real claude
afterAll(() => { process.env.HOME = realHome; process.env.CODEX_HOME = realCodex; process.env.LEANFARE_CLAUDE_BIN = realClaudeBin; });
beforeEach(async () => {
  await reset(); // a clean server (no lock or settings left by another test file)
  home = mkdtempSync(join(tmpdir(), "leanfare-apps-"));
  process.env.HOME = home;
  delete process.env.CODEX_HOME; // Codex's config.toml under this test's home
});

const app = (id: string) => APPS.find((a) => a.id === id)!;
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const readJ = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("apps that keep their MCP servers in a JSON file", () => {
  test("Claude Desktop: Leanfare is added next to your other servers, and removed again, leaving them be", () => {
    const f = app("claude-desktop").file();
    put(f, JSON.stringify({ mcpServers: { llmledger: { command: "uvx", args: ["llmledger-mcp"] } }, preferences: { theme: "dark" } }, null, 2));
    expect(appStatus(app("claude-desktop"))).toBe("not added");
    setApp("claude-desktop", true);
    const j = readJ(f);
    expect(j.mcpServers.llmledger).toEqual({ command: "uvx", args: ["llmledger-mcp"] });
    expect(j.mcpServers.leanfare).toEqual(entry());
    expect(j.mcpServers.leanfare.args.at(-1)).toBe("mcp");
    expect(j.preferences).toEqual({ theme: "dark" });
    expect(existsSync(`${f}.leanfare-backup`)).toBe(true); // the file as it was
    expect(JSON.parse(readFileSync(`${f}.leanfare-backup`, "utf8")).mcpServers.leanfare).toBeUndefined();
    expect(appStatus(app("claude-desktop"))).toBe("added");
    setApp("claude-desktop", false);
    expect(readJ(f).mcpServers).toEqual({ llmledger: { command: "uvx", args: ["llmledger-mcp"] } });
  });
  test("a file that is not valid JSON is left alone, and the screen says so", async () => {
    const f = app("cursor").file();
    put(f, "{ this is not json");
    expect(appStatus(app("cursor"))).toBe("broken");
    await expect(setApp("cursor", true)).rejects.toThrow("is not valid JSON in the shape Cursor uses, so Leanfare left it alone");
    expect(readFileSync(f, "utf8")).toBe("{ this is not json");
    expect(appsView().find((v) => v.id === "cursor")!.note).toContain("is not valid JSON");
  });
  test("an entry from another copy of Leanfare shows as old, and Update points it at this one", async () => {
    const f = app("windsurf").file();
    put(f, JSON.stringify({ mcpServers: { leanfare: { command: "/old/bun", args: ["/old/leanfare/src/cli.ts", "mcp"] } } }));
    expect(appStatus(app("windsurf"))).toBe("old");
    await setApp("windsurf", true);
    expect(readJ(f).mcpServers.leanfare).toEqual(entry());
  });
  test("VS Code's entries say they run over stdio, under servers", async () => {
    mkdirSync(dirname(app("vscode").file()), { recursive: true });
    await setApp("vscode", true);
    expect(readJ(app("vscode").file()).servers.leanfare).toEqual({ type: "stdio", ...entry() });
  });
  test("a settings file kept as a link stays a link; the file it points to is the one written", async () => {
    const real = join(home, "dotfiles", "gemini-settings.json");
    put(real, JSON.stringify({ theme: "Default" }));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    symlinkSync(real, app("gemini-cli").file());
    await setApp("gemini-cli", true);
    expect(lstatSync(app("gemini-cli").file()).isSymbolicLink()).toBe(true);
    expect(readJ(real)).toEqual({ theme: "Default", mcpServers: { leanfare: entry() } });
  });
  test("an app that is not on this computer says so; one that is but has no file yet gets one", async () => {
    expect(appStatus(app("lm-studio"))).toBe("not installed");
    mkdirSync(join(home, ".lmstudio"), { recursive: true });
    expect(appStatus(app("lm-studio"))).toBe("not added");
    await setApp("lm-studio", true);
    expect(readJ(app("lm-studio").file())).toEqual({ mcpServers: { leanfare: entry() } });
  });
});

describe("files Leanfare should leave as they are", () => {
  test("removing from an app that is not there, or from a file without Leanfare, writes nothing", async () => {
    await setApp("cursor", false);
    expect(existsSync(app("cursor").file())).toBe(false);
    await setApp("codex", false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    const f = app("windsurf").file();
    put(f, '{"mcpServers":{"other":{"command":"x","args":[]}},  "keep":   "my spacing"}');
    await setApp("windsurf", false);
    expect(readFileSync(f, "utf8")).toBe('{"mcpServers":{"other":{"command":"x","args":[]}},  "keep":   "my spacing"}');
    expect(existsSync(`${f}.leanfare-backup`)).toBe(false);
  });
  test("servers kept as a list, not an object, is a shape Leanfare leaves alone", async () => {
    const f = app("gemini-cli").file();
    put(f, '{"mcpServers": []}');
    expect(appStatus(app("gemini-cli"))).toBe("broken");
    await expect(setApp("gemini-cli", true)).rejects.toThrow("in the shape Gemini CLI uses");
    expect(readFileSync(f, "utf8")).toBe('{"mcpServers": []}');
  });
  test("a link to a file not made yet stays a link, and the file is made where it points", async () => {
    const real = join(home, "dotfiles", "cursor-mcp.json");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, "dotfiles"), { recursive: true });
    symlinkSync(real, app("cursor").file());
    await setApp("cursor", true);
    expect(lstatSync(app("cursor").file()).isSymbolicLink()).toBe(true);
    expect(readJ(real).mcpServers.leanfare).toEqual(entry());
  });
  test("the backup is the file as it was before Leanfare first changed it", async () => {
    const f = app("lm-studio").file();
    put(f, '{"mcpServers": {"mine": {"command": "a", "args": []}}}');
    await setApp("lm-studio", true);
    await setApp("lm-studio", false);
    await setApp("lm-studio", true);
    expect(readFileSync(`${f}.leanfare-backup`, "utf8")).toBe('{"mcpServers": {"mine": {"command": "a", "args": []}}}');
  });
});

describe("Codex CLI's TOML file", () => {
  const toml = () => join(home, ".codex", "config.toml");
  test("Leanfare's table is added at the end, not twice, and removed with nothing else touched", async () => {
    put(toml(), `model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["y"]\n\n[profiles.fast]\nmodel = "gpt-6-mini"\n`);
    await setApp("codex", true);
    await setApp("codex", true);
    const text = readFileSync(toml(), "utf8");
    expect(text.match(/\[mcp_servers\.leanfare\]/g)).toHaveLength(1);
    expect(text).toContain(`command = ${JSON.stringify(entry().command)}`);
    expect(text).toContain(`args = [${entry().args.map((a) => JSON.stringify(a)).join(", ")}]`);
    expect(text).toContain("[profiles.fast]\nmodel = \"gpt-6-mini\"");
    expect(appStatus(app("codex"))).toBe("added");
    await setApp("codex", false);
    expect(readFileSync(toml(), "utf8")).toBe(`model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["y"]\n\n[profiles.fast]\nmodel = "gpt-6-mini"\n`);
  });
  test("a file that is not valid TOML is left alone, and the screen says so", async () => {
    put(toml(), `model = "gpt-6"\n[profiles\nbroken = `);
    expect(appStatus(app("codex"))).toBe("broken");
    await expect(setApp("codex", true)).rejects.toThrow("is not valid TOML, so Leanfare left it alone");
    expect(readFileSync(toml(), "utf8")).toBe(`model = "gpt-6"\n[profiles\nbroken = `);
  });
  test("its header written another way is still found: never a second table", async () => {
    put(toml(), `[ mcp_servers . "leanfare" ] # added by hand\ncommand = "/old/bun"\nargs = ["mcp"]\n`);
    expect(appStatus(app("codex"))).toBe("old");
    await setApp("codex", true);
    const text = readFileSync(toml(), "utf8");
    expect(Bun.TOML.parse(text)).toEqual({ mcp_servers: { leanfare: entry() } });
  });
  test("its own tables under it go too; a multi line value and the next table's comment stay as they were", async () => {
    const top = `notes = """\nline one\n\n\n\nline five\n"""\n\n`;
    const next = `# my fast profile\n[profiles.fast]\nmodel = "m"\n`;
    put(toml(), `${top}[mcp_servers.leanfare]\ncommand = "/old/bun"\nargs = ["mcp"]\n\n[mcp_servers.leanfare.env]\nX = "1"\n\n${next}`);
    await setApp("codex", false);
    const text = readFileSync(toml(), "utf8");
    expect(text).toBe(`${top}\n${next}`);
    expect((Bun.TOML.parse(text) as any).notes).toBe("line one\n\n\n\nline five\n");
    expect((Bun.TOML.parse(text) as any).mcp_servers).toBeUndefined();
  });
  test("an entry written inline is not rewritten by guesswork: the screen says what to change", async () => {
    put(toml(), `mcp_servers = { leanfare = { command = "/old/bun", args = ["mcp"] } }\n`);
    expect(appStatus(app("codex"))).toBe("old");
    await expect(setApp("codex", true)).rejects.toThrow("is written in a way Leanfare does not change by itself");
    expect(readFileSync(toml(), "utf8")).toBe(`mcp_servers = { leanfare = { command = "/old/bun", args = ["mcp"] } }\n`);
  });
  test("a table in the middle of the file is replaced where it is", async () => {
    put(toml(), `[mcp_servers.leanfare]\ncommand = "/old/bun"\nargs = ["mcp"]\n\n[profiles.fast]\nmodel = "m"\n`);
    expect(appStatus(app("codex"))).toBe("old");
    await setApp("codex", true);
    const text = readFileSync(toml(), "utf8");
    expect(text).not.toContain("/old/bun");
    expect(text).toContain("[profiles.fast]");
    expect(appStatus(app("codex"))).toBe("added");
  });
});

describe("Claude Code, through its own command", () => {
  // Claude Code keeps .claude.json in CLAUDE_CONFIG_DIR when that is set (the tests set it for the log files).
  const keep = process.env.CLAUDE_CONFIG_DIR;
  beforeAll(() => { delete process.env.CLAUDE_CONFIG_DIR; });
  afterAll(() => { process.env.CLAUDE_CONFIG_DIR = keep; });
  // A stand in for claude: mcp add and mcp remove, written to ~/.claude.json the way Claude Code does.
  function fakeClaude() {
    const f = join(home, "bin", "claude");
    put(f, `#!${process.execPath}
const fs = require("fs"), path = require("path");
// Never outside a test home: a stand in that wrote to the real ~/.claude.json would change Claude Code's own settings.
if (!String(process.env.HOME).includes("leanfare-apps-")) { console.error("not a test home: " + process.env.HOME); process.exit(3); }
const file = path.join(process.env.HOME, ".claude.json");
const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const a = process.argv.slice(2);
j.mcpServers ??= {};
if (a[0] === "mcp" && a[1] === "add") { const i = a.indexOf("--"); j.mcpServers[a[4]] = { type: "stdio", command: a[i + 1], args: a.slice(i + 2), env: {} }; console.log("Added stdio MCP server " + a[4]); }
else if (a[0] === "mcp" && a[1] === "remove") { if (!j.mcpServers[a[4]]) { console.error("No MCP server found"); process.exit(1); } delete j.mcpServers[a[4]]; }
fs.writeFileSync(file, JSON.stringify(j));
`);
    chmodSync(f, 0o755);
    process.env.LEANFARE_CLAUDE_BIN = f;
  }
  test("added and removed with claude mcp add and claude mcp remove", async () => {
    fakeClaude();
    put(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x", args: [] } } }));
    expect(appStatus(app("claude-code"))).toBe("not added");
    await setApp("claude-code", true);
    const j = readJ(join(home, ".claude.json"));
    expect(j.mcpServers.leanfare).toMatchObject(entry());
    expect(j.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(appStatus(app("claude-code"))).toBe("added");
    await setApp("claude-code", false);
    expect(readJ(join(home, ".claude.json")).mcpServers.leanfare).toBeUndefined();
  });
  test("with no claude command, the screen gives the line to run in Terminal", async () => {
    process.env.LEANFARE_CLAUDE_BIN = join(home, "nowhere", "claude");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const v = appsView().find((x) => x.id === "claude-code")!;
    expect(v.manual).toBe(claudeAddLine());
    expect(v.manual).toStartWith("claude mcp add --scope user leanfare -- ");
    await expect(setApp("claude-code", true)).rejects.toThrow("You can run it in Terminal instead: claude mcp add");
  });
});

describe("the screen's API and the command line", () => {
  test("GET lists every app; POST adds one", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const a = (await ui(url, "/api/apps")).json.apps as any[];
    expect(a.map((x) => x.id)).toEqual(["claude-desktop", "claude-code", "cursor", "codex", "gemini-cli", "windsurf", "vscode", "lm-studio"]);
    expect(a.find((x) => x.id === "cursor").status).toBe("not added");
    const r = await ui(url, "/api/apps", { id: "cursor", on: true });
    expect(r.json.app).toMatchObject({ id: "cursor", status: "added" });
    expect(readJ(app("cursor").file()).mcpServers.leanfare).toEqual(entry());
    expect((await ui(url, "/api/apps", { id: "nope", on: true })).status).toBe(409);
  });
  test("leanfare apps lists them, and leanfare apps add cursor adds it", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const run = async (...a: string[]) => {
      const p = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home } });
      return { code: await p.exited, out: (await new Response(p.stdout).text()) + (await new Response(p.stderr).text()) };
    };
    const list = await run("apps");
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/cursor\s+Cursor\s+not added/);
    const add = await run("apps", "add", "cursor");
    expect(add.code).toBe(0);
    expect(add.out).toContain("Added Leanfare's tools to Cursor.");
    expect(readJ(app("cursor").file()).mcpServers.leanfare.args.at(-1)).toBe("mcp");
    expect((await run("apps", "add", "nothing")).code).toBe(2);
  });
});
