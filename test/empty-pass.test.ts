// An answer still empty after Leanfare asked the same model once more (0.11.1): Auto passes the request to its next
// pick, once, so a hand off or a plan's part is not lost to one model's empty answers. A model you named is not
// swapped, and what is still empty after the next pick is an error that names it.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { runDelegate } from "../src/delegate";
import { runChat } from "../src/engine";
import { boot, fake, keys, post, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", CLAUDE = "anthropic/claude-sonnet-4-6";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ ticked: [GEMINI, CLAUDE], mode: "save" });
  await keys("google", "anthropic");
});
// Google answers nothing, every time (no text, the answer ended as usual); the others as usual.
const emptyAt = (...providers: string[]) => { fake.hooks.answer = (_p: string, provider: string) => (providers.includes(provider) ? "" : null); };
const tries = () => db.query("SELECT model, status, error FROM ledger ORDER BY id").all();
const chat = async (asked: string) => {
  const events: any[] = [];
  const r = await runChat([{ role: "user", content: "Hi [usage 100 10]" }], asked, new AbortController().signal, (e) => events.push(e));
  return { ...r, events };
};
const AGAIN = "The first try came back empty, so Leanfare asked Gemini 3.8 Flash once more.";
const PASSED = "Gemini 3.8 Flash came back empty again, so Auto passed the request to its next pick.";

describe("an answer still empty after a second try", () => {
  test("Auto passes it to its next pick, says so, and every try is in the ledger at what it cost", async () => {
    emptyAt("google");
    const r = await chat("auto");
    expect([r.status, r.meta.model.id, r.text]).toEqual(["ok", CLAUDE, "Hello from claude-sonnet-4-6."]);
    expect(r.meta.notes).toEqual(expect.arrayContaining([AGAIN, PASSED]));
    expect(r.events.filter((e) => e.type === "retry").map((e) => e.message)).toEqual([AGAIN, PASSED]); // the chat screen starts the answer over each time
    expect(tries()).toEqual([
      { model: GEMINI, status: "error", error: "came back empty" },
      { model: GEMINI, status: "error", error: "came back empty" },
      { model: CLAUDE, status: "ok", error: null }]);
    const sum = (db.query("SELECT SUM(cost) AS s FROM ledger").get() as { s: number }).s;
    expect(r.meta.spent).toBeCloseTo(sum, 10);
  });
  test("a model you named is not swapped: an error that says so", async () => {
    emptyAt("google");
    const r = await chat(GEMINI);
    expect([r.status, r.meta.error]).toEqual(["error", "Gemini 3.8 Flash sent an empty answer."]);
    expect(tries().map((t: any) => t.model)).toEqual([GEMINI, GEMINI]);
  });
  test("once: when the next pick comes back empty too, the error names it", async () => {
    emptyAt("google", "anthropic");
    const r = await chat("auto");
    expect([r.status, r.meta.error]).toEqual(["error", "Claude Sonnet 4.6 sent an empty answer."]);
    expect(tries().map((t: any) => [t.model, t.status])).toEqual([[GEMINI, "error"], [GEMINI, "error"], [CLAUDE, "error"]]);
  });
  test("no other pick: the same error as before", async () => {
    await reset({ ticked: [GEMINI], mode: "save" });
    await keys("google");
    emptyAt("google");
    const r = await chat("auto");
    expect([r.status, r.meta.error]).toEqual(["error", "Gemini 3.8 Flash sent an empty answer."]);
    expect(tries()).toHaveLength(2);
  });
  test("an answer the first time is not passed on", async () => {
    const r = await chat("auto");
    expect([r.status, r.meta.model.id]).toEqual(["ok", GEMINI]);
    expect(tries()).toHaveLength(1);
  });
});

describe("a hand off", () => {
  test("goes to the next pick, and the receipt says why", async () => {
    emptyAt("google");
    const r = await runDelegate({ task: "Say hello.", files: [], kind: "write", effort: "low", check: "never", maxOut: 2000 } as any, new AbortController().signal);
    expect(r.model.id).toBe(CLAUDE);
    expect(r.receipt).toContain(PASSED);
    expect((db.query("SELECT model, status FROM delegations").all() as any[]).map((d) => [d.model, d.status])).toEqual([[CLAUDE, "ok"]]);
  });
});

describe("an app on the OpenAI address (a whole answer)", () => {
  test("still empty after a second try: Auto passes it to its next pick, which answers in its own way (0.11.2)", async () => {
    emptyAt("google");
    const r = await post(`${url}/v1/chat/completions`, { model: "auto", messages: [{ role: "user", content: "From an app [usage 100 10]" }] });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.choices[0].message.content).toBe("Hello from claude-sonnet-4-6.");
    expect(decodeURIComponent(r.headers.get("x-leanfare-reason")!)).toContain(PASSED);
    expect(tries()).toEqual([
      { model: GEMINI, status: "error", error: "came back empty" },
      { model: GEMINI, status: "error", error: "came back empty" },
      { model: CLAUDE, status: "ok", error: null }]);
  });
  test("a model the app named is asked once more, and its answer goes back as it came", async () => {
    emptyAt("google");
    const r = await post(`${url}/v1/chat/completions`, { model: GEMINI, messages: [{ role: "user", content: "From an app [usage 100 10]" }] });
    expect((await r.json()).choices[0].message.content).toBe("");
    expect(tries().map((t: any) => t.model)).toEqual([GEMINI, GEMINI]);
  });
});
