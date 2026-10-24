#!/usr/bin/env bun
// leanfare            start Leanfare and open it in the browser
// leanfare stop       stop a running Leanfare
// leanfare status     say whether it is running, where, and how old its prices are
//
// Exit codes: 0 done, 1 failed, 2 wrong command, 3 not running (status),
// 4 the port is taken by another program.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { BUN_TESTED, PORT, VERSION, paths } from "./config";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | null => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return null;
  return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1] ?? null;
};
const command = args.find((a, i) => !a.startsWith("-") && !(i > 0 && args[i - 1] === "--port")) ?? "start";
const port = Number(value("port") ?? PORT);

const HELP = `Leanfare ${VERSION}: every top AI model in one app on your own computer.

  leanfare            start it and open http://127.0.0.1:${PORT}
  leanfare stop       stop it
  leanfare status     is it running, where, and how old are its prices

  --port 4748         use another port
  --no-open           do not open the browser
  --version           print the version
`;

interface PidFile { pid: number; port: number; started: string }
function readPid(): PidFile | null {
  try { return JSON.parse(readFileSync(paths.pid, "utf8")); } catch { return null; }
}

const readToken = () => { try { return readFileSync(paths.token, "utf8").trim(); } catch { return ""; } };
// A locked Leanfare opens through its unlock link (the control token only you can read).
const pageUrl = (base: string, isLocked: boolean, token: string) => (isLocked && token ? `${base}/unlock?t=${token}` : base);

async function health(p: number): Promise<any | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j?.app === "leanfare" ? j : null;
  } catch { return null; }
}

function openBrowser(url: string) {
  if (flag("no-open") || process.env.LEANFARE_NO_OPEN === "1") return;
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch {}
}

function versionLine() {
  const [maj, min] = Bun.version.split(".");
  const tested = `${maj}.${min}` === BUN_TESTED;
  return { text: `Leanfare ${VERSION} · Bun ${Bun.version}${tested ? "" : ` (tested on Bun ${BUN_TESTED}.x; yours may behave differently)`}`, tested };
}

async function start() {
  const existing = readPid();
  if (existing) {
    const h = await health(existing.port);
    if (h) {
      const url = `http://127.0.0.1:${existing.port}`;
      console.log(`Leanfare is already running at ${url}`);
      openBrowser(pageUrl(url, !!h.locked, readToken()));
      process.exit(0);
    }
    try { unlinkSync(paths.pid); } catch {}
  }
  const v = versionLine();
  console.log(v.text);
  const t0 = performance.now();
  const { openDb, dailyBackup } = await import("./db");
  const data = await import("./data");
  const { loadKeys } = await import("./keys");
  const { startServer, shutdown } = await import("./server");
  const { settings } = await import("./settings");
  openDb(paths.db);
  data.loadCatalog();
  await loadKeys();
  const token = crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  try {
    startServer(port, token);
  } catch (e: any) {
    const inUse = /EADDRINUSE|address already in use|in use/i.test(String(e?.message ?? e) + String(e?.code ?? ""));
    if (inUse) {
      console.error(`Port ${port} is taken by another program. Start Leanfare on another port:\n  leanfare --port ${port + 1}`);
      process.exit(4);
    }
    console.error(`Leanfare could not start: ${String(e?.message ?? e)}`);
    process.exit(1);
  }
  writeFileSync(paths.token, token, { mode: 0o600 });
  writeFileSync(paths.pid, JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() } satisfies PidFile), { mode: 0o600 });
  const url = `http://127.0.0.1:${port}`;

  // The start checks itself the way you will use it.
  const page = await fetch(`${url}/`).then((r) => r.status).catch(() => 0);
  const ok = (await health(port)) && page === 200;
  const ms = Math.round(performance.now() - t0);
  console.log(ok ? `Running at ${url} (ready in ${ms} ms)` : `Started, but the self-check failed (page answered ${page}).`);
  console.log(`Other apps: OpenAI address ${url}/v1 · Anthropic address ${url} · any API key works`);
  console.log(`Prices: ${data.store.catalogFrom} copy from ${data.store.catalog.built.slice(0, 10)} · data folder ${paths.db.replace(/\/leanfare\.db$/, "")}`);
  console.log("Stop: press Ctrl+C here, or run: leanfare stop");
  const { locked } = await import("./lock");
  if (locked()) console.log("Other apps need Leanfare's access key (Settings, Other apps need a key).");
  openBrowser(pageUrl(url, locked(), token));

  process.on("SIGINT", () => shutdown("Ctrl+C"));
  process.on("SIGTERM", () => shutdown("stop signal"));

  // Background work, after the app is already open (nothing heavy before launch).
  const day = 24 * 3600_000;
  const stale = () => Date.now() - Date.parse(data.store.catalog.built) > 12 * 3600_000;
  if (stale()) data.refreshCatalog().then((st) => console.log(st.state === "ok" ? `Prices updated to ${data.store.catalog.built.slice(0, 10)}.` : `Prices not updated: ${st.error}. Using the copy from ${data.store.catalog.built.slice(0, 10)}.`));
  setInterval(() => data.refreshCatalog(), day);
  const orOn = () => settings().providers.openrouter?.on === true;
  if (orOn()) data.refreshOpenRouter();
  setInterval(() => { if (orOn()) data.refreshOpenRouter(); }, day);
  const ollama = async () => {
    const before = data.store.ollamaFound;
    await data.refreshOllama();
    if (data.store.ollamaFound && !before) {
      const { saveSettings } = await import("./settings");
      const s = settings();
      const mine = data.store.ollama.map((m) => m.id);
      if (!s.ticked.some((id) => id.startsWith("ollama/"))) saveSettings({ ticked: [...s.ticked, ...mine] });
    }
    setTimeout(ollama, data.store.ollamaFound ? 300_000 : 30_000);
  };
  ollama();
  dailyBackup(paths.db);
  setInterval(() => dailyBackup(paths.db), 3600_000);
}

async function stop() {
  const pf = readPid();
  const p = pf?.port ?? port;
  if (!(await health(p))) {
    console.log("Leanfare is not running.");
    if (pf) { try { unlinkSync(paths.pid); } catch {} }
    process.exit(0);
  }
  const token = readToken();
  const r = await fetch(`http://127.0.0.1:${p}/api/control/stop`, { method: "POST", headers: { "x-leanfare-token": token } }).catch(() => null);
  if (!r || !r.ok) {
    // No usable token: stop it by its process id, after checking the id is Leanfare's.
    const h = await health(p);
    const pid = h?.pid ?? pf?.pid;
    if (!pid) { console.error("Leanfare is running but did not accept the stop command."); process.exit(1); }
    try { process.kill(pid, "SIGTERM"); } catch (e) { console.error(`Could not stop process ${pid}: ${String(e)}`); process.exit(1); }
  } else {
    const j: any = await r.json().catch(() => ({}));
    if (j.running) console.log(`Waiting for ${j.running} answer${j.running === 1 ? "" : "s"} still running (at most 10 seconds)...`);
  }
  for (let i = 0; i < 150; i++) {
    if (!(await health(p))) { console.log("Leanfare stopped."); process.exit(0); }
    await Bun.sleep(100);
  }
  console.error("Leanfare did not stop within 15 seconds.");
  process.exit(1);
}

async function status() {
  const pf = readPid();
  const p = pf?.port ?? port;
  const h = await health(p);
  if (!h) { console.log(`Leanfare is not running. ${versionLine().text}`); process.exit(3); }
  const st: any = await fetch(`http://127.0.0.1:${p}/api/state`, { headers: { "x-leanfare": "1", "x-leanfare-token": readToken() } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  console.log(`Leanfare ${h.version} is running at http://127.0.0.1:${p} (process ${h.pid}).`);
  if (st) {
    console.log(`Prices from ${st.data.built.slice(0, 10)} (${st.data.from} copy). Providers ready: ${st.readyCount}. Models ticked and ready: ${st.usableCount}.`);
    console.log(`This month: $${st.month.spent.toFixed(4)} over ${st.month.answers} answers.${st.pause.paused ? " Paused." : ""}`);
  }
  process.exit(0);
}

if (flag("version") || command === "version" || args.includes("-v")) { console.log(VERSION); process.exit(0); }
if (flag("help") || command === "help" || args.includes("-h")) { console.log(HELP); process.exit(0); }
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("The port must be a number from 1 to 65535."); process.exit(2); }
if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "status") await status();
else { console.error(`Unknown command "${command}".\n\n${HELP}`); process.exit(2); }
