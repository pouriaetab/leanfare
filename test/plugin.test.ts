// The Leanfare plugin for Claude (plugin/): what the plugin directory checks (a manifest, a README of 40 words or more,
// a licence, small text files only, no bin/ folder, commands inside the plugin), the hooks matching the app's own, and
// the launcher finding the installed Leanfare, staying quiet in a hook when there is none.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CLAUDE_HOOKS, appHooksOn } from "../src/workers";

const ROOT = new URL("..", import.meta.url).pathname;
const P = join(ROOT, "plugin");
const json = (f: string) => JSON.parse(readFileSync(join(P, f), "utf8"));
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test("the manifest: a name of our own, the app's version, a licence, and nothing pointing outside the plugin", () => {
  const m = json(".claude-plugin/plugin.json");
  expect(m.name).toMatch(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
  expect(m).toMatchObject({ name: "leanfare", displayName: "Leanfare", license: "MIT", author: { name: "pouriaetab" } });
  expect(m.version).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version); // raised with every release
  expect(m.description.length).toBeGreaterThan(40);
  const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
  expect(market.plugins).toEqual([expect.objectContaining({ name: "leanfare", source: "./plugin" })]);
});

test("the MCP server and the hooks run the launcher inside the plugin; the hooks are the app's own four", () => {
  // sh runs the launcher, so it works where an install loses the file's run bit
  expect(json(".mcp.json")).toEqual({ mcpServers: { leanfare: { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/leanfare.sh", "mcp"] } } });
  const hooks = json("hooks/hooks.json").hooks;
  expect(Object.keys(hooks).sort()).toEqual(CLAUDE_HOOKS.map((h) => h.event).sort());
  for (const h of CLAUDE_HOOKS) {
    const [group] = hooks[h.event];
    expect(group.matcher ?? null).toBe(h.matcher);
    expect(group.hooks).toEqual([{ type: "command", command: `sh "\${CLAUDE_PLUGIN_ROOT}/scripts/leanfare.sh" hook ${h.what}`, timeout: h.timeout }]);
  }
  expect((statSync(join(P, "scripts/leanfare.sh")).mode & 0o111) !== 0).toBe(true);
});

test("what the directory checks: a README of 40 words or more, a licence, small text files, no bin/ folder or system files", () => {
  const readme = readFileSync(join(P, "README.md"), "utf8").replace(/```[\s\S]*?```/g, "");
  expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  expect(readFileSync(join(P, "LICENSE"), "utf8")).toContain("MIT License");
  const files = walk(P).map((f) => relative(P, f));
  expect(files.length).toBeLessThanOrEqual(512);
  for (const f of files) {
    expect(statSync(join(P, f)).size).toBeLessThan(256 * 1024);
    expect(readFileSync(join(P, f)).includes(0)).toBe(false); // text only
    expect(f).not.toMatch(/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/);
    for (const part of f.split("/").slice(0, -1)) expect(part).toMatch(/^[A-Za-z0-9._-]+$/);
  }
  expect(files.some((f) => f.startsWith("bin/"))).toBe(false); // a top-level bin/ makes chat and Cowork refuse the plugin
  expect(readFileSync(join(P, "skills/leanfare/SKILL.md"), "utf8")).toMatch(/^---\nname: leanfare\ndescription: [^\n]+\n---\n/);
});

test("the launcher runs the installed Leanfare with its arguments, and with none installed a hook stays quiet while the MCP server says how to install", () => {
  const home = mkdtempSync(join(tmpdir(), "leanfare-plugin-home-")), bin = join(home, ".leanfare", "bin");
  const run = (args: string[]) => Bun.spawnSync(["/bin/sh", join(P, "scripts/leanfare.sh"), ...args], { env: { PATH: "/usr/bin:/bin", HOME: home } });
  let r = run(["hook", "read"]);
  expect([r.exitCode, r.stdout.toString(), r.stderr.toString()]).toEqual([0, "", ""]);
  r = run(["mcp"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("Leanfare is not installed on this computer.");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "leanfare"), '#!/bin/sh\necho "ran $* from $LEANFARE_HOOK_FROM"\n');
  chmodSync(join(bin, "leanfare"), 0o755);
  r = run(["hook", "read"]);
  expect(r.stdout.toString()).toBe("ran hook read from plugin\n");
});

test("the plugin's hooks stay quiet when the app's own are in Claude Code's settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "leanfare-plugin-settings-")), file = join(dir, "settings.json");
  const before = process.env.LEANFARE_CLAUDE_SETTINGS;
  process.env.LEANFARE_CLAUDE_SETTINGS = file;
  try {
    writeFileSync(file, JSON.stringify({ hooks: {} }));
    expect(appHooksOn()).toBe(false);
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/Users/you/.leanfare/bin/leanfare hook stop" }] }] } }));
    expect(appHooksOn()).toBe(true);
    const r = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "hook", "stop"], { env: { ...process.env, LEANFARE_HOOK_FROM: "plugin" }, stdin: new TextEncoder().encode('{"session_id":"s1","stop_hook_active":false}') });
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, ""]);
  } finally {
    if (before === undefined) delete process.env.LEANFARE_CLAUDE_SETTINGS; else process.env.LEANFARE_CLAUDE_SETTINGS = before;
  }
});
