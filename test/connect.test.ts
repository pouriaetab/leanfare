// Connect OpenRouter: signing in on OpenRouter's page instead of pasting a key.
// The fake plays OpenRouter's side: the Authorize step that sends the browser back with a
// one time code, and the code trade that checks the PKCE proof (test/fake.ts).
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { paths } from "../src/config";
import { challengeFor } from "../src/connect";
import { setNow } from "../src/util";
import { ALL_TICKED, boot, fake, keys, outgoing, reset, ui } from "./app";
import { KEYS, OAUTH_KEY } from "./fake";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const start = async () => (await ui(url, "/api/connect/openrouter/start", {})).json as { url: string; expiresIn: number };
const status = async () => (await ui(url, "/api/connect/openrouter/status")).json as { status: string; message: string | null; state?: any };
const exchanges = () => fake.seen.filter((s) => s.path === "/openrouter/api/v1/auth/keys");

// What the browser does after Connect: open OpenRouter's link, press Authorize, follow the redirect back to Leanfare.
async function authorize(link: string) {
  const r = await fetch(link, { redirect: "manual" });
  return r.headers.get("location")!;
}
const callback = (to: string, headers: Record<string, string> = {}) => fetch(to, { headers });
async function signIn() {
  const link = await start();
  const back = await authorize(link.url);
  return { link, back, res: await callback(back) };
}
const openrouter = async () => ((await ui(url, "/api/state")).json.providers as any[]).find((p) => p.id === "openrouter");

describe("Connect OpenRouter: the link", () => {
  test("the challenge is the fingerprint of the verifier (the standard's own example)", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  test("start gives OpenRouter's link with a challenge, a state and this Leanfare's callback, and no secret", async () => {
    const a = await start();
    const u = new URL(a.url);
    expect(u.pathname).toBe("/openrouter/auth"); // https://openrouter.ai/auth for real
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("callback_url")).toBe(`${url}/connect/openrouter/callback`);
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.expiresIn).toBe(600);
    const b = await start();
    expect(new URL(b.url).searchParams.get("state")).not.toBe(u.searchParams.get("state"));
    expect(new URL(b.url).searchParams.get("code_challenge")).not.toBe(u.searchParams.get("code_challenge"));
  });
  test("the address is OpenRouter's own site when nothing is overridden", async () => {
    const was = process.env.LEANFARE_OPENROUTER_BASE;
    delete process.env.LEANFARE_OPENROUTER_BASE;
    try { expect(new URL((await start()).url).origin + new URL((await start()).url).pathname).toBe("https://openrouter.ai/auth"); }
    finally { process.env.LEANFARE_OPENROUTER_BASE = was; }
  });
});

describe("Connect OpenRouter: a good sign in", () => {
  test("the key is saved, tested, its models are listed, and the page says so", async () => {
    expect((await openrouter()).key.saved).toBe(false);
    const { link, res } = await signIn();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connected.");
    expect(html).toContain("You can close this tab.");
    // the proof sent matches the challenge in the link
    const sent = exchanges();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.code_challenge_method).toBe("S256");
    expect(createHash("sha256").update(sent[0].body.code_verifier).digest("base64url")).toBe(new URL(link.url).searchParams.get("code_challenge")!);
    // the key was tested before it was kept
    expect(fake.seen.some((s) => s.path.endsWith("/key") && s.auth === OAUTH_KEY)).toBe(true);
    const or = await openrouter();
    expect(or).toMatchObject({ ready: true, on: true });
    expect(or.key).toMatchObject({ saved: true, hint: "…auth" });
    expect(or.list.state).toBe("ok");
    const st = (await ui(url, "/api/state")).json;
    expect(st.models.openrouter.map((m: any) => m.id)).toContain("openrouter/acme/acme-large");
    expect(JSON.stringify(st)).not.toContain(OAUTH_KEY); // never shown back
  });
  test("the waiting page learns the outcome and gets the new state", async () => {
    const link = await start();
    expect((await status()).status).toBe("waiting");
    await callback(await authorize(link.url));
    const s = await status();
    expect(s.status).toBe("connected");
    expect(s.message).toContain("Connected to OpenRouter");
    expect(s.state.providers.find((p: any) => p.id === "openrouter").key.saved).toBe(true);
  });
  test("the credit balance is shown when OpenRouter reports it", async () => {
    await signIn();
    expect((await openrouter()).credit).toMatchObject({ remaining: 7.5, purchased: 10, used: 2.5 });
  });
  test("no balance is shown (and nothing breaks) when the key may not read credits", async () => {
    fake.oauth.credits = false;
    const { res } = await signIn();
    expect(res.status).toBe(200);
    expect((await openrouter()).credit).toBeNull();
  });
  test("Update list refreshes the balance, and removing the key clears it", async () => {
    await signIn();
    fake.oauth.credits = false;
    await ui(url, "/api/refresh", { what: "openrouter" });
    expect((await openrouter()).credit).toBeNull();
    fake.oauth.credits = true;
    await ui(url, "/api/refresh", { what: "openrouter" });
    expect((await openrouter()).credit?.remaining).toBe(7.5);
    await ui(url, "/api/keys/openrouter", undefined, "DELETE");
    expect((await openrouter()).credit).toBeNull();
  });
  test("a pasted key also shows the balance", async () => {
    await ui(url, "/api/keys", { provider: "openrouter", key: KEYS.openrouter });
    expect((await openrouter()).credit?.remaining).toBe(7.5);
  });
  test("the page that opens in the browser is locked down and caches nothing", async () => {
    const { res } = await signIn();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
  test("Leanfare reached only OpenRouter's addresses for this (no telemetry)", async () => {
    await signIn();
    expect([...new Set(outgoing.map((u) => new URL(u).host))].every((h) => h.startsWith("127.0.0.1:"))).toBe(true);
  });
});

describe("Connect OpenRouter: what is refused", () => {
  test("a wrong state is refused, and no code is traded", async () => {
    const link = await start();
    const back = new URL(await authorize(link.url));
    back.searchParams.set("state", "not-the-state");
    const res = await callback(back.href);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not start this sign in");
    expect(exchanges()).toHaveLength(0);
    expect((await openrouter()).key.saved).toBe(false);
    expect((await status()).status).toBe("waiting"); // a stranger's visit does not end your sign in
  });
  test("no state at all is refused", async () => {
    await start();
    const res = await callback(`${url}/connect/openrouter/callback?code=code-1`);
    expect(res.status).toBe(400);
    expect(exchanges()).toHaveLength(0);
  });
  test("a state is good once: visiting the same callback again is refused", async () => {
    const { back } = await signIn();
    const again = await callback(back);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("did not start this sign in");
    expect(exchanges()).toHaveLength(1);
  });
  test("pressing Connect again makes the older link useless", async () => {
    const first = await start();
    const old = await authorize(first.url);
    await start();
    const res = await callback(old);
    expect(res.status).toBe(400);
    expect(exchanges()).toHaveLength(0);
  });
  test("Stop (cancel) forgets the attempt", async () => {
    const link = await start();
    const back = await authorize(link.url);
    await ui(url, "/api/connect/openrouter/cancel", {});
    expect((await status()).status).toBe("idle");
    expect((await callback(back)).status).toBe(400);
    expect(exchanges()).toHaveLength(0);
  });
  test("after 10 minutes the state is expired, and the page says so in words", async () => {
    const link = await start();
    const back = await authorize(link.url);
    setNow("2026-10-21T12:10:01Z"); // the app's clock, 10 minutes and a second on
    const res = await callback(back);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("longer than 10 minutes");
    expect(exchanges()).toHaveLength(0);
    expect((await status()).status).toBe("failed");
  });
  test("pressing Deny on OpenRouter connects nothing and says how to try again", async () => {
    fake.oauth.deny = true;
    const link = await start();
    const back = await authorize(link.url);
    const res = await callback(back);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not send a code");
    expect((await openrouter()).key.saved).toBe(false);
  });
  test("the callback answers only to Leanfare's own host name", async () => {
    const link = await start();
    const back = await authorize(link.url);
    const res = await fetch(back, { headers: { host: "attacker.example" } });
    expect(res.status).toBe(403);
    expect(exchanges()).toHaveLength(0);
  });
});

describe("Connect OpenRouter: a trade that fails says why in plain words", () => {
  const cases: [string, () => void, RegExp][] = [
    ["a code OpenRouter does not know", () => { fake.oauth.failExchange = 403; }, /did not accept the code/],
    ["a code that expired on OpenRouter's side", () => { fake.oauth.expireNext = true; }, /code expired/],
    ["OpenRouter being down", () => { fake.oauth.failExchange = 503; }, /problem on its side \(HTTP 503\)/],
    ["OpenRouter being busy", () => { fake.oauth.failExchange = 429; }, /busy/],
  ];
  for (const [name, setup, words] of cases) {
    test(name, async () => {
      setup();
      const { res } = await signIn();
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Not connected.");
      expect(html).toMatch(words);
      expect((await openrouter()).key.saved).toBe(false);
      const s = await status();
      expect(s.status).toBe("failed");
      expect(s.message).toMatch(words);
    });
  }
  test("what OpenRouter says is printed escaped, never as page code", async () => {
    fake.oauth.failExchange = 418;
    fake.oauth.failMessage = "<script>alert(1)</script>";
    const { res } = await signIn();
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
  test("an address nobody answers at", async () => {
    const link = await start();
    const back = await authorize(link.url);
    const was = process.env.LEANFARE_OPENROUTER_BASE;
    process.env.LEANFARE_OPENROUTER_BASE = "http://127.0.0.1:9/openrouter/api/v1";
    try {
      const res = await callback(back);
      expect(await res.text()).toContain("could not reach OpenRouter");
    } finally { process.env.LEANFARE_OPENROUTER_BASE = was; }
  });
  test("a key that fails its test never replaces one that works", async () => {
    await keys("openrouter");
    const before = (await openrouter()).key.hint;
    fake.oauth.badKey = true;
    const { res } = await signIn();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not pass its test");
    expect((await openrouter()).key).toMatchObject({ saved: true, hint: before });
  });
});

describe("Connect OpenRouter: when the key cannot be kept", () => {
  test("the page says so, and the waiting page hears it too", async () => {
    rmSync(paths.keys, { force: true });
    mkdirSync(paths.keys); // the key file cannot be written while a folder sits where it goes
    try {
      const { res } = await signIn();
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("could not save the key");
      const s = await status();
      expect(s.status).toBe("failed");
      expect(s.message).toContain("could not save the key");
    } finally { rmSync(paths.keys, { recursive: true, force: true }); }
    expect((await openrouter()).key.saved).toBe(false);
  });
});

describe("Connect OpenRouter: with the access key on", () => {
  test("the page's API wants the cookie, but the callback is allowed by its one use state", async () => {
    const lock = await ui(url, "/api/lock", { on: true });
    expect(lock.json.lock.on).toBe(true);
    try {
      const noCookie = await fetch(`${url}/api/connect/openrouter/start`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: "{}" });
      expect(noCookie.status).toBe(401);
      const started = await fetch(`${url}/api/connect/openrouter/start`, { method: "POST", headers: { "x-leanfare": "1", "x-leanfare-token": "test-token", "content-type": "application/json" }, body: "{}" });
      const back = await authorize((await started.json()).url);
      const res = await callback(back); // a browser with no cookie
      expect(res.status).toBe(200);
      expect(exchanges()).toHaveLength(1);
    } finally { await fetch(`${url}/api/lock`, { method: "POST", headers: { "x-leanfare": "1", "x-leanfare-token": "test-token", "content-type": "application/json" }, body: JSON.stringify({ on: false }) }); }
  });
});
