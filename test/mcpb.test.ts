// 0.12, one-click installs (scripts/mcpb.ts): a .mcpb bundle for each computer Claude Desktop runs on, made from the
// release archives, and server.json for the official MCP Registry with each bundle's address and checksum.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPB_TARGETS, SHORT, buildBundles, manifestFor, serverJson } from "../scripts/mcpb";
import { TOOLS } from "../src/mcp";

test("the manifest: a binary server that starts the MCP door, every tool, one platform each", () => {
  const mac = manifestFor("darwin-arm64", "0.12.0", TOOLS), win = manifestFor("windows-x64", "0.12.0", TOOLS);
  expect(mac).toMatchObject({ manifest_version: "0.3", name: "leanfare", version: "0.12.0", author: { name: "pouriaetab" }, icon: "icon.png", license: "MIT", compatibility: { platforms: ["darwin"] } });
  expect(mac.server).toEqual({ type: "binary", entry_point: "server/leanfare", mcp_config: { command: "${__dirname}/server/leanfare", args: ["mcp"], env: {} } });
  expect(win.server.mcp_config.command).toBe("${__dirname}/server/leanfare.exe");
  expect(win.compatibility.platforms).toEqual(["win32"]);
  expect(mac.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  for (const t of mac.tools) expect(t.description.length).toBeLessThanOrEqual(240);
  expect(() => manifestFor("linux-x64", "0.12.0", TOOLS)).toThrow("No bundle for linux-x64");
});

test("server.json: the Registry's name, a short description, and each bundle's release address and checksum", () => {
  const s = serverJson("0.12.0", { "darwin-arm64": "a".repeat(64), "windows-x64": "b".repeat(64) });
  expect(s).toMatchObject({ name: "io.github.pouriaetab/leanfare", version: "0.12.0", repository: { url: "https://github.com/pouriaetab/leanfare", source: "github" } });
  expect(SHORT.length).toBeLessThanOrEqual(100);
  expect(s.packages).toEqual([
    { registryType: "mcpb", identifier: "https://github.com/pouriaetab/leanfare/releases/download/v0.12.0/leanfare-darwin-arm64.mcpb", fileSha256: "a".repeat(64), transport: { type: "stdio" } },
    { registryType: "mcpb", identifier: "https://github.com/pouriaetab/leanfare/releases/download/v0.12.0/leanfare-windows-x64.mcpb", fileSha256: "b".repeat(64), transport: { type: "stdio" } },
  ]);
  for (const p of s.packages) expect(p.identifier).toContain("mcp"); // the Registry's rule for MCPB addresses
});

test("the bundles from the release archives: the program with its run bit, the manifest, the icon; listed in SHA256SUMS and server.json", async () => {
  const dist = mkdtempSync(join(tmpdir(), "leanfare-dist-")), src = mkdtempSync(join(tmpdir(), "leanfare-src-"));
  writeFileSync(join(src, "leanfare"), "#!/bin/sh\necho 0.12.0\n"); chmodSync(join(src, "leanfare"), 0o755);
  writeFileSync(join(src, "leanfare.exe"), "MZ fake");
  for (const f of ["README.md", "LICENSE", "LICENSE-bun.md"]) writeFileSync(join(src, f), f);
  const sh = (cmd: string[], cwd = src) => expect(Bun.spawnSync(cmd, { cwd }).exitCode).toBe(0);
  sh(["tar", "-czf", join(dist, "leanfare-darwin-arm64.tar.gz"), "leanfare", "README.md", "LICENSE", "LICENSE-bun.md"]);
  sh(["zip", "-q", "-X", join(dist, "leanfare-windows-x64.zip"), "leanfare.exe", "README.md", "LICENSE", "LICENSE-bun.md"]);
  writeFileSync(join(dist, "SHA256SUMS"), "1111  leanfare-darwin-arm64.tar.gz\n2222  leanfare-windows-x64.zip\n");
  const made = await buildBundles(dist);
  expect(made.map((f) => f.slice(dist.length + 1))).toEqual(["leanfare-darwin-arm64.mcpb", "leanfare-windows-x64.mcpb"]); // no Intel archive here: no Intel bundle
  const list = Bun.spawnSync(["unzip", "-Z", join(dist, "leanfare-darwin-arm64.mcpb")]).stdout.toString();
  expect(list).toMatch(/-rwxr-xr-x .* server\/leanfare\n/);
  for (const f of ["manifest.json", "icon.png", "README.md", "LICENSE", "LICENSE-bun.md"]) expect(list).toContain(` ${f}\n`);
  const out = mkdtempSync(join(tmpdir(), "leanfare-unz-"));
  expect(Bun.spawnSync(["unzip", "-q", join(dist, "leanfare-windows-x64.mcpb"), "-d", out]).exitCode).toBe(0);
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  expect([m.version, m.server.entry_point]).toEqual([JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "server/leanfare.exe"]);
  const sum = (f: string) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex");
  const sums = readFileSync(join(dist, "SHA256SUMS"), "utf8");
  expect(sums).toContain("1111  leanfare-darwin-arm64.tar.gz\n");
  expect(sums).toContain(`${sum("leanfare-darwin-arm64.mcpb")}  leanfare-darwin-arm64.mcpb\n`);
  const s = JSON.parse(readFileSync(join(dist, "server.json"), "utf8"));
  expect(s.packages.map((p: any) => p.fileSha256)).toEqual([sum("leanfare-darwin-arm64.mcpb"), sum("leanfare-windows-x64.mcpb")]);
  // Built again: each bundle once in SHA256SUMS.
  await buildBundles(dist);
  expect(readFileSync(join(dist, "SHA256SUMS"), "utf8").split("\n").filter((l) => l.endsWith("leanfare-darwin-arm64.mcpb")).length).toBe(1);
  expect(Object.keys(MCPB_TARGETS)).toEqual(["darwin-arm64", "darwin-x64", "windows-x64"]);
}, 30000);
