// 0.12, the Claude plan's use read by itself (usageprobe.ts): Leanfare asks Claude Code's usage view, never touches its
// sign-in, saves the reading where the plan mode looks, stops for good when it would cost anything, and leaves its own
// session out of the report.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { levelFor } from "../src/level";
import { planMode } from "../src/modes";
import { recentPrompts } from "../src/plans";
import { probeUsage, resetsOf, usageOf } from "../src/usageprobe";
import { lastSnap } from "../src/statusline";
import { boot, reset } from "./app";

const dir = mkdtempSync(join(tmpdir(), "leanfare-probe-"));
const bin = join(dir, "claude"), count = join(dir, "count"), mode = join(dir, "mode");
const USAGE = "Current session\\n█████ 41% used\\nResets 5pm (America/Chicago)\\n\\nCurrent week (all models)\\n██████████ 92% used\\nResets Nov 5, 9am (America/Chicago)";
writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi
echo x >> "${count}"
[ -n "$ANTHROPIC_API_KEY" ] && { echo '{"result":"api key leaked","usage":{"input_tokens":0}}'; exit 0; }
case "$(cat "${mode}")" in
  ok) printf '%s\n' '{"type":"result","result":"${USAGE}","usage":{"input_tokens":0,"output_tokens":0},"total_cost_usd":0}' ;;
  model) echo '{"type":"result","result":"I cannot run that.","usage":{"input_tokens":120,"output_tokens":9}}' ;;
  *) echo '{"type":"result","result":"","usage":{"input_tokens":0,"output_tokens":0}}' ;;
esac
`);
chmodSync(bin, 0o755);
const runs = () => { try { return readFileSync(count, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const T = Date.parse("2026-10-31T17:00:00Z");

beforeAll(async () => { await boot(); process.env.LEANFARE_CLAUDE_BIN = bin; process.env.ANTHROPIC_API_KEY = "sk-test-never-passed"; });
afterAll(() => { delete process.env.LEANFARE_CLAUDE_BIN; delete process.env.ANTHROPIC_API_KEY; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  await reset();
  for (const f of ["limits-last.json", "limits.jsonl", "meter-probe.json"]) rmSync(join(process.env.LEANFARE_DATA_DIR!, f), { force: true });
  rmSync(count, { force: true });
});

test("the usage view's two windows and their resets, read as this computer's time", () => {
  const s = usageOf(USAGE.replace(/\\n/g, "\n"), T)!;
  expect([s.five!.used, s.week!.used]).toEqual([41, 92]);
  const at = (t: number) => new Date(t);
  expect([at(s.five!.resets!).getHours(), at(s.week!.resets!).getMonth(), at(s.week!.resets!).getDate(), at(s.week!.resets!).getHours()]).toEqual([17, 10, 5, 9]);
  expect(resetsOf("Resets 9:30am", T)).toBeGreaterThan(T);
  expect(usageOf("nothing here", T)).toBeNull();
});

test("a reading through Claude Code goes where the plan mode looks, with no API key passed, so a low plan raises the level", async () => {
  writeFileSync(mode, "ok");
  const s = await probeUsage({ force: true, now: T });
  expect(s).toMatchObject({ ok: true, why: "read through Claude Code's usage view", version: "2.1.310 (Claude Code)" });
  expect(lastSnap()).toMatchObject({ at: T, five: { used: 41 }, week: { used: 92 } });
  const m = planMode(T + 1000);
  expect(m.mode).toBe("very low");
  expect(levelFor({ level: 4 }, "Cowork", null, m).level).toBe(5);
  // Fresh: not asked again within 45 minutes, asked again after.
  await probeUsage({ now: T + 10 * 60_000 });
  expect(runs()).toBe(1);
  await probeUsage({ now: T + 50 * 60_000 });
  expect(runs()).toBe(2);
  expect(lastSnap()!.at).toBe(T + 50 * 60_000); // same numbers, a fresh time
});

test("an answer through a model, or one with no usage, stops it for this Claude Code version; leanfare meter can still try", async () => {
  writeFileSync(mode, "model");
  const s = await probeUsage({ now: T });
  expect(s.ok).toBe(false);
  expect(s.why).toBe("Claude Code answered through a model, which would spend your plan, so Leanfare stopped asking");
  expect(lastSnap()).toBeNull();
  await probeUsage({ now: T + 3 * 3600_000 });
  expect(runs()).toBe(1); // not asked again
  writeFileSync(mode, "empty");
  expect((await probeUsage({ force: true, now: T + 4 * 3600_000 })).why).toBe("Claude Code's answer had no usage in it");
  expect(runs()).toBe(2);
});

test("its own Claude Code session is left out of your prompts", async () => {
  const root = process.env.CLAUDE_CONFIG_DIR!;
  const line = (cwd: string) => JSON.stringify({ type: "user", timestamp: new Date(T).toISOString(), cwd, message: { role: "user", content: "/usage" } }) + "\n";
  mkdirSync(join(root, "projects", "-data-leanfare-meter-probe"), { recursive: true });
  writeFileSync(join(root, "projects", "-data-leanfare-meter-probe", "p.jsonl"), line("/data/.leanfare/meter-probe"));
  mkdirSync(join(root, "projects", "-Users-you-app"), { recursive: true });
  writeFileSync(join(root, "projects", "-Users-you-app", "s.jsonl"), line("/Users/you/app"));
  const got = await recentPrompts(T - 3600_000);
  expect(got.map((p) => p.project)).toEqual(["app"]); // the probe's session is not among them
  rmSync(join(root, "projects"), { recursive: true, force: true });
});
