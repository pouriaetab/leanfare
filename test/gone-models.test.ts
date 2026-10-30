// A model the provider no longer serves to the key (0.11.2): Google answers 404, "This model ... is no longer available
// to new users". It is left out like a model the key has no quota for (quota.ts), with its own why, and Auto passes the
// request to its next pick instead of failing it. A model you name is still asked, and the error says what was said.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runChat, usableModels } from "../src/engine";
import { clearNoQuota, noQuota, noQuotaText, noteRefusal } from "../src/quota";
import { boot, keys, reset } from "./app";

const GEMINI = "google/gemini-3.8-flash", CLAUDE = "anthropic/claude-sonnet-4-6";
beforeAll(async () => { await boot(); });
beforeEach(async () => {
  await reset({ ticked: [GEMINI, CLAUDE], mode: "save" });
  await keys("google", "anthropic");
});
const GOOGLE_SAID = "Google Gemini does not know this: This model models/gemini-3.8-flash is no longer available to new users. Please update your code to use a newer model.";
const ask = (asked: string) => runChat([{ role: "user", content: "Hi [gone@google]" }], asked, new AbortController().signal, () => {});

describe("a model no longer served to your key", () => {
  test("Auto passes the request to its next pick, says why, and leaves the model out after", async () => {
    const r = await ask("auto");
    expect([r.status, r.meta.model.id]).toEqual(["ok", CLAUDE]);
    expect(r.meta.notes).toContain("Gemini 3.8 Flash is no longer served to your Google Gemini key, so Auto passed the request to its next pick.");
    expect(noQuota(GEMINI)).toMatchObject({ why: "gone", tries: 1 });
    expect(noQuotaText(noQuota(GEMINI)!, "Google Gemini")).toBe("Gemini 3.8 Flash is left out: your Google Gemini key can't use it anymore (Google Gemini said it is no longer available)");
    expect(usableModels().map((m) => m.id)).toEqual([CLAUDE]);
  });
  test("a model you named is asked, and the error says what the provider said", async () => {
    const r = await ask(GEMINI);
    expect(r.status).toBe("error");
    expect(r.meta.error).toBe(GOOGLE_SAID);
    expect(noQuota(GEMINI)?.why).toBe("gone");
  });
  test("Try again clears it; a not found that does not name a model leaves the model in", () => {
    noteRefusal(GEMINI, "google", GOOGLE_SAID, "refused");
    expect(noQuota(GEMINI)?.why).toBe("gone");
    expect(clearNoQuota({ model: GEMINI })).toBe(1);
    expect(noQuota(GEMINI)).toBeNull();
    noteRefusal(GEMINI, "google", "Google Gemini does not know this: Not Found", "refused");
    noteRefusal(GEMINI, "google", "Google Gemini rejected the key: API key not valid. Please pass a valid API key.", "refused");
    expect(noQuota(GEMINI)).toBeNull();
  });
});
