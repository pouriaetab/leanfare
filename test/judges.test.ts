// Judges that do not know who wrote an answer, from another company (judge.ts): a check goes to a stronger model of
// another company than the one that answered when one can take it, and what an answer says of its own model is
// masked in the checker's copy. Models tend to favour answers like their own and their maker's.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getModel, type Model } from "../src/data";
import { draw, runDelegate } from "../src/delegate";
import { companyOf, masked } from "../src/judge";
import { boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { await reset(); draw.next = () => 0; });
const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n10:02 error: retry failed\n" };
const HAIKU = "anthropic/claude-haiku-4-5";
const ask = () => runDelegate({ task: "List the errors.", files: [LOG], kind: "read", effort: "low", check: "always", maxOut: 2000, model: HAIKU }, new AbortController().signal);
const checks = () => fake.seen.filter((s) => JSON.stringify(s.body ?? "").includes("You check another model's work."));

describe("what an answer says of its own model", () => {
  test("is masked for the judge; names the task is about stay", () => {
    expect(masked("I am Claude, an AI assistant made by Anthropic.")).toBe("I am [a model], an AI assistant made by [a company].");
    expect(masked("As Gemini 3 Pro, I can say this.")).toBe("As [a model], I can say this.");
    expect(masked("As Qwen I am not sure. As Claude Code does, it reads files.")).toBe("As [a model] I am not sure. As Claude Code does, it reads files.");
    expect(masked("I'm GPT-5 mini. This is DeepSeek V4 Flash speaking.")).toBe("I'm [a model]. This is [a model] speaking.");
    expect(masked("As an AI model developed by Google, I think so.")).toBe("As an AI model developed by [a company], I think so.");
    expect(masked("Use the Google Maps API as Claude Code does. Gemini Flash is cheap.")).toBe("Use the Google Maps API as Claude Code does. Gemini Flash is cheap.");
  });
});

describe("the company that made a model", () => {
  test("its maker; a local model's from its name; none when not known", () => {
    expect(companyOf(getModel(HAIKU)!)).toBe("anthropic");
    const local = (apiId: string) => ({ id: `ollama/${apiId}`, apiId, name: apiId, maker: "local", local: true }) as unknown as Model;
    expect(companyOf(local("qwen3.5:9b"))).toBe("alibaba");
    expect(companyOf(local("llama3.3:70b"))).toBe("meta");
    expect(companyOf(local("mystery:1b"))).toBeNull();
    expect(companyOf({ ...getModel(HAIKU)!, maker: "other" })).toBeNull();
  });
});

describe("a check", () => {
  test("goes to a stronger model of another company when one can take it, and never sees the answer's own name", async () => {
    await reset({ ticked: [HAIKU, "anthropic/claude-sonnet-4-6", "mistral/mistral-large-4"] });
    await keys("anthropic", "mistral");
    fake.hooks.answer = (_p, provider) => (provider === "anthropic" ? "I am Claude, made by Anthropic. Errors: disk full (2), retry failed (3)." : provider === "mistral" ? "PASS" : null);
    const r = await ask();
    // Claude Sonnet 4.6 is rated higher, but it is Anthropic's, like Claude Haiku that answered.
    expect(r.check).toMatchObject({ verdict: "pass", other: true, checker: { id: "mistral/mistral-large-4" } });
    expect(r.receipt).toContain("Checked blind by Mistral Large 4 (another company): passed");
    const sent = JSON.stringify(checks().at(-1)!.body);
    expect(sent).toContain("I am [a model], made by [a company]. Errors: disk full (2), retry failed (3).");
    expect(sent).not.toContain("Claude");
    expect(sent).not.toContain("Haiku");
  });

  test("with no other company's model rated above, one of the same company checks, and the receipt does not say another", async () => {
    await reset({ ticked: [HAIKU, "anthropic/claude-sonnet-4-6"] });
    await keys("anthropic");
    fake.hooks.answer = (p) => (p.includes("You check another model's work.") ? "PASS" : "Errors: disk full (2), retry failed (3).");
    const r = await ask();
    expect(r.check).toMatchObject({ verdict: "pass", other: false, checker: { id: "anthropic/claude-sonnet-4-6" } });
    expect(r.receipt).toContain("Checked blind by Claude Sonnet 4.6: passed");
  });
});
