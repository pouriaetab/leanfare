// What the Mac app relies on, checked from here (the app itself is built on a
// Mac): the summary it reads every few seconds, the files build.sh copies into
// the app, and that Leanfare runs from that copy.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TICKED, boot, keys, post, reset } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const root = new URL("..", import.meta.url).pathname;
const swift = readFileSync(join(root, "mac/Leanfare.swift"), "utf8");

describe("the Mac app's needs", () => {
  test("the summary has every field the app decodes, with the type it expects", async () => {
    await reset({ ticked: ALL_TICKED, budget: 10 });
    await keys("openai");
    await post(`${url}/v1/chat/completions`, { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Hi [usage 2000 500]" }] });
    const r = await fetch(`${url}/api/summary`, { headers: { "x-leanfare": "1", "x-leanfare-token": "test-token" } });
    expect(r.status).toBe(200);
    const s = await r.json();
    const block = /struct Summary: Decodable \{([\s\S]*?)\n\}/.exec(swift)![1];
    const fields = [...block.matchAll(/^\s{4}let (\w+): (\w+)(\?)?$/gm)].map((m) => ({ name: m[1], type: m[2], optional: !!m[3] }));
    expect(fields.map((f) => f.name)).toEqual(["todayText", "monthText", "answers", "paused", "locked", "running", "budget", "plans"]);
    const kinds: Record<string, "string" | "number" | "boolean" | "object"> = { String: "string", Int: "number", Double: "number", Bool: "boolean", Budget: "object", Plans: "object" };
    for (const f of fields) {
      if (f.optional && s[f.name] === null) continue;
      expect(typeof s[f.name]).toBe(kinds[f.type]);
    }
    expect(s.todayText).toBe("<$0.01");
    expect(s.budget).toMatchObject({ amount: 10, warn: false, reached: false });
    for (const k of ["amount", "left", "pct", "warn", "reached"]) expect(k in s.budget).toBe(true);
  });

  test("the menu bar text stays short", async () => {
    const { summary } = await import("../src/server");
    expect(summary().todayText).toBe("$0");
  });

  test("the app uses only addresses the server has", () => {
    const paths = [...swift.matchAll(/(?:"|\))(\/(?:api|healthz|unlock)[^"\\?]*)/g)].map((m) => m[1]);
    expect([...new Set(paths)].sort()).toEqual(["/api/control/stop", "/api/pause", "/api/summary", "/healthz", "/unlock"]);
  });

  test("Info.plist allows the local address and names the notes file", () => {
    const plist = readFileSync(join(root, "mac/Info.plist"), "utf8");
    for (const k of ["NSAllowsLocalNetworking", "127.0.0.1", "LSUIElement", "LeanfareNotesFile", "LeanfareBun", "__VERSION__", "__BUILD__", "CFBundleIconFile"]) expect(plist).toContain(k);
    expect(Bun.file(join(root, "mac/AppIcon.icns")).size).toBeGreaterThan(10_000);
  });

  test("the app uses the Bun the build found, wherever it is installed", () => {
    const build = readFileSync(join(root, "mac/build.sh"), "utf8");
    expect(build).toContain("process.execPath"); // past a mise, asdf or proto shim, to Bun itself
    expect(build).toContain('plutil -replace LeanfareBun -string "$BUN_PATH"');
    expect(swift).toContain('forInfoDictionaryKey: "LeanfareBun"');
    expect(swift.indexOf('"LeanfareBun"')).toBeLessThan(swift.indexOf('".bun/bin/bun"'));
  });

  test("a window left on the lock screen opens itself again, unlocked", () => {
    const app = readFileSync(join(root, "ui/app.js"), "utf8");
    expect(app).toContain("messageHandlers?.leanfareLocked");
    expect(swift).toContain('add(self, name: "leanfareLocked")');
    expect(swift).toContain("w.onLocked = { [weak self] in self?.reloadPage() }");
  });

  test("a Leanfare that stops answering, or starts late, is noticed", () => {
    // No summary: the app looks again (a new port or token) and says Leanfare stopped.
    expect(swift).toContain("guard let s = s else { self.notAnswering(); return }");
    // An answer clears an old problem and opens the window that was asked for.
    expect(/self\.last = s\s+self\.problem = nil\s+if self\.windowWanted/.test(swift)).toBe(true);
  });

  test("the build points the Swift compiler at the macOS SDK", () => {
    // swiftc run by its full path (from xcrun --find) cannot load the standard library without -sdk
    const build = readFileSync(join(root, "mac/build.sh"), "utf8");
    expect(build).toContain("xcrun --sdk macosx --show-sdk-path");
    expect(build).toContain('-parse-as-library -sdk "$SDK" -target');
  });

  test("Leanfare runs from the copy build.sh puts in the app", async () => {
    const build = readFileSync(join(root, "mac/build.sh"), "utf8");
    expect(build).toContain('cp -R "$ROOT/src" "$ROOT/ui" "$APP/Contents/Resources/leanfare/"');
    expect(build).toContain('cp "$ROOT/data/catalog.json" "$APP/Contents/Resources/leanfare/data/"');
    expect(swift).toContain('appendingPathComponent("leanfare/src/cli.ts")');
    // The same layout, in a temp folder, started the way the app starts it.
    const res = join(mkdtempSync(join(tmpdir(), "leanfare-app-")), "Resources", "leanfare");
    mkdirSync(join(res, "data"), { recursive: true });
    cpSync(join(root, "src"), join(res, "src"), { recursive: true });
    cpSync(join(root, "ui"), join(res, "ui"), { recursive: true });
    cpSync(join(root, "package.json"), join(res, "package.json"));
    cpSync(join(root, "data/catalog.json"), join(res, "data/catalog.json"));
    const port = 4900 + Math.floor(Math.random() * 90);
    const dataDir = mkdtempSync(join(tmpdir(), "leanfare-appdata-"));
    const child = Bun.spawn([process.execPath, join(res, "src/cli.ts"), "--no-open", "--port", String(port)], { env: { ...process.env, LEANFARE_DATA_DIR: dataDir, LEANFARE_NO_OPEN: "1", LEANFARE_DATA_URL: "http://127.0.0.1:9/none" }, stdout: "pipe", stderr: "pipe" });
    try {
      let ok = false;
      for (let i = 0; i < 80 && !ok; i++) { await Bun.sleep(100); ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false); }
      expect(ok).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
      const token = readFileSync(join(dataDir, "control.token"), "utf8").trim();
      const summary = await fetch(`http://127.0.0.1:${port}/api/summary`, { headers: { "x-leanfare": "1", "x-leanfare-token": token } });
      expect(summary.status).toBe(200);
      const stop = await fetch(`http://127.0.0.1:${port}/api/control/stop`, { method: "POST", headers: { "x-leanfare": "1", "x-leanfare-token": token, "content-type": "application/json" }, body: "{}" });
      expect(stop.status).toBe(200);
      expect(await child.exited).toBe(0);
    } finally { try { child.kill(); } catch {} }
  }, 20000);
});
