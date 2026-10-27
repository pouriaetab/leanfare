// install.sh, against a stand in for a GitHub release: it checks the checksum, installs one file,
// adds one PATH line to the shell's own settings file (once), and changes nothing when anything is off.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../install.sh", import.meta.url).pathname;
const release = mkdtempSync(join(tmpdir(), "leanfare-release-"));
let sums = "";
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  // A pretend leanfare for each Linux build: it answers --version, as the real one does.
  for (const name of ["leanfare-linux-x64", "leanfare-linux-arm64", "leanfare-darwin-arm64", "leanfare-darwin-x64"]) {
    const stage = mkdtempSync(join(tmpdir(), "leanfare-stage-"));
    writeFileSync(join(stage, "leanfare"), "#!/bin/sh\n[ \"$1\" = --version ] && echo 0.4.0\n");
    chmodSync(join(stage, "leanfare"), 0o755);
    Bun.spawnSync(["tar", "-czf", join(release, `${name}.tar.gz`), "-C", stage, "leanfare"]);
    sums += `${createHash("sha256").update(readFileSync(join(release, `${name}.tar.gz`))).digest("hex")}  ${name}.tar.gz\n`;
  }
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const file = new URL(req.url).pathname.slice(1);
    if (file === "SHA256SUMS") return new Response(served.sums);
    return existsSync(join(release, file)) ? new Response(Bun.file(join(release, file))) : new Response("not found", { status: 404 });
  } });
});
afterAll(() => server.stop(true));
const served = { get sums() { return sums; } };

// Not spawnSync: the stand in release is served from this same process, so it must keep running.
async function install(shell: string, extra: Record<string, string> = {}) {
  const home = extra.HOME ?? mkdtempSync(join(tmpdir(), "leanfare-home-"));
  const p = Bun.spawn(["sh", script], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: home, SHELL: shell, LEANFARE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`, ...extra } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { home, code, out: out + err };
}

describe("install.sh", () => {
  test("installs leanfare in ~/.leanfare/bin and adds it to bash's PATH, once", async () => {
    const r = await install("/bin/bash");
    expect(r.code).toBe(0);
    const bin = join(r.home, ".leanfare", "bin", "leanfare");
    expect(statSync(bin).mode & 0o111).toBeTruthy();
    expect(r.out).toContain(`Installed Leanfare 0.4.0 in ${join(r.home, ".leanfare", "bin")}.`);
    expect(r.out).toContain("Start it:            leanfare");
    const rc = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
    expect(readFileSync(join(r.home, rc), "utf8")).toBe(`\n# Leanfare\nexport PATH="${join(r.home, ".leanfare", "bin")}:$PATH"\n`);
    const again = await install("/bin/bash", { HOME: r.home });
    expect(again.code).toBe(0);
    expect(readFileSync(join(r.home, rc), "utf8").match(/# Leanfare/g)).toHaveLength(1);
  });
  test("zsh, fish and any other shell get their own file; LEANFARE_NO_PATH leaves them alone", async () => {
    const z = await install("/bin/zsh");
    expect(readFileSync(join(z.home, ".zshrc"), "utf8")).toContain(`export PATH="${join(z.home, ".leanfare", "bin")}:$PATH"`);
    const f = await install("/usr/bin/fish");
    expect(readFileSync(join(f.home, ".config", "fish", "config.fish"), "utf8")).toContain(`fish_add_path "${join(f.home, ".leanfare", "bin")}"`);
    const o = await install("/bin/ksh");
    expect(readFileSync(join(o.home, ".profile"), "utf8")).toContain(".leanfare/bin");
    const n = await install("/bin/zsh", { LEANFARE_NO_PATH: "1" });
    expect(n.code).toBe(0);
    expect(existsSync(join(n.home, ".zshrc"))).toBe(false);
  });
  test("a download that does not match its checksum changes nothing", async () => {
    const keep = sums;
    sums = sums.replace(/^[0-9a-f]{64}/gm, "0".repeat(64));
    try {
      const r = await install("/bin/bash");
      expect(r.code).toBe(1);
      expect(r.out).toContain("Leanfare was not installed: the download does not match the release's checksum, so nothing was changed.");
      expect(existsSync(join(r.home, ".leanfare"))).toBe(false);
      expect(existsSync(join(r.home, ".bashrc"))).toBe(false);
    } finally { sums = keep; }
  });
  test("another install folder, and a release that is not there says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "leanfare-home-"));
    mkdirSync(join(home, "tools"));
    const r = await install("/bin/bash", { HOME: home, LEANFARE_INSTALL_DIR: join(home, "tools"), LEANFARE_NO_PATH: "1" });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, "tools", "leanfare"))).toBe(true);
    const gone = await install("/bin/bash", { LEANFARE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/nothing` });
    expect(gone.code).toBe(1);
    expect(gone.out).toContain("Leanfare was not installed: could not download");
  });
});
