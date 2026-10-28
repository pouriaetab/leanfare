// The `leanfare` command itself: start, status, stop, and its exit codes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../src/config";
import { fake } from "./app";
import { KEYS } from "./fake";
import { freePort } from "./ports";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const port = await freePort();
const env = (dir = mkdtempSync(join(tmpdir(), "leanfare-cli-"))) => {
  // LEANFARE_PORT: a command with no record of a running Leanfare looks at the test's port, never at the
  // one a real Leanfare uses on this computer (the Mac app's, 4747).
  const e: Record<string, string> = { ...(process.env as Record<string, string>), LEANFARE_DATA_DIR: dir, LEANFARE_KEYSTORE: "file", LEANFARE_NO_OPEN: "1", LEANFARE_DATA_URL: `${fake.base}/data.json`, LEANFARE_PORT: String(port) };
  delete e.LEANFARE_NOW;
  return e;
};
const run = async (args: string[], e: Record<string, string>) => {
  const p = Bun.spawn([process.execPath, cliPath, ...args], { env: e, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out + err, code };
};
const upOn = async (p: number) => {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${p}/healthz`).then((r) => r.ok).catch(() => false)) return true;
    await Bun.sleep(50);
  }
  return false;
};
const dir = mkdtempSync(join(tmpdir(), "leanfare-cli-"));
let app: ReturnType<typeof Bun.spawn> | null = null;
afterAll(() => { try { app?.kill(); } catch {} });

describe("leanfare", () => {
  test("--version prints the version", async () => {
    const r = await run(["--version"], env());
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(VERSION);
  });
  test("an unknown command exits 2 with the help", async () => {
    const r = await run(["fly"], env());
    expect(r.code).toBe(2);
    expect(r.out).toContain('Unknown command "fly"');
  });
  test("status when nothing runs exits 3", async () => {
    expect((await run(["status", "--port", String(port)], env(dir))).code).toBe(3);
  });
  test("starts, prints its address and versions, and answers within a second", async () => {
    const t0 = performance.now();
    app = Bun.spawn([process.execPath, cliPath, "--port", String(port)], { env: env(dir), stdout: "pipe", stderr: "pipe" });
    expect(await upOn(port)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500); // within a second and a half, the spawn itself included
  });
  test("a second start finds the first and exits 0", async () => {
    const r = await run(["--port", String(port)], env(dir));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`already running at http://127.0.0.1:${port}`);
  });
  test("status says where it runs", async () => {
    const r = await run(["status"], env(dir));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Leanfare ${VERSION} is running at http://127.0.0.1:${port}`);
  });
  test("a port taken by another program exits 4 and says what to do", async () => {
    const r = await run(["--port", String(port)], env()); // another data folder: no record of the first
    expect(r.code).toBe(4);
    expect(r.out).toContain(`Port ${port} is taken by another program`);
    expect(r.out).toContain(`leanfare --port ${port + 1}`);
  });
  test("stop ends it cleanly, and stopping again is fine", async () => {
    const r = await run(["stop"], env(dir));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Leanfare stopped.");
    expect(await app!.exited).toBe(0);
    const out = await new Response(app!.stdout as ReadableStream).text();
    expect(out).toContain(`Leanfare ${VERSION} · Bun ${Bun.version}`);
    expect(out).toContain(`Running at http://127.0.0.1:${port}`);
    const again = await run(["stop"], env(dir));
    expect(again.code).toBe(0);
    expect(again.out).toContain("not running");
  });
  test("stop and status leave alone a Leanfare that uses another data folder, even when its port is named", async () => {
    const q = await freePort();
    const otherEnv = { ...env(), LEANFARE_PORT: String(q) };
    const other = Bun.spawn([process.execPath, cliPath, "--port", String(q)], { env: otherEnv, stdout: "pipe", stderr: "pipe" });
    try {
      expect(await upOn(q)).toBe(true);
      const mine = { ...env(), LEANFARE_PORT: String(q) }; // no record of it here, and its port is this folder's default
      const s = await run(["stop"], mine);
      expect(s.code).toBe(0);
      expect(s.out).toContain("not running from this data folder");
      expect((await run(["status"], mine)).code).toBe(3);
      expect((await run(["stop", "--port", String(q)], mine)).out).toContain("not running from this data folder");
      expect(await upOn(q)).toBe(true); // still running
      const own = await run(["stop"], otherEnv); // its own folder stops it
      expect(own.out).toContain("Leanfare stopped.");
      expect(await other.exited).toBe(0);
    } finally { try { other.kill(); } catch {} }
  });
});

describe("leanfare after a restart", () => {
  test("the OpenRouter credit is read again by itself at start", async () => {
    const d = mkdtempSync(join(tmpdir(), "leanfare-cli-"));
    const p = await freePort();
    const state = async () => (await (await fetch(`http://127.0.0.1:${p}/api/state`, { headers: { "x-leanfare": "1" } })).json()) as any;
    const credit = async () => (await state()).providers.find((x: any) => x.id === "openrouter").credit;
    let first: ReturnType<typeof Bun.spawn> | null = null, second: ReturnType<typeof Bun.spawn> | null = null;
    try {
      first = Bun.spawn([process.execPath, cliPath, "--port", String(p)], { env: env(d), stdout: "pipe", stderr: "pipe" });
      expect(await upOn(p)).toBe(true);
      const saved = await fetch(`http://127.0.0.1:${p}/api/keys`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ provider: "openrouter", key: KEYS.openrouter }) });
      expect((await saved.json()).ok).toBe(true);
      expect((await credit())?.remaining).toBe(7.5);
      expect((await run(["stop", "--port", String(p)], env(d))).code).toBe(0);
      await first.exited;
      second = Bun.spawn([process.execPath, cliPath, "--port", String(p)], { env: env(d), stdout: "pipe", stderr: "pipe" });
      expect(await upOn(p)).toBe(true);
      let got = null;
      for (let i = 0; i < 40 && !got; i++) { got = await credit(); if (!got) await Bun.sleep(100); }
      expect(got?.remaining).toBe(7.5);
    } finally { try { first?.kill(); second?.kill(); } catch {} }
  }, 30000);
});
