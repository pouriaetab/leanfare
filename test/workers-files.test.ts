// Plan by itself keeps the user's files as they were: links stay links, modes stay, text outside
// Leanfare's block stays, and a failure part way changes nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END, START, autoView, setAuto, withBlock } from "../src/workers";

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR!;
let settingsFile = "";
let saved: string | undefined;
beforeEach(() => {
  rmSync(claudeDir(), { recursive: true, force: true });
  rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
  saved = process.env.LEANFARE_CLAUDE_SETTINGS;
  settingsFile = join(mkdtempSync(join(tmpdir(), "rv-settings-")), "settings.json");
  process.env.LEANFARE_CLAUDE_SETTINGS = settingsFile;
});
afterEach(() => { if (saved === undefined) delete process.env.LEANFARE_CLAUDE_SETTINGS; else process.env.LEANFARE_CLAUDE_SETTINGS = saved; });

describe("Plan by itself and the user's own files", () => {
  test("a CLAUDE.md kept with dotfiles (a symlink) stays a link when Plan by itself is turned on", () => {
    const dot = mkdtempSync(join(tmpdir(), "rv-dotfiles-"));
    writeFileSync(join(dot, "CLAUDE.md"), "# Mine\n\nBe brief.\n");
    mkdirSync(claudeDir(), { recursive: true });
    symlinkSync(join(dot, "CLAUDE.md"), join(claudeDir(), "CLAUDE.md"));
    writeFileSync(settingsFile, "{}");
    setAuto("claude-code", true);
    const isLink = lstatSync(join(claudeDir(), "CLAUDE.md")).isSymbolicLink();
    const dotText = readFileSync(join(dot, "CLAUDE.md"), "utf8");
    expect(isLink).toBe(true);
    expect(dotText).toContain("Be brief."); // the file it points to holds the user's text and Leanfare's block
    expect(dotText).toContain(START);
  });

  test("the same for Codex's AGENTS.md", () => {
    const dot = mkdtempSync(join(tmpdir(), "rv-dotfiles-"));
    writeFileSync(join(dot, "AGENTS.md"), "# Codex rules\n");
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    symlinkSync(join(dot, "AGENTS.md"), join(process.env.CODEX_HOME!, "AGENTS.md"));
    setAuto("codex", true);
    setAuto("codex", false);
    const isLink = lstatSync(join(process.env.CODEX_HOME!, "AGENTS.md")).isSymbolicLink();
    expect(isLink).toBe(true);
  });

  test("a failure part way leaves nothing changed", () => {
    writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }] } }));
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(join(claudeDir(), "agents"), "a file where the agents folder would go"); // the worker cannot be written
    let err = "";
    try { setAuto("claude-code", true); } catch (e: any) { err = String(e?.message ?? e); }
    const j = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(err).not.toBe("");
    expect(j.hooks.UserPromptSubmit).toBeUndefined();
  });

  test("a CLAUDE.md that cannot be replaced (read only, or locked on Windows): nothing changes", () => {
    const { spawnSync } = require("node:child_process");
    writeFileSync(settingsFile, "{}");
    mkdirSync(claudeDir(), { recursive: true });
    const md = join(claudeDir(), "CLAUDE.md");
    writeFileSync(md, "# Mine\n");
    // Read only: for root (a container) only an immutable file is, and only where chattr may set it.
    const root = process.getuid?.() === 0;
    if (root ? spawnSync("chattr", ["+i", md]).status !== 0 : (chmodSync(md, 0o444), false)) return;
    let err = "";
    try { setAuto("claude-code", true); } catch (e: any) { err = String(e?.message ?? e); }
    if (root) spawnSync("chattr", ["-i", md]); else chmodSync(md, 0o644);
    const j = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(err).toContain("cannot write");
    expect(j.hooks?.UserPromptSubmit).toBeUndefined(); // the hook was never put in
    expect(readFileSync(md, "utf8")).toBe("# Mine\n");
    expect(existsSync(join(claudeDir(), "agents", "leanfare-worker.md"))).toBe(false);
  });

  test("a private CLAUDE.md (mode 600) keeps its mode", () => {
    const { statSync } = require("node:fs");
    writeFileSync(settingsFile, "{}");
    mkdirSync(claudeDir(), { recursive: true });
    const md = join(claudeDir(), "CLAUDE.md");
    writeFileSync(md, "# Mine\n");
    chmodSync(md, 0o600);
    setAuto("claude-code", true);
    const mode = (statSync(md).mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });

  test("a START line with no END (an end marker deleted by hand): the user's text survives on and off", () => {
    const mine = `# Mine\n\n${START}\n## Leanfare (old)\n\n# My later notes\n\nKeep these.\n`; // the END line was removed by hand
    const on = withBlock(mine, "Plan first.");
    const off = withBlock(on, null);
    expect(off).toContain("Keep these.");
    expect(off).toBe(mine); // the lone START line is the user's now, and stays
    // A lone END line (its START deleted): the same.
    const lone = `# Mine\n\n${END}\n\nKeep this.\n`;
    expect(withBlock(withBlock(lone, "Plan first."), null)).toBe(lone);
    // Two whole blocks (from two copies of the line): turned on, one is left; off, none.
    const two = `# Mine\n\n${START}\nold\n${END}\n\nMiddle.\n\n${START}\nolder\n${END}\n`;
    const once = withBlock(two, "Plan first.");
    expect(once.split(START).length - 1).toBe(1);
    expect(once).toContain("Middle.");
    expect(withBlock(once, null)).toBe("# Mine\n\nMiddle.\n");
  });
});
