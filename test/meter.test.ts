// The plan meter: Claude's two windows from Claude Code's status line, ChatGPT's from Codex's logs,
// what one percent holds in dollars of work (measured from your own windows, or a starting estimate),
// what is left, and which project still fits. Every test writes its own files into the temp folders
// test/setup.ts points LEANFARE_DATA_DIR, CLAUDE_CONFIG_DIR and CODEX_HOME at.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { claudeSettingsFile, estimate, meterView, observations, ourCommand, quantile, seeded, setStatusline, startingK, statuslineState } from "../src/meter";
import { forgetLogs } from "../src/plans";
import { lineFor, limitsFile, meterCacheFile, readSnaps, saveSnap, snapOf, toMs, unquote, quote } from "../src/statusline";
import { boot, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
const DATA = () => process.env.LEANFARE_DATA_DIR!;
const claudeRoot = () => process.env.CLAUDE_CONFIG_DIR!;
const codexRoot = () => process.env.CODEX_HOME!;
beforeEach(async () => {
  for (const d of [claudeRoot(), codexRoot()]) rmSync(d, { recursive: true, force: true });
  for (const f of [limitsFile(), join(DATA(), "limits-last.json"), meterCacheFile()]) rmSync(f, { force: true });
  forgetLogs();
  await reset();
});

const T = (iso: string) => Date.parse(iso);
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
// Claude Sonnet 4.6 in the fixture catalogue costs $15 per 1M output tokens: dollars -> output tokens.
const outFor = (dollars: number) => Math.round(dollars / 15e-6);
let n = 0;
function claudeSession(project: string, name: string, answers: { ts: string; dollars: number }[]) {
  const rows = answers.map((a) => ({ type: "assistant", timestamp: a.ts, cwd: `/Users/you/${project}`, requestId: `req_${++n}`, message: { id: `msg_${n}`, model: "claude-sonnet-4-6", role: "assistant", content: [{ type: "text", text: "SECRET-ANSWER-TEXT" }], usage: { input_tokens: 0, output_tokens: outFor(a.dollars) } } }));
  put(join(claudeRoot(), "projects", `-Users-you-${project}`, `${name}.jsonl`), jsonl(rows));
}
const snap = (at: string, five: [number, string] | null, week: [number, string] | null) =>
  saveSnap({ at: T(at), five: five ? { used: five[0], resets: T(five[1]) } : null, week: week ? { used: week[0], resets: T(week[1]) } : null });

describe("Claude Code's status line JSON", () => {
  test("the two windows are read, with resets in seconds, milliseconds or as a date", () => {
    const j = { model: { display_name: "Opus" }, rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1792900000 }, seven_day: { used_percentage: 90, resets_at: "2026-10-27T09:00:00Z" } } };
    expect(snapOf(j, 5)).toEqual({ at: 5, five: { used: 42.4, resets: 1792900000000 }, week: { used: 90, resets: T("2026-10-27T09:00:00Z") } });
    expect(toMs(1792900000000)).toBe(1792900000000);
    expect(toMs("1792900000")).toBe(1792900000000);
    expect(toMs("soon")).toBeNull();
  });
  test("no rate_limits (an API key, or an older Claude Code): nothing is saved", () => {
    expect(snapOf({ model: {} }, 1)).toBeNull();
    expect(snapOf({ rate_limits: { five_hour: { resets_at: 1 } } }, 1)).toBeNull();
  });
  test("a snapshot is saved only when a number changed", () => {
    expect(snap("2026-10-21T10:00:00Z", [40, "2026-10-21T15:00:00Z"], [80, "2026-10-27T12:00:00Z"])).toBe(true);
    expect(snap("2026-10-21T10:01:00Z", [40, "2026-10-21T15:00:00Z"], [80, "2026-10-27T12:00:00Z"])).toBe(false);
    expect(snap("2026-10-21T10:02:00Z", [41, "2026-10-21T15:00:00Z"], [80, "2026-10-27T12:00:00Z"])).toBe(true);
    expect(readSnaps(0).map((s) => s.five!.used)).toEqual([40, 41]);
  });
  test("the line: both windows, and the project's sessions left when the meter knows them", () => {
    const s = { at: T("2026-10-21T11:00:00Z"), five: { used: 42, resets: T("2026-10-21T15:00:00Z") }, week: { used: 90, resets: T("2026-10-27T12:00:00Z") } };
    const at = T("2026-10-21T12:00:00Z");
    expect(lineFor(s, null, "llmledger", at)).toBe("5h 42% · week 90%");
    const cache = { at, k5: 1.5, kWeek: 16, projects: { llmledger: 30, leanfare: 200 } };
    expect(lineFor(s, cache, "llmledger", at)).toBe("5h 42% · week 90% · about 2 llmledger sessions left"); // min(58 x 1.5 = 87, 10 x 16 = 160) / 30
    expect(lineFor(s, cache, "leanfare", at)).toBe("5h 42% · week 90% · under 1 leanfare session left");
    expect(lineFor({ ...s, five: { used: 42, resets: T("2026-10-21T11:30:00Z") } }, null, null, at)).toBe("week 90%"); // that 5 hours has reset
    expect(lineFor(null, null, null, at)).toBe("Leanfare: no plan numbers yet");
  });
  test("quoting the command kept after --then survives a round trip", () => {
    for (const c of ["echo hi", "it's \"quoted\" $HOME", "bash -c 'x'"]) expect(unquote(quote(c))).toBe(c);
  });
});

describe("what one percent holds (the statistics)", () => {
  test("windows: points that share a reset are one window; the work between first and last is summed", () => {
    const R1 = T("2026-10-20T05:00:00Z"), R2 = T("2026-10-20T10:00:00Z");
    const pts = [{ at: 1, used: 10, resets: R1 }, { at: 3, used: 30, resets: R1 }, { at: 5, used: 5, resets: R2 }, { at: 9, used: 25, resets: R2 }];
    const work = [{ ts: 2, value: 7 }, { ts: 3, value: 3 }, { ts: 4, value: 99 }, { ts: 6, value: 10 }, { ts: 9, value: 20 }];
    expect(observations(pts, work)).toEqual([{ w: 10, d: 20 }, { w: 30, d: 20 }]);
  });
  test("it recovers a value set in simulated data, with use the logs miss in a third of the windows", () => {
    const rand = seeded(7), trueK = 2.5;
    const obs = Array.from({ length: 15 }, (_, i) => {
      const w = 10 + rand() * 50;
      const other = i % 3 === 0 ? rand() * 15 : 0; // chats and Cowork: percent the logs cannot see
      return { w, d: Math.round(w / trueK + other) }; // the percent comes rounded
    });
    const e = estimate(obs)!;
    expect(e.n).toBe(15);
    expect(Math.abs(e.k - trueK) / trueK).toBeLessThan(0.12);
    expect(e.lo).toBeLessThanOrEqual(e.k);
    expect(e.hi).toBeGreaterThanOrEqual(e.k);
    expect(e.lo).toBeLessThan(trueK * 1.1);
    expect(e.hi).toBeGreaterThan(trueK * 0.9);
  });
  test("fewer than 3 usable windows give no estimate; tiny rises do not count", () => {
    expect(estimate([{ w: 10, d: 5 }, { w: 10, d: 5 }])).toBeNull();
    expect(estimate([{ w: 10, d: 1 }, { w: 10, d: 1 }, { w: 10, d: 1 }])).toBeNull();
  });
  test("quantile matches R's type 7", () => {
    expect(quantile([1, 2, 3, 4], 0.8)).toBeCloseTo(3.4, 10);
    expect(quantile([5], 0.8)).toBe(5);
  });
  test("starting estimates follow the plan's price; ChatGPT has none", () => {
    expect(startingK("claude", 20)).toMatchObject({ plan: "Pro", kWeek: 1.7, k5: 0.14 });
    expect(startingK("claude", 100)).toMatchObject({ plan: "Max 5x", rough: true, k5: 0.7 }); // 5 times Pro for the 5 hours, as Anthropic says
    expect(startingK("claude", 200)).toMatchObject({ plan: "Max 20x", kWeek: 16.4, k5: 2.05 });
    expect(startingK("claude", null)).toBeNull();
    expect(startingK("chatgpt", 20)).toBeNull();
  });
});

describe("the meter for Claude (status line plus Claude Code's logs)", () => {
  // Four past 5 hour windows on Oct 20 where 1% held $1.50 of work (one with chat use the logs miss), and the
  // window running now (resets Oct 21 15:00; the tests' clock is Oct 21 12:00).
  function fourWindows() {
    const wk = "2026-10-27T12:00:00Z";
    const win = [
      { r: "2026-10-20T05:00:00Z", a: "2026-10-20T01:00:00Z", b: "2026-10-20T04:00:00Z", u: [10, 30], dollars: 30, project: "llmledger" },
      { r: "2026-10-20T10:00:00Z", a: "2026-10-20T06:00:00Z", b: "2026-10-20T09:00:00Z", u: [5, 25], dollars: 30, project: "llmledger" },
      { r: "2026-10-20T15:00:00Z", a: "2026-10-20T11:00:00Z", b: "2026-10-20T14:00:00Z", u: [0, 40], dollars: 45, project: "leanfare" }, // 15 points were chats
      { r: "2026-10-20T20:00:00Z", a: "2026-10-20T16:00:00Z", b: "2026-10-20T19:00:00Z", u: [10, 30], dollars: 30, project: "llmledger" },
    ];
    let week = 10;
    win.forEach((w, i) => {
      snap(w.a, [w.u[0], w.r], [week, wk]);
      const mid = new Date((T(w.a) + T(w.b)) / 2).toISOString();
      claudeSession(w.project, `s${i}`, [{ ts: mid, dollars: w.dollars }]);
      week += 5;
      snap(w.b, [w.u[1], w.r], [week, wk]);
    });
    snap("2026-10-21T10:30:00Z", [20, "2026-10-21T15:00:00Z"], [60, wk]);
    claudeSession("llmledger", "now", [{ ts: "2026-10-21T11:00:00Z", dollars: 60 }]);
    snap("2026-10-21T11:50:00Z", [60, "2026-10-21T15:00:00Z"], [70, wk]);
  }

  test("1% of the 5 hours is measured from the windows; what is left and what fits follow", async () => {
    fourWindows();
    const m = await meterView("claude");
    expect(m.source).toBe("status line");
    expect(m.at).toBe("2026-10-21T11:50:00.000Z");
    const five = m.windows.find((w) => w.kind === "5 hours")!;
    expect(five).toMatchObject({ used: 60, from: "measured", resets: "2026-10-21T15:00:00.000Z" });
    expect(five.windows).toBe(5); // the four past windows and the one running now
    expect(five.k!).toBeCloseTo(1.5, 6); // the chat heavy window (1.125) does not drag it down
    expect(five.left!).toBeCloseTo(40 * 1.5, 6);
    expect(five.kLo!).toBeLessThanOrEqual(five.k!);
    const ll = m.projects.find((p) => p.name === "llmledger")!;
    expect(ll.sessions).toBe(4);
    expect(ll.typical).toBeCloseTo(30, 6); // the median of 30, 30, 30, 60
    expect(ll.sessionsLeft!).toBeCloseTo(60 / 30, 6); // the 5 hours binds: $60 left, a session is $30
    // The cache the status line reads
    const cache = JSON.parse(readFileSync(meterCacheFile(), "utf8"));
    expect(cache.k5).toBeCloseTo(1.5, 6);
    expect(cache.projects.llmledger).toBeCloseTo(30, 6);
  });

  test("the week has too few windows: no plan, no number; with a Max 20x plan, a starting estimate", async () => {
    fourWindows();
    let week = (await meterView("claude")).windows.find((w) => w.kind === "week")!;
    expect(week).toMatchObject({ used: 70, k: null, left: null, from: null });
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 200 } } });
    const m = await meterView("claude");
    week = m.windows.find((w) => w.kind === "week")!;
    expect(week).toMatchObject({ from: "starting estimate", k: 16.4 });
    expect(week.left!).toBeCloseTo(30 * 16.4, 6);
    expect(week.leftLo!).toBeCloseTo(30 * 16.4 * 0.7, 6);
    expect(m.plan).toBe("Max 20x");
    expect(m.other!).toBeGreaterThan(0); // the week rose more than the logged work explains at that rate
  });

  test("nothing from the status line yet: no windows, and projects still listed", async () => {
    claudeSession("llmledger", "a", [{ ts: "2026-10-20T10:00:00Z", dollars: 12 }]);
    const m = await meterView("claude");
    expect(m.windows).toEqual([]);
    expect(m.at).toBeNull();
    expect(m.projects[0]).toMatchObject({ name: "llmledger", sessionsLeft: null });
  });

  test("the log's words never reach the meter, its cache or its answer", async () => {
    fourWindows();
    const r = await ui(url, "/api/meter");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("SECRET-ANSWER-TEXT");
    expect(readFileSync(meterCacheFile(), "utf8")).not.toContain("SECRET");
    expect(JSON.stringify(r.json)).not.toContain("/Users/you"); // only the folder's own name
    expect(r.json.claude.projects.map((p: any) => p.name).sort()).toEqual(["leanfare", "llmledger"]);
  });
});

describe("the meter for ChatGPT (Codex's logs carry both)", () => {
  test("Codex's 5 hour windows give the measure; the newest message gives what is left", async () => {
    const rows: unknown[] = [{ timestamp: "2026-10-20T00:00:00Z", type: "session_meta", payload: { cwd: "/Users/you/webshop" } }, { timestamp: "2026-10-20T00:00:01Z", type: "turn_context", payload: { cwd: "/Users/you/webshop", model: "gpt-4.1" } }];
    let inTok = 0, outTok = 0;
    const event = (ts: string, used: number, resets: string, addOut: number) => {
      outTok += addOut;
      rows.push({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: inTok, cached_input_tokens: 0, output_tokens: outTok } }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: T(resets) / 1000 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: T("2026-10-26T00:00:00Z") / 1000 } } } });
    };
    for (const [h, r] of [["01", "05"], ["06", "10"], ["11", "15"]]) {
      event(`2026-10-20T${h}:00:00Z`, 10, `2026-10-20T${r}:00:00Z`, 100);
      event(`2026-10-20T${h}:30:00Z`, 30, `2026-10-20T${r}:00:00Z`, 400_000);
    }
    event("2026-10-21T11:00:00Z", 50, "2026-10-21T15:00:00Z", 100);
    put(join(codexRoot(), "sessions", "2026", "10", "20", "rollout-2026-10-20T00-00-00-x.jsonl"), jsonl(rows));
    const m = await meterView("chatgpt");
    expect(m.source).toBe("Codex logs");
    const five = m.windows.find((w) => w.kind === "5 hours")!;
    expect(five).toMatchObject({ used: 50, from: "measured" });
    expect(five.k!).toBeGreaterThan(0);
    expect(m.projects[0].name).toBe("webshop");
  });
});

describe("Leanfare in Claude Code's status line (the settings file)", () => {
  const settingsFile = () => process.env.LEANFARE_CLAUDE_SETTINGS!;
  beforeEach(() => {
    process.env.LEANFARE_CLAUDE_SETTINGS = join(mkdtempSync(join(tmpdir(), "claude-settings-")), "settings.json");
  });

  test("added to a settings file that has other things: they stay, and a backup is kept", () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    const st = setStatusline(true);
    expect(st).toMatchObject({ installed: true, keeps: null });
    const j = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(j.model).toBe("opus");
    expect(j.permissions.allow).toEqual(["Bash(ls)"]);
    expect(j.statusLine.type).toBe("command");
    expect(j.statusLine.command).toContain("statusline");
    expect(existsSync(settingsFile() + ".leanfare-backup")).toBe(true);
  });

  test("a status line you already had runs first, and comes back when Leanfare's is removed", () => {
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command: "echo 'my line'" } }));
    expect(setStatusline(true)).toMatchObject({ installed: true, keeps: "echo 'my line'" });
    expect(setStatusline(true).keeps).toBe("echo 'my line'"); // adding twice does not wrap it twice
    expect(setStatusline(false)).toMatchObject({ installed: false });
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).statusLine.command).toBe("echo 'my line'");
  });

  test("Leanfare's own line is known on Windows too (backslashes, leanfare.exe, any case)", () => {
    for (const command of ["'C:\\Users\\me\\AppData\\Local\\Leanfare\\bin\\leanfare.exe' statusline", "C:\\Tools\\LEANFARE.EXE statusline --then 'echo x'"]) {
      writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command } }));
      expect(statuslineState().installed).toBe(true);
    }
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command: "myleanfare statusline" } }));
    expect(statuslineState().installed).toBe(false);
  });

  test("no settings file yet: it is made; removing leaves no status line", () => {
    expect(setStatusline(true).installed).toBe(true);
    setStatusline(false);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).statusLine).toBeUndefined();
  });

  test("a settings file that is not JSON, or not an object, is left alone and the reason is given", async () => {
    for (const text of ["{ not json", JSON.stringify([{ keep: "me" }]), "42"]) {
      writeFileSync(settingsFile(), text);
      expect(statuslineState()).toMatchObject({ installed: false, broken: true });
      const r = await ui(url, "/api/meter/statusline", { on: true });
      expect(r.status).toBe(409);
      expect(r.json.error).toContain("is not a valid settings file (a JSON object)");
      expect(readFileSync(settingsFile(), "utf8")).toBe(text);
    }
  });

  test("your own status line comes back exactly as it was, padding and all", () => {
    const mine = { type: "command", command: "~/bin/line.sh", padding: 2 };
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: mine }));
    setStatusline(true);
    setStatusline(false);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).statusLine).toEqual(mine);
  });

  test("a line set by hand to leanfare statusline counts as Leanfare's, so it is never wrapped in itself", () => {
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command: "leanfare statusline" } }));
    expect(statuslineState()).toMatchObject({ installed: true, keeps: null });
    setStatusline(true);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).statusLine.command).toBe(ourCommand());
  });

  test("a settings file that is a link (kept with your dotfiles) stays a link", () => {
    const real = join(mkdtempSync(join(tmpdir(), "dotfiles-")), "claude-settings.json");
    writeFileSync(real, JSON.stringify({ model: "opus" }));
    symlinkSync(real, settingsFile());
    setStatusline(true);
    expect(lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toMatchObject({ model: "opus", statusLine: { type: "command" } });
  });

  test("with CLAUDE_CONFIG_DIR set, the line goes in that folder's settings, where Claude Code reads it", () => {
    const was = { file: process.env.LEANFARE_CLAUDE_SETTINGS, dir: process.env.CLAUDE_CONFIG_DIR };
    const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
    try {
      delete process.env.LEANFARE_CLAUDE_SETTINGS;
      process.env.CLAUDE_CONFIG_DIR = dir;
      expect(claudeSettingsFile()).toBe(join(dir, "settings.json"));
      setStatusline(true);
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine.command).toBe(ourCommand());
    } finally {
      process.env.LEANFARE_CLAUDE_SETTINGS = was.file;
      process.env.CLAUDE_CONFIG_DIR = was.dir;
    }
  });
});

describe("the status line's output, in the same process", () => {
  const input = JSON.stringify({ workspace: { current_dir: "/Users/you/llmledger/" }, rate_limits: { five_hour: { used_percentage: 10, resets_at: "2026-10-21T15:00:00Z" }, seven_day: { used_percentage: 50, resets_at: "2026-10-27T12:00:00Z" } } });
  test("it saves the snapshot and prints the line; a JSON that is not JSON shows the last numbers", async () => {
    const { statuslineOutput } = await import("../src/statusline");
    expect(await statuslineOutput(input)).toBe("5h 10% · week 50%");
    expect(readSnaps(0)).toHaveLength(1);
    expect(await statuslineOutput("not json")).toBe("5h 10% · week 50%"); // from the last snapshot
    expect(await statuslineOutput(input, ["--then", "printf 'first\\nsecond'"])).toBe("first · 5h 10% · week 50%");
    expect(await statuslineOutput(input, ["--then", "true"])).toBe("5h 10% · week 50%"); // a line that prints nothing adds nothing
  });
  test("your own line gets 2 seconds, and everything it started is stopped then; what it printed by then is kept", async () => {
    const { statuslineOutput } = await import("../src/statusline");
    let t0 = performance.now();
    expect(await statuslineOutput(input, ["--then", "sleep 6; echo late"])).toBe("5h 10% · week 50%");
    expect(performance.now() - t0).toBeLessThan(3500);
    t0 = performance.now();
    expect(await statuslineOutput(input, ["--then", "echo early; sleep 6"])).toBe("early · 5h 10% · week 50%");
    expect(performance.now() - t0).toBeLessThan(3500);
  }, 15000);
  test("a damaged line in the snapshots file is skipped; backslashes unquote", () => {
    writeFileSync(limitsFile(), "{bad\n" + JSON.stringify({ at: 5, five: null, week: { used: 1, resets: null } }) + "\n");
    expect(readSnaps(0)).toHaveLength(1);
    expect(unquote("a\\ b")).toBe("a b");
    expect(toMs(-1)).toBeNull();
  });
});

describe("leanfare statusline, run the way Claude Code runs it", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const run = async (input: unknown, extra: string[] = [], dataDir = mkdtempSync(join(tmpdir(), "lf-sl-"))) => {
    const p = Bun.spawn([process.execPath, cli, "statusline", ...extra], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_DATA_DIR: dataDir } });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return { out, dataDir };
  };
  const input = { session_id: "x", workspace: { current_dir: "/Users/you/llmledger" }, rate_limits: { five_hour: { used_percentage: 42, resets_at: T("2026-10-21T15:00:00Z") / 1000 }, seven_day: { used_percentage: 90, resets_at: T("2026-10-27T12:00:00Z") / 1000 } } };

  test("it prints the two windows and saves a snapshot", async () => {
    const { out, dataDir } = await run(input);
    expect(out).toBe("5h 42% · week 90%");
    expect(readFileSync(join(dataDir, "limits.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("with the meter's numbers it adds the sessions left for the folder Claude Code is in", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lf-sl-"));
    writeFileSync(join(dataDir, "meter-cache.json"), JSON.stringify({ at: 0, k5: 1.5, kWeek: 16, projects: { llmledger: 30 } }));
    expect((await run(input, [], dataDir)).out).toBe("5h 42% · week 90% · about 2 llmledger sessions left");
  });

  test("your own status line stays first", async () => {
    expect((await run(input, ["--then", "echo mine"])).out).toBe("mine · 5h 42% · week 90%");
  });
});
