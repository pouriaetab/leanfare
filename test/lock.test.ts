// The optional access key: off by default; when on, apps need it, the page
// needs its cookie, and Leanfare's own command and doors use the control token.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, keys, post, reset } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const page = (path: string, init: RequestInit = {}) => fetch(url + path, { ...init, headers: { "x-leanfare": "1", "content-type": "application/json", ...(init.headers ?? {}) } });
const chatBody = { model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Hi" }] };
async function lockOn() {
  const r = await page("/api/lock", { method: "POST", body: JSON.stringify({ on: true }) });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const st = await r.json();
  return { key: st.lock.key as string, cookie };
}

describe("the access key", () => {
  test("off by default: apps and the page need nothing", async () => {
    await keys("openai");
    expect((await post(`${url}/v1/chat/completions`, chatBody)).status).toBe(200);
    expect((await page("/api/state")).status).toBe(200);
    expect((await (await page("/api/state")).json()).lock).toEqual({ on: false, key: null });
  });

  test("on: apps need the key, in OpenAI's or Anthropic's way", async () => {
    await keys("openai", "anthropic");
    const { key } = await lockOn();
    expect(key).toMatch(/^lf-[0-9a-f]{40}$/);
    const none = await post(`${url}/v1/chat/completions`, chatBody);
    expect(none.status).toBe(401);
    expect((await none.json()).error.type).toBe("authentication_error");
    expect((await post(`${url}/v1/chat/completions`, chatBody, { authorization: `Bearer ${key}` })).status).toBe(200);
    expect((await post(`${url}/v1/chat/completions`, chatBody, { authorization: "Bearer lf-wrong" })).status).toBe(401);
    const claude = { model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] };
    const wrong = await post(`${url}/v1/messages`, claude, { "x-api-key": "nope" });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).type).toBe("error"); // Anthropic's error shape
    expect((await post(`${url}/v1/messages`, claude, { "x-api-key": key })).status).toBe(200);
    expect((await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  });

  test("on: the page needs its cookie, which the page that turned it on gets", async () => {
    const { cookie } = await lockOn();
    const locked = await page("/api/state");
    expect(locked.status).toBe(401);
    expect((await locked.json()).locked).toBe(true);
    expect((await page("/api/state", { headers: { cookie } })).status).toBe(200);
    expect((await page("/api/state", { headers: { "x-leanfare-token": "test-token" } })).status).toBe(200); // Leanfare's own command
    expect((await fetch(url + "/")).status).toBe(200); // the page itself still loads, to show the lock
  });

  test("unlocking with the key gives a new browser its cookie; a wrong key is refused", async () => {
    const { key } = await lockOn();
    const bad = await page("/api/unlock", { method: "POST", body: JSON.stringify({ key: "lf-0000" }) });
    expect(bad.status).toBe(401);
    const good = await page("/api/unlock", { method: "POST", body: JSON.stringify({ key }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie")!.split(";")[0];
    expect((await page("/api/state", { headers: { cookie } })).status).toBe(200);
  });

  test("the unlock link with the control token opens the page unlocked", async () => {
    await lockOn();
    const r = await fetch(`${url}/unlock?t=test-token`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    expect((await page("/api/state", { headers: { cookie } })).status).toBe(200);
    const wrong = await fetch(`${url}/unlock?t=nope`, { redirect: "manual" });
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  test("a new key stops the old one and its cookies; off opens everything again", async () => {
    await keys("openai");
    const first = await lockOn();
    const r = await page("/api/lock", { method: "POST", headers: { cookie: first.cookie }, body: JSON.stringify({ on: true, rotate: true }) });
    const second = (await r.json()).lock.key;
    expect(second).not.toBe(first.key);
    expect((await post(`${url}/v1/chat/completions`, chatBody, { authorization: `Bearer ${first.key}` })).status).toBe(401);
    expect((await page("/api/state", { headers: { cookie: first.cookie } })).status).toBe(401);
    const cookie2 = r.headers.get("set-cookie")!.split(";")[0];
    await page("/api/lock", { method: "POST", headers: { cookie: cookie2 }, body: JSON.stringify({ on: false }) });
    expect((await post(`${url}/v1/chat/completions`, chatBody)).status).toBe(200);
    expect((await page("/api/state")).status).toBe(200);
  });

  test("a browser preflight from an allowed site passes without the key", async () => {
    await reset({ ticked: ALL_TICKED, allowOrigins: ["http://localhost:3000"] });
    await lockOn();
    const r = await fetch(`${url}/v1/chat/completions`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
    expect(r.status).toBe(204);
  });
});
