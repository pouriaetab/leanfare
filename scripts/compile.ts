// Leanfare as one file per kind of computer: bun build --compile, with the screens and the price
// list inside (src/assets.ts). Each file is the whole app (Bun itself is inside, so about 60 to
// 100 MB); nothing else is needed to run it. Then each goes in an archive with the README, the
// licence and Bun's licence (licenses/bun.md), and SHA256SUMS lists the archives' checksums
// (install.sh checks them).
//
//   bun scripts/compile.ts              every target, into dist/
//   bun scripts/compile.ts linux-x64    only the ones named
//   bun scripts/compile.ts --check      also start the one for this computer and ask it for its screens
//
// The x64 builds use Bun's "baseline" build, which runs on older processors too (no AVX2 needed).
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
export const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64-baseline",
};
const named = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const unknown = named.filter((n) => !TARGETS[n]);
if (unknown.length) { console.error(`Unknown target: ${unknown.join(", ")}. Targets: ${Object.keys(TARGETS).join(", ")}.`); process.exit(2); }
const targets = named.length ? named : Object.keys(TARGETS);
const run = (cmd: string[], cwd = ROOT) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) { console.error(`Failed: ${cmd.join(" ")}`); process.exit(1); }
};
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const mb = (file: string) => `${(statSync(file).size / 1e6).toFixed(1)} MB`;

mkdirSync(DIST, { recursive: true });
for (const name of targets) {
  const windows = name.startsWith("windows");
  const exe = windows ? "leanfare.exe" : "leanfare";
  const stage = mkdtempSync(join(tmpdir(), `leanfare-${name}-`));
  const bin = join(stage, exe);
  console.log(`\n== ${name} (${TARGETS[name]})`);
  run([process.execPath, "build", "--compile", `--target=${TARGETS[name]}`, join(ROOT, "src", "cli.ts"), "--outfile", bin]);
  if (!windows) chmodSync(bin, 0o755);
  copyFileSync(join(ROOT, "README.md"), join(stage, "README.md"));
  copyFileSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  copyFileSync(join(ROOT, "licenses", "bun.md"), join(stage, "LICENSE-bun.md")); // Bun is inside the program
  const archive = join(DIST, `leanfare-${name}.${windows ? "zip" : "tar.gz"}`);
  rmSync(archive, { force: true });
  if (windows) run(["zip", "-q", "-X", archive, exe, "README.md", "LICENSE", "LICENSE-bun.md"], stage);
  else run(["tar", "-czf", archive, "-C", stage, exe, "README.md", "LICENSE", "LICENSE-bun.md"]);
  console.log(`${archive.slice(ROOT.length)}: ${mb(archive)} (the program itself ${mb(bin)})`);
  rmSync(stage, { recursive: true, force: true });
}

// The checksums of every archive in dist/, not only the ones built now.
const archives = Object.keys(TARGETS).map((n) => `leanfare-${n}.${n.startsWith("windows") ? "zip" : "tar.gz"}`).filter((f) => existsSync(join(DIST, f)));
writeFileSync(join(DIST, "SHA256SUMS"), archives.map((f) => `${sha256(join(DIST, f))}  ${f}`).join("\n") + "\n");
console.log(`\ndist/SHA256SUMS: ${archives.length} archive${archives.length === 1 ? "" : "s"}`);

// --check: the build for this computer starts, serves its screens and its price list, and stops.
if (process.argv.includes("--check")) {
  const here = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (!targets.includes(here)) { console.error(`--check needs the ${here} build.`); process.exit(1); }
  const dir = mkdtempSync(join(tmpdir(), "leanfare-check-"));
  const ext = here.startsWith("windows") ? "zip" : "tar.gz";
  if (ext === "zip") run(["unzip", "-q", join(DIST, `leanfare-${here}.zip`), "-d", dir]);
  else run(["tar", "-xzf", join(DIST, `leanfare-${here}.tar.gz`), "-C", dir]);
  const bin = join(dir, here.startsWith("windows") ? "leanfare.exe" : "leanfare");
  const port = 4900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, LEANFARE_DATA_DIR: join(dir, "data"), LEANFARE_PORT: String(port), LEANFARE_NO_OPEN: "1", LEANFARE_KEYSTORE: "file", LEANFARE_SHELL_ENV: "off", LEANFARE_LOCAL_PORTS: "none", LEANFARE_DATA_URL: "http://127.0.0.1:9/none.json" };
  const version = Bun.spawnSync([bin, "--version"], { env }).stdout.toString().trim();
  const want = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (version !== want) { console.error(`--version said "${version}", not ${want}.`); process.exit(1); }
  const app = Bun.spawn([bin, "--no-open"], { env, stdout: "ignore", stderr: "inherit" });
  const base = `http://127.0.0.1:${port}`;
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) { await Bun.sleep(100); ok = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false); }
  const fail = (why: string) => { app.kill(); console.error(`The compiled Leanfare ${why}.`); process.exit(1); };
  if (!ok) fail("did not start");
  const page = await fetch(base + "/").then((r) => r.text());
  if (!page.includes("<title>Leanfare")) fail("did not serve its page");
  const js = await fetch(base + "/app.js").then((r) => r.text());
  if (!js.includes("function h(")) fail("did not serve app.js");
  const state = await fetch(base + "/api/state", { headers: { "x-leanfare": "1" } }).then((r) => r.json()).catch(() => null) as any;
  const models = state ? Object.values(state.models ?? {}).flat().length : 0;
  if (models < 50) fail(`listed only ${models} models (the price list inside it did not load)`);
  const help = Bun.spawnSync([bin, "--help"], { env }).stdout.toString();
  if (!help.includes("leanfare mcp")) fail("printed no help");
  // The door Claude Desktop and other MCP clients use: it answers and lists its tools.
  const door = Bun.spawnSync([bin, "mcp"], {
    env: { ...env, LEANFARE_URL: base },
    stdin: new TextEncoder().encode([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n"),
  });
  const replies = door.stdout.toString().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tools = replies.find((m) => m.id === 2)?.result?.tools?.map((t: any) => t.name) ?? [];
  if (!tools.includes("delegate") || !tools.includes("trial")) fail(`listed these MCP tools: ${tools.join(", ") || "none"}`);
  app.kill();
  await app.exited;
  rmSync(dir, { recursive: true, force: true });
  console.log(`Checked ${here}: version ${version}, its page, app.js, ${models} models from the price list inside it, and its MCP door (${tools.length} tools).`);
}
