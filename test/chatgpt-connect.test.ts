// ChatGPT in one press (codex.ts, 0.13): Connect installs Codex when it is not here, starts the ChatGPT sign in and
// turns hand offs on the ChatGPT plan on once Codex says it is signed in; the row sits next to your apps. A hand off no
// ticked model can take runs on Codex, and a plan's web search goes to Codex with its own web search.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetCodex, forgetConnect } from "../src/codex";
import { settings } from "../src/settings";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";
import { closeApp, openApp as open } from "./dom";

const FAKE = `#!/bin/sh
D="$FAKE_CODEX_DIR"
echo "$*" >> "$D/calls.log"
if [ "$1" = "--search" ]; then shift; fi
case "$1" in
  --version) echo "codex-cli 0.164.0"; exit 0 ;;
  login) if [ "$2" = "status" ]; then
           if [ -f "$D/apikey" ]; then echo "API key configured - sk-proj-***ABCDE" >&2; exit 0; fi
           if [ -f "$D/signed-in" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
           echo "Not logged in" >&2; exit 1
         fi
         echo "Starting local login server. If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?client_id=x"
         sleep 1; touch "$D/signed-in"; exit 0 ;;
  mcp) echo "[]"; exit 0 ;;
  exec) ;;
  *) exit 2 ;;
esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > "$D/prompt.txt"
printf 'Codex read it: %s' "$(grep -m1 -o 'nightly job[^.]*' "$D/prompt.txt")" > "$out"
`;
let url = "", dir = "";
const was = { bin: process.env.LEANFARE_CODEX_BIN, install: process.env.LEANFARE_CODEX_INSTALL, dir: process.env.FAKE_CODEX_DIR };
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);
beforeAll(async () => {
  url = (await boot()).url;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-connect-")));
  writeFileSync(join(dir, "fake-codex"), FAKE);
  chmodSync(join(dir, "fake-codex"), 0o755);
  // The installer: puts the fake Codex where Leanfare looks for it.
  writeFileSync(join(dir, "install"), `#!/bin/sh\ncp "${dir}/fake-codex" "${dir}/codex" && chmod 755 "${dir}/codex"\n`);
  chmodSync(join(dir, "install"), 0o755);
  process.env.FAKE_CODEX_DIR = dir;
});
afterAll(() => {
  for (const [k, v] of [["LEANFARE_CODEX_BIN", was.bin], ["LEANFARE_CODEX_INSTALL", was.install], ["FAKE_CODEX_DIR", was.dir]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  forgetConnect(); forgetCodex();
  await reset();
  for (const f of ["codex", "signed-in", "apikey", "calls.log"]) rmSync(join(dir, f), { force: true });
  process.env.LEANFARE_CODEX_BIN = join(dir, "codex"); // not there until the installer runs
  process.env.LEANFARE_CODEX_INSTALL = join(dir, "install");
});
afterEach(() => { closeApp(); forgetConnect(); fake.hooks.answer = null; });
async function until(ok: () => boolean | Promise<boolean>, ms = 12000) { for (let i = 0; i < ms / 100 && !(await ok()); i++) await Bun.sleep(100); }
const look = async () => (await ui(url, "/api/codex?fresh=1")).json;

describe("Connect ChatGPT, in one press", () => {
  test("Codex not here: Leanfare installs it, starts the ChatGPT sign in with its link, and turns hand offs on once signed in", async () => {
    expect(settings().codexPlan).toBe(false);
    const r = await ui(url, "/api/codex/connect", {});
    expect(["installing", "signing_in"]).toContain(r.json.connect.step);
    await until(async () => (await look()).connect.step === "connected");
    const c = await look();
    expect(c).toMatchObject({ installed: true, signedIn: true, login: "chatgpt", on: true, connect: { step: "connected", why: null } });
    expect(c.connect.url).toStartWith("https://auth.openai.com/oauth/authorize");
    expect(settings().codexPlan).toBe(true);
    expect(calls()).toContain("login");
  }, 30000);

  test("signed in with an API key: Connect says to log out first, and turns nothing on", async () => {
    writeFileSync(join(dir, "codex"), readFileSync(join(dir, "fake-codex"))); chmodSync(join(dir, "codex"), 0o755);
    writeFileSync(join(dir, "apikey"), "");
    const r = await ui(url, "/api/codex/connect", {});
    expect(r.json.connect).toMatchObject({ step: "failed" });
    expect(r.json.connect.why).toContain("codex logout");
    expect(settings().codexPlan).toBe(false);
  });

  test("an install that fails says what to run in Terminal", async () => {
    writeFileSync(join(dir, "install"), "#!/bin/sh\necho 'npm ERR! network' >&2\nexit 1\n");
    const r = await ui(url, "/api/codex/connect", {});
    await until(async () => (await look()).connect.step === "failed");
    expect((await look()).connect.why).toContain("Installing Codex did not work (npm ERR! network). In Terminal:");
    writeFileSync(join(dir, "install"), `#!/bin/sh\ncp "${dir}/fake-codex" "${dir}/codex" && chmod 755 "${dir}/codex"\n`);
  });

  test("the ChatGPT row sits next to your apps: Connect when not connected, Turn off once connected", async () => {
    writeFileSync(join(dir, "codex"), readFileSync(join(dir, "fake-codex"))); chmodSync(join(dir, "codex"), 0o755);
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await until(() => !!doc.querySelector("#codexCard")?.textContent.includes("not connected"));
    const apps = doc.querySelector("#appsSetting"), row = doc.querySelector("#codexCard");
    expect(apps.compareDocumentPosition(row) & 4).toBe(4); // after the apps, in the same section
    expect(row.textContent).toContain("A free account works.");
    const connect = [...row.querySelectorAll("button")].find((b: any) => b.textContent === "Connect") as any;
    connect.click();
    await until(() => !!doc.querySelector("#codexCard")?.textContent.includes("· connected"), 20000);
    expect([...doc.querySelector("#codexCard").querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Turn off"]);
    expect(settings().codexPlan).toBe(true);
  }, 30000);
});

describe("work on your ChatGPT plan", () => {
  test("a hand off no ticked model can take runs on Codex, read only, and can be graded", async () => {
    writeFileSync(join(dir, "codex"), readFileSync(join(dir, "fake-codex"))); chmodSync(join(dir, "codex"), 0o755);
    writeFileSync(join(dir, "signed-in"), "");
    await reset({ ticked: [], codexPlan: true });
    const r = await ui(url, "/api/delegate", { task: "Why does the nightly job fail? Answer in one line.", files: [{ name: "job.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "medium", check: "auto", app: "Claude" });
    expect(r.status).toBe(200);
    expect(r.json.answer).toStartWith("Codex read it: nightly job fail");
    expect(r.json.model).toEqual({ id: "codex", label: "Codex (your ChatGPT plan)" });
    expect(r.json.receipt).toContain("Codex (your ChatGPT plan)");
    expect(r.json.receipt).toContain("None of the models you ticked could take it now, so Codex took it on your ChatGPT plan.");
    expect(calls().some((c) => c.startsWith("exec --sandbox read-only"))).toBe(true);
    expect(typeof r.json.row).toBe("number");
    const g = await ui(url, "/api/grades", { handoff: r.json.row, verdict: "good" });
    expect(g.status).toBe(200);
  }, 30000);

  test("a plan's web search, with no Perplexity ticked, goes to Codex with its own web search on", async () => {
    writeFileSync(join(dir, "codex"), readFileSync(join(dir, "fake-codex"))); chmodSync(join(dir, "codex"), 0o755);
    writeFileSync(join(dir, "signed-in"), "");
    await reset({ codexPlan: true, ticked: ALL_TICKED });
    await keys("google");
    fake.hooks.answer = (prompt: string) => (prompt.includes("The person works in") ? JSON.stringify({ parts: [
      { title: "Search for the nightly job's known issues", kind: "search", effort: "low", needs: [], size: "small", task: "Search the web for known issues with the nightly job." },
      { title: "Fix it", kind: "code", effort: "high", needs: [1], size: "small", task: "Fix it." },
    ] }) : null);
    const plan = await ui(url, "/api/plan", { task: "The nightly job fails: search for known issues and fix it", files: [], manager: "Claude", run: true });
    expect(plan.status).toBe(200);
    expect(plan.json.parts[0]).toMatchObject({ kind: "search", where: "codex" });
    await until(async () => (await ui(url, `/api/plan/run?id=${plan.json.id}`)).json.parts[0].status === "done");
    expect(calls().some((c) => c.startsWith("--search exec --sandbox read-only"))).toBe(true);
    expect(readFileSync(join(dir, "prompt.txt"), "utf8")).toContain("Search the web for what the part asks");
  }, 30000);
});
