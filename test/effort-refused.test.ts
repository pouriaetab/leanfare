// A provider that refuses the thinking effort Leanfare sent (Google, 1 Nov 2026: "Thinking level is not supported for
// this model", though the price list said the model takes one): the same model is asked again without it, and the
// model is sent no effort from then on, while the app runs.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { draw } from "../src/delegate";
import { NO_EFFORT } from "../src/upstream";
import { boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ["google/gemini-3.8-flash"] }); NO_EFFORT.clear(); draw.next = () => 0.5; await keys("google"); });
const google = () => fake.seen.filter((s) => s.provider === "google" && s.method === "POST" && s.path.includes("chat/completions"));
const hand = () => ui(url, "/api/delegate", { task: "Summarize the log.", files: [{ name: "app.log", text: "10:01 error: disk full\n" }], kind: "read", effort: "medium", check: "never" });

test("refused once, asked again without the effort, and never sent it again", async () => {
  fake.hooks.refuse = (body, provider) => (provider === "google" && body?.reasoning_effort ? { status: 400, message: "Thinking level is not supported for this model." } : null);
  const before = google().length;
  const r = await hand();
  expect(r.status).toBe(200);
  expect(r.json.model.id).toBe("google/gemini-3.8-flash");
  const sent = google().slice(before);
  expect(sent.map((s) => s.body?.reasoning_effort ?? null)).toEqual(["medium", null]);
  expect(NO_EFFORT.has("google/gemini-3.8-flash")).toBe(true);
  const next = google().length;
  expect((await hand()).status).toBe(200);
  expect(google().slice(next).map((s) => s.body?.reasoning_effort ?? null)).toEqual([null]); // not sent again
});

test("another 400 is not taken for a refused effort", async () => {
  fake.hooks.refuse = (_body, provider) => (provider === "google" ? { status: 400, message: "Invalid value at 'contents'." } : null);
  const r = await hand();
  expect(r.status).not.toBe(200);
  expect(NO_EFFORT.size).toBe(0);
});
