// Always on (0.14.1): Leanfare starts with this computer and comes back if it stops, so an app's door never finds it off.
// On a Mac, a LaunchAgent (launchd starts it at login, and again after a crash, not after `leanfare stop`); on Linux, a
// systemd user unit (the same, with Restart=on-failure). The Mac app does the same with Open at Login and its own
// restarts, so with the app this is not needed. `leanfare service install`, `remove` and `status`.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config";
import { selfCommand } from "./self";

export const LABEL = "dev.leanfare.server";
export type Os = "darwin" | "linux" | "other";
export const osOf = (p = process.platform): Os => (p === "darwin" ? "darwin" : p === "linux" ? "linux" : "other");
// Where the file goes, by system.
export const serviceFile = (os: Os, home = homedir()) => (os === "darwin" ? join(home, "Library", "LaunchAgents", `${LABEL}.plist`) : join(home, ".config", "systemd", "user", "leanfare.service"));
const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

// The LaunchAgent: at login, and again when it stops with a failure (a clean stop stays stopped).
export function plistText(command: string[], log = join(DATA_DIR, "service.log")): string {
  const args = command.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const path = [...new Set([dirname(command[0]), ...PATH_DIRS])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LEANFARE_NO_OPEN</key>
    <string>1</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

// The systemd user unit: started with your session, and again after a failure.
export function unitText(command: string[]): string {
  const q = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a);
  return `[Unit]
Description=Leanfare (runs AI models for your apps, on this computer)
After=network-online.target

[Service]
ExecStart=${command.map(q).join(" ")}
Environment=LEANFARE_NO_OPEN=1
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export interface Runner { run: (cmd: string[]) => { code: number; out: string } }
const real: Runner = { run: (cmd) => { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() }; } };

export interface ServiceResult { ok: boolean; text: string; file: string | null }
const uid = () => { try { return userInfo().uid; } catch { return 501; } };

export function installService(o: { os?: Os; home?: string; runner?: Runner; command?: string[] } = {}): ServiceResult {
  const os = o.os ?? osOf(), runner = o.runner ?? real;
  if (os === "other") return { ok: false, file: null, text: "Always on is for macOS and Linux for now. On Windows, open Leanfare from the Start menu once a day, or add it to Startup." };
  const self = selfCommand("--no-open");
  const command = o.command ?? [self.command, ...self.args];
  const file = serviceFile(os, o.home);
  mkdirSync(dirname(file), { recursive: true });
  if (os === "darwin") {
    writeFileSync(file, plistText(command));
    runner.run(["launchctl", "bootout", `gui/${uid()}/${LABEL}`]); // an older one, if any
    const r = runner.run(["launchctl", "bootstrap", `gui/${uid()}`, file]);
    if (r.code !== 0) return { ok: false, file, text: `The LaunchAgent is in ${file}, but launchctl said: ${r.out || `code ${r.code}`}. It starts at your next login.` };
    return { ok: true, file, text: `Leanfare now starts when you log in and comes back if it stops (${file}). Take it away with: leanfare service remove` };
  }
  writeFileSync(file, unitText(command));
  runner.run(["systemctl", "--user", "daemon-reload"]);
  const r = runner.run(["systemctl", "--user", "enable", "--now", "leanfare.service"]);
  if (r.code !== 0) return { ok: false, file, text: `The unit is in ${file}, but systemctl said: ${r.out || `code ${r.code}`}.` };
  return { ok: true, file, text: `Leanfare now starts with your session and comes back if it stops (${file}). Take it away with: leanfare service remove` };
}

export function removeService(o: { os?: Os; home?: string; runner?: Runner } = {}): ServiceResult {
  const os = o.os ?? osOf(), runner = o.runner ?? real;
  if (os === "other") return { ok: false, file: null, text: "There is no always on service on this system." };
  const file = serviceFile(os, o.home);
  if (os === "darwin") runner.run(["launchctl", "bootout", `gui/${uid()}/${LABEL}`]);
  else { runner.run(["systemctl", "--user", "disable", "--now", "leanfare.service"]); }
  const had = existsSync(file);
  if (had) unlinkSync(file);
  if (os === "linux") runner.run(["systemctl", "--user", "daemon-reload"]);
  return { ok: true, file, text: had ? "Leanfare no longer starts by itself. It runs while you keep it open." : "Leanfare was not set to start by itself." };
}

export function serviceStatus(o: { os?: Os; home?: string } = {}): ServiceResult {
  const os = o.os ?? osOf();
  if (os === "other") return { ok: false, file: null, text: "Always on is for macOS and Linux for now." };
  const file = serviceFile(os, o.home);
  if (!existsSync(file)) return { ok: false, file, text: `Not set. Turn it on with: leanfare service install${os === "darwin" ? " (or, with the Mac app, Open at Login in its menu)" : ""}` };
  const said = readFileSync(file, "utf8");
  return { ok: true, file, text: `On: Leanfare starts by itself and comes back if it stops (${file}${said.includes(LABEL) || said.includes("ExecStart") ? "" : ", in an unknown form"}).` };
}
