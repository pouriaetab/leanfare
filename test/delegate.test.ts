// Claude's delegate: the files the door reads (and the ones it never reads), the task
// each kind is rated for, the checks and their verdicts, a failed check asked again one tier
// up, the receipt, the budget, the rows it keeps (numbers only), and the Savings summary.
//
// The fixture's models, rated overall (no long prompt or hard prompt ratings, so overall
// counts): Gemini 3.8 Flash 1496, Claude Sonnet 4.6 1472, Grok 4.20 Beta 1471, Claude Sonnet
// 4.5 1456, Mistral Large 4 1450, GPT-5 mini 1440, DeepSeek V4 Flash 1438. For a short task,
// low effort (Save more) picks DeepSeek, medium (Balanced) Grok, high (Best quality) Gemini.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR } from "../src/config";
import { db } from "../src/db";
import { CHANCE, checkDelegate, draw, filesBlock, taskFor, verdictOf, weightedPass, wilson } from "../src/delegate";
import { DELEGATE_LIMITS, readForDelegate, secretReason, shownName, tilde } from "../src/readfiles";
import { getModel } from "../src/data";
import { runningList } from "../src/engine";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";

let url = "";
let dir = "";
beforeAll(async () => {
  url = (await boot()).url;
  dir = mkdtempSync(join(tmpdir(), "leanfare-delegate-"));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); draw.next = () => Math.random(); });
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  draw.next = () => 0.5;
});

const sent = (provider: string) => fake.seen.filter((s) => s.provider === provider && (s.path.endsWith("/chat/completions") || s.path.endsWith("/v1/messages")));
const textOf = (s: { body: any }) => JSON.stringify(s.body);
const delegations = () => db.query("SELECT * FROM delegations ORDER BY id").all() as any[];
const delegate = (body: unknown) => ui(url, "/api/delegate", body);
const ALL_KEYS = ["openai", "anthropic", "google", "deepseek", "xai", "mistral"];
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n10:02 retry\n10:03 error: disk full again\n" };

describe("the files the door reads", () => {
  beforeAll(() => { // files more than one test reads, so each test stands on its own
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "\uFEFFconst a = 1;\n");
    writeFileSync(join(dir, "notes.md"), "# Notes\n");
  });

  test("text files from the folder, named from it; one named twice is read once; file:// works", () => {
    const got = readForDelegate(["src/a.ts", join(dir, "notes.md"), "./src/a.ts", pathToFileURL(join(dir, "notes.md")).href], dir);
    expect(got).toEqual([{ name: "src/a.ts", text: "const a = 1;\n" }, { name: "notes.md", text: "# Notes\n" }]);
    expect(readForDelegate(undefined)).toEqual([]);
    expect(readForDelegate([])).toEqual([]);
  });

  test("a file outside the folder shows with ~ for the home folder, so the user name stays out", () => {
    expect(tilde(join(homedir(), "notes", "a.md"))).toBe("~/notes/a.md");
    expect(tilde(homedir())).toBe("~");
    expect(tilde("/etc/hosts")).toBe("/etc/hosts");
    expect(shownName(join(homedir(), "x", "y.txt"), "/somewhere/else")).toBe("~/x/y.txt");
    expect(shownName("/a/b/c.txt", "/a")).toBe("b/c.txt");
  });

  test("files that hold secrets are never read, a link is judged by where it points, and samples are fine", () => {
    const secrets: [string, string][] = [
      [".env", "KEY=1"], [".env.local", "KEY=1"], ["id_ed25519", "-----BEGIN"], ["server.pem", "-----BEGIN"], ["credentials.json", "{}"],
      [".npmrc", "//registry:_authToken=x"], ["secrets.yaml", "a: b"], [".ssh/config", "Host x"], [".git/config", "[remote]"], [".config/gh/hosts.yml", "token: x"],
      ["Library/Keychains/login.txt", "x"],
    ];
    for (const [name, text] of secrets) {
      mkdirSync(join(dir, "sec", name, ".."), { recursive: true });
      writeFileSync(join(dir, "sec", name), text);
      const got = readForDelegate([name], join(dir, "sec"));
      expect(typeof got).toBe("string");
      expect(got as string).toContain(`${name} was not read:`);
      expect(got as string).toContain("Leanfare never hands those to a model.");
    }
    writeFileSync(join(dir, "sec", ".env.example"), "KEY=");
    expect(readForDelegate([".env.example"], join(dir, "sec"))).toEqual([{ name: ".env.example", text: "KEY=" }]);
    symlinkSync(join(dir, "sec", ".env"), join(dir, "sec", "harmless.txt"));
    expect(readForDelegate(["harmless.txt"], join(dir, "sec")) as string).toContain("harmless.txt was not read: files like it hold secrets");
    // Leanfare's own folder holds its keys.
    writeFileSync(join(DATA_DIR, "note.txt"), "x");
    expect(readForDelegate([join(DATA_DIR, "note.txt")]) as string).toContain("inside Leanfare's own folder, where its keys live");
    expect(secretReason("/home/x/project/src/app.ts")).toBeNull();
    expect(secretReason("/home/x/.config/other/settings.json")).toBeNull();
  });

  test("other AI tools' sign ins, token files and .env's kin are refused too", () => {
    const more: Record<string, string> = {
      ".claude/.credentials.json": '{"claudeAiOauth":{}}', ".codex/auth.json": "{}", ".cargo/credentials.toml": "[registry]",
      "p/.envrc": "export A=1", "p/.env-production": "A=1", "p/.env_local": "A=1", "p/production.env": "A=1", "p/.dev.vars": "A=1",
      "p/AuthKey_ABC123DEFG.p8": "x", "p/private.asc": "x", "p/serviceAccountKey.json": "{}", "p/client_secret_123.apps.googleusercontent.com.json": "{}",
      "p/.yarnrc.yml": "npmAuthToken: x", "p/main.tfvars": "x", "p/.vault-token": "x",
    };
    for (const [rel, text] of Object.entries(more)) {
      mkdirSync(join(dir, "more", rel, ".."), { recursive: true });
      writeFileSync(join(dir, "more", rel), text);
      expect(readForDelegate([join(dir, "more", rel)]) as string).toContain("was not read:");
    }
    writeFileSync(join(dir, "more", "p", "production.env.example"), "A=");
    expect(readForDelegate(["production.env.example"], join(dir, "more", "p"))).toEqual([{ name: "production.env.example", text: "A=" }]);
  });

  test("names are compared without regard to case, as a Mac's disk does", () => {
    mkdirSync(join(dir, "case", ".SSH"), { recursive: true });
    writeFileSync(join(dir, "case", ".SSH", "config"), "Host x");
    writeFileSync(join(dir, "case", "ID_RSA"), "-----BEGIN");
    writeFileSync(join(dir, "case", "Server.PEM"), "-----BEGIN");
    for (const f of [".SSH/config", "ID_RSA", "Server.PEM"]) expect(readForDelegate([f], join(dir, "case")) as string).toContain(`${f} was not read:`);
    expect(secretReason(join(DATA_DIR.toUpperCase(), "keys.json"))).toBe("it is inside Leanfare's own folder, where its keys live");
  });

  test.skipIf(process.platform !== "linux")("a file that says it is empty but never ends is refused at once, not read to the end", () => {
    const t0 = performance.now();
    // Read up to the limit, or (where the system allows no reading of it) not opened at all.
    expect(readForDelegate(["/proc/self/pagemap"]) as string).toMatch(/^\/proc\/self\/pagemap (is more than 2\.0 MB|could not be read)/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("a pipe is never opened, so nothing waits on it", () => {
    execFileSync("mkfifo", [join(dir, "pipe")]);
    expect(readForDelegate(["pipe"], dir)).toBe("pipe is not a plain file.");
  });

  test("folders, missing files, binary files and anything too big are refused with a sentence", () => {
    mkdirSync(join(dir, "big"), { recursive: true });
    expect(readForDelegate(["big"], dir)).toBe(`big is a folder. Name the files in it instead (at most ${DELEGATE_LIMITS.count}).`);
    expect(readForDelegate(["nope.txt"], dir) as string).toMatch(/^nope\.txt does not exist \(Leanfare looked in .+\)\.$/);
    writeFileSync(join(dir, "big", "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(readForDelegate(["big/image.bin"], dir)).toBe("big/image.bin is not a text file. delegate reads text files only.");
    writeFileSync(join(dir, "big", "huge.log"), "x".repeat(DELEGATE_LIMITS.file + 1));
    expect(readForDelegate(["big/huge.log"], dir) as string).toMatch(/^big\/huge\.log is more than 2\.0 MB; delegate reads at most 2\.0 MB a file\. Hand over the part that matters/);
    for (const n of [1, 2, 3]) writeFileSync(join(dir, "big", `part${n}.log`), "y".repeat(1.5 * 1024 * 1024));
    expect(readForDelegate(["big/part1.log", "big/part2.log", "big/part3.log"], dir)).toBe("These files add up to more than 4.0 MB, the most delegate reads at once. Hand over fewer of them.");
    expect(readForDelegate(Array.from({ length: 51 }, (_, i) => `f${i}.txt`), dir)).toBe("At most 50 files go with one task.");
    expect(readForDelegate("a.txt", dir)).toBe("files must be a list of file paths.");
    expect(readForDelegate(["ok.txt", 3], dir)).toBe("files must be a list of file paths.");
    expect(readForDelegate(["a.txt"], join(dir, "missing-folder"))).toBe(`The folder ${join(dir, "missing-folder")} does not exist.`);
    expect(readForDelegate(["a.txt"], join(dir, "notes.md"))).toBe(`${join(dir, "notes.md")} is not a folder.`);
  });

  test("a relative path where the client started Leanfare at the root needs a folder", () => {
    const was = process.cwd();
    try {
      process.chdir("/");
      expect(readForDelegate(["src/a.ts"])).toBe("src/a.ts is a relative path, and Leanfare does not know your project's folder here. Give full paths, or the folder in folder.");
      expect(readForDelegate(["src/a.ts"], dir)).toEqual([{ name: "src/a.ts", text: "const a = 1;\n" }]);
    } finally { process.chdir(was); }
  });
});

describe("what the delegate works out before it sends", () => {
  test("each kind is rated as its own task; no kind is Auto's usual guess", () => {
    const m = (content: string) => [{ role: "user", content }];
    expect(taskFor("read", m("Summarize this")).task).toBe("longer_query");
    expect(taskFor("read", m("Summarize this")).why).toBe("the kind it was handed over as (read)");
    expect(taskFor("write", m("Write a function in python that sorts a list")).task).toBe("coding");
    expect(taskFor("write", m("Write a short story about a fox")).task).toBe("creative_writing");
    expect(taskFor("write", m("Draft the release notes")).task).toBe("instruction_following");
    expect(taskFor("reason", m("Why does this fail?")).task).toBe("hard_prompts");
    expect(taskFor("reason", m("Solve 3x + 5 = 20")).task).toBe("math");
    expect(taskFor(null, m("Solve 3x + 5 = 20")).task).toBe("math");
  });

  test("lines are numbered so an answer can point to name:line, except for writing", () => {
    const files = [{ name: "a.txt", text: "one\r\ntwo\n" }, { name: "empty.txt", text: "" }];
    expect(filesBlock(files, true)).toBe("[File: a.txt, 2 lines]\n1: one\n2: two\n[End of a.txt]\n\n[File: empty.txt, empty]");
    expect(filesBlock(files.slice(0, 1), false)).toBe("[File: a.txt, 2 lines]\none\ntwo\n[End of a.txt]");
  });

  test("the checker's verdict: PASS or FAIL first, or in capitals near the start; anything else is unclear", () => {
    expect(verdictOf("PASS")).toEqual({ verdict: "pass", why: "" });
    expect(verdictOf("**PASS**\nThe answer is right.")).toEqual({ verdict: "pass", why: "" });
    expect(verdictOf("pass.")).toEqual({ verdict: "pass", why: "" });
    expect(verdictOf("FAIL: it misses the second error.")).toEqual({ verdict: "fail", why: "it misses the second error" });
    expect(verdictOf("Failed - the totals are wrong\nMore text")).toEqual({ verdict: "fail", why: "the totals are wrong" });
    expect(verdictOf("Verdict: FAIL. Line numbers are off.")).toEqual({ verdict: "fail", why: "Line numbers are off" });
    expect(verdictOf("My verdict is PASS.")).toEqual({ verdict: "pass", why: "" });
    expect(verdictOf("I think it is mostly right")).toEqual({ verdict: "unclear", why: "" });
    expect(verdictOf("PASSWORD reset steps are listed")).toEqual({ verdict: "unclear", why: "" });
    expect(verdictOf("This would not PASS a careful review. FAIL: it misses the second error.")).toEqual({ verdict: "fail", why: "it misses the second error" });
    expect(verdictOf("Looking at it again, it does not PASS.")).toEqual({ verdict: "fail", why: "" });
    expect(verdictOf("At first I thought FAIL, but the totals check out. PASS")).toEqual({ verdict: "pass", why: "" });
    expect(verdictOf("")).toEqual({ verdict: "unclear", why: "" });
  });

  test("pass rates: Wilson's 90% range, and the rate weighted back to every task", () => {
    expect(wilson(0, 0)).toBeNull();
    // The same numbers as statsmodels' proportion_confint(k, n, alpha=0.1, method="wilson").
    const w = wilson(9, 10)!;
    expect(w.lo).toBeCloseTo(0.6522813326641415, 9);
    expect(w.hi).toBeCloseTo(0.9773650912691327, 9);
    expect(wilson(1, 2)!.lo).toBeCloseTo(0.1208663194222736, 9);
    expect(wilson(10, 10)!.lo).toBeCloseTo(0.7870580299165928, 9);
    expect(wilson(10, 10)!.hi).toBe(1);
    expect(wilson(0, 4)!.lo).toBe(0);
    expect(wilson(0, 4)!.hi).toBeCloseTo(0.4034786252027049, 9);
    // Two high effort answers checked (chance 1): one passed. One low effort answer checked
    // (chance 0.1) that passed stands for ten answers: (1 + 10) / (2 + 10).
    expect(weightedPass([{ verdict: "pass", chance: 1 }, { verdict: "fail", chance: 1 }, { verdict: "pass", chance: 0.1 }])).toBeCloseTo(11 / 12, 10);
    expect(weightedPass([{ verdict: "unclear", chance: 1 }])).toBeNull();
    expect(weightedPass([])).toBeNull();
  });

  test("the request is checked before anything is sent", () => {
    const ok = checkDelegate({ task: " Find the errors ", files: [LOG] });
    expect(ok).toEqual({ task: "Find the errors", files: [LOG], kind: null, effort: "medium", check: "auto", maxOut: 8192 });
    expect(checkDelegate({ task: "x", kind: "auto", effort: "high", check: "never", max_tokens: 300 })).toMatchObject({ kind: null, effort: "high", check: "never", maxOut: 300 });
    expect(checkDelegate(null)).toBe("The request must be a JSON object.");
    expect(checkDelegate([])).toBe("The request must be a JSON object.");
    expect(checkDelegate({ task: "  " })).toBe("delegate needs a task.");
    expect(checkDelegate({ task: "x".repeat(DELEGATE_LIMITS.task + 1) })).toBe("The task is 200,001 characters; the most is 200,000. Put long text in a file.");
    expect(checkDelegate({ task: "x", kind: "summarize" })).toBe("kind must be read, write or reason.");
    expect(checkDelegate({ task: "x", effort: "max" })).toBe("effort must be low, medium or high.");
    expect(checkDelegate({ task: "x", check: "sometimes" })).toBe("check must be auto, always or never.");
    expect(checkDelegate({ task: "x", max_tokens: 0 })).toBe("max_tokens must be a whole number from 1 to 64,000.");
    expect(checkDelegate({ task: "x", max_tokens: 2.5 })).toBe("max_tokens must be a whole number from 1 to 64,000.");
    expect(checkDelegate({ task: "x", files: "a.txt" })).toBe("files must be a list.");
    expect(checkDelegate({ task: "x", files: [{ name: "a.txt" }] })).toBe("Each file needs a name and its text.");
    expect(checkDelegate({ task: "x", files: Array.from({ length: 51 }, (_, i) => ({ name: `${i}`, text: "" })) })).toBe("At most 50 files go with one task.");
    expect(checkDelegate({ task: "x", files: [{ name: "big.log", text: "x".repeat(DELEGATE_LIMITS.file + 1) }] })).toBe("big.log is 2.0 MB; delegate reads at most 2.0 MB a file.");
    expect(checkDelegate({ task: "x", files: [1, 2, 3].map((n) => ({ name: `${n}`, text: "y".repeat(1.5 * 1024 * 1024) })) })).toBe("These files add up to more than 4.0 MB, the most delegate reads at once.");
    expect((checkDelegate({ task: "x", files: [{ name: "a\u0000b\n.txt", text: "q\u0000r" }] }) as any).files).toEqual([{ name: "ab.txt", text: "qr" }]);
  });
});

describe("handing a task over", () => {
  test("low effort reads with the cheapest model that rates well enough, and says what it saved", async () => {
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "List the errors in the log as file:line.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ answer: "Hello from deepseek-v4-flash.", model: { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }, task: "longer_query", taskLabel: "Long prompts", kind: "read", effort: "low", mode: "save", first: null, cut: false });
    expect(r.json.check).toEqual({ chance: 0, picked: false, verdict: null, why: "", checker: null, cost: null });
    expect(r.json.tokens).toEqual({ files: Math.ceil(LOG.text.length / 4), answer: Math.ceil("Hello from deepseek-v4-flash.".length / 4) });
    expect(r.json.total).toBe(r.json.cost);
    expect(r.json.receipt).toBe(`Leanfare delegate: DeepSeek V4 Flash, $${r.json.cost.toPrecision(2)}. About ${r.json.tokens.files} tokens of files stayed out of your context; this answer is about ${r.json.tokens.answer}.`);
    // What the model got: the brief instructions, the task first, then the file with numbered lines.
    const req = sent("deepseek").at(-1)!;
    expect(req.body.messages[0].role).toBe("system");
    expect(req.body.messages[0].content).toContain("it pays for every word it reads");
    expect(req.body.messages[0].content).toContain("only when the task asks where something is, point to it as name:line");
    // The trial's misses: an answer in the form asked for, not a place in the file.
    expect(req.body.messages[0].content).toContain("Answer in the form the task asks for");
    expect(req.body.messages[0].content).not.toContain("point to a place as name:line");
    expect(req.body.messages[1].content).toBe("List the errors in the log as file:line.\n\n[File: app.log, 4 lines]\n1: 10:00 start\n2: 10:01 error: disk full\n3: 10:02 retry\n4: 10:03 error: disk full again\n[End of app.log]");
    expect(req.body.max_tokens).toBe(8192); // the delegate's answer limit
    // The ledger has it as delegated work, at Save more, for long prompts.
    expect(ledger().map((l) => [l.source, l.model, l.mode, l.task, l.status])).toEqual([["delegate", "deepseek/deepseek-v4-flash", "save", "longer_query", "ok"]]);
    expect(delegations()).toMatchObject([{ task: "longer_query", kind: "read", effort: "low", model: "deepseek/deepseek-v4-flash", files: 1, status: "ok", chance: 0, verdict: null, checker: null, rerun: null }]);
  });

  test("medium effort, not picked for a check this time: the receipt says how often it is", async () => {
    await keys(...ALL_KEYS);
    draw.next = () => 0.9; // over the chance of 0.25
    const r = await delegate({ task: "Summarize the log.", files: [LOG], kind: "read" });
    expect(r.json.model.id).toBe("xai/grok-4.20-beta");
    expect(r.json.check).toMatchObject({ chance: CHANCE.medium, picked: false, verdict: null });
    expect(r.json.receipt).toContain("Not checked this time (Leanfare checks 1 in 4 medium effort answers).");
    expect(ledger().map((l) => l.source)).toEqual(["delegate"]);
    expect(delegations()[0]).toMatchObject({ chance: 0.25, verdict: null });
  });

  test("picked for a check: a stronger model reads the task, the files and the answer, and passes it", async () => {
    await keys(...ALL_KEYS);
    draw.next = () => 0.1; // under 0.25
    const r = await delegate({ task: "Summarize the log. [reply@google PASS]", files: [LOG], kind: "read" });
    expect(r.json.answer).toBe("Hello from grok-4.20-beta.");
    expect(r.json.check).toMatchObject({ picked: true, verdict: "pass", why: "", checker: { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" } });
    expect(r.json.receipt).toContain(`Checked by Gemini 3.8 Flash: passed ($${r.json.check.cost.toPrecision(2)}).`);
    expect(r.json.total).toBeCloseTo(r.json.cost + r.json.check.cost, 12);
    const ck = sent("google").at(-1)!;
    expect(ck.body.messages[0].content).toContain("You check another model's work.");
    expect(ck.body.messages[1].content).toContain("The task:\nSummarize the log. [reply@google PASS]\n\n[File: app.log, 4 lines]\n1: 10:00 start");
    expect(ck.body.messages[1].content.endsWith("The answer to check:\nHello from grok-4.20-beta.")).toBe(true);
    expect(ck.body.max_tokens).toBe(4096);
    expect(ledger().map((l) => [l.source, l.model, l.mode])).toEqual([["delegate", "xai/grok-4.20-beta", "balanced"], ["check", "google/gemini-3.8-flash", "best"]]);
    expect(delegations()[0]).toMatchObject({ model: "xai/grok-4.20-beta", checker: "google/gemini-3.8-flash", verdict: "pass", chance: 0.25, rerun: null });
  });

  test("a failed check is asked again one tier up, among models rated above the first, with the checker's reason", async () => {
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "Find every error. [reply@google FAIL: it misses the second error.]", files: [LOG], kind: "read", effort: "low", check: "always" });
    expect(r.json.answer).toBe("Hello from grok-4.20-beta.");
    expect(r.json.model.id).toBe("xai/grok-4.20-beta"); // Balanced, one tier above Save more
    expect(r.json.first).toMatchObject({ model: { id: "deepseek/deepseek-v4-flash" } });
    expect(r.json.check).toMatchObject({ chance: 1, verdict: "fail", why: "it misses the second error", checker: { id: "google/gemini-3.8-flash" } });
    expect(r.json.receipt).toStartWith(`Leanfare delegate: DeepSeek V4 Flash answered first ($${r.json.first.cost.toPrecision(2)}), Gemini 3.8 Flash failed it (it misses the second error; $${r.json.check.cost.toPrecision(2)}), so Grok 4.20 Beta answered again ($${r.json.cost.toPrecision(2)}). This is the second answer, not checked again.`);
    expect(r.json.total).toBeCloseTo(r.json.first.cost + r.json.check.cost + r.json.cost, 12);
    const again = sent("xai").at(-1)!;
    expect(again.body.messages[1].content).toEndWith("A checker found a problem with an earlier answer to this task: it misses the second error. Avoid it.");
    expect(ledger().map((l) => [l.source, l.model, l.mode])).toEqual([
      ["delegate", "deepseek/deepseek-v4-flash", "save"], ["check", "google/gemini-3.8-flash", "best"], ["delegate", "xai/grok-4.20-beta", "balanced"],
    ]);
    expect(delegations()[0]).toMatchObject({ model: "deepseek/deepseek-v4-flash", checker: "google/gemini-3.8-flash", verdict: "fail", rerun: "xai/grok-4.20-beta", chance: 1 });
    expect(delegations()[0].rerun_cost).toBeCloseTo(r.json.cost, 12);
  });

  test("when asking again fails, the first answer comes back with a warning", async () => {
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "Find every error. [reply@google FAIL: misses one] [fail@xai 400]", files: [LOG], kind: "read", effort: "low", check: "always" });
    expect(r.status).toBe(200);
    expect(r.json.answer).toBe("Hello from deepseek-v4-flash.");
    expect(r.json.first).toBeNull();
    expect(r.json.check).toMatchObject({ verdict: "fail", why: "misses one" });
    expect(r.json.rerunError).toContain("fake failure 400");
    expect(r.json.receipt).toContain("Gemini 3.8 Flash failed it (misses one; $");
    expect(r.json.receipt).toContain("), and asking again did not work (");
    expect(r.json.receipt).toContain("Check this answer yourself.");
    expect(delegations()[0]).toMatchObject({ verdict: "fail", rerun: null, rerun_cost: 0 });
  });

  test("stopped during the check: nothing is asked again, and the row says stopped", async () => {
    await keys(...ALL_KEYS);
    const ac = new AbortController();
    const going = fetch(`${url}/api/delegate`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ task: "Summarize. [slow@google 3000]", files: [LOG], effort: "low", check: "always" }), signal: ac.signal }).catch(() => null);
    for (let i = 0; i < 100 && !sent("google").length; i++) await Bun.sleep(20);
    ac.abort();
    await going;
    for (let i = 0; i < 100 && !delegations().length; i++) await Bun.sleep(20);
    expect(delegations()).toMatchObject([{ status: "stopped", model: "deepseek/deepseek-v4-flash", verdict: null }]);
    expect(sent("xai")).toHaveLength(0);
  });

  test("from Best quality there is no tier above, so the checker itself answers again", async () => {
    await reset({ ticked: ALL_TICKED.filter((id) => id !== "google/gemini-3.8-flash") });
    await keys(...ALL_KEYS);
    // Best quality without Gemini: within 15 of Claude Sonnet 4.6 (1472) is Grok (1471), the cheaper; above Grok, only Sonnet 4.6.
    const r = await delegate({ task: "Find the cause. [reply@anthropic FAIL: wrong cause]", files: [LOG], kind: "reason", effort: "high" });
    expect(r.json.first.model.id).toBe("xai/grok-4.20-beta");
    expect(r.json.check).toMatchObject({ verdict: "fail", checker: { id: "anthropic/claude-sonnet-4-6" } });
    expect(r.json.model.id).toBe("anthropic/claude-sonnet-4-6");
    const asks = sent("anthropic");
    expect(asks).toHaveLength(2); // the check, then the second answer
    expect(textOf(asks[1])).toContain("A checker found a problem with an earlier answer to this task: wrong cause. Avoid it.");
    expect(ledger().map((l) => [l.source, l.model, l.task])).toEqual([
      ["delegate", "xai/grok-4.20-beta", "hard_prompts"], ["check", "anthropic/claude-sonnet-4-6", "hard_prompts"], ["delegate", "anthropic/claude-sonnet-4-6", "hard_prompts"],
    ]);
  });

  test("the best rated model is not checked, because nothing is stronger; and an unclear verdict is said plainly", async () => {
    await keys(...ALL_KEYS);
    const high = await delegate({ task: "Summarize the log.", files: [LOG], kind: "read", effort: "high" });
    expect(high.json.model.id).toBe("google/gemini-3.8-flash");
    expect(high.json.check).toMatchObject({ chance: 1, picked: true, verdict: "skipped", checker: null });
    expect(high.json.receipt).toContain("Not checked: Gemini 3.8 Flash is the best rated model you ticked for this, so there is no stronger one to check it.");
    expect(delegations()[0]).toMatchObject({ verdict: "skipped", checker: null });
    draw.next = () => 0.01;
    const unclear = await delegate({ task: "Summarize the log. [reply@google I think it is mostly right]", files: [LOG], kind: "read" });
    expect(unclear.json.check).toMatchObject({ verdict: "unclear", checker: { id: "google/gemini-3.8-flash" } });
    expect(unclear.json.receipt).toContain("Checked by Gemini 3.8 Flash: no clear verdict");
    expect(unclear.json.first).toBeNull();
  });

  test("a check the budget has no room for is skipped, and the answer still comes back", async () => {
    // DeepSeek's answer can cost up to about $0.010 (8,192 tokens at $1.20 per million); Gemini's check up to about $0.016.
    await reset({ ticked: ALL_TICKED, budget: 0.012, atLimit: "stop" });
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "Summarize the log.", files: [LOG], kind: "read", effort: "low", check: "always" });
    expect(r.status).toBe(200);
    expect(r.json.answer).toBe("Hello from deepseek-v4-flash.");
    expect(r.json.check).toMatchObject({ picked: true, verdict: "skipped", cost: 0 });
    expect(r.json.check.why).toMatch(/^the check could not run \(This request could cost up to \$0\.01\d+ with Gemini 3\.8 Flash \(its longest possible answer\), which would pass your monthly budget of \$0\.012/);
    expect(r.json.receipt).toContain("Not checked: the check could not run (");
    expect(ledger().map((l) => l.source)).toEqual(["delegate"]);
    // "Keep going on the cheapest model" lets the work past the budget, never a check.
    await reset({ ticked: ALL_TICKED, budget: 0.012, atLimit: "cheapest" });
    await keys(...ALL_KEYS);
    const past = await delegate({ task: "Summarize the log.", files: [LOG], kind: "read", effort: "low", check: "always" });
    expect(past.json.check.verdict).toBe("skipped");
    expect(past.json.check.why).toEndWith("Work Leanfare can skip, like a check, never goes past the budget)");
    expect(ledger().map((l) => l.source)).toEqual(["delegate"]);
  });

  test("an answer limit is sent as asked, and an answer that reaches it is called cut short", async () => {
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "Explain the log in detail. [usage 300 500]", files: [LOG], kind: "read", effort: "low", check: "never", max_tokens: 200 });
    expect(sent("deepseek").at(-1)!.body.max_tokens).toBe(200);
    expect(r.json.cut).toBe(true);
    expect(r.json.receipt).toEndWith("It stopped at its limit of 200 tokens, so it may be cut short.");
  });

  test("more text than any ticked model can hold is refused before anything is sent", async () => {
    await keys(...ALL_KEYS);
    const half = "z".repeat(DELEGATE_LIMITS.file);
    const r = await delegate({ task: "Read these.", files: [{ name: "a.log", text: half }, { name: "b.log", text: half }], effort: "low" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^None of the models you ticked can take this much text \(about 1,\d{3},\d{3} tokens with the answer\)\. Hand over fewer or shorter files, or tick a model with a longer context\.$/);
    expect(sent("deepseek")).toHaveLength(0);
    expect(delegations()).toMatchObject([{ status: "error", model: null, files: 2 }]);
  });

  test("a bad request is refused with a sentence; with no key, it says how to add one", async () => {
    expect(await delegate({ task: "" })).toEqual({ status: 400, json: { error: "delegate needs a task." } });
    expect((await delegate({ task: "x", effort: "max" })).json.error).toBe("effort must be low, medium or high.");
    const none = await delegate({ task: "Summarize this." });
    expect(none.status).toBe(400);
    expect(none.json.error).toContain("No model is ready yet.");
    expect(delegations()).toMatchObject([{ status: "error" }]);
  });

  test("stopped half way: nothing more is sent, and the row says stopped", async () => {
    await keys(...ALL_KEYS);
    const ac = new AbortController();
    const going = fetch(`${url}/api/delegate`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ task: "Summarize. [slow 3000]", files: [LOG], effort: "low", check: "always" }), signal: ac.signal }).catch(() => null);
    for (let i = 0; i < 100 && !sent("deepseek").length; i++) await Bun.sleep(20);
    ac.abort();
    await going;
    for (let i = 0; i < 100 && !delegations().length; i++) await Bun.sleep(20);
    expect(delegations()).toMatchObject([{ status: "stopped" }]);
    expect(sent("google")).toHaveLength(0); // no check after a stop
  });

  test("what a task cost counts every try: a first answer that came back empty and was asked again is in the total", async () => {
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "Summarize the log. [empty1]", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(r.status).toBe(200);
    const charged = ledger().reduce((n, l) => n + l.cost, 0);
    expect(ledger()).toHaveLength(2); // the empty try, then the answer
    expect(r.json.total).toBeCloseTo(charged, 12);
    expect(r.json.cost).toBeCloseTo(charged, 12);
    expect((await ui(url, "/api/savings")).json.delegate.cost).toBeCloseTo(charged, 12);
  });

  test("stopped in Leanfare during the check: the answer already paid for still comes back", async () => {
    await keys(...ALL_KEYS);
    const going = delegate({ task: "Summarize. [slow@google 3000]", files: [LOG], kind: "read", effort: "low", check: "always" });
    let id: string | undefined;
    for (let i = 0; i < 300 && !id; i++) { await Bun.sleep(10); id = runningList().find((r) => r.label.startsWith("Delegate check"))?.id; }
    expect(id).toBeTruthy();
    await ui(url, "/api/running/stop", { id });
    const r = await going;
    expect(r.status).toBe(200);
    expect(r.json.answer).toBe("Hello from deepseek-v4-flash.");
    expect(r.json.check).toMatchObject({ verdict: "skipped", why: "the check was stopped in Leanfare" });
    expect(r.json.receipt).toContain("Not checked: the check was stopped in Leanfare.");
    const ck = ledger().find((l) => l.source === "check")!;
    expect(delegations()[0].check_cost).toBeCloseTo(ck.cost, 12);
  });

  test("the caller gone during the check: the row still has what the check was charged", async () => {
    await keys(...ALL_KEYS);
    const ac = new AbortController();
    const going = fetch(`${url}/api/delegate`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ task: "Summarize. [slow@google 3000] [chunks 40]", files: [LOG], effort: "low", check: "always" }), signal: ac.signal }).catch(() => null);
    for (let i = 0; i < 200 && !sent("google").length; i++) await Bun.sleep(20);
    await Bun.sleep(50);
    ac.abort();
    await going;
    for (let i = 0; i < 100 && !delegations().length; i++) await Bun.sleep(20);
    const ck = ledger().find((l) => l.source === "check");
    expect(delegations()[0]).toMatchObject({ status: "stopped" });
    expect(delegations()[0].check_cost ?? 0).toBe(ck ? ck.cost : 0); // on a slow computer the stop can come before the check
  });

  test("stronger models that cannot take the check's text: the receipt says that, not that none is stronger", async () => {
    await keys(...ALL_KEYS);
    for (const id of ALL_TICKED) if (id !== "deepseek/deepseek-v4-flash") getModel(id)!.context = 5000;
    const big = { name: "big.log", text: "line of log text\n".repeat(200) };
    const r = await delegate({ task: "Summarize the log.", files: [big], kind: "read", effort: "low", check: "always" });
    expect(r.json.model.id).toBe("deepseek/deepseek-v4-flash");
    expect(r.json.check.verdict).toBe("skipped");
    expect(r.json.receipt).toMatch(/Not checked: the models rated above DeepSeek V4 Flash cannot take the check's text \(about [\d,]+ tokens\)\./);
  });

  test("after a failed check, the second try never goes past the budget, and never to a weaker model", async () => {
    await reset({ ticked: ALL_TICKED.filter((id) => id !== "google/gemini-3.8-flash"), budget: 0.08, atLimit: "cheapest" });
    await keys(...ALL_KEYS);
    const r = await delegate({ task: "Find the cause. [reply@anthropic FAIL: wrong cause]", files: [LOG], kind: "reason", effort: "high" });
    expect(r.status).toBe(200);
    expect(r.json.model.id).toBe("xai/grok-4.20-beta"); // the first answer: Claude Sonnet 4.6's second try does not fit the budget
    expect(r.json.first).toBeNull();
    expect(r.json.check).toMatchObject({ verdict: "fail", checker: { id: "anthropic/claude-sonnet-4-6" } });
    expect(r.json.rerunError).toContain("never goes past the budget");
    expect(sent("deepseek")).toHaveLength(0);
    expect(ledger().map((l) => l.source)).toEqual(["delegate", "check"]);
  });

  test("numbers only: neither the ledger nor the delegations table keeps the task or the files", async () => {
    await keys(...ALL_KEYS);
    const secret = "the launch code is tangerine-42";
    await delegate({ task: `Find ${secret}. [reply@google FAIL: missing ${secret}]`, files: [{ name: "plan.md", text: `Plan: ${secret}\n` }], kind: "read", effort: "low", check: "always" });
    const kept = JSON.stringify([ledger(), delegations()]);
    expect(kept).not.toContain("tangerine");
    expect(kept).not.toContain("plan.md");
    expect(kept).not.toContain("Find ");
  });

  test("Savings: what was handed over, what stayed out of context, and how the checks went", async () => {
    await keys(...ALL_KEYS);
    expect((await ui(url, "/api/savings")).json.delegate).toBeNull();
    await delegate({ task: "Summarize the log. [reply@google PASS]", files: [LOG], kind: "read", effort: "low", check: "always" });
    await delegate({ task: "Find every error. [reply@google FAIL: misses one]", files: [LOG], kind: "read", effort: "low", check: "always" });
    draw.next = () => 0.9;
    await delegate({ task: "Count the lines.", files: [LOG], kind: "read", effort: "low" });
    await delegate({ task: "Count the lines. [fail 400]", files: [LOG], kind: "read", effort: "low" }); // failed: nothing kept out
    const v = (await ui(url, "/api/savings")).json;
    const d = v.delegate;
    expect(d).toMatchObject({ tasks: 4, ok: 3, passed: 1, failed: 1, unclear: 0, reruns: 1, passRate: 0.5, weighted: 0.5 });
    expect(d.kept).toBe(3 * Math.ceil(LOG.text.length / 4));
    const l = ledger();
    expect(d.cost).toBeCloseTo(l.reduce((n, r) => n + r.cost, 0), 12);
    expect(d.checkCost).toBeCloseTo(l.filter((r) => r.source === "check").reduce((n, r) => n + r.cost, 0), 12);
    const w = wilson(1, 2)!;
    expect(d.passLo).toBeCloseTo(w.lo, 12);
    expect(d.passHi).toBeCloseTo(w.hi, 12);
    expect(v.bySource.map((s: any) => s.source).sort()).toEqual(["check", "delegate"]);
    expect(v.definitions.delegate).toContain("one over its chance of being checked");
  });
});
