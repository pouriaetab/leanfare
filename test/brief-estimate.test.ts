// The estimate shown before sending counts what is sent, the short answers line too.
import { beforeAll, expect, test } from "bun:test";
import { ALL_TICKED, boot, keys, readSSE, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });

test("the estimate shown before sending counts what is sent, the short answers line too", async () => {
  await reset({ ticked: ALL_TICKED, brief: true });
  await keys("openai");
  const messages = [{ role: "user", content: "Hi" }];
  const before = (await ui(url, "/api/estimate", { messages, model: "openai/gpt-5-mini" })).json.estimate;
  const r = await fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ messages, model: "openai/gpt-5-mini" }) });
  const { events } = await readSSE(r);
  const sent = events.find((e: any) => e.type === "meta")?.plan?.estimate;
  expect(sent).toBe(before);
}, 30000);
