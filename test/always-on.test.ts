// Always on (0.14.1): Leanfare starts with the computer and comes back if it stops (a LaunchAgent on a Mac, a systemd
// user unit on Linux, and in the Mac app Open at Login and its own restarts); an app's door waits longer for a start
// and, when one fails, says why from what that Leanfare said.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSaid, notStarted, startWait } from "../src/client";
import { installService, LABEL, plistText, removeService, serviceFile, serviceStatus, unitText } from "../src/service";

const home = () => mkdtempSync(join(tmpdir(), "lf-home-"));
const runner = () => { const ran: string[][] = []; return { ran, run: (cmd: string[]) => { ran.push(cmd); return { code: 0, out: "" }; } }; };
const CMD = ["/Users/you/.bun/bin/bun", "/Users/you/leanfare/src/cli.ts", "--no-open"];

describe("always on", () => {
  test("a Mac: a LaunchAgent that starts at login and again after a failure, never after a clean stop", () => {
    const t = plistText(CMD, "/Users/you/.leanfare/service.log");
    expect(t).toContain(`<string>${LABEL}</string>`);
    expect(t).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(t).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(t).toContain("<string>/Users/you/.bun/bin/bun</string>\n    <string>/Users/you/leanfare/src/cli.ts</string>\n    <string>--no-open</string>");
    expect(t).toContain("<string>/Users/you/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>");
    const h = home(), r = runner();
    const got = installService({ os: "darwin", home: h, runner: r, command: CMD });
    expect(got.ok).toBe(true);
    expect(got.file).toBe(join(h, "Library", "LaunchAgents", `${LABEL}.plist`));
    expect(readFileSync(got.file!, "utf8")).toBe(plistText(CMD));
    expect(r.ran.map((c) => c.slice(0, 2).join(" "))).toEqual(["launchctl bootout", "launchctl bootstrap"]);
    expect(serviceStatus({ os: "darwin", home: h }).text).toStartWith("On: Leanfare starts by itself");
    expect(removeService({ os: "darwin", home: h, runner: r }).text).toBe("Leanfare no longer starts by itself. It runs while you keep it open.");
    expect(existsSync(got.file!)).toBe(false);
    expect(serviceStatus({ os: "darwin", home: h }).text).toContain("leanfare service install (or, with the Mac app, Open at Login in its menu)");
  });

  test("Linux: a systemd user unit, enabled now and at every session, restarted on failure; Windows says what to do", () => {
    expect(unitText(["/opt/bun", "/home/me/leanfare/src/cli.ts", "--no-open"])).toContain("ExecStart=/opt/bun /home/me/leanfare/src/cli.ts --no-open\nEnvironment=LEANFARE_NO_OPEN=1\nRestart=on-failure");
    const h = home(), r = runner();
    const got = installService({ os: "linux", home: h, runner: r, command: CMD });
    expect([got.ok, got.file]).toEqual([true, serviceFile("linux", h)]);
    expect(r.ran.map((c) => c.join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now leanfare.service"]);
    expect(installService({ os: "other" }).text).toStartWith("Always on is for macOS and Linux for now.");
    const failing = { run: (cmd: string[]) => ({ code: cmd.includes("enable") ? 1 : 0, out: cmd.includes("enable") ? "Failed to connect to bus" : "" }) };
    expect(installService({ os: "linux", home: home(), runner: failing, command: CMD }).text).toContain("but systemctl said: Failed to connect to bus.");
  });

  test("a door waits 20 seconds for a start, and a failed start says what Leanfare said", () => {
    expect(startWait()).toBe(Number(process.env.LEANFARE_START_WAIT) > 0 ? Number(process.env.LEANFARE_START_WAIT) : 20);
    const f = join(home(), "start.log");
    writeFileSync(f, "Leanfare 0.14.1\nloading prices\nerror: Port 4747 is in use (EADDRINUSE)\n");
    expect(lastSaid(f)).toBe("error: Port 4747 is in use (EADDRINUSE)");
    expect(lastSaid(join(home(), "none.log"))).toBe(null);
    expect(notStarted("error: Port 4747 is in use (EADDRINUSE)")).toStartWith("Leanfare did not start (it said: error: Port 4747 is in use (EADDRINUSE)). Open it once from Terminal with: leanfare");
  });

  test("the Mac app starts Leanfare again by itself, up to 3 times in 10 minutes, and turns on Open at Login once", () => {
    const swift = readFileSync(join(import.meta.dir, "..", "mac", "Leanfare.swift"), "utf8");
    expect(swift).toContain("let wait = [2.0, 10.0, 30.0][restarts.count]");
    expect(swift).toContain("restarts = restarts.filter { now.timeIntervalSince($0) < 600 }");
    expect(swift).toContain('if !UserDefaults.standard.bool(forKey: "loginOnce") {');
    expect(swift).toContain("if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }");
  });
});
