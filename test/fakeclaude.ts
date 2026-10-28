// A stand in for Claude Code's claude command (mcp add, mcp remove), written to .claude.json the way
// Claude Code does: in CLAUDE_CONFIG_DIR when that is set, else in the home folder. Tests never run
// the real command (setup.ts points LEANFARE_CLAUDE_BIN at nothing until a test asks for this one).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function fakeClaude(folder: string, opts: { slowMs?: number } = {}): string {
  const f = join(folder, "bin", "claude");
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `#!${process.execPath}
const fs = require("fs"), path = require("path");
const root = String(process.env.CLAUDE_CONFIG_DIR || "").split(",")[0].trim() || process.env.HOME;
// Never outside a test's own folder: a stand in that wrote to the real .claude.json would change Claude Code's settings.
if (!/leanfare-/.test(String(root))) { console.error("not a test folder: " + root); process.exit(3); }
const file = path.join(root, ".claude.json");
const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const a = process.argv.slice(2);
${opts.slowMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${opts.slowMs}); // a slow claude` : ""}
j.mcpServers ??= {};
if (a[0] === "mcp" && a[1] === "add") { const i = a.indexOf("--"); j.mcpServers[a[4]] = { type: "stdio", command: a[i + 1], args: a.slice(i + 2), env: {} }; console.log("Added stdio MCP server " + a[4]); }
else if (a[0] === "mcp" && a[1] === "remove") { if (!j.mcpServers[a[4]]) { console.error("No MCP server found"); process.exit(1); } delete j.mcpServers[a[4]]; }
fs.writeFileSync(file, JSON.stringify(j));
`);
  chmodSync(f, 0o755);
  process.env.LEANFARE_CLAUDE_BIN = f;
  return f;
}
