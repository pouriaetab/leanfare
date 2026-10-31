#!/usr/bin/env bun
// leanfare            start Leanfare and open it in the browser
// leanfare stop       stop a running Leanfare
// leanfare status     say whether it is running, where, and how old its prices are
//
// Exit codes: 0 done, 1 failed, 2 wrong command, 3 not running (status),
// 4 the port is taken by another program.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { BUN_TESTED, DATA_DIR_PROBLEM, DATA_ID, PORT, VERSION, paths } from "./config";

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
  leanfare mcp        Leanfare as an MCP server (stdio), for Claude Desktop and other MCP clients
  leanfare statusline the line for Claude Code's status line: your plan's 5 hour and weekly use (Settings adds it)
  leanfare hook prompt the line Claude Code's prompt hook adds: your plan's use, and that plan can split a task
  leanfare hook stop  Claude Code's stop hook: before Claude finishes, it asks once for a grade of each answer
                      Leanfare brought back, and a fix of what is partly or wrong ("hook handoff" notes them)
  leanfare meter      reads your Claude plan's use now through Claude Code's usage view (it does this by itself while it runs)
  leanfare level      how much Leanfare takes first, 1 (Off) to 5 (All it can), for every app and each app;
                      "leanfare level 4" sets it, "leanfare level 4 --app codex" one app's
  leanfare apps       the AI apps on this computer, and whether Leanfare's tools are in each
  leanfare apps add claude-desktop   add Leanfare's tools to one (claude-desktop, claude-code, cursor, codex,
                      gemini-cli, windsurf, vscode, lm-studio); "leanfare apps remove <app>" takes them out
  leanfare trial      try the delegate before you trust it: 10 questions with known answers, at low, medium
                      and high effort; "--report" shows the last one again, "--share" opens it as a GitHub issue
                      for you to read and send (nothing is sent on its own)

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

// Whether the Leanfare that answered uses this data folder. One that names no folder (0.3 and before)
// counts when this folder's record points to its port, or when the port was given on purpose.
function ours(h: any, pf: PidFile | null, p: number): boolean {
  if (h?.data) return h.data === DATA_ID;
  return (pf !== null && pf.port === p) || value("port") !== null;
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
  if (DATA_DIR_PROBLEM) { console.error(`${DATA_DIR_PROBLEM} Set LEANFARE_DATA_DIR to a folder it can write in.`); process.exit(1); }
  const existing = readPid();
  if (existing) {
    const h = await health(existing.port);
    if (h && ours(h, existing, existing.port)) {
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
  const providers = await import("./providers");
  providers.loadCustomProviders(); // the providers you added, before their keys are read
  await loadKeys({ shell: false });
  // Keys your login shell exports, only for a Leanfare that did not start from a terminal (the Mac
  // app, or an MCP client starting it), which does not get them; and the model apps running on this
  // computer. Both in the background, so the start never waits.
  if (!process.stdin.isTTY) loadKeys().catch(() => {});
  providers.refreshLocalServers().catch(() => {});
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
  // Plan by itself, where it is on, brought up to this version (workers.ts): its block's text and its hooks.
  import("./workers").then((w) => { const done = w.refreshAuto(); if (done.length) console.log(`Plan by itself is up to date in ${done.join(", ")}.`); }).catch(() => {});
  // The Claude plan's use, read through Claude Code's usage view when the last reading is old (usageprobe.ts, 0.12).
  // Kept words past the days Settings keeps them (words.ts, 0.12) go, even with no new hand off.
  Promise.all([import("./words"), import("./settings")]).then(([w, st]) => { if ((st.settings().keep ?? 1) >= 2 || w.wordsKept().count) w.pruneWords(st.settings().keepDays ?? 30); }).catch(() => {});
  Promise.all([import("./usageprobe"), import("./settings"), import("./switch")]).then(([u, st, sw]) => u.startUsageProbe(() => st.settings().planMeter !== false && sw.switchedOn())).catch(() => {});
  const day = 24 * 3600_000;
  const stale = () => Date.now() - Date.parse(data.store.catalog.built) > 12 * 3600_000;
  if (stale()) data.refreshCatalog().then((st) => console.log(st.state === "ok" ? `Prices updated to ${data.store.catalog.built.slice(0, 10)}.` : `Prices not updated: ${st.error}. Using the copy from ${data.store.catalog.built.slice(0, 10)}.`));
  setInterval(() => data.refreshCatalog(), day);
  const orOn = () => settings().providers.openrouter?.on === true;
  const orRefresh = async () => {
    await data.refreshOpenRouter();
    const { refreshCredit } = await import("./connect");
    const { getKey } = await import("./keys");
    await refreshCredit(getKey("openrouter"));
  };
  if (orOn()) orRefresh();
  setInterval(() => { if (orOn()) orRefresh(); }, day);
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
  const { checkUpdate } = await import("./update");
  const askGitHub = () => { if (settings().updateCheck) checkUpdate(); };
  setTimeout(askGitHub, 20_000); // after the app is up and the prices are in
  setInterval(askGitHub, day);
}

async function stop() {
  const pf = readPid();
  const p = pf?.port ?? port;
  const first = await health(p);
  if (!first) {
    console.log("Leanfare is not running.");
    if (pf) { try { unlinkSync(paths.pid); } catch {} }
    process.exit(0);
  }
  if (!ours(first, pf, p)) {
    // Another copy answers there: never stop it from here.
    console.log(`Leanfare is not running from this data folder: the one at http://127.0.0.1:${p} uses another folder (the Mac app, or another copy). Stop it there.`);
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
  if (!ours(h, pf, p)) { console.log(`Leanfare is not running from this data folder: the one at http://127.0.0.1:${p} uses another. ${versionLine().text}`); process.exit(3); }
  const st: any = await fetch(`http://127.0.0.1:${p}/api/state`, { headers: { "x-leanfare": "1", "x-leanfare-token": readToken() } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  console.log(`Leanfare ${h.version} is running at http://127.0.0.1:${p} (process ${h.pid}).`);
  if (st) {
    console.log(`Prices from ${st.data.built.slice(0, 10)} (${st.data.from} copy). Providers ready: ${st.readyCount}. Models ticked and ready: ${st.usableCount}.`);
    console.log(`This month: $${st.month.spent.toFixed(4)} over ${st.month.answers} answers.${st.pause.paused ? " Paused." : ""}`);
  }
  process.exit(0);
}

// leanfare apps [add|remove <app>]: Leanfare's tools in the AI apps on this computer (see apps.ts).
async function apps() {
  const { APPS, appsView, setApp } = await import("./apps");
  const [verb, id] = args.slice(args.indexOf("apps") + 1);
  if (verb === "add" || verb === "remove") {
    if (!id || !APPS.some((a) => a.id === id)) { console.error(`Name the app: ${APPS.map((a) => a.id).join(", ")}.`); process.exit(2); }
    try {
      const v = await setApp(id, verb === "add");
      console.log(verb === "add" ? `Added Leanfare's tools to ${v.name}. ${v.after}` : `Took Leanfare's tools out of ${v.name}.`);
      process.exit(0);
    } catch (e: any) { console.error(String(e?.message ?? e)); process.exit(1); }
  }
  const SAY: Record<string, string> = { added: "added", old: "added, from another copy (run: leanfare apps add <app> to update)", "not added": "not added", broken: "settings file is not valid; left alone", "not installed": "not on this computer" };
  for (const v of appsView()) console.log(`${v.id.padEnd(15)} ${v.name.padEnd(28)} ${SAY[v.status]}`);
  console.log(`\nAdd Leanfare's tools to one: leanfare apps add <app>`);
  process.exit(0);
}

// leanfare trial [--report] [--share]: the delegate trial, run by the Leanfare that is running (trial.ts).
// leanfare meter: reads the Claude plan's use through Claude Code's usage view now (usageprobe.ts), and says how it went.
async function meter() {
  const { probeUsage } = await import("./usageprobe");
  const s = await probeUsage({ force: true });
  const r = s.read;
  if (s.ok && r) console.log(`Your Claude plan: ${[r.five ? `the 5 hours ${Math.round(r.five.used)}% used` : "", r.week ? `the week ${Math.round(r.week.used)}% used` : ""].filter(Boolean).join(", ")}, ${s.why}. Leanfare reads it like this by itself while it runs, when the last reading is over 45 minutes old.`);
  else console.log(`Leanfare could not read your Claude plan's use: ${s.why}. It still reads it from Claude Code's status line while a Claude Code session is open.`);
  process.exit(0);
}

// leanfare level: the level (0.12, level.ts) for every app and each app's own; leanfare level 4 sets the default, and
// leanfare level 4 --app codex one app's.
async function level() {
  const { call } = await import("./client");
  const { APP_LEVELS, LEVEL_MEANS, LEVEL_NAME, isLevel } = await import("./level");
  const n = Number(args.find((a) => /^[1-5]$/.test(a)));
  const at = args.indexOf("--app"), key = at >= 0 ? args[at + 1] ?? "" : null;
  try {
    if (key !== null && !(key in APP_LEVELS)) { console.error(`--app takes one of: ${Object.keys(APP_LEVELS).join(", ")}.`); process.exit(2); }
    if (isLevel(n)) await call("/api/level", { method: "POST", json: key ? { set: n, scope: "app", key } : { set: n, scope: "default" } });
    const { j } = await call("/api/level");
    const name = (v: number) => `${v} (${(LEVEL_NAME as Record<number, string>)[v]})`;
    console.log(`Leanfare's level: ${name(j.default)}. ${(LEVEL_MEANS as Record<number, string>)[j.default]}`);
    for (const [k, label] of Object.entries(APP_LEVELS)) console.log(`  ${label}: ${j.levels?.[k] ? name(j.levels[k]) : "the default"}`);
    console.log(`Raise it when your Claude plan runs low: ${j.raiseWhenLow ? "on" : "off"}. Ask at the start of each new chat: ${j.ask ? "on" : "off"}.`);
    console.log('Set it with: leanfare level 4 (every app), or leanfare level 4 --app codex. In a chat, say "Leanfare 4".');
  } catch (e: any) { console.error(String(e?.message ?? e)); process.exit(1); }
  process.exit(0);
}

async function trial() {
  const { call } = await import("./client");
  const say = (line = "") => console.log(line);
  const { reportText, trialSecs: secs } = await import("./trialtext");
  const usd = (v: number | null) => (v === null ? "cost unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
  const report = (r: any) => say(`\n${reportText(r)}`);
  try {
    if (flag("report") || flag("share")) {
      const { j } = await call("/api/trial");
      if (!j.report) { say("No trial has run yet. Run one with: leanfare trial"); process.exit(0); }
      if (flag("share")) {
        if (flag("no-open") || process.env.LEANFARE_NO_OPEN === "1") say(j.report.share.url);
        else { openBrowser(j.report.share.url); say("Opened GitHub with the results filled in. Read them, then press Submit if you want to send them."); }
      } else report(j.report);
      process.exit(0);
    }
    const before = (await call("/api/trial")).j;
    if (!before.running) {
      const e = before.estimate;
      if (!e?.models?.low) { console.error(e?.error ?? "No model is ready yet. Open Leanfare, add a key and tick a model, then run the trial again."); process.exit(1); }
      say(`Leanfare delegate trial: ${e.questions} questions with known answers about files Leanfare makes up, each asked at low, medium and high effort (${e.answers} answers).`);
      say(`${e.estimate === 0 ? "$0 on the models you ticked now (free)" : e.estimate === null ? "On the models you ticked now" : `About ${usd(e.estimate)} on the models you ticked now`}${typeof e.seconds === "number" ? `, about ${Math.max(1, Math.round(e.seconds / 60))} min` : ""}. Nothing of yours is sent. Ctrl+C stops it.\n`);
      await call("/api/trial/start", { method: "POST", json: {} });
    } else say("A trial is already running; following it.\n");
    process.on("SIGINT", () => { call("/api/trial/stop", { method: "POST", json: {} }).catch(() => {}).finally(() => { say("\nStopped."); process.exit(130); }); });
    let shown = 0;
    for (;;) {
      const { j } = await call("/api/trial");
      const r = j.report;
      for (; r && shown < r.rows.length; shown++) {
        const x = r.rows[shown];
        say(`${String(shown + 1).padStart(3)}/${r.total}  ${x.what} · ${x.effort} · ${x.ok ? `${x.right ? "right" : "WRONG"} · ${x.label ?? "?"}${x.check ? ` · check ${x.check}` : ""}` : "no answer"} · ${secs(x.seconds)}`);
      }
      if (!j.running) { if (r) report(r); process.exit(r?.status === "failed" ? 1 : 0); }
      await Bun.sleep(1500);
    }
  } catch (e: any) { console.error(String(e?.message ?? e)); process.exit(1); }
}

if (flag("version") || command === "version" || args.includes("-v")) { console.log(VERSION); process.exit(0); }
if (flag("help") || command === "help" || args.includes("-h")) { console.log(HELP); process.exit(0); }
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("The port must be a number from 1 to 65535."); process.exit(2); }
if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "status") await status();
else if (command === "mcp") { const { runMcp } = await import("./mcp"); await runMcp(); }
else if (command === "statusline") { const { runStatusline } = await import("./statusline"); await runStatusline(args); }
// Claude Code's hooks (Settings, In your apps, Plan by itself): the prompt hook, one line of numbers for Claude, never
// the prompt; the read hook (0.11), a reminder before Claude Code reads a big file itself (readhook.ts). They must
// never get in the way: anything that goes wrong prints nothing.
else if (command === "hook") {
  try {
    if (args.includes("read")) { const { runReadHook } = await import("./readhook"); await runReadHook(); }
    else if (args.includes("handoff")) { const { runHandoffHook } = await import("./reviewhook"); await runHandoffHook(); }
    else if (args.includes("stop")) { const { runStopHook } = await import("./reviewhook"); await runStopHook(); }
    else if (args.includes("prompt")) { // the JSON Claude Code sends: only its session_id is read (statusline.ts)
      let input: any = null;
      if (!process.stdin.isTTY) { try { input = JSON.parse(await Bun.stdin.text()); } catch {} }
      const { hookLine, clock } = await import("./statusline"); const line = hookLine(clock(), input); if (line) console.log(line);
    }
  } catch {}
  process.exit(0);
}
else if (command === "apps") await apps();
else if (command === "level") await level();
else if (command === "meter") await meter();
else if (command === "trial") await trial();
else { console.error(`Unknown command "${command}".\n\n${HELP}`); process.exit(2); }
