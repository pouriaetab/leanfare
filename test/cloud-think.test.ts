// Cloud models that think (upstream.ts: thinkRoom): their thinking counts toward the answer's limit, so Leanfare's
// own requests give them room for it on top of the limit asked, and an answer cut off while still thinking (handed
// back under a first line "thought") is asked again with more room. 29 Oct: a hand off to Gemini 3.8 Flash at high
// effort with 4,000 tokens came back as 120 tokens of its thinking.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getModel } from "../src/data";
import { runDelegate } from "../src/delegate";
import { CLOUD_THINK_ROOM, thinkRoom } from "../src/upstream";
import { boot, fake, keys, post, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", MISTRAL = "mistral/mistral-large-4";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ ticked: [GEMINI, MISTRAL] });
  await keys("google", "mistral");
  getModel(GEMINI)!.skills.push("reasoning"); // Gemini thinks (the test price list does not say so)
});
const handOff = (task: string, model: string, effort: "low" | "medium" | "high") =>
  runDelegate({ task, files: [], kind: "reason", effort, check: "never", maxOut: 4000, model }, new AbortController().signal);
const limits = (provider: string) => fake.seen.filter((s) => s.provider === provider && s.path.endsWith("/chat/completions")).map((s) => s.body.max_tokens);

describe("a cloud model that thinks", () => {
  test("gets room for its thinking on top of the limit a hand off asks, by effort", async () => {
    await handOff("Work it out.", GEMINI, "high");
    await handOff("Work it out.", GEMINI, "low");
    expect(limits("google")).toEqual([4000 + CLOUD_THINK_ROOM.high, 4000 + CLOUD_THINK_ROOM.low]);
  });

  test("a model that does not think gets the limit as asked, and an app's own limit is sent as it set it", async () => {
    await handOff("Work it out.", MISTRAL, "high");
    expect(limits("mistral")).toEqual([4000]);
    const r = await post(`${url}/v1/chat/completions`, { model: GEMINI, max_tokens: 500, messages: [{ role: "user", content: "Hi" }] });
    expect(r.status).toBe(200);
    expect(limits("google")).toEqual([500]);
    expect(thinkRoom(getModel(MISTRAL)!, "high")).toBe(0);
  });

  test("an answer cut off while it was still thinking is thinking, not an answer: asked again with more room", async () => {
    const r = await handOff("Work it out. [thought1]", GEMINI, "high");
    expect(r.answer).toBe("Hello from gemini-3.8-flash.");
    const first = 4000 + CLOUD_THINK_ROOM.high;
    expect(limits("google")).toEqual([first, Math.min(2 * first, 64000)]);
  });
});
