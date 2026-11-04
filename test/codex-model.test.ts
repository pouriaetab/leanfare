// Codex set to a model ChatGPT sign in no longer offers (0.13.1): Codex's settings can still name an old model (like
// gpt-5.4), and every part then fails with "not supported when using Codex with a ChatGPT account". Leanfare asks Codex
// which models it offers this account (its app server's model list, else `codex debug models`), runs the part on the
// first that works, keeps it for the next parts, and the receipt says how to change the setting. From 0.13.2 the ChatGPT
// row in Settings says when Codex's setting is stale, and Fix it turns that line off in one press. A stand-in codex plays
// Codex: it offers the models listed in its folder's "offered" file; its settings name the model in its config.toml, else
// the one in "configured", else it takes its own pick ("default").
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexArgs, codexModels, codexPicked, codexSetting, forgetCodex, notOffered, runCodex } from "../src/codex";
import { saveSettings } from "../src/settings";
import { boot, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const FAKE = `#!/bin/sh
D="$FAKE_CODEX_DIR"
echo "$*" >> "$D/calls.log"
case "$1" in
  --version) echo "codex-cli 0.166.0"; exit 0 ;;
  login) echo "Logged in using ChatGPT" >&2; exit 0 ;;
  mcp) echo "[]"; exit 0 ;;
  app-server) if [ -f "$D/no-app-server" ]; then exit 2; fi
    while IFS= read -r line; do
      case "$line" in *'"model/list"'*) cat "$D/model-list.json"; echo ;; esac
    done; exit 0 ;;
  debug) cat "$D/debug-models.json"; exit 0 ;;
  exec) ;;
  *) exit 2 ;;
esac
out=""; prev=""; model=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; [ "$prev" = "-m" ] && model="$a"; prev="$a"; done
[ -n "$model" ] || model="$(awk '/^[[]/{exit} /^model *= *"/{print; exit}' "$CODEX_HOME/config.toml" 2>/dev/null | cut -d'"' -f2)"
[ -n "$model" ] || model="$(cat "$D/configured" 2>/dev/null)"
[ -n "$model" ] || model="$(cat "$D/default" 2>/dev/null)"
cat > /dev/null
if ! grep -qx "$model" "$D/offered" 2>/dev/null; then echo "ERROR: The '$model' model is not supported when using Codex with a ChatGPT account." >&2; exit 1; fi
printf 'Answered on %s' "$model" > "$out"
`;
// Codex's app server: its pick (isDefault) is not first in its list, a hidden model and one it offers an upgrade from.
const LIST = { id: 2, result: { nextCursor: null, data: [
  { id: "gpt-6-astra", model: "gpt-6-astra", isDefault: false, hidden: false, upgrade: null },
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", isDefault: true, hidden: false, upgrade: null },
  { id: "gpt-daybreak", model: "gpt-daybreak", isDefault: false, hidden: true, upgrade: null },
  { id: "gpt-5.6-luna", model: "gpt-5.6-luna", isDefault: false, hidden: false, upgrade: "gpt-6-luna" },
  { id: "gpt-6-luna", model: "gpt-6-luna", isDefault: false, hidden: false, upgrade: null },
] } };
// `codex debug models`: the catalog, with a priority each (the smallest is Codex's pick).
const CATALOG = { models: [
  { slug: "gpt-6-luna", visibility: "list", priority: 4, upgrade: null },
  { slug: "gpt-6.1-sol", visibility: "list", priority: 1, upgrade: null },
  { slug: "gpt-5.5", visibility: "list", priority: 13, upgrade: { model: "gpt-6-sol" } },
  { slug: "codex-auto-review", visibility: "hide", priority: 43, upgrade: null },
] };

let dir = "", url = "";
const was = process.env.LEANFARE_CODEX_BIN, wasHome = process.env.CODEX_HOME;
const config = () => join(dir, "home", "config.toml");
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);
const set = (name: string, value: string) => writeFileSync(join(dir, name), value);
const part = () => runCodex({ n: 1, title: "A part", task: "Read it and say what it is.", folder: null, files: [], effort: "low" }, new AbortController().signal);
beforeAll(async () => {
  url = (await boot()).url;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-codex-model-")));
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "codex"), FAKE);
  chmodSync(join(dir, "codex"), 0o755);
  process.env.FAKE_CODEX_DIR = dir;
});
afterAll(() => {
  forgetCodex();
  if (was === undefined) delete process.env.LEANFARE_CODEX_BIN; else process.env.LEANFARE_CODEX_BIN = was;
  if (wasHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = wasHome;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(); // a clean server: no lock or settings left by another test file (local.test.ts ends with the lock on)
  forgetCodex();
  for (const f of ["calls.log", "no-app-server", "offered", "configured", "default", "home/config.toml"]) rmSync(join(dir, f), { force: true });
  set("model-list.json", JSON.stringify(LIST));
  set("debug-models.json", JSON.stringify(CATALOG));
  process.env.LEANFARE_CODEX_BIN = join(dir, "codex");
  process.env.CODEX_HOME = join(dir, "home");
});

describe("a model the ChatGPT plan offers", () => {
  test("Codex's settings name one it no longer offers: Leanfare asks Codex, runs the part on the first that works, keeps it, and says how to change the setting", async () => {
    set("configured", "gpt-5.4");
    set("offered", "gpt-6-luna\n"); // a Free plan: not Codex's pick, gpt-6.1-sol
    const r = await part();
    expect(r.answer).toBe("Answered on gpt-6-luna");
    expect(r.model).toBe("gpt-6-luna");
    expect(r.note).toBe("Codex's settings name gpt-5.4, which your ChatGPT plan does not offer, so it ran on gpt-6-luna, a model Codex offers you. Fix it in one press on the ChatGPT row in Leanfare's Settings.");
    const execs = calls().filter((c) => c.startsWith("exec "));
    expect(execs.map((c) => / -m (\S+)/.exec(c)?.[1] ?? null)).toEqual([null, "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]); // its settings, then Codex's pick, then the next ones
    expect(calls().filter((c) => c === "app-server").length).toBe(1);
    expect(codexPicked()).toEqual({ model: "gpt-6-luna", instead: "gpt-5.4" });
    // The next part goes straight to it, and Codex is not asked again.
    rmSync(join(dir, "calls.log"));
    const again = await part();
    expect(again.answer).toBe("Answered on gpt-6-luna");
    expect(again.note).toContain("so it ran on gpt-6-luna");
    expect(calls().filter((c) => c.startsWith("exec ")).map((c) => / -m (\S+)/.exec(c)?.[1])).toEqual(["gpt-6-luna"]);
    expect(calls()).not.toContain("app-server");
  });
  test("settings the plan is fine with: the part runs as before, with no model named and nothing asked", async () => {
    set("configured", "gpt-6-luna");
    set("offered", "gpt-6-luna\n");
    const r = await part();
    expect(r).toMatchObject({ answer: "Answered on gpt-6-luna", model: null, note: null });
    expect(calls().filter((c) => c.startsWith("exec ")).length).toBe(1);
    expect(calls().some((c) => c.includes(" -m "))).toBe(false);
    expect(calls()).not.toContain("app-server");
  });
  test("a Codex without the app server's model list: the catalog of codex debug models, by priority, without hidden models or those with an upgrade", async () => {
    set("no-app-server", "");
    expect(await codexModels(join(dir, "codex"))).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    forgetCodex();
    rmSync(join(dir, "no-app-server"));
    expect(await codexModels(join(dir, "codex"))).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]); // the app server: its pick first
  });
  test("none of them runs: the part fails, names what was tried, and says how to change the setting", async () => {
    set("configured", "gpt-5.4");
    set("offered", "gpt-7\n");
    const e: any = await part().catch((x) => x);
    expect(e.message).toBe("Codex's settings name gpt-5.4, which ChatGPT sign in does not offer, and Codex did not run gpt-6.1-sol, gpt-6-astra, gpt-6-luna either. Press Fix it on the ChatGPT row in Leanfare's Settings (it turns that setting off), or run codex and pick a model with /model.");
    expect(calls().filter((c) => c.startsWith("exec ")).length).toBe(4); // its settings and three more, no more
    expect(codexPicked()).toBe(null);
  });
  test("what Codex said, read: the refused model's name, none, or another error", () => {
    expect(notOffered("ERROR: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.")).toBe("gpt-5.4");
    expect(notOffered('{"detail":"This model is not supported when using Codex with a ChatGPT account."}')).toBe("");
    expect(notOffered("You've hit your usage limit. Try again later.")).toBe(null);
    expect(codexArgs("low", "/tmp/a.md", [], "gpt-6-luna").slice(0, 4)).toEqual(["exec", "-m", "gpt-6-luna", "--sandbox"]);
    expect(codexArgs("low", "/tmp/a.md").slice(0, 2)).toEqual(["exec", "--sandbox"]);
  });
});

describe("Codex's own setting, fixed in one press (0.13.2)", () => {
  const MINE = '# my Codex settings\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.docs]\ncommand = "docs"\nmodel = "not-top-level"\n';
  test("after a part ran on another model, the ChatGPT row says the setting is stale; Fix it turns only that line off, and Codex goes back to its own pick", async () => {
    writeFileSync(config(), MINE);
    set("offered", "gpt-6-luna\n");
    set("default", "gpt-6-luna");
    expect((await part()).model).toBe("gpt-6-luna");
    let r = await ui(url, "/api/codex");
    expect(r.json.setting).toEqual({ file: config(), model: "gpt-5.4", stale: true, using: "gpt-6-luna" });
    r = await ui(url, "/api/codex/setting/fix", {});
    expect(r.json).toEqual({ ok: true, message: "Done: Codex's settings no longer name gpt-5.4, so Codex uses its own pick." });
    expect(readFileSync(config(), "utf8")).toBe(MINE.replace('model = "gpt-5.4"', '# model = "gpt-5.4"  # turned off by Leanfare: ChatGPT sign in no longer offers this model, so Codex uses its own pick'));
    expect(codexPicked()).toBe(null);
    rmSync(join(dir, "calls.log"));
    const again = await part();
    expect(again).toMatchObject({ answer: "Answered on gpt-6-luna", model: null, note: null }); // no -m: Codex's own pick
    expect(calls().some((c) => c.includes(" -m "))).toBe(false);
    expect((await ui(url, "/api/codex")).json.setting).toMatchObject({ model: null, stale: false });
  });
  test("a model Codex's list does not have is stale before any part fails; one it has is not; a setting for another provider is left alone", async () => {
    writeFileSync(config(), 'model = "gpt-4o"\n');
    expect(await codexSetting()).toMatchObject({ model: "gpt-4o", stale: true, using: null });
    writeFileSync(config(), "model = 'gpt-5.6-luna'\n"); // on the list, with an upgrade offered: still a model Codex runs
    expect(await codexSetting()).toMatchObject({ model: "gpt-5.6-luna", stale: false });
    writeFileSync(config(), 'model_provider = "ollama"\nmodel = "llama3.2"\n');
    expect(await codexSetting()).toMatchObject({ model: "llama3.2", stale: false });
    rmSync(config());
    expect(await codexSetting()).toMatchObject({ model: null, stale: false });
  });
  test("on the page: the ChatGPT row shows it with Fix it, and one press fixes it", async () => {
    writeFileSync(config(), 'model = "gpt-4o"\n');
    saveSettings({ codexPlan: true });
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 200 && !doc.querySelector("#codexCard .codex-fix"); i++) await Bun.sleep(25);
    const fix = doc.querySelector("#codexCard .codex-fix");
    expect(fix.textContent).toContain("Codex is set to gpt-4o, which your ChatGPT plan no longer offers.");
    fix.querySelector("button").click();
    for (let i = 0; i < 200 && !readFileSync(config(), "utf8").startsWith("# model"); i++) await Bun.sleep(25);
    expect(readFileSync(config(), "utf8")).toStartWith('# model = "gpt-4o"  # turned off by Leanfare');
    for (let i = 0; i < 200 && doc.querySelector("#codexCard .codex-fix"); i++) await Bun.sleep(25);
    expect(doc.querySelector("#codexCard .codex-fix")).toBe(null);
    await closeApp();
    saveSettings({ codexPlan: false });
  }, 20000);
});
