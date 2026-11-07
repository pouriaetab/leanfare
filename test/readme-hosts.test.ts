// The README's section for any MCP host (0.15.3, asked by the GitHub MCP Registry's review on 6 Nov 2026): the command,
// its args and no environment variables, as the bundles start it; where the install line puts the program; the hosts;
// and the packages the registry lists, as scripts/mcpb.ts writes them.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCPB_TARGETS, REGISTRY_NAME, manifestFor, serverJson } from "../scripts/mcpb";

const ROOT = join(import.meta.dir, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("## In any MCP host"), readme.indexOf("## Privacy"));

test("the README says how any MCP host runs Leanfare, as the bundles and the install line do", () => {
  expect(section.length).toBeGreaterThan(500);
  const config = JSON.parse(/```json\n([\s\S]*?)```/.exec(section)![1]);
  expect(config.mcpServers.leanfare).toEqual({ command: "/Users/you/.leanfare/bin/leanfare", args: ["mcp"] });
  // The same args the one-click bundles start, with no environment variables.
  const m = manifestFor("darwin-arm64", "0.15.3", []);
  expect(m.server.mcp_config.args).toEqual(config.mcpServers.leanfare.args);
  expect(m.server.mcp_config.env).toEqual({});
  // Where the install lines put the program.
  expect(readFileSync(join(ROOT, "install.sh"), "utf8")).toContain('DIR="${LEANFARE_INSTALL_DIR:-$HOME/.leanfare/bin}"');
  expect(readFileSync(join(ROOT, "install.ps1"), "utf8")).toContain('Join-Path $env:LOCALAPPDATA "Leanfare\\bin"');
  expect(section).toContain("`~/.leanfare/bin/leanfare`");
  expect(section).toContain("`%LOCALAPPDATA%\\Leanfare\\bin\\leanfare.exe`");
  expect(section).toContain("VS Code with GitHub Copilot");
  expect(section).toContain("other hosts are not tested");
});

test("the README names the packages the registry lists: an MCPB bundle for each computer Claude Desktop runs on", () => {
  const s = serverJson("0.15.3", { "darwin-arm64": "a", "darwin-x64": "b", "windows-x64": "c" });
  expect(s.name).toBe(REGISTRY_NAME);
  expect(section).toContain(`\`${REGISTRY_NAME}\``);
  expect(s.packages.map((p) => [p.registryType, p.transport.type])).toEqual([["mcpb", "stdio"], ["mcpb", "stdio"], ["mcpb", "stdio"]]);
  expect(Object.keys(MCPB_TARGETS)).toEqual(["darwin-arm64", "darwin-x64", "windows-x64"]);
  expect(section).toContain("macOS on Apple silicon, macOS on Intel, and Windows");
});
