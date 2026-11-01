// One-click installs (0.12): a .mcpb bundle for each kind of computer Claude Desktop runs on (macOS on Apple silicon
// and on Intel, Windows), made from the archives scripts/compile.ts left in dist/: the program, its manifest (MCPB
// 0.3, a binary server that starts `leanfare mcp`), the icon and the licences. A double click on one adds Leanfare's
// MCP door to Claude Desktop. Then server.json for the official MCP Registry: each bundle's address on the release and
// its SHA-256, which apps check before they install it.
//
//   bun scripts/compile.ts && bun scripts/mcpb.ts     dist/leanfare-<target>.mcpb, dist/server.json, SHA256SUMS
//
// The version is package.json's, so the release's tag must be v<version> (release.yml checks it).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REPO = "https://github.com/pouriaetab/leanfare";
export const REGISTRY_NAME = "io.github.pouriaetab/leanfare";
// Where Claude Desktop runs, and the platform name a manifest uses for it.
export const MCPB_TARGETS: Record<string, "darwin" | "win32"> = { "darwin-arm64": "darwin", "darwin-x64": "darwin", "windows-x64": "win32" };
export const SHORT = "Hands reading, drafting and checks to cheaper models you pick, and shows what it saved."; // the Registry takes 100 characters

// A tool's first sentence, for the manifest's list.
const first = (s: string) => { const m = /^(.+?[.!?])(\s|$)/.exec(s); return (m ? m[1] : s).slice(0, 240); };

export function manifestFor(target: string, version: string, tools: { name: string; description: string }[]) {
  const platform = MCPB_TARGETS[target];
  if (!platform) throw new Error(`No bundle for ${target}: ${Object.keys(MCPB_TARGETS).join(", ")}.`);
  return {
    manifest_version: "0.3",
    name: "leanfare",
    display_name: "Leanfare",
    version,
    description: SHORT,
    long_description: "Leanfare works inside the AI apps you already use. It hands simple work, like reading files, searching, drafting and checking, to cheaper or free models you pick (with your own keys, or Ollama on your computer), so your app's plan lasts longer. Each answer comes back with a receipt, your app reviews and grades it, and Leanfare's page shows what was kept out and what it cost. It sends nothing anywhere by itself: work goes only to the providers you add, under their terms. Its page opens at http://127.0.0.1:4747 once it runs.",
    author: { name: "pouriaetab" },
    repository: { type: "git", url: REPO },
    homepage: REPO,
    documentation: `${REPO}/blob/main/docs/GUIDE.md`,
    support: `${REPO}/issues`,
    icon: "icon.png",
    server: {
      type: "binary",
      entry_point: platform === "win32" ? "server/leanfare.exe" : "server/leanfare",
      mcp_config: { command: platform === "win32" ? "${__dirname}/server/leanfare.exe" : "${__dirname}/server/leanfare", args: ["mcp"], env: {} },
    },
    tools: tools.map((t) => ({ name: t.name, description: first(t.description) })),
    keywords: ["tokens", "cost", "models", "delegate", "ollama", "claude"],
    license: "MIT",
    compatibility: { platforms: [platform] },
  };
}

export function serverJson(version: string, sums: Record<string, string>) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: REGISTRY_NAME,
    title: "Leanfare",
    description: SHORT,
    repository: { url: REPO, source: "github" },
    version,
    packages: Object.keys(MCPB_TARGETS).filter((t) => sums[t]).map((t) => ({
      registryType: "mcpb",
      identifier: `${REPO}/releases/download/v${version}/leanfare-${t}.mcpb`,
      fileSha256: sums[t],
      transport: { type: "stdio" },
    })),
  };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(cmd: string[], cwd = ROOT) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`Failed: ${cmd.join(" ")}`);
}

// Builds the bundles from dist/'s archives into dist/, adds them to SHA256SUMS, and writes server.json.
export async function buildBundles(dist = join(ROOT, "dist")): Promise<string[]> {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
  process.env.LEANFARE_DATA_DIR ??= mkdtempSync(join(tmpdir(), "leanfare-mcpb-data-")); // the tools' list loads the app's code: never the real data
  const { TOOLS } = await import("../src/mcp");
  const made: string[] = [], sums: Record<string, string> = {};
  for (const target of Object.keys(MCPB_TARGETS)) {
    const windows = target.startsWith("windows");
    const archive = join(dist, `leanfare-${target}.${windows ? "zip" : "tar.gz"}`);
    if (!existsSync(archive)) { console.log(`(no ${archive.slice(dist.length + 1)}: no bundle for ${target})`); continue; }
    const from = mkdtempSync(join(tmpdir(), `leanfare-${target}-in-`)), stage = mkdtempSync(join(tmpdir(), `leanfare-${target}-mcpb-`));
    if (windows) run(["unzip", "-q", archive, "-d", from]); else run(["tar", "-xzf", archive, "-C", from]);
    const exe = windows ? "leanfare.exe" : "leanfare";
    mkdirSync(join(stage, "server"));
    copyFileSync(join(from, exe), join(stage, "server", exe));
    for (const f of ["README.md", "LICENSE", "LICENSE-bun.md"]) copyFileSync(join(from, f), join(stage, f));
    copyFileSync(join(ROOT, "ui", "icon-512.png"), join(stage, "icon.png")); // 512 pixels, as Claude Desktop likes
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifestFor(target, version, TOOLS), null, 2) + "\n");
    const out = join(dist, `leanfare-${target}.mcpb`);
    rmSync(out, { force: true });
    run(["zip", "-q", "-X", "-r", out, "manifest.json", "icon.png", "server", "README.md", "LICENSE", "LICENSE-bun.md"], stage); // zip keeps the program's run bit
    sums[target] = sha256(out);
    made.push(out);
    console.log(`dist/${out.slice(dist.length + 1)}: ${(statSync(out).size / 1e6).toFixed(1)} MB`);
    rmSync(from, { recursive: true, force: true }); rmSync(stage, { recursive: true, force: true });
  }
  // SHA256SUMS lists the bundles too (each line once), and server.json carries their addresses and checksums.
  const sumsFile = join(dist, "SHA256SUMS");
  const kept = existsSync(sumsFile) ? readFileSync(sumsFile, "utf8").split("\n").filter((l) => l && !l.endsWith(".mcpb")) : [];
  writeFileSync(sumsFile, [...kept, ...Object.entries(sums).map(([t, s]) => `${s}  leanfare-${t}.mcpb`)].join("\n") + "\n");
  writeFileSync(join(dist, "server.json"), JSON.stringify(serverJson(version, sums), null, 2) + "\n");
  console.log(`dist/server.json: ${Object.keys(sums).length} bundle${Object.keys(sums).length === 1 ? "" : "s"} for ${REGISTRY_NAME} ${version}`);
  return made;
}

if (import.meta.main) {
  try { await buildBundles(); process.exit(0); } catch (e: any) { console.error(String(e?.message ?? e)); process.exit(1); }
}
