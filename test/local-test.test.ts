// The test of a model on this computer (localtest.ts): the trial's reading questions with known answers, on
// that model only; one that passes takes reading at low and medium effort first, in the delegate and in plans.
// The models here are the fake Ollama's; the answers come from test hooks.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passedLocal, testResults } from "../src/localpass";
import { makePlan } from "../src/planner";
import { setSwitch } from "../src/switch";
import { QUESTIONS, truths } from "../src/trial";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";
const MACHINE = process.platform === "darwin" ? "Mac" : "computer"; // what the texts call this computer

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterAll(() => setSwitch(true));
const QWEN = "ollama/qwen3.5:9b";
const T = truths();
const right = (q: (typeof QUESTIONS)[number]) => { const v = T[QUESTIONS.indexOf(q)]; return Array.isArray(v) ? v.join(", ") : String(v); };
// The local model answers every question right, except the ones named in `miss`; other models say hello.
function answers(miss: string[] = []) {
  fake.hooks.answer = (prompt, provider) => {
    if (provider !== "ollama") return null;
    const q = QUESTIONS.find((x) => prompt.includes(x.task));
    if (!q) return null;
    return miss.includes(q.id) ? "I do not know." : right(q);
  };
}
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  setSwitch(true);
  fake.ollama.models.push({ name: "qwen3.5:9b", model: "qwen3.5:9b", modified_at: "2026-10-01T00:00:00Z", size: 6.6e9, digest: "b1", details: { family: "qwen35", parameter_size: "9B", quantization_level: "Q4_K_M" } });
  fake.ollama.contexts["qwen3.5:9b"] = 16384;
  await ui(url, "/api/refresh", { what: "ollama" });
  await keys("openai", "google", "deepseek");
});
async function finished(ms = 20_000) {
  let v: any = null;
  for (let i = 0; i < ms / 50; i++) { v = (await ui(url, "/api/local/test")).json; if (!v.running) return v; await Bun.sleep(50); }
  throw new Error("the test did not finish");
}

describe("testing a model on this computer", () => {
  test("8 reading questions that fit its context, on that model only, free; a pass is kept and ticks it", async () => {
    answers();
    const start = await ui(url, "/api/local/test", { model: QWEN });
    expect(start.status).toBe(200);
    expect(start.json.current).toMatchObject({ model: QWEN, status: "running", total: 8, skipped: 1 }); // the long log does not fit 16k tokens
    const v = await finished();
    expect(v.current).toMatchObject({ status: "done", right: 8, total: 8 });
    expect(v.results[QWEN]).toMatchObject({ right: 8, asked: 8, skipped: 1, passed: true, corpus: "1" });
    // Only the model on this computer was asked, with no check: nothing went to a model in the cloud.
    expect(fake.seen.filter((s) => s.path.includes("/chat/completions") || s.path.includes("/api/chat")).every((s) => s.path.startsWith("/ollama"))).toBe(true);
    expect(ledger().every((l) => l.source === "trial" && l.model === QWEN)).toBe(true);
    expect((await ui(url, "/api/state")).json.settings.ticked).toContain(QWEN);
    expect(passedLocal()?.id).toBe(QWEN);
  });

  test("two wrong does not pass: it gets no reading work, and it is ticked only as before", async () => {
    answers(["log-errors", "csv-refunds"]);
    await ui(url, "/api/models/tick", { ids: [QWEN], on: false }); // not ticked: the test ticks it while it runs
    await ui(url, "/api/local/test", { model: QWEN });
    const v = await finished();
    expect(v.results[QWEN]).toMatchObject({ right: 6, asked: 8, passed: false });
    expect((await ui(url, "/api/state")).json.settings.ticked).not.toContain(QWEN);
    expect(passedLocal()).toBeNull();
  });

  test("one at a time, never during the trial, Stop ends it, and switching Leanfare off stops it", async () => {
    answers();
    fake.hooks.slow = (text: string) => (text.includes("server.log") ? 400 : 0);
    await ui(url, "/api/local/test", { model: QWEN });
    const again = await ui(url, "/api/local/test", { model: QWEN });
    expect(again.status).toBe(409);
    const trial = await ui(url, "/api/trial/start", {});
    expect(trial.status).toBe(409);
    expect(trial.json.error).toContain("is being tested");
    const stop = await ui(url, "/api/local/test/stop", {});
    expect(stop.json.current.status).toBe("stopped");
    expect(testResults()[QWEN]).toBeUndefined(); // a stopped test keeps nothing
    await ui(url, "/api/local/test", { model: QWEN });
    const off = await ui(url, "/api/switch", { on: false });
    expect(off.json.stopped.trial).toBe(true);
    expect((await ui(url, "/api/local/test")).json.current.status).toBe("stopped");
    fake.hooks.slow = null;
  });

  test("only models on this computer, by name or id", async () => {
    expect((await ui(url, "/api/local/test", { model: "openai/gpt-5-mini" })).status).toBe(404);
    expect((await ui(url, "/api/local/test", {})).status).toBe(400);
    answers();
    expect((await ui(url, "/api/local/test", { model: "qwen3.5:9b" })).json.current.model).toBe(QWEN);
    await finished();
  });
});

describe("a model that passed takes reading first", () => {
  async function pass() { answers(); await ui(url, "/api/local/test", { model: QWEN }); await finished(); fake.hooks.answer = null; }
  const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };

  test("the delegate: reading at low and medium effort goes to it, $0; drafting and high effort do not", async () => {
    await pass();
    const low = await ui(url, "/api/delegate", { task: "List the errors.", files: [LOG], kind: "read", effort: "low", check: "never" });
    expect(low.json.model.id).toBe(QWEN);
    expect(low.json.cost).toBe(0);
    const medium = await ui(url, "/api/delegate", { task: "List the errors.", files: [LOG], kind: "read", effort: "medium", check: "never" });
    expect(medium.json.model.id).toBe(QWEN);
    expect((await ui(url, "/api/delegate", { task: "Draft a note.", files: [], kind: "write", effort: "low", check: "never" })).json.model.id).not.toBe(QWEN);
    expect((await ui(url, "/api/delegate", { task: "List the errors.", files: [LOG], kind: "read", effort: "high", check: "never" })).json.model.id).not.toBe(QWEN);
  });

  test("when it cannot answer, another model does, and the receipt says why", async () => {
    await pass();
    fake.hooks.fail = (_t: string, provider: string) => (provider === "ollama" ? 500 : null);
    const r = await ui(url, "/api/delegate", { task: "List the errors.", files: [LOG], kind: "read", effort: "low", check: "never" });
    fake.hooks.fail = null;
    expect(r.status).toBe(200);
    expect(r.json.model.id).not.toBe(QWEN);
    expect(r.json.receipt).toContain("qwen3.5:9b, on this computer, could not answer");
  });

  test("a plan: its reading part runs on it, and the table says why", async () => {
    await pass();
    const dir = mkdtempSync(join(tmpdir(), "local-first-"));
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "app.log"), "10:01 error: the nightly job timed out\n".repeat(200));
    const plan = await makePlan({ task: "Find out why the nightly job fails and fix it", files: [{ name: join(dir, "logs", "app.log"), size: 7800 }], manager: "Claude Code", split: "rules", signal: new AbortController().signal });
    const read = plan.parts.find((p) => p.kind === "read")!;
    expect(read).toMatchObject({ where: "local", model: { id: QWEN }, cost: 0 });
    expect(read.why).toContain("reading goes first to qwen3.5:9b, which passed this computer's reading test");
  });
});

describe("on the screen and in the apps", () => {
  test("Settings: Test it on this computer runs the test, and the model then shows it passed and is used first", async () => {
    answers();
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    const card = () => doc.querySelector("#localCard");
    for (let i = 0; i < 160 && !card()?.querySelector(".krow"); i++) await Bun.sleep(50);
    const reading = card().querySelector(".krow");
    expect(reading.textContent).toContain("qwen3.5:9b");
    const btn = [...reading.querySelectorAll("button")].find((b: any) => b.textContent === `Test it on this ${MACHINE}`) as any;
    btn.click();
    for (let i = 0; i < 200 && !card()?.textContent.includes("passed the test: 8 of 8"); i++) await Bun.sleep(50);
    expect(card().textContent).toContain("passed the test: 8 of 8");
    expect(card().querySelector(".krow").textContent).toContain("used first");
    expect(card().querySelector(".krow").textContent).toContain(`It passed this ${MACHINE}'s test, 8 of 8 right, so plans and the delegate send reading here first: it is free.`);
    expect([...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" ")).toContain("qwen3.5:9b: 8 of 8 right. It passed");
    closeApp();
  }, 20000);

  test("the local_model tool: test starts it, status follows it, suggest says where and what for each kind", async () => {
    answers();
    const child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LEANFARE_URL: url, LEANFARE_TOKEN: "test-token" } });
    let buf = ""; const got = new Map<number, any>();
    (async () => { const dec = new TextDecoder(); for await (const c of child.stdout as ReadableStream<Uint8Array>) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id !== undefined) got.set(m.id, m); } } })();
    let n = 1;
    const call = async (args: unknown) => {
      const id = n++;
      (child.stdin as any).write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "local_model", arguments: args } }) + "\n"); (child.stdin as any).flush?.();
      for (let i = 0; i < 200 && !got.has(id); i++) await Bun.sleep(25);
      return got.get(id).result;
    };
    try {
      const started = await call({ action: "test", model: "qwen3.5:9b" });
      expect(started.content[0].text).toContain("Testing qwen3.5:9b on this computer: 8 questions with known answers");
      let st: any = null;
      for (let i = 0; i < 100; i++) { st = await call({ action: "status" }); if (!st.content[0].text.startsWith("Testing")) break; await Bun.sleep(50); }
      expect(st.content[0].text).toContain("qwen3.5:9b: 8 of 8 right (1 too long for it, left out)");
      expect(st.content[0].text).toContain("It passed: plans and the delegate send reading to it first.");
      const s = await call({});
      expect(s.content[0].text).toContain("Reading and pulling out facts: qwen3.5:9b (6.6 GB), you have it, passed the test (8 of 8).");
      expect((await call({ action: "test" })).isError).toBe(true);
    } finally { child.kill(); }
  }, 20000);
});
